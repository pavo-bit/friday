// ============================================================
// FRIDAY — Location Intelligence Service
// Privacy-first named geofences and entry/exit event handling
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { getSchedulerService } from './schedulerService';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('Location');

export interface SavedLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  address: string;
  createdAt: string;
}

export class LocationService {
  async saveLocation(input: {
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters?: number;
    address?: string;
  }): Promise<SavedLocation> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const name = input.name.trim().toLowerCase();
    if (!name) throw new Error('Location name is required');
    if (input.latitude < -90 || input.latitude > 90 || input.longitude < -180 || input.longitude > 180) {
      throw new Error('Invalid latitude/longitude coordinates');
    }

    const id = uuidv4();
    const radius = Math.max(25, Math.min(10_000, input.radiusMeters ?? 150));

    db.prepare(
      `INSERT INTO locations (id, name, latitude, longitude, radius_meters, address)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         radius_meters = excluded.radius_meters,
         address = excluded.address,
         updated_at = datetime('now')`
    ).run(id, name, input.latitude, input.longitude, radius, input.address || '');

    const saved = await this.getLocationByName(name);
    if (!saved) throw new Error('Location save verification failed');
    return saved;
  }

  async getLocationByName(name: string): Promise<SavedLocation | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;
    const row = db
      .prepare(`SELECT * FROM locations WHERE LOWER(name) = LOWER(?) OR id = ? LIMIT 1`)
      .get(name.trim(), name.trim()) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async listLocations(): Promise<SavedLocation[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const rows = db.prepare(`SELECT * FROM locations ORDER BY name ASC`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async deleteLocation(idOrName: string): Promise<boolean> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return false;
    const info = db
      .prepare(`DELETE FROM locations WHERE id = ? OR LOWER(name) = LOWER(?)`)
      .run(idOrName, idOrName);
    return info.changes > 0;
  }

  async handleGeofenceEvent(params: {
    deviceId: string;
    locationIdOrName: string;
    eventType: 'enter' | 'exit';
  }): Promise<{ location: SavedLocation; triggeredRemindersCount: number }> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const device = db
      .prepare(`SELECT location_opt_in FROM devices WHERE id = ?`)
      .get(params.deviceId) as { location_opt_in: number } | undefined;

    if (device && device.location_opt_in !== 1) {
      throw new Error('Location tracking is disabled for this device. Enable opt-in location privacy first.');
    }

    const location = await this.getLocationByName(params.locationIdOrName);
    if (!location) {
      throw new Error(`Saved location "${params.locationIdOrName}" not found.`);
    }

    const scheduler = getSchedulerService();
    const triggered = await scheduler.triggerLocationReminders(location.id, params.eventType);
    store.logAudit(
      `device:${params.deviceId}`,
      `geofence:${params.eventType}`,
      location.name,
      'low',
      true,
      `Triggered ${triggered.length} reminder(s)`
    );

    log.info(`Geofence ${params.eventType} at "${location.name}" triggered ${triggered.length} reminder(s)`);
    return { location, triggeredRemindersCount: triggered.length };
  }

  private mapRow(row: Record<string, unknown>): SavedLocation {
    return {
      id: String(row.id),
      name: String(row.name),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      radiusMeters: Number(row.radius_meters),
      address: String(row.address || ''),
      createdAt: String(row.created_at),
    };
  }
}

let _location: LocationService | null = null;
export function getLocationService(): LocationService {
  if (!_location) {
    _location = new LocationService();
  }
  return _location;
}
