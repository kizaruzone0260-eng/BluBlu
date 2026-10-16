import { createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  EMAIL_CODE_LENGTH, EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_RETENTION_MS, EMAIL_CODE_TTL_MS,
  EMAIL_RESEND_COOLDOWN_MS, buildVerificationEmail, codeExpiresAtMs, consumeVerdict,
  emailCopyFor, isSixDigitCode, maskEmail, normalizeEmailCode, resendGate, escapeHtml,
} from '@klass/shared';
import { ConsoleEmailTransport, createEmailTransport, type EmailMessage } from '../../src/services/email.js';
import { buildMessage, sendMail, SmtpError } from '../../src/lib/smtp.js';

/*
 * Часть F (2026-10-16): то, что проверяется БЕЗ живого провайдера и без почты. Правила кода —
 * чистые (`@klass/shared`), выбор транспорта — чистая функция от конфигурации, а SMTP-клиент
 * говорит с настоящей TCP-куклой, которую этот же тест и поднимает: разговор виден по байтам,
 * поэтому «провайдер smtp» — не обещание, а проверенный набор реплик.
 */

const NOW = 1_800_000_000_000;

describe('правила кода подтверждения', () => {
  it('числа соответствуют документу: 6 цифр, 15 минут, 5 попыток, пауза минуты, сутки уборки', () => {
    expect(EMAIL_CODE_LENGTH).toBe(6);
    expect(EMAIL_CODE_TTL_MS).toBe(15 * 60_000);
    expect(EMAIL_CODE_MAX_ATTEMPTS).toBe(5);
    expect(EMAIL_RESEND_COOLDOWN_MS).toBe(60_000);
    expect(EMAIL_CODE_RETENTION_MS).toBe(24 * 3600_000);
  });

  it('нормализация срезает пробелы и дефисы, но не превращает буквы в цифры', () => {
    expect(normalizeEmailCode(' 12 34 56 ')).toBe('123456');
    expect(normalizeEmailCode('12-34-56')).toBe('123456');
    expect(isSixDigitCode(normalizeEmailCode('12 34 5a'))).toBe(false);
    expect(isSixDigitCode('123456')).toBe(true);
    expect(isSixDigitCode('12345')).toBe(false);
    expect(isSixDigitCode('000000')).toBe(true);
  });

  it('край срока = отправка + 15 минут', () => {
    expect(codeExpiresAtMs(NOW)).toBe(NOW + EMAIL_CODE_TTL_MS);
  });

  it('вердикт попыток расставляет приоритеты: использован > истёк > потолок > жив', () => {
    const row = (over: Partial<{ attempts: number; usedAt: number | null; expiresAt: number }>) => ({
      attempts: 0, usedAt: null, expiresAt: NOW + 60_000, ...over,
    });
    expect(consumeVerdict(row({}), NOW)).toBe('live');
    expect(consumeVerdict(row({ usedAt: NOW }), NOW)).toBe('used');
    expect(consumeVerdict(row({ expiresAt: NOW }), NOW)).toBe('expired');      // ровно в край — уже нет
    expect(consumeVerdict(row({ attempts: EMAIL_CODE_MAX_ATTEMPTS }), NOW)).toBe('attempts');
    // исчерпанный потолок важнее «живого» срока, но НЕ важнее истёкшего: порядок проверяется
    expect(consumeVerdict(row({ attempts: 9, expiresAt: NOW - 1 }), NOW)).toBe('expired');
  });

  it('пауза между письмами: ровно 60 с, наружу — целые секунды retry-after', () => {
    expect(resendGate(null, NOW)).toEqual({ allowed: true });
    expect(resendGate(NOW - EMAIL_RESEND_COOLDOWN_MS, NOW)).toEqual({ allowed: true });
    const early = resendGate(NOW - 59_000, NOW);
    expect(early.allowed).toBe(false);
    expect(early.allowed === false && early.retryAfterSec).toBe(1);
    expect(resendGate(NOW, NOW)).toEqual({ allowed: false, retryAfterSec: 60 });
  });

  it('маска адреса не оставляет полной почты в журнале, но домен сохраняет', () => {
    expect(maskEmail('aliya@school.uz')).toBe('al***@school.uz');
    // короткий локальный часть не масштабуем: два символа и так всё, что осталось
    expect(maskEmail('ab@school.uz')).toBe('ab*@school.uz');
    expect(maskEmail('no-at-sign')).toBe('**********');
    expect(maskEmail('')).toBe('');
    expect(maskEmail('aliya@school.uz')).not.toContain('aliya');
  });
});

