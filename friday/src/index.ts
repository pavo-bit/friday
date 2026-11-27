// ============================================================
// FRIDAY — Main Entry Point
// Boots all layers and starts the system
// ============================================================

import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables before anything else
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { createLayerLogger } from './shared/logger';
import { getConfig, validateConfig } from './shared/config';
import { eventBus } from './shared/events';
import { FridayServer } from './api/server';
import { getClawBridge } from './orchestration/clawBridge';
import { getMemoryStore } from './memory/store';
import { getMonitoringEngine } from './services/monitoringEngine';
import { getSchedulerService } from './services/schedulerService';
import { getBackgroundOrchestrator } from './orchestration/backgroundOrchestrator';
import { getVoiceService } from './voice/voiceService';

const log = createLayerLogger('Core');

const BANNER = `
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║     ███████╗██████╗ ██╗██████╗  █████╗ ██╗   ██╗         ║
║     ██╔════╝██╔══██╗██║██╔══██╗██╔══██╗╚██╗ ██╔╝         ║
║     █████╗  ██████╔╝██║██║  ██║███████║ ╚████╔╝          ║
║     ██╔══╝  ██╔══██╗██║██║  ██║██╔══██║  ╚██╔╝           ║
║     ██║     ██║  ██║██║██████╔╝██║  ██║   ██║            ║
║     ╚═╝     ╚═╝  ╚═╝╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝            ║
║                                                           ║
║     Fully Responsive Intelligent Digital Assistant         ║
║     Powered by Claw Code Engine                           ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`;

/**
 * Boot sequence for FRIDAY.
 *
 * 1. Validate configuration
 * 2. Initialize memory database
 * 3. Verify Claw binary availability
 * 4. Start API + WebSocket server
 * 5. Register shutdown handlers
 */
async function boot(): Promise<void> {
  console.log(BANNER);

  log.info('FRIDAY boot sequence initiated...');

  // Step 1: Validate configuration
  const config = getConfig();
  const errors = validateConfig(config);

  if (errors.length > 0) {
    log.warn('Configuration warnings:');
    for (const error of errors) {
      log.warn(`  ⚠ ${error}`);
    }
  }

  // Step 2: Initialize memory database
  log.info('Initializing memory store...');
  try {
    const memoryStore = await getMemoryStore();
    const stats = memoryStore.getStats();
    log.info(`Memory store ready — ${stats.totalMemories} memories, ${stats.totalTasks} tasks, ${stats.totalConversations} conversations`);
  } catch (error) {
    log.warn('Memory store initialization failed — running in volatile mode', {
      error: (error as Error).message,
    });
  }

  // Step 3: Verify Claw binary
  const bridge = getClawBridge();
  if (bridge.isAvailable()) {
    log.info(`✅ Claw engine found: ${bridge.getBinaryPath()}`);
  } else {
    log.warn(`❌ Claw binary not found at: ${bridge.getBinaryPath()}`);
    log.warn('   Build it with: cd rust && cargo build --workspace');
    log.warn('   FRIDAY will run in limited mode (no Claw-powered tasks)');
  }

  // Step 4: Recover persistent watchers, background tasks & start scheduler
  await getMonitoringEngine().recoverOnBoot();
  await getBackgroundOrchestrator().recoverOnBoot();
  await getSchedulerService().start();

  // Step 5: Start the server
  const server = new FridayServer();
  await server.start();

  // Step 6: Start Native Windows Voice Service
  const voiceService = getVoiceService();
  await voiceService.start();

  // Step 7: Register shutdown handlers
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal} — shutting down gracefully...`);
    eventBus.emitEvent('system:shutdown');

    getMonitoringEngine().stopAll();
    getSchedulerService().stop();
    bridge.cancelAll();
    await voiceService.stop();
    await server.stop();

    try {
      const memoryStore = await getMemoryStore();
      memoryStore.close();
    } catch {
      // Best-effort cleanup
    }

    log.info('FRIDAY shutdown complete. Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', { error: error.message, stack: error.stack });
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { reason: String(reason) });
  });

  log.info('🟢 FRIDAY is fully operational. Awaiting commands.');
}

// Run
boot().catch((error) => {
  console.error('FRIDAY failed to boot:', error);
  process.exit(1);
});
