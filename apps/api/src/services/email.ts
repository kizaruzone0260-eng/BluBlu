/**
 * Часть F (2026-10-16): отправка писем. Один интерфейс `EmailTransport`, пять реализаций и один
 * включатель `EMAIL_PROVIDER` — ровно как `TELEGRAM_TRANSPORT` выбирает между настоящим Bot API
 * и записывающим логом, и по той же причине: проверка «письмо отправилось» должна исполнять
 * НАСТОЯЩИЙ код отправки, а не mock самого себя.
 *
 * Что общего у всех реализаций: `send` либо завершается, либо бросает `EmailSendError` с КОРОТКОЙ
 * причиной. Причина уходит в лог только через `safeErrorMessage` и никогда не содержит ни ключа
 * провайдера, ни кода, ни тела ответа провайдера (эхо запроса — это персональные данные).
 */
import { maskEmail } from '@klass/shared';
import { env, type Env } from '../env.js';
import { sendMail, type SmtpMessage } from '../lib/smtp.js';

export type EmailProvider = 'none' | 'console' | 'brevo' | 'resend' | 'smtp';

export interface EmailMessage {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html: string;
  /**
   * Только для `console`: строка, которую человек должен увидеть глазами, потому что письмо никуда
   * не летит (код подтверждения). Остальные провайдеры её игнорируют — она НЕ часть письма.
   */
  consoleLine?: string;
}

export interface EmailTransport {
  readonly provider: EmailProvider;
  /** Бросает `EmailSendError` при отказе; resolve = провайдер принял письмо. */
  send(message: EmailMessage): Promise<void>;
}

/** Короткая причина без секретов: именно её печатает `server.ts` и именно её даёт тест. */
export class EmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailSendError';
  }
}

/**
 * `none` — выключатель по умолчанию. Отправка через него невозможна ПО КОНСТРУКЦИИ: код
 * регистрации создаётся только когда провайдер есть, а если кто-то вызовет `send` на заглушке,
 * это баг вызывающего, и он обязан упасть громко, а не «успешно отправить в никуда».
 */
export class NoneEmailTransport implements EmailTransport {
  readonly provider = 'none' as const;
  async send(): Promise<void> {
    throw new EmailSendError('почта выключена (EMAIL_PROVIDER=none)');
  }
}

/**
 * Консольный провайдер: письмо НЕ уходит, а одна строка с кодом печатается в stdout. Это и
 * рабочий режим для разработки без почтового ящика, и то, чем проверяется весь тракт в тестах.
 * Строка собирается через `process.stdout.write` (не `console.*`): инвентарь печатных мест
 * (`test/unit/no-raw-error-logging.test.ts`) считает `console`, а разработчику нужен вывод.
 */
export class ConsoleEmailTransport implements EmailTransport {
  readonly provider = 'console' as const;
  /** всё, что «отправилось» с момента создания транспорта — то, на что смотрит тест */
  readonly sent: EmailMessage[] = [];
  constructor(private readonly write: (line: string) => void = (s) => process.stdout.write(s)) {}
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    const code = message.consoleLine ? ` — ${message.consoleLine}` : '';
    // адрес маскируется: полной почты в dev-логе быть не нужно, а лог переживает разработку
    this.write(`email(console) → ${maskEmail(message.to)} · ${message.subject}${code}\n`);
  }
}

/** POST на JSON-API провайдера. Один код на Brevo и Resend: различаются только форма и заголовок. */
async function post(provider: string, url: string, headers: Record<string, string>,
  body: unknown, timeoutMs: number): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new EmailSendError(`${provider}: сеть/таймаут (${e instanceof Error ? e.name : 'unknown'})`);
  }
  if (!res.ok) {
    // НИКОГДА не тело ответа: провайдеры возвращают эхо запроса, то есть адресата и письмо
    throw new EmailSendError(`${provider}: HTTP ${res.status}`);
  }
  try { await res.body?.cancel(); } catch { /* уже прочитано */ }
}

