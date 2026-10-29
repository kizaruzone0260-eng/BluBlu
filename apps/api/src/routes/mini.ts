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
import { eq } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { users } from '../db/schema.js';
import { env } from '../env.js';
import { errorBody } from '../lib/requestId.js';
import { miniSessionExpiresAt } from '../lib/telegramMiniAuth.js';
import { releaseUploadSlot, tryAcquireUploadSlot } from '../lib/uploadGate.js';
import type { BotApi } from '../services/botApi.js';
import { makeHomeworkAi } from '../services/homework/ai.js';
import {
  MINI_MAX_LINKS, MINI_MAX_LINK_LABEL, MINI_MAX_LINK_URL, MINI_MAX_TITLE,
  cancelMiniDraft, createMiniDraft, formatMiniDraft, getMiniDraft, listMiniMaterials,
  miniBootstrap, miniHistory, patchMiniDraft, previewMiniDraft, publishMiniDraft,
  retryMiniDraft, setMiniGroups, setMiniMaterials,
  type MiniSession,
} from '../services/homework/mini.js';
import { startMiniGroupConnect, miniConnectState, miniGroupsHealth } from '../services/homework/miniGroups.js';
import { uploadMiniMaterial } from '../services/homework/miniLibrary.js';
import type { HomeworkAi } from '../services/homework/types.js';
import { acceptLegal, legalStatus } from '../services/legal.js';
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
    miniLegal?: import('../services/legal.js').LegalStatus;
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
const WRITE_BUDGET = {
  draft: 20, format: 20, preview: 30, publish: 10, retry: 10,
  // Task G: uploads talk to Telegram and write to disk; a teacher never needs more than a few
  // per minute, and a loop must not fill the volume.
  upload: 10, connect: 10, legal: 10,
} as const;
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

  async function requireSession(
    req: FastifyRequest, reply: FastifyReply, opts: { allowUnaccepted?: boolean } = {},
  ): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.code(401).send(errorBody(req.id, 'sessionExpired'));
    }
    const resolved = await resolveMiniSession(db, header.slice(7));
    if (!resolved.ok) {
      return reply.code(resolved.status).send(errorBody(req.id, resolved.error));
    }
    req.miniSession = resolved.session;
    /*
     * Task G: the legal gate is enforced HERE, next to the session, not in the page. Every
     * functional route calls it; only bootstrap, the acceptance itself and the language choice
     * opt out. A direct URL therefore gets 403 `policyRequired` like any other request.
     */
    const legal = await legalStatus(db, resolved.session.userId);
    req.miniLegal = legal;
    if (!legal.accepted && !opts.allowUnaccepted) {
      return reply.code(403).send({
        ...errorBody(req.id, 'policyRequired'),
        legal: {
          privacyVersion: legal.privacyVersion,
          termsVersion: legal.termsVersion,
          currentPrivacyVersion: legal.currentPrivacyVersion,
          currentTermsVersion: legal.currentTermsVersion,
        },
      });
    }
  }
  const requireOpen = (req: FastifyRequest, reply: FastifyReply) =>
    requireSession(req, reply, { allowUnaccepted: true });
  // Fastify passes its own third argument to a preHandler; a two-parameter wrapper keeps the
  // options object out of that position.
  const preAuth = (req: FastifyRequest, reply: FastifyReply) => requireSession(req, reply);

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

  app.get('/api/mini/bootstrap', { preHandler: requireOpen }, async (req) => {
    return miniBootstrap(deps, session(req));
  });

  // ─── legal gate (Task G) ──────────────────────────────────────────────────

  // Both endpoints are reachable BEFORE acceptance — that is their whole purpose. They carry
  // no homework data and no write beyond the person's own consent/language row.
  app.post('/api/mini/accept-legal', { preHandler: requireOpen }, async (req, reply) => {
    if (!guardWrite(req, reply, 'legal')) return reply;
    const body = z.object({
      privacyVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      termsVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
    const result = await acceptLegal(db, session(req).userId, {
      privacyVersion: body.data.privacyVersion,
      termsVersion: body.data.termsVersion,
      locale: session(req).locale,
      context: 'mini',
    });
    if (result === 'stale') {
      return reply.code(409).send(errorBody(req.id, 'policyVersionStale'));
    }
    return { ok: true, legal: await legalStatus(db, session(req).userId) };
  });

  app.post('/api/mini/locale', { preHandler: requireOpen }, async (req, reply) => {
    const body = z.object({ locale: z.enum(['ru', 'uz', 'en']) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
    // A language choice is allowed before acceptance (the gate itself must be readable), and
    // it is recorded as an explicit choice, exactly like the web profile does.
    await db.update(users)
      .set({ locale: body.data.locale, localeExplicit: true })
      .where(eq(users.id, session(req).userId));
    return { ok: true, locale: body.data.locale };
  });

  app.get('/api/mini/history', { preHandler: preAuth }, async (req) => {
    return miniHistory(deps, session(req));
  });

  app.get('/api/mini/groups', { preHandler: preAuth }, async (req) => {
    const boot = await miniBootstrap(deps, session(req));
    return { groups: boot.groups, limits: boot.limits };
  });

  app.get('/api/mini/materials', { preHandler: preAuth }, async (req) => {
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

  // ─── library upload (Task G) ──────────────────────────────────────────────

  /*
   * One file per request, and only for a teacher who is in the middle of the library/wizard.
   * The bytes get the same concurrency gate as the web uploads: a Mini App loop must not hold
   * several 50 MB buffers at once. `requireSession` has already enforced the legal gate.
   */
  const uploadSlots = new WeakSet<FastifyRequest>();
  const uploadGate = {
    onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
      if (tryAcquireUploadSlot()) { uploadSlots.add(req); return undefined; }
      reply.header('retry-after', '5');
      return reply.code(429).send(errorBody(req.id, 'uploadBusy'));
    },
    onResponse: async (req: FastifyRequest) => {
      if (uploadSlots.delete(req)) releaseUploadSlot();
    },
    onRequestAbort: async (req: FastifyRequest) => {
      if (uploadSlots.delete(req)) releaseUploadSlot();
    },
  };

  app.post('/api/mini/materials/upload', {
    preHandler: preAuth, ...uploadGate,
  }, async (req, reply) => {
    if (!guardWrite(req, reply, 'upload')) return reply;
    let file: { bytes: Buffer; filename: string } | null = null;
    const fields: Record<string, string> = {};
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (file) {
            // A second file is not a library item; drain it and refuse the request.
            await part.toBuffer();
            return reply.code(400).send(errorBody(req.id, 'invalidInput'));
          }
          file = { bytes: await part.toBuffer(), filename: part.filename || 'file' };
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
    } catch (e) {
      if (/too.?large|FILE_TOO_LARGE/i.test(String((e as Error)?.message ?? e))) {
        return reply.code(413).send(errorBody(req.id, 'fileTooLarge'));
      }
      return reply.code(400).send(errorBody(req.id, 'invalidInput'));
    }
    if (!file) return reply.code(400).send(errorBody(req.id, 'invalidInput'));

    let groupIds: string[] = [];
    try {
      const raw = fields.groupIds ? JSON.parse(fields.groupIds) : [];
      groupIds = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return reply.code(400).send(errorBody(req.id, 'invalidInput'));
    }
    const draftId = fields.draftId && uuid.safeParse(fields.draftId).success ? fields.draftId : undefined;

    const result = await uploadMiniMaterial(deps, {
      ownerId: session(req).userId,
      title: fields.title,
      kind: fields.kind === 'book' || fields.kind === 'workbook' ? fields.kind : 'other',
      groupIds,
      draftId,
      filename: file.filename,
      bytes: file.bytes,
    });

    switch (result.status) {
      case 'ok': {
        const draft = result.draftId ? await getMiniDraft(deps, session(req), result.draftId) : null;
        return reply.code(201).send({
          material: {
            id: result.material.id, title: result.material.title, kind: result.material.kind,
            fileName: result.material.fileName, fileSize: result.material.fileSize,
            mediaType: result.material.mediaType,
          },
          draft,
          draftAttached: result.draftAttached,
          replaced: result.replaced,
        });
      }
      case 'unsupported': return reply.code(415).send(errorBody(req.id, 'unsupportedFile'));
      case 'tooLarge': return reply.code(413).send(errorBody(req.id, 'fileTooLarge'));
      case 'quota': return reply.code(507).send(errorBody(req.id, 'quotaExceeded'));
      case 'limit': return reply.code(400).send(errorBody(req.id, 'materialsLimit'));
      case 'noGroups': return reply.code(400).send(errorBody(req.id, 'groupsRequired'));
      case 'noPrivateChat': return reply.code(409).send(errorBody(req.id, 'telegramLinkRequired'));
      case 'telegramFailed': return reply.code(502).send(errorBody(req.id, 'telegramUploadFailed'));
      default: return reply.code(400).send(errorBody(req.id, 'invalidInput'));
    }
  });

  // ─── group connection (Task G) ────────────────────────────────────────────

  app.get('/api/mini/groups/health', { preHandler: preAuth }, async (req) => {
    return { groups: await miniGroupsHealth(deps, session(req).userId) };
  });

  app.post('/api/mini/groups/connect', { preHandler: preAuth }, async (req, reply) => {
    if (!guardWrite(req, reply, 'connect')) return reply;
    const result = await startMiniGroupConnect(deps, session(req).userId);
    if (result.status === 'limit') return reply.code(400).send(errorBody(req.id, 'groupsLimit'));
    return reply.code(201).send({ connect: result.connect });
  });

  app.get('/api/mini/groups/connect/:id', { preHandler: preAuth }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    const state = await miniConnectState(deps, session(req).userId, params.data.id);
    if (state.status === 'notFound') return reply.code(404).send(errorBody(req.id, 'notFound'));
    return state;
  });

  // ─── drafts ───────────────────────────────────────────────────────────────

  app.post('/api/mini/drafts', { preHandler: preAuth }, async (req, reply) => {
    if (!guardWrite(req, reply, 'draft')) return reply;
    const draft = await createMiniDraft(deps, session(req));
    return reply.code(201).send({ draft });
  });

  app.get('/api/mini/drafts/:id', { preHandler: preAuth }, async (req, reply) => {
    const parsed = z.object({ id: uuid }).safeParse(req.params);
    if (!parsed.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    const draft = await getMiniDraft(deps, session(req), parsed.data.id);
    if (!draft) return reply.code(404).send(errorBody(req.id, 'notFound'));
    return { draft };
  });

  app.patch('/api/mini/drafts/:id', { preHandler: preAuth }, async (req, reply) => {
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

  app.put('/api/mini/drafts/:id/groups', { preHandler: preAuth }, async (req, reply) => {
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

  app.get('/api/mini/drafts/:id/materials', { preHandler: preAuth }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    const query = z.object({ q: z.string().max(100).optional() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send(errorBody(req.id, 'invalidInput'));
    return listMiniMaterials(deps, session(req), {
      draftId: params.data.id,
      query: query.data.q,
    });
  });

  app.put('/api/mini/drafts/:id/materials', { preHandler: preAuth }, async (req, reply) => {
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
    preHandler: preAuth,
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

  app.post('/api/mini/drafts/:id/preview', { preHandler: preAuth }, async (req, reply) => {
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
    preHandler: preAuth,
  }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    if (!guardWrite(req, reply, 'publish')) return reply;
    const result = await publishMiniDraft(deps, session(req), params.data.id);
    return reply.send(result);
  });

  app.post('/api/mini/drafts/:id/retry', {
    preHandler: preAuth,
  }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    if (!guardWrite(req, reply, 'retry')) return reply;
    const result = await retryMiniDraft(deps, session(req), params.data.id);
    return reply.send(result);
  });

  app.post('/api/mini/drafts/:id/cancel', { preHandler: preAuth }, async (req, reply) => {
    const params = z.object({ id: uuid }).safeParse(req.params);
    if (!params.success) return reply.code(404).send(errorBody(req.id, 'notFound'));
    const ok = await cancelMiniDraft(deps, session(req), params.data.id);
    if (!ok) return reply.code(409).send(errorBody(req.id, 'draftLocked'));
    return { ok: true };
  });
}
