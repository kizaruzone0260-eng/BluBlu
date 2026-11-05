/**
 * Task G.2 (2026-11-04): матрица запуска Mini App без браузера и без Telegram.
 *
 * Всё, что решает «какая дверь», живёт в `@klass/shared/miniLaunch`, поэтому проверяется
 * таблицей истинности, а не скриншотом. Строки 1–7 соответствуют пунктам 1–7 матрицы постановки
 * (SDK загрузился / load error / отсутствует / моста нет / initData нет / initData поддельный /
 * initData просрочен); поддельный и просроченный здесь — это «подпись есть в адресе, решение за
 * сервером», сами подписи проверяет `test/integration/mini-app.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  readInitData, readLaunchParams, resolveLaunch, telegramBridgePresent,
  telegramCapabilities, SDK_FIRST_TIMEOUT_MS, SDK_MAX_ATTEMPTS, SDK_RETRY_TIMEOUT_MS,
  TELEGRAM_SDK_URL, type LaunchInput,
} from '@klass/shared';

/** Подписанная строка ровно в той форме, в какой её отдаёт Telegram и ждёт наш верификатор. */
const SIGNED = `auth_date=1730000000&query_id=AAHl-ptr&user=%7B%22id%22%3A4242%7D&hash=${'a'.repeat(64)}`;

function input(over: Partial<LaunchInput> = {}): LaunchInput {
  return {
    sdkState: 'ready',
    webApp: { initData: SIGNED },
    location: { hash: '', search: '' },
    bridge: true,
    ...over,
  };
}

