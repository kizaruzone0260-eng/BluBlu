/**
 * Часть F (2026-10-16): письмо с кодом подтверждения почты. Тексты живут ЗДЕСЬ, а не в `apps/api`,
 * по той же причине, что и правила черновика: это чистые функции, их проверяет тест, и они
 * обязаны быть на трёх языках одинаковыми по смыслу, а не «переведены где дошли руки».
 *
 * Язык письма выбирает ЗАПРОСИВШИЙ (переключатель языка на экране регистрации), а не язык
 * аккаунта: аккаунта ещё нет. Поэтому `locale` приходит аргументом, а фолбэк — продуктовый
 * `DEFAULT_LOCALE`.
 *
 * Имя и фамилия в письмо берёт человек, который их только что ввёл, и они УЖЕ попадают в HTML.
 * Экранирование — не косметика: без него поле «Фамилия» становится местом, куда чужой код
 * влезает в письмо, которое Почта показывает как HTML.
 */
import { APP_NAME, DEFAULT_LOCALE, type Locale } from './constants.js';
import { EMAIL_CODE_LENGTH, EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_TTL_MS } from './emailCode.js';

export interface EmailCopy {
  subject: string;
  greeting: string;
  /** «вы запросили регистрацию в …» */
  requested: string;
  codeLabel: string;
  validFor: string;
  attempts: string;
  notYou: string;
  footer: string;
}

const MINUTES = Math.round(EMAIL_CODE_TTL_MS / 60_000);

export const EMAIL_COPY: Record<Locale, EmailCopy> = {
  ru: {
    subject: `Подтвердите адрес почты — ${APP_NAME}`,
    greeting: 'Здравствуйте',
    requested: `Вы запросили регистрацию в ${APP_NAME}. Чтобы подтвердить адрес, введите этот код на экране регистрации:`,
    codeLabel: 'Код подтверждения',
    validFor: `Код действителен ${MINUTES} минут.`,
    attempts: `Не больше ${EMAIL_CODE_MAX_ATTEMPTS} попыток ввода: после пятой ошибки код перестанет приниматься, и потребуется новый.`,
    notYou: 'Если вы этого не запрашивали, просто проигнорируйте письмо — адрес останется незанятым.',
    footer: `${APP_NAME} — письмо отправлено автоматически, отвечать на него не нужно.`,
  },
  uz: {
    subject: `Pochta manzilini tasdiqlang — ${APP_NAME}`,
    greeting: 'Assalomu alaykum',
    requested: `${APP_NAME}da roʻyxatdan oʻtishni soʻragansiz. Manzilni tasdiqlash uchun ushbu kodni roʻyxatdan oʻtish oynasiga kiriting:`,
    codeLabel: 'Tasdiqlash kodi',
    validFor: `Kod ${MINUTES} daqiqa amal qiladi.`,
    attempts: `Koʻpi bilan ${EMAIL_CODE_MAX_ATTEMPTS} marta urinish: beshinchi xatodan keyin kod qabul qilmaydi va yangi kod soʻrash kerak boʻladi.`,
    notYou: 'Buni siz soʻramagan boʻlsangiz, xatni shunchaki eʼtiborsiz qoldiring — manzil band boʻlmay qoladi.',
    footer: `${APP_NAME} — xat avtomatik yuborildi, javob berish shart emas.`,
  },
  en: {
    subject: `Confirm your email address — ${APP_NAME}`,
    greeting: 'Hello',
    requested: `You asked to create an account in ${APP_NAME}. To confirm this address, enter this code on the registration screen:`,
    codeLabel: 'Confirmation code',
    validFor: `The code is valid for ${MINUTES} minutes.`,
    attempts: `At most ${EMAIL_CODE_MAX_ATTEMPTS} tries: after a fifth mistake the code stops being accepted and a new one is required.`,
    notYou: "If you didn't request this, just ignore the message — the address stays free.",
    footer: `${APP_NAME} — this message was sent automatically, no need to reply.`,
  },
};

export function emailCopyFor(locale: string | undefined): EmailCopy {
  return EMAIL_COPY[(locale as Locale) in EMAIL_COPY ? (locale as Locale) : DEFAULT_LOCALE];
}

/** Экранирование HTML: имя и фамилия приходят от посетителя и попадают в письмо как HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface VerificationEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Письмо с кодом. `code` сюда приходит уже готовый шестизначный: шаблон не генерирует его и не
 * хранит — за код отвечает сервис, а здесь только то, что увидит человек.
 */
export function buildVerificationEmail(args: {
  locale?: string;
  firstName: string;
  lastName: string;
  code: string;
}): VerificationEmail {
  const c = emailCopyFor(args.locale);
  const name = [args.firstName, args.lastName].map((s) => s.trim()).filter(Boolean).join(' ');
  const greeting = name ? `${c.greeting}, ${name}!` : `${c.greeting}!`;
  const spaced = args.code.split('').join(' ');

  const text = [
    greeting,
    '',
    c.requested,
    '',
    `${c.codeLabel}: ${spaced}`,
    '',
    c.validFor,
    c.attempts,
    '',
    c.notYou,
    '',
    c.footer,
  ].join('\n');

  const html = [
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">',
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(c.requested)}</p>`,
    `<p style="font-size:24px;letter-spacing:6px;font-weight:700">${escapeHtml(spaced)}</p>`,
    `<p>${escapeHtml(c.codeLabel)}</p>`,
    `<p>${escapeHtml(c.validFor)} ${escapeHtml(c.attempts)}</p>`,
    `<p>${escapeHtml(c.notYou)}</p>`,
    `<p style="color:#666;font-size:12px">${escapeHtml(c.footer)}</p>`,
    '</body></html>',
  ].join('');

  return { subject: c.subject, text, html };
}

