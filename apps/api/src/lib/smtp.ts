/**
 * Часть F (2026-10-16): минимальный SMTP-клиент для провайдера `smtp`.
 *
 * Почему свои строки, а не `nodemailer`: этот проект собирает `pnpm audit` как БЛОКИРУЮЩИЙ шаг
 * (часть C4), и каждый новый пакет в `dependencies` — чужой код, который CI потом обязан
 * переживать. Разговор, который здесь ведётся, короткий: greeting → EHLO → STARTTLS →
 * AUTH LOGIN → MAIL FROM → RCPT TO → DATA → QUIT. Реализация умещается в один файл и, главное,
 * ПРОВЕРЯЕТСЯ без живого сервера: тест поднимает настоящую TCP-куклу на 127.0.0.1 и сверяет
 * реплики.
 *
 * Чего здесь сознательно нет: PIPELINING, SIZE, 8BITMIME, CHUNKING, OAuth, нескольких
 * получателей в одном соединении, повторной попытки на другом хосте. Есть ровно то, что нужно
 * одному письму с кодом подтверждения.
 */
import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export interface SmtpMessage {
  from: string;
  fromName?: string;
  replyTo?: string;
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html: string;
}

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  /**
   * 'starttls' — обычный порт 587 (сервер обязан объявить STARTTLS, иначе ошибка),
   * 'tls' — порт 465 (соединение с первого байта зашифровано),
   * 'plain' — без шифрования: только локальная кукла и явно выбранная владельцем конфигурация.
   */
  security: 'starttls' | 'tls' | 'plain';
  /** Имя клиента в EHLO: почтовые серверы требуют FQDN, а не «localhost». */
  heloName: string;
  /** Предельный срок ВСЕЙ отправки, а не одного ответа: зависший шаг не должен держать процесс. */
  timeoutMs: number;
}

/** Ошибка всегда КОРОТКАЯ и без секретов: код ответа и его текст, не пароль и не тело письма. */
export class SmtpError extends Error {
  constructor(message: string) {
    super(`smtp: ${message}`);
    this.name = 'SmtpError';
  }
}

const CRLF = '\r\n';

/** Заголовки не переносят сырые не-ASCII — RFC 2047 encoded-word. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function addressLine(email: string, name?: string): string {
  return name ? `${encodeHeader(name)} <${email}>` : email;
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** Готовое письмо: `multipart/alternative`, обе части в base64 — безопасно для UTF-8 без квотинга. */
export function buildMessage(m: SmtpMessage): string {
  const boundary = `----=_Part_${b64(`${Date.now()}${m.to}`).replace(/[=+/]/g, '')}`;
  const head = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${addressLine(m.from, m.fromName)}`,
    `To: ${addressLine(m.to, m.toName)}`,
    ...(m.replyTo ? [`Reply-To: ${addressLine(m.replyTo)}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(m.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(m.html),
    `--${boundary}--`,
  ];
  return [...head, '', ...parts].join(CRLF);
}

interface LineBuffer {
  data: string;
  listeners: Set<() => void>;
  onError: ((e: Error) => void) | null;
}

function attach(sock: Socket | TLSSocket): LineBuffer {
  const buffer: LineBuffer = { data: '', listeners: new Set(), onError: null };
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buffer.data += chunk;
    for (const l of [...buffer.listeners]) l();
  });
  sock.on('error', (e) => { buffer.onError?.(e); });
  return buffer;
}

/**
 * Ждать ОДНУ завершенную реплику: многострочный ответ («250-foo», «250 OK») кончается строкой
 * с ПРОБЕЛОМ после кода. Проверка идёт по Полным строкам (после CRLF), а съеденный ответ
 * убирается из буфера — иначе следующий шаг увидел бы код предыдущего.
 * Класс ответа сверяется по первой цифре: 2xx везде, кроме 3xx на AUTH/STARTTLS-пороге/Data —
 * так клиент переживает малоизвестные формулировки серверов, не теряя главного.
 */
function readReply(buffer: LineBuffer, classDigit: string): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    const onData = () => {
      const lines = buffer.data.split(CRLF);
      let i = 0;
      // последняя часть после последнего CRLF ещё не завершена — её не читаем
      while (i <= lines.length - 2) {
        const line = lines[i] as string;
        if (!/^\d{3}[ -]/.test(line)) {
          cleanup();
          reject(new SmtpError(`непонятный ответ сервера: ${line.slice(0, 80)}`));
          return;
        }
        const code = Number(line.slice(0, 3));
        const sep = line[3];
        i += 1;
        if (sep !== ' ') continue;                                 // «250-…» — ещё не конец
        const text = lines.slice(0, i).join(CRLF);
        buffer.data = lines.slice(i).join(CRLF);
        cleanup();
        if (String(code)[0] !== classDigit) reject(new SmtpError(`сервер ответил ${code}: ${line.slice(4, 80)}`));
        else resolve({ code, text });
        return;
      }
    };
    const onError = (e: Error) => { cleanup(); reject(new SmtpError(`соединение: ${e.message}`)); };
    const cleanup = () => {
      buffer.listeners.delete(onData);
      if (buffer.onError === onError) buffer.onError = null;
    };
    buffer.listeners.add(onData);
    buffer.onError = onError;
    // ответ мог успеть лечь в буфер ПЕРЕД подпиской: быстрый локальный сервер и любой
    // «ответ+ещё один ответ в одном TCP-сегменте» дают ровно такой случай, и без этого вызова
    // клиент бы ждал данных, которые уже лежат
    onData();
  });
}

