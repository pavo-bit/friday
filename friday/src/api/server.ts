// ============================================================
// FRIDAY — API Server
// Express + WebSocket gateway bridging UI to all FRIDAY layers
// ============================================================

import express from 'express';
import cors from 'cors';
import * as http from 'http';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { createLayerLogger } from '../shared/logger';
import { getConfig, validateConfig } from '../shared/config';
import { eventBus } from '../shared/events';
import { WsMessage, WsMessageType } from '../shared/types';
import { fridayRoutes } from './routes/friday';
import { memoryRoutes } from './routes/memory';
import { healthRoutes } from './routes/health';
import { assistantRoutes } from './routes/assistant';
import { taskRoutes } from './routes/tasks';
import { getAuthService } from '../services/authService';

const log = createLayerLogger('API');

/**
 * FridayServer — the HTTP + WebSocket gateway.
 *
 * Provides REST endpoints for task execution and voice processing,
 * plus WebSocket for real-time streaming of events to the UI.
 */
export class FridayServer {
  private app: express.Application;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();

  constructor() {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /** Configure Express middleware */
  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json({ limit: '5mb' }));

    // Serve the dashboard UI
    const uiPath = path.resolve(__dirname, '..', '..', 'ui');
    this.app.use(express.static(uiPath));

    // Request logging
    this.app.use((req, _res, next) => {
      if (!req.path.includes('/health')) {
        log.debug(`${req.method} ${req.path}`, { ip: req.ip });
      }
      next();
    });

    // Origin validation + Bearer token authentication for remote/companion access
    this.app.use(async (req, res, next) => {
      const origin = req.get('origin');
      const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1', getConfig().host]);

      if (origin) {
        try {
          const originHost = new URL(origin).hostname;
          if (!allowedHosts.has(originHost)) {
            res.status(403).json({ error: 'Cross-origin request rejected' });
            return;
          }
        } catch {
          res.status(403).json({ error: 'Invalid request origin' });
          return;
        }
      }

      const isLocalIp =
        req.ip === '127.0.0.1' ||
        req.ip === '::1' ||
        req.ip === '::ffff:127.0.0.1' ||
        allowedHosts.has(req.hostname);

      const publicPaths = new Set(['/friday/health', '/friday/auth/pair']);
      if (isLocalIp || publicPaths.has(req.path) || !req.path.startsWith('/friday')) {
        next();
        return;
      }

      const authHeader = req.get('authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const device = await getAuthService().verifyToken(token);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized: valid paired device bearer token required' });
        return;
      }
      next();
    });

    // Simple rate limiting (per IP)
    const requestCounts = new Map<string, { count: number; resetAt: number }>();
    this.app.use((req, res, next) => {
      const ip = req.ip || 'unknown';
      const now = Date.now();
      const entry = requestCounts.get(ip) || { count: 0, resetAt: now + 60_000 };

      if (now > entry.resetAt) {
        entry.count = 0;
        entry.resetAt = now + 60_000;
      }

      entry.count++;
      requestCounts.set(ip, entry);

      if (entry.count > 100) {
        res.status(429).json({ error: 'Too many requests' });
        return;
      }

      next();
    });
  }

  /** Mount API routes */
  private setupRoutes(): void {
    this.app.use('/friday', fridayRoutes);
    this.app.use('/friday/memory', memoryRoutes);
    this.app.use('/friday/tasks', taskRoutes);
    this.app.use('/friday', healthRoutes);
    this.app.use('/friday', assistantRoutes);

    // Fallback — serve the dashboard
    this.app.get('/', (_req, res) => {
      res.sendFile(path.resolve(__dirname, '..', '..', 'ui', 'index.html'));
    });

    // 404 handler
    this.app.use((_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

  /** Set up WebSocket for real-time communication */
  private setupWebSocket(): void {
    if (!this.server) return;

    this.wss = new WebSocketServer({ server: this.server, path: '/friday/ws' });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      log.info(`WebSocket client connected (total: ${this.clients.size})`);

      // Send initial system status
      ws.send(
        JSON.stringify({
          type: WsMessageType.SYSTEM_STATUS,
          payload: { connected: true, timestamp: new Date().toISOString() },
          timestamp: new Date().toISOString(),
        })
      );

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as WsMessage;
          this.handleWsMessage(ws, message);
        } catch (error) {
          log.warn('Invalid WebSocket message', { error: (error as Error).message });
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        log.info(`WebSocket client disconnected (total: ${this.clients.size})`);
      });

      ws.on('error', (error) => {
        log.error('WebSocket error', { error: error.message });
        this.clients.delete(ws);
      });
    });

    // Subscribe to event bus broadcasts
    eventBus.onEvent('ws:broadcast', (message: WsMessage) => {
      this.broadcast(message);
    });

    log.info('WebSocket server initialized at /friday/ws');
  }

  /** Handle incoming WebSocket messages */
  private handleWsMessage(ws: WebSocket, message: WsMessage): void {
    switch (message.type) {
      case WsMessageType.APPROVAL_RESPONSE: {
        const { requestId, approved } = message.payload as {
          requestId: string;
          approved: boolean;
        };
        // Forward to safety gate via dynamic import
        import('../orchestration/safetyGate').then(({ getSafetyGate }) => {
          getSafetyGate().processApproval(requestId, approved);
        });
        break;
      }

      case WsMessageType.TEXT_INPUT: {
        const { text } = message.payload as { text: string };
        // Process as a new user input
        import('./routes/friday').then(({ processTextInput }) => {
          processTextInput(text).then((result) => {
            ws.send(
              JSON.stringify({
                type: WsMessageType.TASK_COMPLETED,
                payload: result,
                timestamp: new Date().toISOString(),
              })
            );
          });
        });
        break;
      }

      default:
        log.debug(`Unhandled WS message type: ${message.type}`);
    }
  }

  /** Broadcast a message to all connected WebSocket clients */
  broadcast(message: WsMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /** Return the actual bound listening port */
  getPort(): number {
    const addr = this.server?.address();
    if (addr && typeof addr === 'object') return addr.port;
    return getConfig().port;
  }

  /** Start the server */
  async start(portOverride?: number): Promise<void> {
    const config = getConfig();
    const listenPort = portOverride !== undefined ? portOverride : config.port;

    // Validate configuration
    const errors = validateConfig(config);
    if (errors.length > 0) {
      for (const error of errors) {
        log.warn(`Config warning: ${error}`);
      }
    }

    this.server = http.createServer(this.app);
    this.setupWebSocket();

    return new Promise((resolve) => {
      this.server!.listen(listenPort, config.host, () => {
        const boundPort = this.getPort();
        log.info(`🚀 FRIDAY is live at http://${config.host}:${boundPort}`);
        log.info(`   Dashboard: http://${config.host}:${config.port}`);
        log.info(`   API: http://${config.host}:${config.port}/friday/run`);
        log.info(`   WebSocket: ws://${config.host}:${config.port}/friday/ws`);
        log.info(`   Health: http://${config.host}:${config.port}/friday/health`);

        eventBus.emitEvent('system:ready');
        resolve();
      });
    });
  }

  /** Stop the server gracefully */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all WebSocket connections
      for (const client of this.clients) {
        client.close();
      }
      this.clients.clear();

      if (this.wss) {
        this.wss.close();
      }

      if (this.server) {
        this.server.close(() => {
          log.info('FRIDAY server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
