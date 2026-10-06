/**
 * BluBlu Telegram bot — private-chat dispatcher (bot task §1–§5).
 *
 * Rules baked in here:
 *  • role comes from the linked site account (telegram_links → users.role);
 *    EVERY command and EVERY callback is authorized on the server, callbacks
 *    are additionally signed+bound to the acting user (botApi signCb);
 *  • dialog state lives in Postgres (bot_sessions) — the Render service may
 *    sleep between updates, /announce confirmations and /contact steps must
 *    survive a restart;
 *  • a redelivered update_id is processed exactly once (bot_updates ledger);
 *  • ≤20 commands/min per user, ≤10 schedule-name tries/min, ≤3 contacts/hour;
 *  • in groups the bot answers NOTHING except the existing /link binding;
 *  • user text is never interpreted as HTML (esc()).
 */
import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import {
  botSessions, botUpdates, classMembers, classes, contactBlocklist,
  contactReports, notificationPrefs, posts, telegramLinks, users,
  classLinkTokens, classTelegramChats,
} from '../db/schema.js';
import { listEventsInRange } from './events.js';
import { consumeLinkToken, getPrefs, hashToken, siteUrl, unlinkUser, enqueueNotification } from './notify.js';
import { applyMenu, esc, removeMenu, verifyCb, signCb, type BotApi, type InlineButton } from './botApi.js';
import { audit } from './audit.js';

export interface BotDeps {
  db: DB;
  api: BotApi;
  isGroupAdmin: (chatId: string, tgUserId: number) => Promise<boolean>;
}

export interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type: string }; from?: { id: number; is_bot?: boolean }; text?: string; date?: number };
  callback_query?: {
    id: string; from: { id: number }; message?: { message_id: number; chat: { id: number; type: string } }; data?: string;
  };
}

type Lang = 'ru' | 'uz' | 'en';
type Loc = Record<Lang, string>;

