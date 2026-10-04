import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { resolveClass } from '../services/classes.js';
import { createEvent, listEventsInRange, editEvent, deleteEventOccurrence, rotateIcsToken, userByIcsToken, buildIcs } from '../services/events.js';
import { events } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { enqueueNotification } from '../services/notify.js';
import { APP_NAME } from '@klass/shared';
import { classTitle } from '../services/notifyQueue.js';

const eventInputSchema = z.object({
  kind: z.enum(['lesson', 'deadline', 'other']),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(''),
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/, 'badLocalTime'),
  durationMin: z.number().int().min(1).max(480),
  tz: z.string().min(1).max(64),
  repeat: z.object({
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).nullable().optional(),
});

const scopeSchema = z.object({
  scope: z.enum(['all', 'this', 'following']),
  occurrenceStart: z.string().datetime({ offset: true }).or(z.string()).optional(),
});

export async function eventRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;

  app.post('/api/classes/:id/events', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const classId = (req.params as { id: string }).id;
    const cls = await resolveClass(db, req.user!.id, 'teacher', classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const p = eventInputSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalidInput' });
    const e = await createEvent(db, cls.id, p.data);
    void (async () => {
      const name = await classTitle(db, cls.id);
      await enqueueNotification(db, {
        kind: 'eventNew', classId: cls.id, when: e.startsAt,
        params: { title: e.title, class: name, when: e.startsAt.toISOString() },
        dedupeBase: `evt:${e.id}:new`, excludeUserId: req.user!.id,
      });
    })().catch(() => undefined);
    return reply.code(201).send(e);
  });

  app.get('/api/events', { preHandler: app.authenticate }, async (req) => {
    const q = req.query as { from?: string; to?: string; classId?: string };
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 60 * 86400_000);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 180 * 86400_000);
    return listEventsInRange(db, req.user!.id, req.user!.role, from, to, q.classId);
  });

  app.patch('/api/events/:id', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [e] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!e) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', e.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const body = (req.body ?? {}) as { changes?: unknown } & z.infer<typeof scopeSchema>;
    const sc = scopeSchema.safeParse(body);
    const ch = eventInputSchema.safeParse(body.changes);
    if (!sc.success || !ch.success) return reply.code(400).send({ error: 'invalidInput' });
    const r = await editEvent(db, id, sc.data, ch.data);
    if (!r.ok) return reply.code(404).send({ error: 'notFound' });
    void (async () => {
      const name = await classTitle(db, e.classId);
      await enqueueNotification(db, {
        kind: 'eventChanged', classId: e.classId, when: new Date(),
        params: { title: ch.data.title, class: name, when: ch.data.startLocal },
        dedupeBase: `evt:${id}:ch:${new Date().toISOString()}`, excludeUserId: req.user!.id,
      });
    })().catch(() => undefined);
    return { ok: true };
  });

  app.delete('/api/events/:id', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [e] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!e) return reply.code(404).send({ error: 'notFound' });
    const cls = await resolveClass(db, req.user!.id, 'teacher', e.classId);
    if (!cls) return reply.code(404).send({ error: 'notFound' });
    const q = (req.query ?? {}) as { scope?: string; occurrenceStart?: string };
    const scope = (q.scope === 'this' || q.scope === 'following' ? q.scope : 'all') as 'all' | 'this' | 'following';
    const r = await deleteEventOccurrence(db, id, { scope, occurrenceStart: q.occurrenceStart });
    if (!r.ok) return reply.code(404).send({ error: 'notFound' });
    if (scope === 'all') {
      void (async () => {
        const name = await classTitle(db, e.classId);
        await enqueueNotification(db, {
          kind: 'eventCancelled', classId: e.classId, when: new Date(),
          params: { title: e.title, class: name, when: '' },
          dedupeBase: `evt:${id}:cancelled`, excludeUserId: req.user!.id,
        });
      })().catch(() => undefined);
    }
    return { ok: true };
  });

  // Personal ICS subscription (§3.5): secret token in URL, read-only.
  app.post('/api/me/ical-token', { preHandler: app.authenticate }, async (req) => {
    const token = await rotateIcsToken(db, req.user!.id);
    return { token };
  });

  app.get('/api/ical/:token', async (req, reply) => {
    const token = (req.params as { token: string }).token;
    if (!token || token.length > 64) return reply.code(404).send({ error: 'notFound' });
    const userId = await userByIcsToken(db, token);
    if (!userId) return reply.code(404).send({ error: 'notFound' });
    // role unknown from token alone: union of teacher/student views
    const now = new Date();
    const horizon = new Date(now.getTime() + 400 * 86400_000);
    const asTeacher = await listEventsInRange(db, userId, 'teacher', now, horizon);
    const asStudent = await listEventsInRange(db, userId, 'student', now, horizon);
    const seen = new Set<string>();
    const all = [...asTeacher, ...asStudent].filter((o) => !seen.has(o.uid) && !!seen.add(o.uid));
    reply.header('content-type', 'text/calendar; charset=utf-8');
    reply.header('content-disposition', 'inline; filename="klass.ics"');
    return buildIcs(all, APP_NAME);
  });
}
