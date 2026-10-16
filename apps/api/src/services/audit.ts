import { auditLog } from '../db/schema.js';
import type { DB } from '../db/index.js';

/** §6 audit_log: append-only trail of privileged actions. Never throws. */
export function audit(db: DB, actorId: string | null, action: string, target: Record<string, unknown>): void {
  void db.insert(auditLog).values({ actorId, action, target }).catch(() => undefined);
}

/**
 * B4 (2026-10-16): та же запись, но дождавшаяся вставки. Нужна ровно одному месту —
 * удалению аккаунта: `eraseAccount` обезличивает журнал (гасит `actor_id` и вырезает
 * `userId` из цели), и если запись об удалении успевает влететь ПОСЛЕ этого, строка
 * навсегда оставляет идентификатор уже стёртого человека. Fire-and-forget `audit()` тут
 * не годится: вставка идёт отдельным промисом и порядок не гарантирован.
 * Ошибка записи не должна останавливать стирание — она проглатывается, как и везде.
 */
export async function auditAndWait(db: DB, actorId: string | null, action: string, target: Record<string, unknown>): Promise<void> {
  try {
    await db.insert(auditLog).values({ actorId, action, target });
  } catch {
    // журнал не важнее права на забвение, и бросать наружу `audit` никогда не умел
  }
}