function writeLine(sock: Socket | TLSSocket, line: string): void {
  sock.write(line + CRLF);
}

/**
 * Разговор целиком. Бросает `SmtpError` с короткой причиной; сокет закрывается в любом случае.
 */
export function sendMail(opts: SmtpOptions, message: SmtpMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    let sock: Socket | TLSSocket | null = null;
    let settled = false;
    const stop = (e?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(total);
      if (e === undefined) {
        // успех: сокет УЖЕ получил `end('QUIT')`, разрушать его сейчас — значит отбросить
        // неотправленный байт; это сделает таймер на 50 мс ниже
        resolve();
        return;
      }
      try { sock?.destroy(); } catch { /* уже закрыт */ }
      reject(e instanceof Error ? e : new SmtpError(String(e)));
    };
    const total = setTimeout(() => stop(new SmtpError('отправка прервана по таймауту')), opts.timeoutMs);

    const expect = (buffer: LineBuffer, classDigit: string) =>
      readReply(buffer, classDigit).catch((e: Error) => { stop(e); throw e; });

    const converse = async (socket: Socket | TLSSocket) => {
      sock = socket;
      let buffer = attach(socket);
      const ask = async (line: string | null, classDigit: string) => {
        // ответ может прийти ДО записи (сервер болтлив), поэтому ждём, а потом пишем: порядок
        // внутри одного шага не важен, важен между шагами
        if (line !== null) writeLine(socket, line);
        return expect(buffer, classDigit);
      };

      await expect(buffer, '2');                                   // приветствие
      const ehlo = await ask(`EHLO ${opts.heloName}`, '2');
      // возможности сервера читаются ИЗ ТЕКСТА ОТВЕТА: съеденный ответ убран из буфера,
      // поэтому `buffer.data` про STARTTLS ничего бы не рассказал
      const advertisesStarttls = () => /250[- ]starttls/i.test(ehlo.text);

      if (opts.security === 'starttls') {
        if (!advertisesStarttls()) throw new SmtpError('сервер не объявил STARTTLS, а настроен starttls');
        await ask('STARTTLS', '2');
        const upgraded = await new Promise<TLSSocket>((res, rej) => {
          const t = tlsConnect({ socket: sock as Socket, servername: opts.host, rejectUnauthorized: true }, () => res(t));
          t.once('error', (err) => rej(new SmtpError(`STARTTLS: ${err.message}`)));
        });
        sock = upgraded;
        buffer = attach(upgraded);
        await expect(buffer, '2');                                 // приветствие после рукопожатия
        await ask(`EHLO ${opts.heloName}`, '2');                   // повтор: возможности меняются
      }

      if (opts.user && opts.password) {
        await ask('AUTH LOGIN', '3');
        await ask(b64(opts.user), '3');
        await ask(b64(opts.password), '2');
      }
      await ask(`MAIL FROM:<${message.from}>`, '2');
      await ask(`RCPT TO:<${message.to}>`, '2');
      await ask('DATA', '3');
      // terminator `.␍␊`: base64-строки точкой начинаться не могут, dot-stuffing не нужен
      socket.write(buildMessage(message) + CRLF + '.' + CRLF);
      await expect(buffer, '2');
      /*
       * QUIT уходит через `end()`, а не `write()` + немедленный `destroy()`: сокет отбрасывает
       * неотправленный байт при разрушении, и сервер видел бы обрыв соединения вместо
       * завершённого разговора (проверено на кукле: `QUIT` до неё не доходил).
       */
      try { socket.end('QUIT' + CRLF); } catch { /* письмо уже принято — это не потеря */ }
      setTimeout(() => { try { socket.destroy(); } catch { /* уже закрыт */ } }, 50).unref?.();
      stop();
    };

    if (opts.security === 'tls') {
      const t = tlsConnect({ host: opts.host, port: opts.port, servername: opts.host, rejectUnauthorized: true });
      t.once('secure', () => { void converse(t).catch((e) => stop(e)); });
      t.once('error', (e) => stop(new SmtpError(`соединение: ${e.message}`)));
    } else {
      const s = createConnection({ host: opts.host, port: opts.port });
      s.once('connect', () => { void converse(s).catch((e) => stop(e)); });
      s.once('error', (e) => stop(new SmtpError(`соединение: ${e.message}`)));
    }
  });
}