// ─── texts ────────────────────────────────────────────────────────────────────
const T: Record<string, Loc> = {
  helloBasic: {
    ru: 'Привет! Это бот BluBlu. Свяжи аккаунт ссылкой из профиля BluBlu (сообщение вида /start <код>), тогда станут доступны твоё расписание и настройки.',
    uz: 'Salom! Bu BluBlu boti. Proildagi havola orqali hisobingizni boglang (/start <kod>) — shunda jadval va sozlamalar ochiladi.',
    en: 'Hi! This is the BluBlu bot. Link your account with the URL from your BluBlu profile (a /start <code> message) to unlock your schedule and settings.',
  },
  helloTeacher: { ru: 'Готово! Меню учителя активно.', uz: 'Tayyor! O‘qituvchi menyusi yoqildi.', en: 'Done! The teacher menu is active.' },
  helloStudent: { ru: 'Готово! Меню ученика активно.', uz: 'Tayyor! O‘quvchi menyusi yoqildi.', en: 'Done! The student menu is active.' },
  linked: { ru: 'Telegram привязан к аккаунту BluBlu.', uz: 'Telegram BluBlu hisobiga bog‘landi.', en: 'Telegram is linked to your BluBlu account.' },
  badLink: { ru: 'Ссылка недействительна или устарела. Создайте новую в профиле.', uz: 'Havola yaroqsiz yoki eskirgan. Proilda yangisini yarating.', en: 'This link is invalid or expired. Create a new one in your profile.' },
  stopped: { ru: 'Аккаунт отвязан, уведомления отключены.', uz: 'Hisob uzildi, bildirishnomalar o‘chirildi.', en: 'Account unlinked, notifications are off.' },
  needLink: {
    ru: 'Эта команда доступна только после привязки аккаунта. Откройте профиль BluBlu → Telegram → /start.',
    uz: 'Bu buyruq faqat hisob bog‘langandan keyin mavjud. BluBlu profili → Telegram → /start.',
    en: 'This command needs a linked account. Open BluBlu profile → Telegram → /start.',
  },
  denied: {
    ru: 'Извините, эта команда доступна только учителю.',
    uz: 'Kechirasiz, bu buyruq faqat o‘qituvchi uchun.',
    en: 'Sorry, this command is for teachers only.',
  },
  deniedStudent: {
    ru: 'Извините, эта команда доступна только ученикам.',
    uz: 'Kechirasiz, bu buyruq faqat o‘quvchilar uchun.',
    en: 'Sorry, this command is for students only.',
  },
  helpBasic: {
    ru: 'Команды: /start — привязка, /schedule — расписание класса по названию, /contact — написать учителю, /language — язык, /help — это сообщение.',
    uz: 'Buyruqlar: /start — bog‘lash, /schedule — sinf jadvali nom bo‘yicha, /contact — o‘qituvchiga yozish, /language — til, /help — shu xabar.',
    en: 'Commands: /start — link, /schedule — class schedule by name, /contact — write to a teacher, /language — language, /help — this message.',
  },
  helpTeacher: {
    ru: 'Команды: /schedule — расписание (сегодня/завтра/неделя, по классам), /next — ближайшее событие, /classes — мои классы, /materials — материалы, /announce — объявление классу, /settings — уведомления, /language, /help.',
    uz: 'Buyruqlar: /schedule — jadval (bugun/erta/hafta, sinf bo‘yicha), /next — yaqin tadbir, /classes — sinflarim, /materials — materiallar, /announce — e’lon, /settings — bildirishnomalar, /language, /help.',
    en: 'Commands: /schedule — today/tomorrow/week per class, /next — next event, /classes — my classes, /materials — class materials, /announce — post an announcement, /settings — notifications, /language, /help.',
  },
  helpStudent: {
    ru: 'Команды: /schedule — расписание моих классов, /next — ближайшее событие, /contact — написать учителю, /language, /stop — отвязать аккаунт, /help.',
    uz: 'Buyruqlar: /schedule — sinflarim jadvali, /next — yaqin tadbir, /contact — o‘qituvchiga yozish, /language, /stop — hisobni uzish, /help.',
    en: 'Commands: /schedule — my classes schedule, /next — next event, /contact — write to a teacher, /language, /stop — unlink, /help.',
  },
  langSet: { ru: 'Язык — русский.', uz: 'Til — o‘zbekcha.', en: 'Language: English.' },
  pickClass: { ru: 'Выберите класс:', uz: 'Sinfni tanlang:', en: 'Pick a class:' },
  allClasses: { ru: 'Все классы', uz: 'Barcha sinflar', en: 'All classes' },
  today: { ru: 'Сегодня', uz: 'Bugun', en: 'Today' },
  tomorrow: { ru: 'Завтра', uz: 'Ertaga', en: 'Tomorrow' },
  week: { ru: 'Неделя', uz: 'Hafta', en: 'Week' },
  range: { ru: 'Период', uz: 'Davr', en: 'Range' },
  open: { ru: 'Открыть', uz: 'Ochish', en: 'Open' },
  openClass: { ru: 'Открыть класс', uz: 'Sinfni ochish', en: 'Open class' },
  startLesson: { ru: 'Начать урок', uz: 'Darsni boshlash', en: 'Start lesson' },
  joinLesson: { ru: 'Войти в урок', uz: 'Darsga kirish', en: 'Join lesson' },
  noEvents: { ru: 'Событий нет.', uz: 'Tadbirlar yo‘q.', en: 'No events.' },
  askClassName: {
    ru: 'Напишите точное название класса (например, «7B»).',
    uz: 'Sinf nomini to‘liq yozing (masalan, «7B»).',
    en: 'Type the exact class name (e.g. “7B”).',
  },
  classNotFound: {
    ru: 'Класс не найден или расписание не открыто.',
    uz: 'Sinf topilmadi yoki jadval ochiq emas.',
    en: 'Class not found or its schedule is not public.',
  },
  tooManyTries: {
    ru: 'Слишком много попыток. Подождите минуту.',
    uz: 'Juda ko‘p urinish. Bir daqiqa kuting.',
    en: 'Too many attempts. Wait a minute.',
  },
  noClasses: { ru: 'У вас пока нет классов.', uz: 'Sizda hozircha sinf yo‘q.', en: 'You have no classes yet.' },
  studentsN: { ru: 'учеников: %{n}', uz: 'o‘quvchilar: %{n}', en: 'students: %{n}' },
  materialsOf: { ru: 'Материалы класса «%{c}»:', uz: '«%{c}» sinf materiallari:', en: 'Materials of “%{c}”:' },
  noMaterials: { ru: 'Материалов пока нет.', uz: 'Materiallar yo‘q.', en: 'No materials yet.' },
  announcePick: { ru: 'Классу? Выберите или отправьте: /announce <точное название> <текст>', uz: 'Qaysi sinfga? Tanlang yoki yuboring: /announce <to‘liq nom> <matn>', en: 'Which class? Pick one or send: /announce <exact name> <text>' },
  announceText: { ru: 'Текст объявления (до 2000 символов):', uz: 'E’lon matni (2000 belgigacha):', en: 'Announcement text (up to 2000 chars):' },
  announceTooLong: { ru: 'Слишком длинно — максимум 2000 символов.', uz: 'Juda uzun — eng ko‘pi 2000 belgi.', en: 'Too long — 2000 characters max.' },
  announcePreview: {
    ru: 'Класс «%{c}» (%{n} учеников): %{t}',
    uz: '«%{c}» sinfi (%{n} o‘quvchi): %{t}',
    en: 'Class “%{c}” (%{n} students): %{t}',
  },
  send: { ru: 'Отправить', uz: 'Yuborish', en: 'Send' },
  cancel: { ru: 'Отмена', uz: 'Bekor qilish', en: 'Cancel' },
  announceSent: { ru: 'Отправлено: %{n} ученикам.', uz: '%{n} o‘quvchiga yuborildi.', en: 'Sent to %{n} students.' },
  announceCancelled: { ru: 'Отменено.', uz: 'Bekor qilindi.', en: 'Cancelled.' },
  announceExpired: {
    ru: 'Подтверждение истекло (10 минут). Начните заново: /announce',
    uz: 'Tasdiq muddati tugadi (10 daqiqa). Qaytadan: /announce',
    en: 'The confirmation expired (10 minutes). Start again: /announce',
  },
  alreadySent: { ru: 'Это объявление уже отправлено.', uz: 'Bu e’lon allaqachon yuborilgan.', en: 'This announcement was already sent.' },
  contactName: {
    ru: 'Шаг 1/3. Ваше имя и фамилия (2–80 символов):',
    uz: '1/3-qadam. Ism va familiyangiz (2–80 belgi):',
    en: 'Step 1/3. Your first and last name (2–80 characters):',
  },
  contactClass: {
    ru: 'Шаг 2/3. Класс: название, номер или кнопка ниже (до 40 символов).',
    uz: '2/3-qadam. Sinf: nom, raqam yoki quyidagi tugma (40 belgigacha).',
    en: 'Step 2/3. Class: name, number or a button below (up to 40 characters).',
  },
  contactSkip: { ru: 'Не знаю класс', uz: 'Sinfni bilmayman', en: 'I don’t know the class' },
  contactText: {
    ru: 'Шаг 3/3. Сообщение учителю (до 1000 символов):',
    uz: '3/3-qadam. O‘qituvchiga xabar (1000 belgigacha):',
    en: 'Step 3/3. Your message to the teacher (up to 1000 characters):',
  },
  contactBadName: { ru: 'Имя должно быть 2–80 символов. Попробуйте ещё раз:', uz: 'Ism 2–80 belgi bo‘lsin. Qayta urinib ko‘ring:', en: 'The name must be 2–80 characters. Try again:' },
  contactBadClass: { ru: 'Класс должен быть не длиннее 40 символов:', uz: 'Sinf 40 belgidan uzun bo‘lmasin:', en: 'The class must be at most 40 characters:' },
  contactBadText: { ru: 'Сообщение должно быть не длиннее 1000 символов:', uz: 'Xabar 1000 belgidan uzun bo‘lmasin:', en: 'The message must be at most 1000 characters:' },
  contactReport: {
    ru: 'Новое обращение через бота.\nИмя: %{name}\nКласс: %{cls}\n%{account}Сообщение: %{msg}\nВремя: %{at}',
    uz: 'Bot orqali yangi murojaat.\nIsm: %{name}\nSinf: %{cls}\n%{account}Xabar: %{msg}\nVaqt: %{at}',
    en: 'New message via the bot.\nName: %{name}\nClass: %{cls}\n%{account}Message: %{msg}\nTime: %{at}',
  },
  contactAccount: {
    ru: 'Аккаунт: %{n}, классы: %{c} (подтверждено)\n',
    uz: 'Hisob: %{n}, sinflar: %{c} (tasdiqlangan)\n',
    en: 'Account: %{n}, classes: %{c} (verified)\n',
  },
  replyBtn: { ru: 'Ответить', uz: 'Javob berish', en: 'Reply' },
  blockBtn: { ru: 'Заблокировать отправителя', uz: 'Yuboruvchini bloklash', en: 'Block sender' },
  contactDone: {
    ru: 'Сообщение отправлено учителю. Ответ придёт сюда.',
    uz: 'Xabar o‘qituvchiga yuborildi. Javob shu yerga keladi.',
    en: 'Your message was sent to the teacher. A reply will arrive here.',
  },
  contactNoTeacher: {
    ru: 'Ни один учитель ещё не подключил Telegram — сообщение не доставлено. Привяжите бота в профиле или напишите позже.',
    uz: 'Hech bir o‘qituvchi Telegramni ulamagan — xabar yetkazilmadi. Keyinroq urinib ko‘ring.',
    en: 'No teacher has connected Telegram yet — the message could not be delivered. Try again later.',
  },
  contactLimit: {
    ru: 'Не больше 3 обращений в час. Подождите.',
    uz: 'Soatiga 3 tadan ko‘p murojaat qilmaydi. Kuting.',
    en: 'At most 3 messages per hour. Please wait.',
  },
  contactBlocked: {
    ru: 'Вы заблокированы этим учителем и не можете писать через бота.',
    uz: 'Siz ushbu o‘qituvchi tomonidan bloklangansiz.',
    en: 'You are blocked by this teacher and cannot write via the bot.',
  },
  replyAsk: { ru: 'Ответ ученику (до 1000 символов):', uz: 'O‘quvchiga javob (1000 belgigacha):', en: 'Reply to the student (up to 1000 characters):' },
  replyPrefix: { ru: 'Ответ учителя: ', uz: 'O‘qituvchi javobi: ', en: 'Teacher reply: ' },
  replySent: { ru: 'Ответ отправлен.', uz: 'Javob yuborildi.', en: 'Reply sent.' },
  blockedNow: { ru: 'Отправитель заблокирован. Разблокировать: /settings', uz: 'Yuboruvchi bloklandi. Blokdan chiqarish: /settings', en: 'Sender blocked. Unblock in /settings.' },
  notBlocked: { ru: 'Никто не заблокирован.', uz: 'Bloklanganlar yo‘q.', en: 'Nobody is blocked.' },
  unblockBtn: { ru: 'Разблокировать %{c}', uz: 'Blokdan chiqarish %{c}', en: 'Unblock %{c}' },
  settingsTitle: { ru: 'Настройки уведомлений (✓ — вкл):', uz: 'Bildirishnoma sozlamalari (✓ — yoqilgan):', en: 'Notification settings (✓ = on):' },
  kReminder24h: { ru: 'Напоминание за 24 ч', uz: '24 soat oldin eslatma', en: '24 h reminder' },
  kReminder1h: { ru: 'Напоминание за 1 ч', uz: '1 soat oldin eslatma', en: '1 h reminder' },
  kReminder10m: { ru: 'Напоминание за 10 мин', uz: '10 daqiqa oldin eslatma', en: '10 min reminder' },
  kLessonStarted: { ru: 'Урок начался', uz: 'Dars boshlandi', en: 'Lesson started' },
  kMaterialNew: { ru: 'Новый материал', uz: 'Yangi material', en: 'New material' },
  quiet: { ru: 'Тихие часы: %{a}:00–%{b}:00', uz: 'Jim soatlar: %{a}:00–%{b}:00', en: 'Quiet hours: %{a}:00–%{b}:00' },
  quietFrom: { ru: 'начало', uz: 'boshi', en: 'from' },
  quietTo: { ru: 'конец', uz: 'oxiri', en: 'to' },
  rateLimited: {
    ru: 'Слишком много команд. Подождите минуту.',
    uz: 'Juda ko‘p buyruq. Bir daqiqa kuting.',
    en: 'Too many commands. Wait a minute.',
  },
  dialogExpired: { ru: 'Диалог истёк. Начните заново.', uz: 'Suhbat tugadi. Qaytadan boshlang.', en: 'The dialog expired. Start again.' },
  cancelled: { ru: 'Отменено. /help — список команд.', uz: 'Bekor qilindi. /help — buyruqlar.', en: 'Cancelled. /help for commands.' },
  badCallback: { ru: 'Кнопка устарела или не для вас.', uz: 'Tugma eskirgan yoki sizga tegishli emas.', en: 'This button is stale or not yours.' },
  nextNone: { ru: 'Ближайших событий нет.', uz: 'Yaqin tadbirlar yo‘q.', en: 'No upcoming events.' },
};
const t = (k: keyof typeof T, lang: Lang, vars: Record<string, string | number> = {}) => {
  let s = T[k]?.[lang] ?? '';
  for (const [a, b] of Object.entries(vars)) s = s.replaceAll(`%{${a}}`, String(b));
  return s;
};