describe('письмо на трёх языках', () => {
  const args = { firstName: 'Алия', lastName: 'Каримова', code: '004213' };

  it('каждый язык отдаёт свой непустой subject/text/html и тот же код', () => {
    const seen = new Set<string>();
    for (const locale of ['ru', 'uz', 'en'] as const) {
      const m = buildVerificationEmail({ ...args, locale });
      expect(m.subject.length, locale).toBeGreaterThan(5);
      expect(m.text.includes('0 0 4 2 1 3'), locale).toBe(true);   // код разбит для чтения с экрана
      expect(m.html.includes('0 0 4 2 1 3'), locale).toBe(true);
      expect(m.text.includes(args.firstName), locale).toBe(true);
      expect(m.html.includes(`${args.firstName} ${args.lastName}`), locale).toBe(true);
      seen.add(m.subject);
    }
    expect(seen.size, 'заголовки обязаны различаться').toBe(3);
  });

  it('неизвестный язык — продуктовый английский, а не падение и не русский', () => {
    const m = buildVerificationEmail({ ...args, locale: 'zz' });
    expect(m.subject).toBe(buildVerificationEmail({ ...args, locale: 'en' }).subject);
    expect(emailCopyFor(undefined).greeting).toBe(emailCopyFor('en').greeting);
  });

  it('экранирование: имя-разметка не становится разметкой письма', () => {
    const evil = '<script>alert(1)</script>';
    const m = buildVerificationEmail({ firstName: evil, lastName: '', code: '123456', locale: 'en' });
    expect(m.html).not.toContain('<script>alert(1)</script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(escapeHtml('&"\'<>')).toBe('&amp;&quot;&#39;&lt;&gt;');
  });

  it('пустое имя не рождает «Здравствуйте, »', () => {
    const m = buildVerificationEmail({ firstName: '', lastName: '', code: '123456', locale: 'ru' });
    expect(m.text.startsWith('Здравствуйте!')).toBe(true);
  });
});

describe('выбор транспорта по конфигурации', () => {
  const base = {
    EMAIL_FROM: 'noreply@school.uz', EMAIL_FROM_NAME: 'School', EMAIL_REPLY_TO: '',
    EMAIL_TIMEOUT_MS: 5000, BREVO_API_KEY: '', RESEND_API_KEY: '',
    SMTP_HOST: '', SMTP_PORT: 587, SMTP_SECURITY: 'starttls', SMTP_USER: '', SMTP_PASS: '',
    SMTP_HELO_NAME: 'school.uz',
  } as never as Parameters<typeof createEmailTransport>[0];

  it('каждый провайдер даёт свой транспорт, none — заглушку', () => {
    for (const p of ['none', 'console', 'brevo', 'resend', 'smtp'] as const) {
      const t = createEmailTransport({ ...base, EMAIL_PROVIDER: p } as never);
      expect(t.provider, p).toBe(p);
    }
  });

  it('заглушка none отказывается отправлять, а не «успешно» молчит', async () => {
    const t = createEmailTransport({ ...base, EMAIL_PROVIDER: 'none' } as never);
    await expect(t.send({ to: 'a@b.c', subject: 's', text: 't', html: 'h' })).rejects.toThrow(/EMAIL_PROVIDER=none/);
  });

  it('console пишет маску адреса, полный адрес в stdout не попадает', async () => {
    const lines: string[] = [];
    const t = new ConsoleEmailTransport((s) => lines.push(s));
    const m: EmailMessage = {
      to: 'aliya@school.uz', subject: 'Тема', text: 'body', html: '<p>body</p>', consoleLine: '004213',
    };
    await t.send(m);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('al***@school.uz');
    expect(lines[0]).not.toContain('aliya@school.uz');
    expect(lines[0]).toContain('004213');
    expect(t.sent).toEqual([m]);
  });
});

/*
 * Кукла вместо живого сервера: настоящий TCP, настоящий разговор по строкам. Проверяет ровно то,
 * за что иначе пришлось бы ручаться на слово, — порядок реплик, base64 в AUTH, terminator после
 * DATA и то, что тело доезжает целым.
 */
function fakeSmtpServer(onQuit: () => void) {
  const received: string[] = [];
  const state = { authStep: 0 as 0 | 1 | 2, user: '', pass: '', body: '' };
  const server = createServer((sock: Socket) => {
    let buf = '';
    let inData = false;
    sock.on('error', () => { /* клиент вправе оборвать разговор — нас интересует только принятая часть */ });
    sock.write('220 fake.example.com ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // строка могла прийти по частям: разбираем только завершённые, остаток ждёт следующий chunk
      for (;;) {
        const at = buf.indexOf('\r\n');
        if (at < 0) return;
        const line = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 2.0.0 queued\r\n'); continue; }
          state.body += line + '\n';
          continue;
        }
        received.push(line);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) {
          sock.write('250-fake.example.com\r\n250-SIZE 10485760\r\n250 AUTH LOGIN PLAIN\r\n');
        } else if (up === 'AUTH LOGIN') {
          state.authStep = 1; sock.write('334 VXNlcm5hbWU6\r\n');
        } else if (state.authStep === 1) {
          state.user = line; state.authStep = 2; sock.write('334 UGFzc3dvcmQ6\r\n');
        } else if (state.authStep === 2) {
          state.pass = line; state.authStep = 0; sock.write('235 2.7.0 authenticated\r\n');
        } else if (up.startsWith('MAIL FROM')) {
          sock.write('250 2.1.0 ok\r\n');
        } else if (up.startsWith('RCPT TO')) {
          sock.write('250 2.1.5 ok\r\n');
        } else if (up === 'DATA') {
          inData = true; sock.write('354 go ahead\r\n');
        } else if (up === 'QUIT') {
          sock.write('221 bye\r\n'); onQuit(); sock.end();
        } else {
          sock.write('250 ok\r\n');
        }
      }
    });
  });
  return { server, received, state };
}

