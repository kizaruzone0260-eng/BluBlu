import { z } from 'zod';
import { DEFAULT_TIMEZONE, INVITE_MAX_TTL_DAYS, INVITE_MIN_TTL_DAYS, SUPPORTED_LOCALES } from './constants.js';

const email = z.string().trim().toLowerCase().email().max(254);
const name = z.string().trim().min(2).max(100);
const password = z
  .string()
  .min(8, 'passwordTooShort')
  .max(128)
  .regex(/(?=.*[a-zА-Яа-я])(?=[^ ]+$)/, 'passwordTooSimple');

export const registerByCodeSchema = z.object({
  name,
  email,
  password,
  code: z.string().trim().toUpperCase(),
});

export const loginSchema = z.object({ email, password });

export const joinByCodeSchema = z.object({
  code: z.string().trim().toUpperCase(),
});

export const classCreateSchema = z.object({
  name: name.max(120),
  description: z.string().trim().max(2000).optional().default(''),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'invalidColor')
    .optional()
    .default('#4f46e5'),
});

export const classUpdateSchema = classCreateSchema.partial();

export const inviteCreateSchema = z.object({
  ttlDays: z
    .number()
    .int()
    .min(INVITE_MIN_TTL_DAYS)
    .max(INVITE_MAX_TTL_DAYS)
    .optional()
    .default(7),
});

export const profileUpdateSchema = z.object({
  name,
  locale: z.enum(['ru', 'uz', 'en']),
  tz: z.string().min(1).max(64).default(DEFAULT_TIMEZONE),
});

export const memberAddSchema = z.object({ userId: z.string().uuid() });
export const memberMoveSchema = z.object({ toClassId: z.string().uuid() });

export type RegisterByCodeInput = z.infer<typeof registerByCodeSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type JoinByCodeInput = z.infer<typeof joinByCodeSchema>;
export type ClassCreateInput = z.infer<typeof classCreateSchema>;
export type ClassUpdateInput = z.infer<typeof classUpdateSchema>;
export type InviteCreateInput = z.infer<typeof inviteCreateSchema>;
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;