// ─── rate limiting (in-memory; commands are stateless) ───────────────────────
const rl = new Map<string, { n: number; windowStart: number }>();
function rateOk(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const e = rl.get(key);
  if (!e || now - e.windowStart > windowMs) { rl.set(key, { n: 1, windowStart: now }); return true; }
  if (e.n >= max) return false;
  e.n++;
  return true;
}
setInterval(() => { for (const [k, e] of rl) if (Date.now() - e.windowStart > 3_600_000) rl.delete(k); }, 5 * 60_000).unref?.();

// ─── session helpers (Postgres, survives restarts) ───────────────────────────
interface Session { state: string; data: Record<string, unknown>; expiresAt: Date }
async function loadSession(db: DB, chatId: string): Promise<Session | null> {
  const [row] = await db.select().from(botSessions).where(eq(botSessions.chatId, chatId)).limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(botSessions).where(eq(botSessions.chatId, chatId));
    return null;
  }
  return { state: row.state, data: row.data as Record<string, unknown>, expiresAt: row.expiresAt };
}
async function saveSession(db: DB, chatId: string, state: string, data: Record<string, unknown>, ttlMin: number) {
  const expiresAt = new Date(Date.now() + ttlMin * 60_000);
  await db.insert(botSessions).values({ chatId, state, data, expiresAt, updatedAt: new Date() })
    .onConflictDoUpdate({ target: botSessions.chatId, set: { state, data, expiresAt, updatedAt: new Date() } });
}
async function clearSession(db: DB, chatId: string) {
  await db.delete(botSessions).where(eq(botSessions.chatId, chatId));
}

// ─── identity & roles ─────────────────────────────────────────────────────────
interface Identity { userId: string | null; role: 'teacher' | 'student' | null; lang: Lang; tz: string }
async function identify(db: DB, chatId: string, fallbackLang: Lang): Promise<Identity> {
  const [link] = await db.select({ userId: telegramLinks.userId, blockedAt: telegramLinks.blockedAt })
    .from(telegramLinks).where(eq(telegramLinks.chatId, chatId)).limit(1);
  if (link && !link.blockedAt) {
    const [u] = await db.select({ role: users.role, locale: users.locale, tz: users.tz }).from(users)
      .where(and(eq(users.id, link.userId), isNull(users.deletedAt))).limit(1);
    if (u) return { userId: link.userId, role: u.role, lang: u.locale, tz: u.tz };
  }
  return { userId: null, role: null, lang: fallbackLang, tz: 'Asia/Tashkent' };
}
/** classes the user can see: teacher owns, student is member of (non-archived) */
async function visibleClasses(db: DB, id: Identity) {
  if (!id.userId) return [];
  if (id.role === 'teacher') {
    return db.select({ id: classes.id, name: classes.name, teacherId: classes.teacherId }).from(classes)
      .where(and(eq(classes.teacherId, id.userId), isNull(classes.archivedAt))).orderBy(classes.name);
  }
  return db.select({ id: classes.id, name: classes.name, teacherId: classes.teacherId }).from(classMembers)
    .innerJoin(classes, and(eq(classes.id, classMembers.classId), isNull(classes.archivedAt)))
    .where(eq(classMembers.userId, id.userId))
    .orderBy(classes.name);
}
const btn = (text: string, cb?: string, url?: string): InlineButton => ({ text, cb, url });
const row = (...b: InlineButton[]): InlineButton[] => b;

// ─── housekeeping (§6: cleanup by schedule) ──────────────────────────────────
export async function sweepBotState(db: DB, now = new Date()): Promise<void> {
  await db.delete(botSessions).where(lt(botSessions.expiresAt, now));
  await db.delete(botUpdates).where(lt(botUpdates.seenAt, new Date(now.getTime() - 7 * 86400_000)));
  await db.delete(contactReports).where(lt(contactReports.expiresAt, now)); // report↔chat link lives 30 days
}