describe('G.2: состояние SDK ≠ вердикт', () => {
  it('1. SDK загрузился, мост есть, initData есть → Telegram mode с этой подписью', () => {
    const r = resolveLaunch(input());
    expect(r).toEqual({
      mode: 'telegram', reason: 'signedLaunch', initData: SIGNED, sdkReady: true, notice: 'none',
    });
  });

  it('2. SDK вернул load error, но запуск подписан в адресе → всё ещё Telegram mode', () => {
    const r = resolveLaunch(input({
      sdkState: 'blocked', webApp: null,
      location: { hash: `#tgWebAppPlatform=android&tgWebAppData=${encodeURIComponent(SIGNED)}` },
    }));
    expect(r.mode).toBe('telegram');
    expect(r.reason).toBe('signedLaunchWithoutSdk');
    expect(r.initData).toBe(SIGNED);
    // интеграция с Telegram при этом недоступна — это строка состояния, а не экран-приговор
    expect(r.notice).toBe('telegramUnavailable');
  });

  it('3. SDK отсутствует и подписи нет → браузер, а не «Telegram did not load»', () => {
    const r = resolveLaunch(input({ sdkState: 'absent', webApp: null, location: {}, bridge: false }));
    expect(r.mode).toBe('browser');
    expect(r.reason).toBe('noBridge');
    expect(r.initData).toBeNull();
    // обычный браузер не обязан ни за что извиняться
    expect(r.notice).toBe('none');
  });

  it('4. моста нет, даже если скрипт почему-то есть', () => {
    const r = resolveLaunch(input({ bridge: false, webApp: null, location: {} }));
    expect(r.mode).toBe('browser');
    expect(r.reason).toBe('noBridge');
  });

  /*
   * Тот же заблокированный скрипт, но внутри клиента с мостом: вот здесь человек имеет право
   * увидеть «Telegram integration unavailable» — автовход действительно не состоялся.
   */
  it('4б. мост есть, скрипт не доехал, подписи нет → браузер с честной строкой состояния', () => {
    const r = resolveLaunch(input({ bridge: true, sdkState: 'blocked', webApp: null, location: {} }));
    expect(r.mode).toBe('browser');
    expect(r.notice).toBe('telegramUnavailable');
  });

  it('5. SDK есть, initData пуст → доступа через Telegram нет, предлагается обычный вход', () => {
    const r = resolveLaunch(input({ webApp: { initData: '' }, location: {} }));
    expect(r.mode).toBe('browser');
    expect(r.reason).toBe('noInitData');
    expect(r.notice).toBe('telegramUnavailable');
  });

  it('6/7. поддельная или просроченная подпись: здесь мы лишь отдаём её серверу', () => {
    // ключевое свойство: клиент НЕ решает, валидна ли подпись, и не выдумывает её
    const forged = `auth_date=1&user=%7B%22id%22%3A1%7D&hash=${'0'.repeat(64)}`;
    const r = resolveLaunch(input({ webApp: { initData: forged } }));
    expect(r.mode).toBe('telegram');
    expect(r.initData).toBe(forged);
    // а 401 invalidInitData превращается в браузерную дверь — см. bootMiniApp и e2e
    expect(r.notice).toBe('none');
  });

  it('8. веб-дверь /web не использует подписанный запуск, даже когда он есть', () => {
    const r = resolveLaunch(input({ forceBrowser: true }));
    expect(r).toMatchObject({ mode: 'browser', reason: 'forcedWebEntry', initData: null });
  });

  it('таймауты и повторы ограничены: бесконечного retry нет', () => {
    expect(SDK_MAX_ATTEMPTS).toBe(3);
    expect(SDK_FIRST_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(SDK_RETRY_TIMEOUT_MS).toBeLessThan(SDK_FIRST_TIMEOUT_MS);
    // URL ровно один и официальный: другой адрес означал бы «мы сами решили, что такое SDK»
    expect(TELEGRAM_SDK_URL).toBe('https://telegram.org/js/telegram-web-app.js');
  });
});

describe('G.2: разбор адреса запуска', () => {
  it('берёт initData из фрагмента — так делает официальный SDK', () => {
    const hash = `#tgWebAppVersion=8.0&tgWebAppPlatform=android&tgWebAppData=${encodeURIComponent(SIGNED)}`;
    expect(readInitData({ hash })).toBe(SIGNED);
    expect(readLaunchParams({ hash }).tgWebAppPlatform).toBe('android');
  });

  it('и из query тоже (старые клиенты), а фрагмент важнее', () => {
    const encoded = encodeURIComponent(SIGNED);
    expect(readInitData({ search: `?tgWebAppData=${encoded}` })).toBe(SIGNED);
    const other = encodeURIComponent('auth_date=2&hash=c'.padEnd(70, 'c'));
    const both = readLaunchParams({ search: `?tgWebAppData=${other}`, hash: `#tgWebAppData=${encoded}` });
    expect(both.tgWebAppData).toBe(SIGNED);
  });

  it('пустая строка — это «нет запуска», а не «есть пустой запуск»', () => {
    expect(readInitData({ hash: '#tgWebAppData=' })).toBeNull();
    expect(readInitData({})).toBeNull();
    expect(readInitData({ hash: '#not-a-launch' })).toBeNull();
  });

  it('не ломается на мусоре в адресе', () => {
    expect(() => readLaunchParams({ hash: '#%%%%=%%%%' })).not.toThrow();
    expect(readInitData({ hash: '#%%%%=%%%%' })).toBeNull();
  });
});

describe('G.2: признак моста — признаки, а не user-agent', () => {
  it('TelegramWebviewProxy (Android/iOS/Desktop)', () => {
    expect(telegramBridgePresent({ TelegramWebviewProxy: { postEvent() {} } })).toBe(true);
  });
  it('external.notify (Windows-оболочки)', () => {
    expect(telegramBridgePresent({ external: { notify() {} } })).toBe(true);
  });
  it('окно внутри web.telegram.org (WebA/WebK)', () => {
    expect(telegramBridgePresent({ self: {}, parent: {} })).toBe(true);
  });
  it('обычная вкладка браузера — моста нет', () => {
    expect(telegramBridgePresent({})).toBe(false);
    const same = {};
    expect(telegramBridgePresent({ self: same, parent: same })).toBe(false);
    expect(telegramBridgePresent({ external: {} })).toBe(false);
  });
});

describe('G.2: частичная Telegram-API — приложение живое', () => {
  it('13. клиент дал только часть Telegram-API — флаги честные, исключений нет', () => {
    const partial = {
      initData: SIGNED,
      BackButton: { show() {}, onClick() {} },
      themeParams: {},
    };
    expect(telegramCapabilities(partial)).toEqual({
      backButton: true, mainButton: false, haptic: false, theme: true,
      openLink: false, close: false, writeAccess: false, viewportEvents: false,
    });
  });

  it('пусто и null не бросаются', () => {
    const all = telegramCapabilities(null);
    expect(Object.values(all).every((v) => v === false)).toBe(true);
    expect(Object.values(telegramCapabilities({})).every((v) => v === false)).toBe(true);
  });
});