export class BrevoEmailTransport implements EmailTransport {
  readonly provider = 'brevo' as const;
  constructor(private readonly o: { key: string; from: string; fromName: string; replyTo: string; timeoutMs: number }) {}
  async send(m: EmailMessage): Promise<void> {
    await post('brevo', 'https://api.brevo.com/v3/smtp/email', { 'api-key': this.o.key }, {
      sender: { name: this.o.fromName, email: this.o.from },
      to: [{ email: m.to, name: m.toName ?? '' }],
      ...(this.o.replyTo ? { replyTo: { email: this.o.replyTo } } : {}),
      subject: m.subject,
      htmlContent: m.html,
      textContent: m.text,
    }, this.o.timeoutMs);
  }
}

export class ResendEmailTransport implements EmailTransport {
  readonly provider = 'resend' as const;
  constructor(private readonly o: { key: string; from: string; fromName: string; replyTo: string; timeoutMs: number }) {}
  async send(m: EmailMessage): Promise<void> {
    await post('resend', 'https://api.resend.com/emails', { authorization: `Bearer ${this.o.key}` }, {
      from: `${this.o.fromName} <${this.o.from}>`,
      to: [m.toName ? `${m.toName} <${m.to}>` : m.to],
      ...(this.o.replyTo ? { reply_to: this.o.replyTo } : {}),
      subject: m.subject,
      html: m.html,
      text: m.text,
    }, this.o.timeoutMs);
  }
}

export class SmtpEmailTransport implements EmailTransport {
  readonly provider = 'smtp' as const;
  constructor(private readonly o: {
    host: string; port: number; user: string; pass: string; security: 'starttls' | 'tls' | 'plain';
    heloName: string; from: string; fromName: string; replyTo: string; timeoutMs: number;
  }) {}
  async send(m: EmailMessage): Promise<void> {
    const message: SmtpMessage = {
      from: this.o.from,
      fromName: this.o.fromName,
      ...(this.o.replyTo ? { replyTo: this.o.replyTo } : {}),
      to: m.to,
      ...(m.toName ? { toName: m.toName } : {}),
      subject: m.subject,
      text: m.text,
      html: m.html,
    };
    try {
      await sendMail({
        host: this.o.host, port: this.o.port, user: this.o.user, password: this.o.pass,
        security: this.o.security, heloName: this.o.heloName, timeoutMs: this.o.timeoutMs,
      }, message);
    } catch (e) {
      // SmtpError уже короткий и без секретов; чужую ошибку не переносим строкой целиком
      throw new EmailSendError(e instanceof Error ? e.message : 'smtp: неизвестная ошибка');
    }
  }
}

/** Выбор провайдера по конфигу. Отдельная функция — её видно в тесте без запуска процесса. */
export function createEmailTransport(e: Env = env, write?: (line: string) => void): EmailTransport {
  switch (e.EMAIL_PROVIDER) {
    case 'none':
      return new NoneEmailTransport();
    case 'console':
      return new ConsoleEmailTransport(write);
    case 'brevo':
      return new BrevoEmailTransport({
        key: e.BREVO_API_KEY, from: e.EMAIL_FROM, fromName: e.EMAIL_FROM_NAME,
        replyTo: e.EMAIL_REPLY_TO, timeoutMs: e.EMAIL_TIMEOUT_MS,
      });
    case 'resend':
      return new ResendEmailTransport({
        key: e.RESEND_API_KEY, from: e.EMAIL_FROM, fromName: e.EMAIL_FROM_NAME,
        replyTo: e.EMAIL_REPLY_TO, timeoutMs: e.EMAIL_TIMEOUT_MS,
      });
    case 'smtp':
      return new SmtpEmailTransport({
        host: e.SMTP_HOST, port: e.SMTP_PORT, user: e.SMTP_USER, pass: e.SMTP_PASS,
        security: e.SMTP_SECURITY, heloName: e.SMTP_HELO_NAME, from: e.EMAIL_FROM,
        fromName: e.EMAIL_FROM_NAME, replyTo: e.EMAIL_REPLY_TO, timeoutMs: e.EMAIL_TIMEOUT_MS,
      });
  }
}

/**
 * Подтверждение почты включено ТОГДА, когда есть провайдер. Второго выключателя намеренно нет:
 * одна переменная означает и «письма ходят», и «регистрация требует код», и расхождение между
 * ними невозможно. При `none` регистрация остаётся прежней — байт-в-байт.
 */
export function emailVerificationEnabled(e: Env = env): boolean {
  return e.EMAIL_PROVIDER !== 'none';
}