// ─── main entry ───────────────────────────────────────────────────────────────
export async function handleUpdate(deps: BotDeps, update: TgUpdate): Promise<void> {
  const { db, api } = deps;
  // idempotency: a redelivered update_id is dropped (§6)
  const fresh = await db.insert(botUpdates).values({ updateId: update.update_id }).onConflictDoNothing().returning({ x: botUpdates.updateId });
  if (!fresh.length) return;

  if (update.callback_query) { await onCallback(deps, update.callback_query); return; }
  const m = update.message;
  if (!m || m.chat.id === undefined) return;
  const chatId = String(m.chat.id);

  // groups/supergroups: only the existing /link binding, everything else silent (§1)
  if (m.chat.type === 'group' || m.chat.type === 'supergroup') {
    if (m.text?.trim().toLowerCase().startsWith('/link')) {
      await legacyGroupLink(deps, chatId, m);
    }
    return;
  }
  if (m.chat.type !== 'private') return;

  // command budget: 20/min per user (§6)
  const text = (m.text ?? '').trim();
  if (text.startsWith('/')) {
    if (!rateOk(`cmd:${chatId}`, 20, 60_000)) { await send(deps, chatId, 'rateLimited', {}); return; }
  }

  const sess = await loadSession(db, chatId);
  const id = await identify(db, chatId, (sess?.data.lang as Lang) ?? 'ru');

  // in a dialog? plain text goes to the dialog first (commands still work,
  // EXCEPT /cancel which belongs to the dialog — §5)
  if (sess && (!text.startsWith('/') || text.toLowerCase() === '/cancel')) {
    if (await dialogStep(deps, chatId, sess, id, m)) return;
  }

  const cmd = ((text.split('@')[0] ?? '').split(/\s+/)[0] ?? '').toLowerCase();
  const arg = text.slice(cmd.length).trim();
  switch (cmd) {
    case '/start': return onStart(deps, chatId, id, arg);
    case '/help': return send(deps, chatId, id.role === 'teacher' ? 'helpTeacher' : id.role === 'student' ? 'helpStudent' : 'helpBasic', {}, id.lang);
    case '/language': return sendLangPicker(deps, chatId, id);
    case '/stop': return onStop(deps, chatId, id);
    case '/contact': return contactStart(deps, chatId, id, sess, m);
    case '/schedule': return scheduleHome(deps, chatId, id, sess);
    case '/next': return nextEvent(deps, chatId, id);
    case '/classes': return myClasses(deps, chatId, id);
    case '/materials': return materialsHome(deps, chatId, id);
    case '/settings': return settings(deps, chatId, id);
    case '/announce': return announceHome(deps, chatId, id, arg);
    default:
      if (cmd.startsWith('/')) await send(deps, chatId, id.role === 'teacher' ? 'helpTeacher' : id.role === 'student' ? 'helpStudent' : 'helpBasic', {}, id.lang);
  }
}

async function send(deps: BotDeps, chatId: string, key: string, vars: Record<string, string | number>, lang?: Lang) {
  const l = lang ?? 'ru';
  await deps.api.sendMessage(chatId, t(key as keyof typeof T, l, vars));
}

async function onStart(deps: BotDeps, chatId: string, id: Identity, arg: string) {
  const { db, api } = deps;
  if (arg) {
    const ok = await consumeLinkToken(db, arg, chatId);
    if (!ok) { await send(deps, chatId, 'badLink', {}, id.lang); return; }
    const nid = await identify(db, chatId, 'ru');
    await applyMenu(api, nid.role ?? 'basic', chatId);
    await send(deps, chatId, 'linked', {}, nid.lang);
    await send(deps, chatId, nid.role === 'teacher' ? 'helloTeacher' : 'helloStudent', {}, nid.lang);
    return;
  }
  await send(deps, chatId, id.role ? (id.role === 'teacher' ? 'helloTeacher' : 'helloStudent') : 'helloBasic', {}, id.lang);
}

async function onStop(deps: BotDeps, chatId: string, id: Identity) {
  if (!id.userId) { await send(deps, chatId, 'stopped', {}, id.lang); return; }
  await unlinkUser(deps.db, id.userId);
  await removeMenu(deps.api, chatId);
  await applyMenu(deps.api, 'basic', chatId);
  await clearSession(deps.db, chatId);
  await send(deps, chatId, 'stopped', {}, id.lang);
}

async function sendLangPicker(deps: BotDeps, chatId: string, id: Identity) {
  await deps.api.sendMessage(chatId, 'Язык / Til / Language:', {
    buttons: [row(btn('Русский', signCb({ u: id.userId ?? '', a: 'lang', l: 'ru' }))), row(btn("O'zbekcha", signCb({ u: id.userId ?? '', a: 'lang', l: 'uz' }))), row(btn('English', signCb({ u: id.userId ?? '', a: 'lang', l: 'en' })))],
  });
}

// ─── /schedule ────────────────────────────────────────────────────────────────
async function scheduleHome(deps: BotDeps, chatId: string, id: Identity, sess: Session | null) {
  const { db } = deps;
  if (!id.userId) {
    // unbound: schedule by class name, only for classes with bot_public_schedule (§3)
    await saveSession(db, chatId, 'sched:name', { lang: id.lang }, 15);
    await send(deps, chatId, 'askClassName', {}, id.lang);
    return;
  }
  const cls = await visibleClasses(db, id);
  if (!cls.length) { await send(deps, chatId, 'noClasses', {}, id.lang); return; }
  const buttons = [row(btn(t('today', id.lang), signCb({ u: id.userId, a: 'sch', c: 'all', r: 'today' }))), row(btn(t('tomorrow', id.lang), signCb({ u: id.userId, a: 'sch', c: 'all', r: 'tomorrow' }))), row(btn(t('week', id.lang), signCb({ u: id.userId, a: 'sch', c: 'all', r: 'week' })))];
  buttons.push(row(btn(t('allClasses', id.lang), signCb({ u: id.userId, a: 'sch', c: 'all', r: 'week' }))));
  for (const c of cls.slice(0, 20)) buttons.push(row(btn(c.name, signCb({ u: id.userId, a: 'sch', c: c.id, r: 'week' }))));
  await deps.api.sendMessage(chatId, `${t('pickClass', id.lang)}\n${t('range', id.lang)}: ${t('today', id.lang)} / ${t('tomorrow', id.lang)} / ${t('week', id.lang)}`, { buttons });
}

function rangeFor(r: string): [Date, Date] {
  const now = new Date();
  if (r === 'today') return [now, new Date(now.getTime() + 24 * 3600_000)];
  if (r === 'tomorrow') return [new Date(now.getTime() + 24 * 3600_000), new Date(now.getTime() + 48 * 3600_000)];
  return [now, new Date(now.getTime() + 7 * 86400_000)];
}

async function renderSchedule(deps: BotDeps, chatId: string, id: Identity, classFilter: string, range: string) {
  if (!id.userId) return;
  const { db, api } = deps;
  // ownership re-check: a student forging c=<other class> gets nothing (§1)
  const cls = await visibleClasses(db, id);
  if (classFilter !== 'all' && !cls.some((c) => c.id === classFilter)) { await send(deps, chatId, 'classNotFound', {}, id.lang); return; }
  const [from, to] = rangeFor(range);
  const role = id.role ?? 'student';
  const occ = await listEventsInRange(db, id.userId, role, from, to, classFilter === 'all' ? undefined : classFilter);
  if (!occ.length) { await send(deps, chatId, 'noEvents', {}, id.lang); return; }
  const lines = occ.slice(0, 30).map((o) => {
    const when = new Intl.DateTimeFormat('en-GB', { timeZone: o.tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(o.startsAt));
    return `• ${when} — [${o.kind}] ${esc(o.title)} (${esc(o.className)})`;
  });
  const url = `${siteUrl()}/calendar`;
  await api.sendMessage(chatId, lines.join('\n'), { buttons: [row(btn(t('open', id.lang), undefined, url))], html: true });
}

/** unbound /schedule by name: public classes only, uniform miss, 10/min (§3) */
async function scheduleByName(deps: BotDeps, chatId: string, name: string, lang: Lang): Promise<boolean> {
  const { db, api } = deps;
  if (!rateOk(`schedname:${chatId}`, 10, 60_000)) { await send(deps, chatId, 'tooManyTries', {}, lang); return true; }
  const [cls] = await db.select({ id: classes.id, name: classes.name }).from(classes)
    .where(and(sql`lower(${classes.name}) = lower(${name.trim()})`, eq(classes.botPublicSchedule, true), isNull(classes.archivedAt)))
    .limit(1);
  if (!cls) { await send(deps, chatId, 'classNotFound', {}, lang); return true; }
  const now = new Date();
  const occ = await listEventsInRangePublic(db, cls.id, now, new Date(now.getTime() + 7 * 86400_000));
  if (!occ.length) { await send(deps, chatId, 'noEvents', {}, lang); return true; }
  // time + title only — no lesson links, descriptions or materials (§3)
  const lines = occ.slice(0, 20).map((o) => {
    const when = new Intl.DateTimeFormat('en-GB', { timeZone: o.tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(o.startsAt));
    return `• ${when} — ${esc(o.title)}`;
  });
  await api.sendMessage(chatId, `${esc(cls.name)}\n${lines.join('\n')}`, { html: true });
  return true;
}

async function listEventsInRangePublic(db: DB, classId: string, from: Date, to: Date) {
  const [cls] = await db.select({ name: classes.name }).from(classes).where(eq(classes.id, classId)).limit(1);
  const occ = await listEventsInRange(db, (await db.select({ teacherId: classes.teacherId }).from(classes).where(eq(classes.id, classId)).limit(1))[0]!.teacherId, 'teacher', from, to, classId);
  return occ.map((o) => ({ ...o, className: cls?.name ?? '' }));
}

async function nextEvent(deps: BotDeps, chatId: string, id: Identity) {
  if (!id.userId) { await send(deps, chatId, 'needLink', {}, id.lang); return; }
  const now = new Date();
  const occ = await listEventsInRange(deps.db, id.userId, id.role ?? 'student', now, new Date(now.getTime() + 14 * 86400_000));
  const next = occ.sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt))[0];
  if (!next) { await send(deps, chatId, 'nextNone', {}, id.lang); return; }
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: next.tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(next.startsAt));
  const label = id.role === 'teacher' ? t('startLesson', id.lang) : t('open', id.lang);
  const url = id.role === 'teacher' ? `${siteUrl()}/lesson?classId=${next.classId}` : `${siteUrl()}/calendar`;
  await deps.api.sendMessage(chatId, `• ${when} — [${next.kind}] ${esc(next.title)} (${esc(next.className)})`, { buttons: [row(btn(label, undefined, url))], html: true });
}

