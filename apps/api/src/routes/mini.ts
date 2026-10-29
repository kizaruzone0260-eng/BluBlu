/**
 * Mini App HTTP surface (`/api/mini`).
 *
 * Public door: `POST /api/mini/auth` accepts the raw Telegram `initData`, verifies it and
 * returns a limited session token. Every other route requires `Authorization: Bearer …` with
 * that token; the session is re-checked against the live `telegram_links` row, so unlinking
 * revokes it immediately. No cookie is used, so the regular web session and CSRF model are
 * untouched, and nothing here can be reached by a browser tab outside Telegram.
 *
 * The route layer only validates shapes and maps service outcomes. Ownership, group rights,
 * material eligibility, AI fidelity and publication safety live in `services/homework/mini.ts`
 * and the existing homework engine.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { env } from '../env.js';
import { errorBody } from '../lib/requestId.js';
import { miniSessionExpiresAt } from '../lib/telegramMiniAuth.js';
import type { BotApi } from '../services/botApi.js';
import { makeHomeworkAi } from '../services/homework/ai.js';
import {
  MINI_MAX_LINKS, MINI_MAX_LINK_LABEL, MINI_MAX_LINK_URL, MINI_MAX_TITLE,
  cancelMiniDraft, createMiniDraft, formatMiniDraft, getMiniDraft, listMiniMaterials,
  miniBootstrap, miniHistory, patchMiniDraft, previewMiniDraft, publishMiniDraft,
  retryMiniDraft, setMiniGroups, setMiniMaterials,
  type MiniSession,
} from '../services/homework/mini.js';
import type { HomeworkAi } from '../services/homework/types.js';
import { exchangeInitData, resolveMiniSession } from '../services/miniAuth.js';
import { createBot } from '../services/telegramBot.js';
import { getBotApi } from './telegram.js';

export interface MiniRouteOptions {
  db: DB;
  /** Test seams. Production uses the shared bot API and env-configured formatter. */
  api?: BotApi;
  ai?: HomeworkAi;
  aiRemote?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    miniSession?: MiniSession;
  }
}

const uuid = z.string().regex(/^[0-9a-f-]{36}$/i);

/**
 * Per-teacher budget for the write path (Task F, 2026-10-28).
 *
 * `app.ts` has one rate limiter for the whole API, and its `onRoute` hook deliberately replaces
 * every per-route `config.rateLimit` with the shared 300/min/IP flood ceiling. That is right for
 * reads and wrong for "publish": a teacher tapping the button in a loop (or a stuck client
 * retrying) must be stopped per PERSON, not per address, because a whole school can share one
 * address. The counter is process memory — the app runs as a single instance (see lib/throttle.ts
 * for the same reasoning) — and a window is one minute, so a real lesson's several homeworks are
 * never refused. Publish and retry are the two actions that talk to Telegram, hence the tightest
 * ceilings.
 */
const WRITE_BUDGET = { draft: 20, format: 20, preview: 30, publish: 10, retry: 10 } as const;
const writeWindows = new Map<string, { start: number; count: number }>();

function allowWrite(userId: string, action: keyof typeof WRITE_BUDGET, now = Date.now()): boolean {
  const key = `${action}:${userId}`;
  const w = writeWindows.get(key);
  if (!w || now - w.start >= 60_000) {
    if (writeWindows.size > 5_000) {
      for (const [k, v] of writeWindows) if (now - v.start >= 60_000) writeWindows.delete(k);
    }
    writeWindows.set(key, { start: now, count: 1 });
    return true;
  }
  if (w.count >= WRITE_BUDGET[action]) return false;
  w.count += 1;
  return true;
}