describe('smtp-клиент: разговор с куклой', () => {
  it('проходит EHLO → AUTH LOGIN → MAIL FROM → RCPT TO → DATA → QUIT и доставляет тело', async () => {
    let quitSeen = false;
    const { server, received, state } = fakeSmtpServer(() => { quitSeen = true; });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      await sendMail(
        {
          host: '127.0.0.1', port, user: 'user-name', password: 'secret-pass', security: 'plain',
          heloName: 'school.uz', timeoutMs: 5000,
        },
        {
          from: 'noreply@school.uz', fromName: 'Школа', to: 'aliya@school.uz', toName: 'Алия',
          subject: 'Подтвердите почту', text: 'Код: 004213', html: '<p>Код: 004213</p>',
        },
      );
      // `QUIT` уходит через `end()`, и сервер читает его асинхронно: без этого тика проверка
      // последней реплики зависела бы от планировщика
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      server.close();
    }
    // реплики, которые обязан увидеть серверный конец: список наполняется асинхронно, поэтому
    // читается ПОСЛЕ отправки, а не до
    const wire = received.map((l) => l + '\r\n').join('');
    expect(wire).toMatch(/^EHLO school\.uz\r\n/);
    expect(wire).toContain('AUTH LOGIN\r\n');
    expect(wire).toContain('MAIL FROM:<noreply@school.uz>\r\n');
    expect(wire).toContain('RCPT TO:<aliya@school.uz>\r\n');
    expect(wire).toContain('DATA\r\n');
    expect(wire).toMatch(/QUIT\r\n$/);
    expect(quitSeen, 'клиент обязан закрыть разговор, а не бросить соединение').toBe(true);
    // base64-пароль доехал и сервер смог его раскодировать: это и есть проверка формы AUTH LOGIN
    expect(Buffer.from(state.user, 'base64').toString('utf8')).toBe('user-name');
    expect(Buffer.from(state.pass, 'base64').toString('utf8')).toBe('secret-pass');
    // тело письма дошло целым: base64-строка декодируется обратно в русский текст
    const decoded = state.body.split('\n').map((line) => {
      try { return Buffer.from(line.trim(), 'base64').toString('utf8'); } catch { return ''; }
    }).join('\n');
    expect(decoded).toContain('Код: 004213');
    expect(state.body).toMatch(/^Date: /m);
    expect(state.body).toMatch(/^Subject: =\?UTF-8\?B\?/m);
  }, 20_000);

  it('сервер без STARTTLS при configured starttls — короткая ошибка, а не тихий plain', async () => {
    const { server } = fakeSmtpServer(() => undefined);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    // EHLO куклы не объявляет STARTTLS? объявляет только AUTH — значит этот путь обязан отвалиться
    let err: unknown;
    try {
      await sendMail({
        host: '127.0.0.1', port, security: 'starttls', heloName: 'school.uz', timeoutMs: 5000,
      }, { from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't', html: 'h' });
    } catch (e) { err = e; }
    server.close();
    expect(err).toBeInstanceOf(SmtpError);
    expect(String((err as Error).message)).toMatch(/STARTTLS/);
  }, 20_000);

  it('заголовки кодируются по RFC 2047, а тело остаётся base64: ни одной голой не-ASCII строки', () => {
    const raw = buildMessage({
      from: 'noreply@school.uz', to: 'aliya@school.uz', subject: 'Подтвердите почту',
      text: 'Код: 004213', html: '<p>Код: 004213</p>',
    });
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=/m);
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="');
    const first = /Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=]+)/.exec(raw);
    expect(first, 'base64-часть обязана найтись').not.toBeNull();
    expect(Buffer.from(first![1]!, 'base64').toString('utf8')).toContain('004213');
    // ни одного «голого» не-ASCII в заголовках: все русские слова уехали в encoded-word
    const headers = raw.slice(0, raw.indexOf('\r\n\r\n'));
    // eslint-disable-next-line no-control-regex
    expect(headers).toMatch(/^[\x20-\x7E\r\n]*$/);
  });
});