async function myClasses(deps: BotDeps, chatId: string, id: Identity) {
  if (id.role !== 'teacher') { await send(deps, chatId, id.role === 'student' ? 'denied' : 'needLink', {}, id.lang); return; }
  const cls = await visibleClasses(deps.db, id);
  if (!cls.length) { await send(deps, chatId, 'noClasses', {}, id.lang); return; }
  const buttons = cls.slice(0, 20).map((c) => {
    void signCb({ u: id.userId ?? '', a: 'noop', c: c.id });
    return row(btn(`${c.name} — ${t('openClass', id.lang)}`, undefined, `${siteUrl()}/classes/${c.id}`));
  });
  const counts = await deps.db.execute(sql`
    select c.id, count(m.user_id)::int as n from classes c
    left join class_members m on m.class_id = c.id
    where c.teacher_id = ${id.userId} and c.archived_at is null group by c.id`);
  const cnt = new Map(((Array.isArray(counts) ? counts : (counts as { rows?: { id: string; n: number }[] }).rows ?? []) as { id: string; n: number }[]).map((r) => [r.id, r.n]));
  const lines = cls.map((c) => `• ${esc(c.name)} — ${t('studentsN', id.lang, { n: cnt.get(c.id) ?? 0 })}`);
  await deps.api.sendMessage(chatId, lines.join('\n'), { buttons, html: true });
}

async function materialsHome(deps: BotDeps, chatId: string, id: Identity) {
  if (id.role !== 'teacher') { await send(deps, chatId, id.role === 'student' ? 'denied' : 'needLink', {}, id.lang); return; }
  const cls = await visibleClasses(deps.db, id);
  if (!cls.length) { await send(deps, chatId, 'noClasses', {}, id.lang); return; }
  const buttons = cls.slice(0, 20).map((c) => row(btn(c.name, signCb({ u: id.userId ?? '', a: 'mat', c: c.id }))));
  await deps.api.sendMessage(chatId, t('pickClass', id.lang), { buttons });
}

async function renderMaterials(deps: BotDeps, chatId: string, id: Identity, classId: string) {
  const cls = await visibleClasses(deps.db, id);
  const mine = cls.find((c) => c.id === classId);
  if (!mine) { await send(deps, chatId, 'classNotFound', {}, id.lang); return; }
  const rows = await deps.db.select({ id: posts.id, title: posts.title, createdAt: posts.createdAt }).from(posts)
    // material task A: the bot never leaks drafts or scheduled posts
    .where(and(eq(posts.classId, classId), eq(posts.kind, 'material'), eq(posts.status, 'published')))
    .orderBy(desc(posts.createdAt)).limit(5);
  if (!rows.length) { await send(deps, chatId, 'noMaterials', {}, id.lang); return; }
  const lines = rows.map((p) => `• ${new Intl.DateTimeFormat('en-GB', { timeZone: id.tz, day: '2-digit', month: '2-digit' }).format(p.createdAt)} — ${esc(p.title || '(—)')}`);
  await deps.api.sendMessage(chatId, `${t('materialsOf', id.lang, { c: mine.name })}\n${lines.join('\n')}`, { html: true, buttons: [row(btn(t('open', id.lang), undefined, `${siteUrl()}/classes/${classId}`))] });
}

// ─── /settings (teacher) ──────────────────────────────────────────────────────
const KIND_KEYS = ['reminder24h', 'reminder1h', 'reminder10m', 'lessonStarted', 'materialNew'] as const;
const KIND_LABEL: Record<string, keyof typeof T> = {
  reminder24h: 'kReminder24h', reminder1h: 'kReminder1h', reminder10m: 'kReminder10m',
  lessonStarted: 'kLessonStarted', materialNew: 'kMaterialNew',
};
const kindLabel = (k: string): keyof typeof T => KIND_LABEL[k] ?? 'kReminder1h';
async function settings(deps: BotDeps, chatId: string, id: Identity) {
  if (id.role !== 'teacher') { await send(deps, chatId, id.role === 'student' ? 'denied' : 'needLink', {}, id.lang); return; }
  const prefs = await getPrefs(deps.db, id.userId!);
  const lines = KIND_KEYS.map((k) => `• ${prefs.kinds[k] === false ? '✗' : '✓'} ${t(kindLabel(k), id.lang)}`);
  lines.push(`• ${t('quiet', id.lang, { a: prefs.quietFrom, b: prefs.quietTo })}`);
  const buttons = KIND_KEYS.map((k) => row(btn(`${prefs.kinds[k] === false ? '✗' : '✓'} ${t(kindLabel(k), id.lang)}`, signCb({ u: id.userId!, a: 'set', c: k }))));
  buttons.push(row(
    btn(`− ${t('quietFrom', id.lang)}`, signCb({ u: id.userId!, a: 'setq', c: 'from-1' })),
    btn(`+ ${t('quietFrom', id.lang)}`, signCb({ u: id.userId!, a: 'setq', c: 'from+1' })),
  ));
  buttons.push(row(
    btn(`− ${t('quietTo', id.lang)}`, signCb({ u: id.userId!, a: 'setq', c: 'to-1' })),
    btn(`+ ${t('quietTo', id.lang)}`, signCb({ u: id.userId!, a: 'setq', c: 'to+1' })),
  ));
  const blocked = await deps.db.select({ chatId: contactBlocklist.senderChatId }).from(contactBlocklist).where(eq(contactBlocklist.blockedBy, id.userId!));
  for (const b of blocked) buttons.push(row(btn(t('unblockBtn', id.lang, { c: b.chatId }), signCb({ u: id.userId!, a: 'unblock', c: b.chatId }))));
  await deps.api.sendMessage(chatId, `${t('settingsTitle', id.lang)}\n${lines.join('\n')}${blocked.length ? `\n⛔ ${blocked.length}` : ''}`, { buttons });
}

