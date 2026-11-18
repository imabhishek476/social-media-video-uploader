import type { Request } from 'express';
import { AuditLogModel } from '@shorts/database';

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  actor?: { id?: string; email?: string };
}

/** Record an admin action. Never throws — auditing must not break the request. */
export async function recordAudit(req: Request, entry: AuditEntry): Promise<void> {
  try {
    await AuditLogModel.create({
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? null,
      actorId: entry.actor?.id ?? req.user?.id ?? null,
      actorEmail: entry.actor?.email ?? req.user?.email ?? null,
      ip: req.ip ?? null,
      requestId: String(req.id ?? ''),
    });
  } catch (err) {
    req.log?.error({ err, action: entry.action }, 'Failed to write audit log');
  }
}
