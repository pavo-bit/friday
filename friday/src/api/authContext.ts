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
  const remoteAddr = req.socket?.remoteAddress || req.ip || '';
  const isLoopbackSocket =
    remoteAddr === '127.0.0.1' ||
    remoteAddr === '::1' ||
    remoteAddr === '::ffff:127.0.0.1';
  const isLocal =
    isLoopbackSocket &&
    (req.ip === '127.0.0.1' ||
      req.ip === '::1' ||
      req.ip === '::ffff:127.0.0.1' ||
      allowedHosts.has(req.hostname));

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

export class ActorImpersonationError extends Error {
  constructor(message = 'Forbidden: cannot impersonate another actor identity.') {
    super(message);
    this.name = 'ActorImpersonationError';
  }
}

/**
 * Prevent remote paired devices from impersonating another actorId.
 */
export function enforceActorScope(identity: CallerIdentity, requestedActorId?: string): string {
  const trimmed = requestedActorId?.trim();
  if (!trimmed) return identity.actorId;
  if (identity.isLocal) return trimmed;
  if (trimmed === identity.actorId || trimmed === identity.deviceId) {
    return trimmed;
  }
  throw new ActorImpersonationError();
}

/**
 * Convenience helper for private routes: returns { identity, actorId } or sends 401/403 and returns null.
 */
export async function resolveActorOrRespond(
  req: Request,
  res: Response,
  requestedActorId?: string
): Promise<{ identity: CallerIdentity; actorId: string } | null> {
  const identity = await resolveCallerIdentity(req);
  if (!identity) {
    res.status(401).json({ error: 'Unauthorized: valid bearer token required' });
    return null;
  }
  try {
    const actorId = enforceActorScope(identity, requestedActorId);
    return { identity, actorId };
  } catch (err) {
    if (err instanceof ActorImpersonationError) {
      res.status(403).json({ error: err.message });
      return null;
    }
    throw err;
  }
}