// ─── /announce (§4) ───────────────────────────────────────────────────────────
async function announceHome(deps: BotDeps, chatId: string, id: Identity, arg: string) {
  if (id.role !== 'teacher') { await send(deps, chatId, id.role === 'student' ? 'denied' : 'needLink', {}, id.lang); return; }
  const cls = await visibleClasses(deps.db, id);
  if (!cls.length) { await send(deps, chatId, 'noClasses', {}, id.lang); return; }
  if (arg) {
    // quick form: /announce <exact class name> <text> — names may contain
    // spaces, so try the LONGEST class name that prefixes the argument.
    const norm = arg.toLowerCase();
    const byLen = [...cls].sort((a, b) => b.name.length - a.name.length);
    const hit = byLen.find((c) => norm.startsWith(c.name.toLowerCase() + ' ') && arg.slice(c.name.length + 1).trim());
    if (hit) { await announceAsk(deps, chatId, id, hit.id, arg.slice(hit.name.length + 1).trim()); return; }
    const exact = byLen.filter((c) => norm.startsWith(c.name.toLowerCase() + ' '));
    if (exact.length !== 1) {
      // ambiguous or no match at all → the class button list (§4)
      const buttons2 = cls.slice(0, 30).map((c) => row(btn(c.name, signCb({ u: id.userId!, a: 'an', c: c.id }))));
      await deps.api.sendMessage(chatId, t('announcePick', id.lang), { buttons: buttons2 });
      return;
    }
  }
  const buttons = cls.slice(0, 30).map((c) => row(btn(c.name, signCb({ u: id.userId!, a: 'an', c: c.id }))));
  await deps.api.sendMessage(chatId, t('announcePick', id.lang), { buttons });
}

async function announceAsk(deps: BotDeps, chatId: string, id: Identity, classId: string, preset?: string) {
  await saveSession(deps.db, chatId, 'announce:text', { classId, lang: id.lang }, 15);
  if (preset) { await announceText(deps, chatId, id, classId, preset); return; }
  await send(deps, chatId, 'announceText', {}, id.lang);
}

async function announceText(deps: BotDeps, chatId: string, id: Identity, classId: string, text: string) {
  const clean = text.trim();
  if (!clean) return;
  if (clean.length > 2000) { await send(deps, chatId, 'announceTooLong', {}, id.lang); return; }
  const cls = await visibleClasses(deps.db, id);
  const mine = cls.find((c) => c.id === classId);
  if (!mine) { await clearSession(deps.db, chatId); await send(deps, chatId, 'classNotFound', {}, id.lang); return; }
  const cntRow = (await deps.db.execute(sql`select count(*)::int as n from class_members where class_id = ${classId}`)) as unknown as { n: number }[];
  const n = Number(cntRow[0]?.n ?? 0);
  await saveSession(deps.db, chatId, 'announce:confirm', { classId, text: clean, lang: id.lang }, 10);
  await deps.api.sendMessage(chatId, t('announcePreview', id.lang, { c: mine.name, n, t: esc(clean) }), {
    html: true,
    buttons: [row(
      btn(t('send', id.lang), signCb({ u: id.userId!, a: 'ansend', c: classId })),
      btn(t('cancel', id.lang), signCb({ u: id.userId!, a: 'ancancel', c: classId })),
    )],
  });
}

async function announceSend(deps: BotDeps, chatId: string, id: Identity, classId: string) {
  const { db, api } = deps;
  // read the pending confirmation FIRST (RETURNING would hand back the cleared
  // row), then claim it atomically — only the first press wins, no double post
  const sess = await loadSession(db, chatId);
  const data = sess?.state === 'announce:confirm' ? sess.data as { text?: string; classId?: string } : null;
  if (!data?.text || data.classId !== classId) { await send(deps, chatId, 'alreadySent', {}, id.lang); return; }
  const claimed = await db.update(botSessions).set({ state: '', data: {}, expiresAt: new Date(0) })
    .where(and(eq(botSessions.chatId, chatId), eq(botSessions.state, 'announce:confirm')))
    .returning({ chatId: botSessions.chatId });
  if (!claimed.length) { await send(deps, chatId, 'alreadySent', {}, id.lang); return; }
  const [post] = await db.insert(posts).values({
    classId, authorId: id.userId!, kind: 'announcement',
    title: data.text.split('\n')[0]!.slice(0, 80), body: data.text,
  }).returning();
  const members = await db.select({ userId: classMembers.userId }).from(classMembers).where(eq(classMembers.classId, classId));
  const { enqueueNotification } = await import('./notify.js');
  await enqueueNotification(db, {
    kind: 'announcementNew', classId, when: new Date(),
    params: { title: data.text.split('\n')[0]!.slice(0, 80), class: (await db.select({ name: classes.name }).from(classes).where(eq(classes.id, classId)).limit(1))[0]?.name ?? '', url: `${siteUrl()}/classes/${classId}` },
    dedupeBase: `post:${post!.id}`, excludeUserId: id.userId!,
  });
  audit(db, id.userId!, 'bot_announce', { classId, postId: post!.id, students: members.length });
  await send(deps, chatId, 'announceSent', { n: members.length }, id.lang);
}

// ─── /contact (§5) ────────────────────────────────────────────────────────────
async function contactStart(deps: BotDeps, chatId: string, id: Identity, sess: Session | null, m: NonNullable<TgUpdate['message']>) {
  const { db, api } = deps;
  if (id.role === 'teacher') { await send(deps, chatId, 'deniedStudent', {}, id.lang); return; }
  const [blocked] = await db.select({ x: contactBlocklist.senderChatId }).from(contactBlocklist).where(eq(contactBlocklist.senderChatId, chatId)).limit(1);
  if (blocked) { await send(deps, chatId, 'contactBlocked', {}, id.lang); return; }
  const key = id.userId ?? `chat:${chatId}`;
  if (!rateOk(`contact:${key}`, 3, 3600_000)) { await send(deps, chatId, 'contactLimit', {}, id.lang); return; }
  await api.deleteMessage(chatId, m.message_id).catch(() => undefined);
  await saveSession(db, chatId, 'contact:name', { lang: id.lang }, 15);
  await send(deps, chatId, 'contactName', {}, id.lang);
}

async function contactClassStep(deps: BotDeps, chatId: string, id: Identity, name: string) {
  const cls = id.userId ? await visibleClasses(deps.db, id) : [];
  await saveSession(deps.db, chatId, 'contact:class', { name, lang: id.lang }, 15);
  const buttons = cls.slice(0, 10).map((c) => row(btn(c.name, signCb({ u: id.userId ?? '', a: 'ccls', c: c.id }))));
  buttons.push(row(btn(t('contactSkip', id.lang), signCb({ u: id.userId ?? '', a: 'ccls', c: '' }))));
  await deps.api.sendMessage(chatId, t('contactClass', id.lang), { buttons: buttons.length > 1 ? buttons : undefined });
}