export async function miniRoutes(app: FastifyInstance, opts: MiniRouteOptions): Promise<void> {
  const { db } = opts;
  const aiRemote = opts.aiRemote
    ?? (env.AI_PROVIDER === 'openai-compatible' && Boolean(env.AI_API_KEY && env.AI_MODEL));
  const deps = {
    db,
    api: opts.api ?? getBotApi(db, createBot()),
    ai: opts.ai ?? makeHomeworkAi(),
    aiRemote,
  };

  app.decorateRequest('miniSession', undefined);

  async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.code(401).send(errorBody(req.id, 'sessionExpired'));
    }
    const resolved = await resolveMiniSession(db, header.slice(7));
    if (!resolved.ok) {
      return reply.code(resolved.status).send(errorBody(req.id, resolved.error));
    }
    req.miniSession = resolved.session;
  }

  function session(req: FastifyRequest): MiniSession {
    return req.miniSession!;
  }

  /** false — the reply already carries 429; the handler must return immediately. */
  function guardWrite(
    req: FastifyRequest, reply: FastifyReply, action: keyof typeof WRITE_BUDGET,
  ): boolean {
    if (!allowWrite(session(req).userId, action)) {
      reply.code(429).header('retry-after', '60').send(errorBody(req.id, 'tooManyRequests'));
      return false;
    }
    return true;
  }

  // ─── public: launch exchange ──────────────────────────────────────────────

  // The per-IP ceiling for this door is the shared public-entrance window in `app.ts` (the same
  // one registration and guest entry use); a route-level `config.rateLimit` here would be
  // overwritten by that hook, so no dead setting is kept. The raw initData is never logged.
  app.post('/api/mini/auth', async (req, reply) => {
    const parsed = z.object({ initData: z.string().min(1).max(8_192) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
    const result = await exchangeInitData(db, parsed.data.initData);
    if (!result.ok) return reply.code(result.status).send(errorBody(req.id, result.error));
    return reply.send({
      token: result.token,
      expiresAt: miniSessionExpiresAt(),
      teacher: result.teacher,
      bot: { username: env.TELEGRAM_BOT_NAME || null },
    });
  });

  // ─── teacher home ─────────────────────────────────────────────────────────

  app.get('/api/mini/bootstrap', { preHandler: requireSession }, async (req) => {
    return miniBootstrap(deps, session(req));
  });

  app.get('/api/mini/history', { preHandler: requireSession }, async (req) => {
    return miniHistory(deps, session(req));
  });

  app.get('/api/mini/groups', { preHandler: requireSession }, async (req) => {
    const boot = await miniBootstrap(deps, session(req));
    return { groups: boot.groups, limits: boot.limits };
  });

  app.get('/api/mini/materials', { preHandler: requireSession }, async (req) => {
    const parsed = z.object({
      q: z.string().max(100).optional(),
      draftId: uuid.optional(),
    }).safeParse(req.query);
    if (!parsed.success) return { materials: [], reason: 'notFound' as const };
    return listMiniMaterials(deps, session(req), {
      query: parsed.data.q,
      draftId: parsed.data.draftId,
    });
  });

  // ─── drafts ───────────────────────────────────────────────────────────────

  app.post('/api/mini/drafts', { preHandler: requireSession }, async (req, reply) => {
    if (!guardWrite(req, reply, 'draft')) return reply;
    const draft = await createMiniDraft(deps, session(req));
    return reply.code(201).send({ draft });
  });

  app.get('/api/mini/drafts/:id', { preHandler: requireSession }, async (req, reply) => {
    const parsed = z.object({ id: uuid }).safeParse(req.params);
    if (!parsed.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    const draft = await getMiniDraft(deps, session(req), parsed.data.id);
    if (!draft) return reply.code(404).send(errorBody(req.id, 'notFound'));
    return { draft };
  });

  app.patch('/api/mini/drafts/:id', { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    const body = z.object({
      title: z.string().max(MINI_MAX_TITLE).optional(),
      instruction: z.string().max(2_000).optional(),
      dueAt: z.string().max(40).nullable().optional(),
      formattedText: z.string().max(6_000).optional(),
      links: z.array(z.object({
        url: z.string().max(MINI_MAX_LINK_URL),
        label: z.string().max(MINI_MAX_LINK_LABEL).optional(),
      })).max(MINI_MAX_LINKS).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));

    const result = await patchMiniDraft(deps, session(req), params.data.id, body.data);
    switch (result.status) {
      case 'ok': return { draft: result.draft };
      case 'locked': return reply.code(409).send(errorBody(req.id, 'draftLocked'));
      case 'tooManyLinks': return reply.code(400).send(errorBody(req.id, 'tooManyLinks'));
      default: return reply.code(400).send(errorBody(req.id, 'invalidInput'));
    }
  });

  app.put('/api/mini/drafts/:id/groups', { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    const body = z.object({ groupIds: z.array(uuid).max(20) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
    const result = await setMiniGroups(deps, session(req), params.data.id, body.data.groupIds);
    switch (result.status) {
      case 'ok':
        return { draft: result.draft, droppedMaterials: result.droppedMaterials };
      case 'locked': return reply.code(409).send(errorBody(req.id, 'draftLocked'));
      case 'tooMany': return reply.code(400).send(errorBody(req.id, 'tooManyGroups'));
      default: return reply.code(403).send(errorBody(req.id, 'groupNotAllowed'));
    }
  });

  app.get('/api/mini/drafts/:id/materials', { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    const query = z.object({ q: z.string().max(100).optional() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
    return listMiniMaterials(deps, session(req), {
      draftId: params.data.id,
      query: query.data.q,
    });
  });

  app.put('/api/mini/drafts/:id/materials', { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    const body = z.object({ materialIds: z.array(uuid).max(8) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
    const result = await setMiniMaterials(deps, session(req), params.data.id, body.data.materialIds);
    switch (result.status) {
      case 'ok': return { draft: result.draft };
      case 'locked': return reply.code(409).send(errorBody(req.id, 'draftLocked'));
      case 'noGroups': return reply.code(400).send(errorBody(req.id, 'groupsRequired'));
      case 'limit': return reply.code(400).send(errorBody(req.id, 'tooManyMaterials'));
      default: return reply.code(403).send(errorBody(req.id, 'materialNotAllowed'));
    }
  });

  app.post('/api/mini/drafts/:id/format', {
    preHandler: requireSession,
  }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    if (!guardWrite(req, reply, 'format')) return reply;
    const body = z.object({ mode: z.enum(['ai', 'manual']) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
    const result = await formatMiniDraft(deps, session(req), params.data.id, body.data.mode);
    switch (result.status) {
      case 'ok':
        return {
          draft: result.draft, warnings: result.warnings, questions: result.questions,
          provider: result.provider, usedAi: result.usedAi,
        };
      case 'aiUnavailable':
        return reply.code(409).send(errorBody(req.id, 'aiUnavailable'));
      case 'aiError':
        return reply.code(502).send({ ...errorBody(req.id, 'aiUnavailable'), fallback: result.fallback });
      case 'locked': return reply.code(409).send(errorBody(req.id, 'draftLocked'));
      default: return reply.code(404).send(errorBody(req.id, 'notFound'));
    }
  });

  app.post('/api/mini/drafts/:id/preview', { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    if (!guardWrite(req, reply, 'preview')) return reply;
    const result = await previewMiniDraft(deps, session(req), params.data.id);
    switch (result.status) {
      case 'ok': return { draft: result.draft };
      case 'noGroups': return reply.code(400).send(errorBody(req.id, 'groupsRequired'));
      case 'emptyHomework': return reply.code(400).send(errorBody(req.id, 'emptyHomework'));
      case 'locked': return reply.code(409).send(errorBody(req.id, 'draftLocked'));
      default: return reply.code(404).send(errorBody(req.id, 'notFound'));
    }
  });

  app.post('/api/mini/drafts/:id/publish', {
    preHandler: requireSession,
  }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    if (!guardWrite(req, reply, 'publish')) return reply;
    const result = await publishMiniDraft(deps, session(req), params.data.id);
    return reply.send(result);
  });

  app.post('/api/mini/drafts/:id/retry', {
    preHandler: requireSession,
  }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    if (!guardWrite(req, reply, 'retry')) return reply;
    const result = await retryMiniDraft(deps, session(req), params.data.id);
    return reply.send(result);
  });

  app.post('/api/mini/drafts/:id/cancel', { preHandler: requireSession }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    const ok = await cancelMiniDraft(deps, session(req), params.data.id);
    if (!ok) return reply.code(409).send(errorBody(req.id, 'draftLocked'));
    return { ok: true };
  });
}
