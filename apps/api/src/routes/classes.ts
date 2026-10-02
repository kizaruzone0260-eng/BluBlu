import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  classCreateSchema, classUpdateSchema, joinByCodeSchema, memberAddSchema, memberMoveSchema,
} from '@klass/shared';
import type { DB } from '../db/index.js';
import {
  resolveClass, listMyClasses, createClass, updateClass, archiveClass,
  listMembers, removeMember, addStudentDirectly, moveMember,
} from '../services/classes.js';
import { registerInviteRoutes } from './invites.js';
import { redeemInviteCode } from '../services/invites.js';
import { normalizeInviteCode } from '../lib/invite.js';
import { throttleCheck, throttleRecordAttempt, throttleReset } from '../lib/throttle.js';
import { classMembers } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { audit } from '../services/audit.js';
import { setTempPassword } from '../services/auth.js';
import { randomBytes } from 'node:crypto';

const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function tempPassword(len = 10): string {
  const b = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += TEMP_ALPHABET[b[i] as number % TEMP_ALPHABET.length];
  return s;
}

const uuidParam = z.object({ id: z.string().uuid(), userId: z.string().uuid().optional(), inviteId: z.string().uuid().optional() });

/** §7: unknown or foreign class → 404, never 403, to avoid leaking existence. */
async function needClass(db: DB, req: { user: { id: string; role: 'teacher' | 'student' } | null }, reply: FastifyReply, classId: string) {
  if (!req.user) { await reply.code(401).send({ error: 'unauthorized' }); return null; }
  const cls = await resolveClass(db, req.user.id, req.user.role, classId);
  if (!cls) { await reply.code(404).send({ error: 'notFound' }); return null; }
  return cls;
}

export async function classRoutes(app: FastifyInstance, opts: { db: DB }) {
  const { db } = opts;

  app.post('/api/classes', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const parsed = classCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
    const c = await createClass(db, req.user!.id, parsed.data);
    audit(db, req.user!.id, 'class_create', { classId: c!.id });
    return reply.code(201).send(c);
  });

  app.get('/api/classes', { preHandler: app.authenticate }, async (req) => {
    const includeArchived = (req.query as { archived?: string }).archived === '1';
    return listMyClasses(db, req.user!.id, req.user!.role, includeArchived);
  });

  app.patch('/api/classes/:id', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const parsed = classUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
    const cls = await needClass(db, req, reply, p.data.id);
    if (!cls) return;
    return updateClass(db, cls.id, parsed.data);
  });

  app.post('/api/classes/:id/archive', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success || !p.data.id) return reply.code(404).send({ error: 'notFound' });
    const cls = await needClass(db, req, reply, p.data.id);
    if (!cls) return;
    await archiveClass(db, cls.id);
    audit(db, req.user!.id, 'class_archive', { classId: cls.id });
    return { ok: true };
  });

  // Students: join an additional class with a fresh code (already logged in)
  app.post('/api/join-by-code', { preHandler: app.authenticate }, async (req, reply) => {
    if (req.user!.role !== 'student') return reply.code(403).send({ error: 'forbidden' });
    const parsed = joinByCodeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
    const key = `code:${req.user!.id}:${req.ip}`;
    const gate = throttleCheck(key);
    if (!gate.allowed) {
      return reply.code(429).header('retry-after', String(gate.retryAfterSec)).send({ error: 'codeRateLimited' });
    }
    throttleRecordAttempt(key);
    const code = normalizeInviteCode(parsed.data.code);
    const redeem = await redeemInviteCode(db, code, req.user!.id);
    if (!redeem.ok || !redeem.classId) {
      return reply.code(400).send({ error: 'invalidCode' });
    }
    throttleReset(key);
    await db.insert(classMembers)
      .values({ classId: redeem.classId, userId: req.user!.id })
      .onConflictDoNothing();
    return { classId: redeem.classId };
  });

  // Members management (teacher of the class)
  app.get('/api/classes/:id/members', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const cls = await needClass(db, req, reply, p.data.id);
    if (!cls) return;
    return listMembers(db, cls.id);
  });

  app.post('/api/classes/:id/members', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const parsed = memberAddSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
    const cls = await needClass(db, req, reply, p.data.id);
    if (!cls) return;
    const ok = await addStudentDirectly(db, cls.id, parsed.data.userId);
    if (!ok) return reply.code(400).send({ error: 'invalidInput' });
    return { ok: true };
  });

  app.delete('/api/classes/:id/members/:userId', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success || !p.data.userId) return reply.code(404).send({ error: 'notFound' });
    const cls = await needClass(db, req, reply, p.data.id);
    if (!cls) return;
    await removeMember(db, cls.id, p.data.userId);
    audit(db, req.user!.id, 'member_remove', { classId: cls.id, userId: p.data.userId });
    return { ok: true };
  });

  app.post('/api/classes/:id/members/:userId/move', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success || !p.data.userId) return reply.code(404).send({ error: 'notFound' });
    const parsed = memberMoveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalidInput' });
    const cls = await needClass(db, req, reply, p.data.id);
    if (!cls) return;
    const ok = await moveMember(db, req.user!.id, cls.id, parsed.data.toClassId, p.data.userId);
    if (!ok) return reply.code(400).send({ error: 'invalidInput' });
    return { ok: true };
  });

  // §3.1 password reset by teacher: generates a temporary password (no email server)
  app.post('/api/classes/:id/members/:userId/reset-password', { preHandler: app.authenticateTeacher }, async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success || !p.data.userId) return reply.code(404).send({ error: 'notFound' });
    const cls = await needClass(db, req, reply, p.data.id);
    if (!cls) return;
    const [member] = await db.select({ id: classMembers.userId }).from(classMembers)
      .where(and(eq(classMembers.classId, cls.id), eq(classMembers.userId, p.data.userId))).limit(1);
    if (!member) return reply.code(404).send({ error: 'notFound' });
    const pw = tempPassword();
    await setTempPassword(db, p.data.userId, pw);
    audit(db, req.user!.id, 'reset_password', { classId: cls.id, userId: p.data.userId });
    return { tempPassword: pw };
  });

  // Students can leave a class themselves
  app.post('/api/classes/:id/leave', { preHandler: app.authenticate }, async (req, reply) => {
    if (req.user!.role !== 'student') return reply.code(403).send({ error: 'forbidden' });
    const p = uuidParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: 'notFound' });
    const cls = await needClass(db, req, reply, p.data.id);
    if (!cls) return;
    await removeMember(db, cls.id, req.user!.id);
    return { ok: true };
  });

  await app.register(registerInviteRoutes(db));
}