async function contactFinish(deps: BotDeps, chatId: string, id: Identity, sess: Session, name: string, hint: string, message: string) {
  const { db, api } = deps;
  await clearSession(db, chatId);
  // resolve the class ONLY for routing the report: bound student → his classes;
  // unbound → public classes; unique match wins.
  let classId: string | null = null;
  let teacherId: string | null = null;
  const sessCls = sess.data.pickedClass as string | undefined;
  if (sessCls) { classId = sessCls; }
  else if (hint) {
    const pool = id.userId ? await visibleClasses(db, id) : await db.select({ id: classes.id, teacherId: classes.teacherId }).from(classes).where(and(eq(classes.botPublicSchedule, true), isNull(classes.archivedAt)));
    const hits = (pool as { id: string; teacherId: string; name?: string }[]).filter((c) => (c.name ?? '').toLowerCase() === hint.toLowerCase() || c.id === hint || (c as { id: string }).id.slice(0, 8) === hint);
    if (hits.length === 1) { classId = hits[0]!.id; teacherId = hits[0]!.teacherId; }
  }
  if (classId && !teacherId) {
    teacherId = (await db.select({ teacherId: classes.teacherId }).from(classes).where(eq(classes.id, classId)).limit(1))[0]?.teacherId ?? null;
  }
  if (!teacherId) {
    // instance owner: the first teacher account
    const [owner] = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.role, 'teacher'), isNull(users.deletedAt))).orderBy(asc(users.createdAt)).limit(1);
    teacherId = owner?.id ?? null;
  }
  const teacherChat = teacherId
    ? (await db.select({ chatId: telegramLinks.chatId }).from(telegramLinks).where(and(eq(telegramLinks.userId, teacherId), isNull(telegramLinks.blockedAt))).limit(1))[0]?.chatId ?? null
    : null;
  const accountLine = id.userId ? await confirmedAccountLine(db, id, id.lang) : '';
  const reportId = crypto.randomUUID();
  const at = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC' }).format(new Date()) + ' UTC';
  const body = t('contactReport', id.lang, { name: esc(name), cls: esc(hint || '—'), account: accountLine, msg: esc(message), at });
  let delivered = false;
  if (teacherChat) {
    await api.sendMessage(teacherChat, body, {
      html: true,
      buttons: [row(
        btn(t('replyBtn', id.lang), signCb({ u: teacherId ?? '', a: 'creply', r: reportId })),
        btn(t('blockBtn', id.lang), signCb({ u: teacherId ?? '', a: 'cblock', r: reportId })),
      )],
    });
    delivered = true;
  }
  await db.insert(contactReports).values({
    id: reportId, senderChatId: chatId, senderUserId: id.userId, name, classHint: hint,
    classId, message, teacherUserId: teacherId, teacherChatId: teacherChat, delivered,
    expiresAt: new Date(Date.now() + 30 * 86400_000), // the report↔chat link lives 30 days
  });
  await send(deps, chatId, delivered ? 'contactDone' : 'contactNoTeacher', {}, id.lang);
}

async function confirmedAccountLine(db: DB, id: Identity, lang: Lang): Promise<string> {
  const [u] = await db.select({ name: users.name, lastName: users.lastName }).from(users).where(eq(users.id, id.userId!)).limit(1);
  const cls = await visibleClasses(db, id);
  return t('contactAccount', lang, {
    n: esc(`${u?.name ?? ''} ${u?.lastName ?? ''}`.trim() || '?'),
    c: cls.map((c) => esc(c.name)).join(', ') || '—',
  });
}

// ─── dialog text steps ────────────────────────────────────────────────────────
async function dialogStep(deps: BotDeps, chatId: string, sess: Session, id: Identity, m: NonNullable<TgUpdate['message']>): Promise<boolean> {
  const { db } = deps;
  const text = (m.text ?? '').trim();
  const lang = id.lang;
  const del = () => deps.api.deleteMessage(chatId, m.message_id); // ignore failures per spec
  switch (sess.state) {
    case '/cancel': break;
    case 'sched:name':
      await del();
      await clearSession(db, chatId);
      await scheduleByName(deps, chatId, text, (sess.data.lang as Lang) ?? lang);
      return true;
    case 'announce:text': {
      await del();
      if (text === '/cancel') { await clearSession(db, chatId); await send(deps, chatId, 'cancelled', {}, lang); return true; }
      await announceText(deps, chatId, id, String(sess.data.classId ?? ''), text);
      return true;
    }
    case 'announce:confirm':
      // plain text while a confirmation is pending: re-show the preview
      await del();
      await announceText(deps, chatId, id, String(sess.data.classId ?? ''), text);
      return true;
    case 'contact:name':
      await del();
      if (text === '/cancel') { await clearSession(db, chatId); await send(deps, chatId, 'cancelled', {}, lang); return true; }
      if (text.length < 2 || text.length > 80) { await send(deps, chatId, 'contactBadName', {}, lang); return true; }
      await contactClassStep(deps, chatId, id, text);
      return true;
    case 'contact:class':
      await del();
      if (text === '/cancel') { await clearSession(db, chatId); await send(deps, chatId, 'cancelled', {}, lang); return true; }
      if (text.length > 40) { await send(deps, chatId, 'contactBadClass', {}, lang); return true; }
      await saveSession(db, chatId, 'contact:text', { ...sess.data, hint: text }, 15);
      await send(deps, chatId, 'contactText', {}, lang);
      return true;
    case 'contact:text':
      await del();
      if (text === '/cancel') { await clearSession(db, chatId); await send(deps, chatId, 'cancelled', {}, lang); return true; }
      if (!text || text.length > 1000) { await send(deps, chatId, 'contactBadText', {}, lang); return true; }
      await contactFinish(deps, chatId, id, sess, String(sess.data.name ?? ''), String(sess.data.hint ?? ''), text);
      return true;
    case 'reply': {
      await del();
      if (text === '/cancel') { await clearSession(db, chatId); await send(deps, chatId, 'cancelled', {}, lang); return true; }
      const reportId = String(sess.data.reportId ?? '');
      const [rep] = await db.select().from(contactReports).where(eq(contactReports.id, reportId)).limit(1);
      if (!rep || rep.teacherUserId !== id.userId || !text || text.length > 1000) { await clearSession(db, chatId); await send(deps, chatId, 'badCallback', {}, lang); return true; }
      await deps.api.sendMessage(rep.senderChatId, t('replyPrefix', lang) + text);
      await clearSession(db, chatId);
      await send(deps, chatId, 'replySent', {}, lang);
      return true;
    }
    default: return false;
  }
  return false;
}

