import { auditLog } from '../db/schema.js';
import type { DB } from '../db/index.js';

/** §6 audit_log: append-only trail of privileged actions. Never throws. */
export function audit(db: DB, actorId: string | null, action: string, target: Record<string, unknown>): void {
  void db.insert(auditLog).values({ actorId, action, target }).catch(() => undefined);
}
