import { z } from 'zod';
import { DEFAULT_TIMEZONE, SUPPORTED_LOCALES } from './constants.js';
import { INVITE_LABEL_MAX, INVITE_LINK_DEFAULT_TTL_DAYS, INVITE_LINK_TTL_DAYS, isInviteToken } from './inviteLinks.js';

const email = z.string().trim().toLowerCase().email().max(254);
const name = z.string().trim().min(2).max(100);

/**
 * Hardening (Phase 1д): common/breached passwords rejected at SET time. This is
 * a curated denylist of the most frequent weak passwords (case-insensitive),
 * NOT a full breach corpus — it stops the trivial "password"/"123456" class of
 * choices. Extended over time; deliberately excludes legitimate test phrases.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'passworde',
  'qwerty', 'qwerty123', 'qwertyuiop', '123456', '1234567', '12345678', '123456789', '1234567890',
  'abc123', 'abcd1234', 'iloveyou', 'letmein', 'welcome', 'welcome1', 'admin', 'administrator',
  'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'login', 'password',
  'secret', 'secret123', 'trustno1', 'master', 'hello', 'freedom', 'whatever', 'qazwsx',
  '111111', '000000', '121212', '654321', '666666', '888888', 'asdasd', 'azerty', 'zuza',
]);

/**
 * Password POLICY — applied when a password is CREATED (registration).
 *
 * 2026-10-28 (аудит SEC-12): прежнее правило требовало ровно одной строчной буквы и запрещало
 * пробелы — «aaaaaaaaaaaa» или «1234567890ab» проходили, хотя оба набираются с одной руки и
 * живут в первых строках любого словаря подбора. Теперь нужны **два вида символов из четырёх**:
 * строчные, заглавные, цифры, знаки. Два, а не четыре, — сознательный компромисс: четыре вида
 * на телефоне при диктовке ученику дают больше сбросов пароля, чем добавляют стойкости, а два
 * вида уже отсекают одноалфавитные строки, которые и были настоящей проблемой.
 *
 * Классы считаются по Unicode-свойствам, а не по ASCII: кириллица, латиница и, например, арабский
 * попадают в «строчные/заглавные» одинаково, и пароль на родном языке ученика не отвергается
 * из-за того, что буква не английская. «Знак» — всё, что не буква и не цифра (пунктуация,
 * спецсимволы); пробелы запрещены отдельно, чтобы «два вида» нельзя было набрать пробелом.
 *
 * Список ходовых паролей проверяется последним и не ослаблен: «Pupil2026!» проходит форму, но
 * точное совпадение с ходовым значением по-прежнему отклоняется.
 */
const PASSWORD_CLASSES: readonly RegExp[] = [
  /\p{Ll}/u, // строчные буквы
  /\p{Lu}/u, // заглавные буквы
  /\p{Nd}/u, // десятичные цифры
  /[^\p{L}\p{Nd}]/u, // знаки: всё, что не буква и не цифра
];

export function passwordClassCount(value: string): number {
  return PASSWORD_CLASSES.reduce((n, re) => n + (re.test(value) ? 1 : 0), 0);
}

export const passwordPolicy = z
  .string()
  .min(10, 'passwordTooShort')
  .max(128)
  .refine((v) => !/\s/u.test(v), 'passwordTooSimple')
  .refine((v) => passwordClassCount(v) >= 2, 'passwordTooSimple')
  .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), 'passwordTooCommon');

/** Login only checks the SHA against the stored hash — never re-applies the
 * policy, so accounts created under the earlier 8-char rule can still sign in. */
const loginPassword = z.string().min(1).max(128);

/**
 * Аккаунт ученика, который создаёт учитель (2026-10-27, задача «упростить приём в класс»).
 *
 * Поля и политика — ровно те же, что у саморегистрации по приглашению (`inviteRegisterSchema` за
 * вычетом токена): пароль здесь набирает человек и передаёт его ученику, поэтому он обязан пройти
 * ту же `passwordPolicy`, что и при самостоятельной регистрации, — «12345678» не проходит и тут.
 * Ослаблять политику ради «временного» пароля нельзя: временный пароль и есть самый удобный канал
 * подобрать лёгкий.
 *
 * Чего в схеме сознательно нет:
 *  • `classId` — класс берётся из пути (`/api/classes/:id/students`) и полномочия на него проверяет
 *    маршрут; тело не может выбрать чужой класс;
 *  • `emailCode` — подтверждение почты подтверждает адрес того, кто регистрируется сам. Адрес
 *    здесь называет учитель по памяти, и письмо на него ничего не подтверждает;
 *  • `locale` — язык ещё никто не выбирал. Аккаунт получает продуктовый default, а ученик сам укажет
 *    свой в профиле; `localeExplicit` при вставке остаётся false (тот же контракт, что у
 *    регистрации без выбора языка).
 *
 * `mustChangePassword` поднимает СЕРВИС, а не схема: флаг — свойство созданного аккаунта, и
 * решение «после первого входа пароль обязаны сменить» не должно зависеть от тела запроса.
 */