// ─── callbacks ────────────────────────────────────────────────────────────────
async function onCallback(deps: BotDeps, cbq: NonNullable<TgUpdate['callback_query']>) {
  const { db, api } = deps;
  const data = cbq.data ?? '';
  const payload = verifyCb(data);
  const chatId = String(cbq.message?.chat.id ?? cbq.from.id);
  if (!payload) { await api.sendMessage(chatId, t('badCallback', 'ru')); return; }
  if (!rateOk(`cmd:${chatId}`, 20, 60_000)) { await send(deps, chatId, 'rateLimited', {}, 'ru'); return; }
  const id = await identify(db, chatId, 'ru');
  // the signed payload must belong to the acting account (§1)
  if ((payload.u || '') !== (id.userId ?? '')) { await api.sendMessage(chatId, t('badCallback', id.lang)); return; }

  switch (payload.a) {
    case 'lang': {
      const lang = (payload.l === 'uz' || payload.l === 'en' || payload.l === 'ru') ? payload.l as Lang : 'ru';
      if (id.userId) {
        await db.update(users).set({ locale: lang }).where(eq(users.id, id.userId));
        await applyMenu(api, id.role ?? 'basic', chatId);
      } else {
        const s = await loadSession(db, chatId);
        await saveSession(db, chatId, s?.state ?? '', { ...(s?.data ?? {}), lang }, 15);
      }
      await api.sendMessage(chatId, t('langSet', lang));
      return;
    }
    case 'sch':
      if (!id.userId) { await send(deps, chatId, 'needLink', {}, id.lang); return; }
      await renderSchedule(deps, chatId, id, payload.c ?? 'all', payload.r ?? 'week');
      return;
    case 'mat':
      if (id.role !== 'teacher') { await send(deps, chatId, 'denied', {}, id.lang); return; }
      await renderMaterials(deps, chatId, id, payload.c ?? '');
      return;
    case 'an':
      if (id.role !== 'teacher') { await send(deps, chatId, 'denied', {}, id.lang); return; }
      await announceAsk(deps, chatId, id, payload.c ?? '');
      return;
    case 'ansend':
      if (id.role !== 'teacher') { await send(deps, chatId, 'denied', {}, id.lang); return; }
      await announceSend(deps, chatId, id, payload.c ?? '');
      return;
    case 'ancancel':
      await clearSession(db, chatId);
      await send(deps, chatId, 'announceCancelled', {}, id.lang);
      return;
    case 'set': {
      if (id.role !== 'teacher' || !id.userId) { await send(deps, chatId, 'denied', {}, id.lang); return; }
      const kind = payload.c ?? '';
      if (!KIND_KEYS.includes(kind as typeof KIND_KEYS[number])) return;
      const prefs = await getPrefs(db, id.userId);
      const next = { ...prefs.kinds, [kind]: prefs.kinds[kind] === false };
      await db.insert(notificationPrefs).values({ userId: id.userId, kinds: next, quietFrom: prefs.quietFrom, quietTo: prefs.quietTo, channel: prefs.channel })
        .onConflictDoUpdate({ target: notificationPrefs.userId, set: { kinds: next } });
      await settings(deps, chatId, id);
      return;
    }
    case 'setq': {
      if (id.role !== 'teacher' || !id.userId) { await send(deps, chatId, 'denied', {}, id.lang); return; }
      const prefs = await getPrefs(db, id.userId);
      const [what, dir] = [String(payload.c ?? '').slice(0, 4), String(payload.c ?? '').endsWith('+1') ? 1 : -1];
      const key = what === 'from' ? 'quietFrom' : 'quietTo';
      const val = (((prefs[key as 'quietFrom' | 'quietTo'] + dir) % 24) + 24) % 24;
      await db.update(notificationPrefs).set({ [key]: val }).where(eq(notificationPrefs.userId, id.userId));
      await settings(deps, chatId, id);
      return;
    }
    case 'unblock':
      if (id.role !== 'teacher' || !id.userId) { await send(deps, chatId, 'denied', {}, id.lang); return; }
      await db.delete(contactBlocklist).where(and(eq(contactBlocklist.senderChatId, payload.c ?? ''), eq(contactBlocklist.blockedBy, id.userId)));
      await settings(deps, chatId, id);
      return;
    case 'ccls': {
      const s = await loadSession(db, chatId);
      if (!s || s.state !== 'contact:class') { await send(deps, chatId, 'dialogExpired', {}, id.lang); return; }
      // a picked class must belong to the student (§1)
      if (payload.c) {
        const cls = await visibleClasses(db, id);
        if (!cls.some((c) => c.id === payload.c)) { await send(deps, chatId, 'classNotFound', {}, id.lang); return; }
      }
      await saveSession(db, chatId, 'contact:text', { ...s.data, hint: payload.c ?? '', pickedClass: payload.c ?? '' }, 15);
      await send(deps, chatId, 'contactText', {}, id.lang);
      return;
    }
    case 'creply': {
      const [rep] = await db.select().from(contactReports).where(eq(contactReports.id, payload.r ?? '')).limit(1);
      if (!rep || rep.teacherUserId !== id.userId) { await api.sendMessage(chatId, t('badCallback', id.lang)); return; }
      await saveSession(db, chatId, 'reply', { reportId: rep.id }, 15);
      await send(deps, chatId, 'replyAsk', {}, id.lang);
      return;
    }
    case 'cblock': {
      const [rep] = await db.select().from(contactReports).where(eq(contactReports.id, payload.r ?? '')).limit(1);
      if (!rep || rep.teacherUserId !== id.userId) { await api.sendMessage(chatId, t('badCallback', id.lang)); return; }
      await db.insert(contactBlocklist).values({ senderChatId: rep.senderChatId, blockedBy: id.userId })
        .onConflictDoNothing();
      await send(deps, chatId, 'blockedNow', {}, id.lang);
      return;
    }
    default: return;
  }
}

// ─── legacy group /link (unchanged behaviour, §1: groups stay silent otherwise) ─
async function legacyGroupLink(deps: BotDeps, chatId: string, m: NonNullable<TgUpdate['message']>) {
  const { db } = deps;
  const code = ((m.text ?? '').split(/\s+/)[1] ?? '').toUpperCase();
  const loc: Lang = 'ru';
  if (!code) { await api0(deps, chatId, t('needCodeLocal', loc)); return; }
  const tgUserId = m.from?.id ?? 0;
  if (!(await deps.isGroupAdmin(chatId, tgUserId))) { await api0(deps, chatId, t('notAdminLocal', loc)); return; }
  const [personal] = await db.select({ userId: telegramLinks.userId }).from(telegramLinks).where(eq(telegramLinks.chatId, String(tgUserId))).limit(1);
  if (!personal) { await api0(deps, chatId, t('needPersonalLocal', loc)); return; }
  const rows = await db.select().from(classLinkTokens).where(and(eq(classLinkTokens.tokenHash, hashToken(code)), gt(classLinkTokens.expiresAt, new Date()))).limit(1);
  const tokenRow = rows[0];
  if (!tokenRow) { await api0(deps, chatId, t('badCodeLocal', loc)); return; }
  await db.delete(classLinkTokens).where(eq(classLinkTokens.tokenHash, tokenRow.tokenHash));
  await db.insert(classTelegramChats).values({ classId: tokenRow.classId, chatId, linkedBy: personal.userId })
    .onConflictDoUpdate({ target: [classTelegramChats.classId, classTelegramChats.chatId], set: { linkedBy: personal.userId, linkedAt: new Date() } });
  audit(db, personal.userId, 'telegram_group_link', { classId: tokenRow.classId, chatId });
  await api0(deps, chatId, t('okGroupLocal', loc));
}
const api0 = async (deps: BotDeps, chatId: string, text: string) => { await deps.api.sendMessage(chatId, text); };
// group /link texts (kept from the old bot)
const G: Record<string, Loc> = {
  needCodeLocal: { ru: 'Используйте /link <код> — код создаётся в интерфейсе класса.', uz: '/link <kod> ishlating — kod sinf interfeysida yaratiladi.', en: 'Use /link <code> — the code is created in the class UI.' },
  notAdminLocal: { ru: 'Команду /link может выполнять только администратор группы.', uz: '/link buyrug‘ini faqat guruh administratori bajara oladi.', en: 'Only a group administrator can run /link.' },
  needPersonalLocal: { ru: 'Сначала привяжите личный Telegram в профиле BluBlu.', uz: 'Avval proilda shaxsiy Telegramni boglang.', en: 'First link your personal Telegram in the BluBlu profile.' },
  badCodeLocal: { ru: 'Код привязки не найден или истёк.', uz: 'Bog‘lash kodi topilmadi yoki eskirgan.', en: 'Link code not found or expired.' },
  okGroupLocal: { ru: 'Группа привязана к классу. Уведомления будут приходить сюда.', uz: 'Guruh sinfga bog‘landi. Bildirishnomalar shu yerga keladi.', en: 'The group is linked to the class. Notifications will arrive here.' },
};
for (const k of Object.keys(G)) (T as Record<string, Loc>)[k] = G[k as keyof typeof G]!;
