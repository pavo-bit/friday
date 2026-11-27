// ============================================================
// FRIDAY — Security & Device Pairing Service
// Cryptographic pairing codes, SHA-256 token hashing, rotation
// ============================================================

import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('Auth');

export interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  locationOptIn: boolean;
  pushToken: string | null;
  lastSeenAt: string;
  createdAt: string;
}

interface PendingPairingCode {
  code: string;
  expiresAt: number;
}

export class AuthService {
  private pendingCodes: Map<string, PendingPairingCode> = new Map();

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Generate a short-lived 6-digit pairing code (valid for 5 minutes).
   */
  generatePairingCode(): { code: string; expiresAt: string } {
    const code = String(crypto.randomInt(100_000, 999_999));
    const expiresAt = Date.now() + 5 * 60_000;
    this.pendingCodes.set(code, { code, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Exchange a valid pairing code for a device record and bearer token.
   */
  async pairDevice(params: {
    code: string;
    name: string;
    platform?: string;
    pushToken?: string;
  }): Promise<{ device: DeviceRecord; token: string }> {
    const entry = this.pendingCodes.get(params.code.trim());
    if (!entry || Date.now() > entry.expiresAt) {
      this.pendingCodes.delete(params.code.trim());
      throw new Error('Invalid or expired pairing code.');
    }
    this.pendingCodes.delete(params.code.trim());

    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const deviceId = uuidv4();
    const token = `frd_${crypto.randomBytes(32).toString('hex')}`;
    const tokenHash = this.hashToken(token);
    const platform = params.platform || 'android';

    db.prepare(
      `INSERT INTO devices (id, name, platform, token_hash, push_token, location_opt_in)
       VALUES (?, ?, ?, ?, ?, 0)`
    ).run(deviceId, params.name.trim() || 'Companion Device', platform, tokenHash, params.pushToken || null);

    store.logAudit(`device:${deviceId}`, 'device:pair', params.name, 'medium', true);

    const device = await this.getDevice(deviceId);
    if (!device) throw new Error('Device pairing failed verification');
    log.info(`Paired new device: ${device.name} (${device.platform})`);
    return { device, token };
  }

  /**
   * Verify a bearer token and update device last_seen_at.
   */
  async verifyToken(token: string): Promise<DeviceRecord | null> {
    if (!token || !token.startsWith('frd_')) return null;
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;

    const hash = this.hashToken(token);
    const row = db
      .prepare(`SELECT * FROM devices WHERE token_hash = ? AND COALESCE(revoked, 0) = 0 LIMIT 1`)
      .get(hash) as Record<string, unknown> | undefined;

    if (!row) return null;

    if (row.token_expires_at) {
      const expiresMs = Date.parse(String(row.token_expires_at));
      if (!Number.isNaN(expiresMs) && Date.now() > expiresMs) {
        return null;
      }
    }

    db.prepare(`UPDATE devices SET last_seen_at = datetime('now') WHERE id = ?`).run(String(row.id));
    return this.mapRow(row);
  }

  /**
   * Rotate a device's bearer token.
   */
  async rotateToken(deviceId: string): Promise<string | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;

    const newToken = `frd_${crypto.randomBytes(32).toString('hex')}`;
    const info = db
      .prepare(`UPDATE devices SET token_hash = ?, last_seen_at = datetime('now') WHERE id = ?`)
      .run(this.hashToken(newToken), deviceId);

    if (info.changes === 0) return null;
    store.logAudit(`device:${deviceId}`, 'device:rotate_token', deviceId, 'medium', true);
    return newToken;
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return false;
    const info = db.prepare(`DELETE FROM devices WHERE id = ?`).run(deviceId);
    if (info.changes > 0) {
      store.logAudit('admin', 'device:revoke', deviceId, 'high', true);
      return true;
    }
    return false;
  }

  async setLocationOptIn(deviceId: string, optIn: boolean): Promise<boolean> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return false;
    const info = db
      .prepare(`UPDATE devices SET location_opt_in = ? WHERE id = ?`)
      .run(optIn ? 1 : 0, deviceId);
    if (info.changes > 0) {
      store.logAudit(`device:${deviceId}`, 'privacy:location_opt_in', String(optIn), 'medium', true);
      return true;
    }
    return false;
  }

  async getDevice(id: string): Promise<DeviceRecord | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;
    const row = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async listDevices(): Promise<DeviceRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const rows = db.prepare(`SELECT * FROM devices ORDER BY last_seen_at DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: Record<string, unknown>): DeviceRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      platform: String(row.platform),
      locationOptIn: Number(row.location_opt_in) === 1,
      pushToken: row.push_token ? String(row.push_token) : null,
      lastSeenAt: String(row.last_seen_at),
      createdAt: String(row.created_at),
    };
  }
}

let _auth: AuthService | null = null;
export function getAuthService(): AuthService {
  if (!_auth) {
    _auth = new AuthService();
  }
  return _auth;
}