export const studentCreateSchema = z.object({
  firstName: z.string().trim().min(2, 'name2').max(80),
  lastName: z.string().trim().min(2, 'name2').max(80),
  email,
  password: passwordPolicy,
});

/**
 * Часть F: запрос кода на подтверждение почты. Имя и фамилия здесь не для аккаунта (его ещё нет),
 * а для самого письма — человек должен получить «Здравствуйте, Алия», а не безликую машинную
 * строку. Поля те же и с той же length-политикой, что у регистрации, чтобы письмо и аккаунт не
 * разошлись в написании имени.
 */
export const emailCodeRequestSchema = z.object({
  firstName: z.string().trim().min(2, 'name2').max(80),
  lastName: z.string().trim().min(2, 'name2').max(80),
  email,
  locale: z.enum(SUPPORTED_LOCALES).optional(),
});

export const loginSchema = z.object({ email, password: loginPassword });

/*
 * 2026-10-27 — приём в класс по восьмизначному коду класса выведен из продукта, вместе с ним
 * ушли `checkCodeSchema` («проверить код, не расходуя»), `joinByCodeSchema` (вход в класс по коду)
 * и `inviteCreateSchema` (выпуск кода учителем). Коды больше не создаются, не проверяются и не
 * расходятся: остаются только одноразовые ссылки-приглашения ниже и аккаунты, которые создаёт
 * учитель.
 */

export const classCreateSchema = z.object({
  name: name.max(120),
  description: z.string().trim().max(2000).optional().default(''),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'invalidColor')
    .optional()
    .default('#4f46e5'),
  // bot task §3: publish this class schedule to the Telegram bot by name
  botPublicSchedule: z.boolean().optional().default(false),
  // часть 4: показывать ученикам архив досок этого класса (по умолчанию — нет)
  boardArchivePublic: z.boolean().optional().default(false),
});

/**
 * Обновление класса — СВОЯ схема, а не `classCreateSchema.partial()` (2026-10-27, миграция на
 * Zod 4).
 *
 * Причина не вкусовая, а ровно одна и она из этой миграции. В Zod 4 `.partial()` оставляет
 * `default()` внутри поля, тогда как в Zod 3 поле становилось опциональным ДО срабатывания
 * дефолта. Проверено на живом 4.6.7:
 *   classCreateSchema.partial().parse({ name: 'X' }) →
 *   { name: 'X', description: '', color: '#4f46e5', botPublicSchedule: false, boardArchivePublic: false }
 * Для PATCH это не «не заполнено», а «учитель просил очистить описание, вернуть цвет по
 * умолчанию и выключить оба переключателя»: одно переименование класса стирало бы его оформление
 * и настройки приватности. Поэтому здесь те же поля и та же length-политика, что у создания, но
 * БЕЗ значений по умолчанию: отсутствие ключа в PATCH значит «не трогать», а «что подставить»
 * решает вызывающий, а не транспорт. Держится это тестом
 * `apps/api/test/unit/class-update-partial.test.ts`, а не памятью о поведении третьей версии.
 */
export const classUpdateSchema = z.object({
  name: name.max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'invalidColor')
    .optional(),
  botPublicSchedule: z.boolean().optional(),
  boardArchivePublic: z.boolean().optional(),
});

export const profileUpdateSchema = z.object({
  name,
  /** item 9 — family name; optional so pre-existing accounts (empty) keep working */
  lastName: z.string().trim().max(80).optional(),
  /**
   * Language (task 1). Optional on purpose: a profile PATCH is also how the app stores the
   * device timezone and the name screen's family name, and those requests used to re-send the
   * locale from a snapshot taken before a concurrent write. Whichever PATCH landed last then
   * looked like "the person changed the language" — run 37974043289 turned the automatic timezone
   * sync into a forged English choice. Absent means "do not touch the language", present means
   * "this is a choice" (see routes/auth.ts, which still flags `locale_explicit` only on a change).
   */
  locale: z.enum(['ru', 'uz', 'en']).optional(),
  tz: z.string().min(1).max(64).default(DEFAULT_TIMEZONE),
});

