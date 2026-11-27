// ============================================================
// FRIDAY — Request Authentication & Actor Identity Context
// ============================================================

import { Request, Response } from 'express';
import { DeviceRecord, getAuthService } from '../services/authService';
import { getConfig } from '../shared/config';

export interface CallerIdentity {
  actorId: string;
  deviceId: string;
  isLocal: boolean;
  authenticated: boolean;
  device?: DeviceRecord;
}

/**
 * Resolve caller identity from Bearer token or localhost context.
 * Returns null if credentials are missing (for remote) or invalid (even on localhost).
 */
export async function resolveCallerIdentity(req: Request): Promise<CallerIdentity | null> {
  const authHeader = req.get('authorization');
  if (authHeader !== undefined) {
    if (!authHeader.startsWith('Bearer ')) {
      return null;
    }
    const token = authHeader.slice(7).trim();
    const device = await getAuthService().verifyToken(token);
    if (!device) {
      return null;
    }
    return {
      actorId: `device:${device.id}`,
      deviceId: device.id,
      isLocal: false,
      authenticated: true,
      device,
    };
  }

  const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1', getConfig().host]);
  const isLocal =
    req.ip === '127.0.0.1' ||
    req.ip === '::1' ||
    req.ip === '::ffff:127.0.0.1' ||
    allowedHosts.has(req.hostname);

  if (!isLocal) {
    return null;
  }

  const headerOwner = req.get('x-friday-owner');
  const actorId = headerOwner && headerOwner.trim() ? headerOwner.trim() : 'local';
  return {
    actorId,
    deviceId: 'local',
    isLocal: true,
    authenticated: true,
  };
}

export async function requireCallerIdentity(
  req: Request,
  res: Response
): Promise<CallerIdentity | null> {
  const identity = await resolveCallerIdentity(req);
  if (!identity) {
    res.status(401).json({ error: 'Unauthorized: valid bearer token required' });
    return null;
  }
  return identity;
}