/**
 * Добавление ученика учителем (2026-10-26). Два способа, ровно один на запрос:
 *  • `userId` — прежний прямой путь (uuid уже известен);
 *  • `email` — путь для «ученик забыл пароль, а в списке его нет»: почта нормализуется так же,
 *    как при входе и регистрации, чтобы `Ann@X.io ` и `ann@x.io` были одним адресом.
 * Оба поля одновременно — ошибка формы, а не «сработало первое»: иначе клиент не знает,
 * кого именно добавил.
 */
export const memberAddSchema = z
  .object({ userId: z.string().uuid().optional(), email: email.optional() })
  .refine((v) => Boolean(v.userId) !== Boolean(v.email), { path: ['email'], message: 'exactlyOne' });

/**
 * Поиск существующего ученика ПЕРЕД добавлением (2026-10-27, часть B).
 *
 * Зачем отдельная схема, а не переиспользование `memberAddSchema`: поиск — это запрос ровно об
 * одном поле, и «оба способа сразу» (`userId` + `email`) здесь невозможны по смыслу. Почта
 * нормализуется тем же `email`-примитивом, что при входе и регистрации, поэтому найденное и
 * добавленное всегда про один и тот же адрес: `Ann@X.io ` и `ann@x.io` не расходятся на два
 * разных аккаунта между шагом «найти» и шагом «подтвердить».
 */
export const memberLookupSchema = z.object({ email });

export const memberMoveSchema = z.object({ toClassId: z.string().uuid() });

/* ─── одноразовые ссылки-приглашения (задача 2026-10-23, часть A) ─────────────────────── */

/**
 * Создание приглашения учителем. `ttlDays` — строго один из трёх вариантов постановки,
 * а не любое число: «срок» должен быть тем, что человек реально понял из подписи в форме.
 */
export const inviteLinkCreateSchema = z.object({
  label: z.string().trim().max(INVITE_LABEL_MAX).optional().default(''),
  ttlDays: z.number().int().refine((d) => (INVITE_LINK_TTL_DAYS as readonly number[]).includes(d))
    .optional().default(INVITE_LINK_DEFAULT_TTL_DAYS),
});

/** Тело запроса ученика: токен всегда в ТЕЛЕ, никогда в query или path (§3.1 пункта 5). */
const inviteTokenField = z.string().trim().refine(isInviteToken, 'inviteInvalid');

export const invitePreviewSchema = z.object({ token: inviteTokenField });

/**
 * Регистрация по приглашению — те же поля и та же политика пароля, что у аккаунта, который
 * создаёт учитель, и токен вместо кода класса: класс берётся из приглашения на сервере, а не из
 * тела.
 *
 * `emailCode` здесь ПОЯВИЛСЯ 2026-10-27 и это осознанная смена решения, а не опечатка. раньше его
 * не было, потому что подтверждение почты было выключено, а единственным путём саморегистрации
 * оставался код класса. Когда приём по коду выведен из продукта, ссылка стала единственным
 * публичным способом завести аккаунт — и если владелец включит `EMAIL_PROVIDER`, требование кода
 * из письма должно действовать именно здесь. Иначе получился бы тихий отказ средства защиты:
 * включатель есть, письмо приходит, а спросить его не у чего.
 *
 * Поле остаётся ОПЦИОНАЛЬНЫМ в схеме: при `EMAIL_PROVIDER=none` его не существует, и прежний
 * клиент регистрирует аккаунт ровно тем же запросом, что раньше. Обязательность решает маршрут, а
 * не схема, — это то же разделение, что было у регистрации по коду.
 */
export const inviteRegisterSchema = z.object({
  token: inviteTokenField,
  firstName: z.string().trim().min(2, 'name2').max(80),
  lastName: z.string().trim().min(2, 'name2').max(80),
  email,
  password: passwordPolicy,
  emailCode: z.string().trim().regex(/^\d{6}$/, 'emailCodeRequired').optional(),
  locale: z.enum(SUPPORTED_LOCALES).optional(),
});

/** Вход в класс уже существующим аккаунтом: кроме токена ничего не приходит. */
export const inviteJoinSchema = z.object({ token: inviteTokenField });

/**
 * Сброс пароля ученика учителем (часть C). Поле СОЗНАТЕЛЬНО опционально: без него остаётся
 * прежнее поведение — сервер сам выдаёт временный пароль, и прежние тесты/клиенты этим путем
 * пользуются. С ним — пароль, который учитель набрал сам; он проходит ровно ту же
 * `passwordPolicy`, что и регистрация, то есть «12345678» не проходит и здесь.
 */
export const memberResetPasswordSchema = z.object({
  password: passwordPolicy.optional(),
});

export type StudentCreateInput = z.infer<typeof studentCreateSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ClassCreateInput = z.infer<typeof classCreateSchema>;
export type ClassUpdateInput = z.infer<typeof classUpdateSchema>;
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;
