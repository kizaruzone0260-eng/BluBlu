/**
 * Task G.2 (2026-11-04): запуск Mini App — решение о режиме принимается ЗДЕСЬ, а не в браузере.
 *
 * Почему это общий пакет, а не `apps/web`: вся логика здесь чистая (функции над переданными
 * `location`/`window`-подобными объектами), и её можно проверить без браузера и без Telegram —
 * ровно так же, как `joinToken.ts` и `guestLinks.ts` проверяются юнитом. Матрица G.2 (SDK
 * загрузился / заблокирован / отсутствует, моста нет, `initData` нет/поддельный/просрочен) —
 * это таблицы истинности ниже, а не скриншоты.
 *
 * Три вещи, которые здесь разделены и которые раньше были смешаны в один «Telegram did not
 * load»:
 *  • состояние SDK (`ready` | `blocked` | `timeout` | `absent`) — сетевой факт о скрипте;
 *  • наличие Telegram-моста — факт о КЛИЕНТЕ (`TelegramWebviewProxy`, `window.external.notify`,
 *    окно внутри web.telegram.org); проверяется признаками, а не user-agent;
 *  • наличие подписанного `initData` — факт о ЗАПУСКЕ.
 *
 * Только вместе первые два плюс подписанный третий дают Telegram mode. Всё остальное —
 * Browser mode: тот же Mini App, но вход обычный, BluBlu. Фатального экрана больше нет ни при
 * каком сочетании.
 *
 * Про `initData` без SDK. Telegram кладёт подписанную строку в адрес запуска (фрагмент
 * `#tgWebAppData=…`, старые клиенты — query), и наш сервер проверяет её HMAC-подпись токеном бота
 * (`lib/telegramMiniAuth.ts`). Значит чтение строки из адреса — это ТРАНСПОРТ, а не доверие:
 * подпись по-прежнему проверяет сервер, `initDataUnsafe` не читается нигде, и выдуманная подпись
 * даёт 401 с честным переходом на обычный вход. Мы ничего не генерируем и не подделываем — мы
 * перестаём терять запуск из-за того, что сторонний скрипт не скачался.
 */

/** Единственный официальный адрес SDK; тот же, что и в `<head>` shell-страницы `/mini`. */
export const TELEGRAM_SDK_URL = 'https://telegram.org/js/telegram-web-app.js';

/**
 * Бюджет ожидания SDK. Первый заход — 4 с (с 119 КБ на мобильной сети это уже щедро), повторные
 * — по 2,5 с, и повторов ровно два: всего три захода, после которых приложение работает как
 * веб-версия. Бесконечный retry запрещён постановкой и был бы вежливым способом ничего не
 * показать человеку.
 */
export const SDK_FIRST_TIMEOUT_MS = 4_000;
export const SDK_RETRY_TIMEOUT_MS = 2_500;
export const SDK_MAX_ATTEMPTS = 3;

export type SdkState = 'ready' | 'blocked' | 'timeout' | 'absent';
export type LaunchMode = 'telegram' | 'browser';

/** Причина выбора режима — её печатает экран, поэтому вариантов ровно пять и они не пересекаются. */
export type LaunchReason =
  /** мост есть, подпись есть: обычный путь Task F */
  | 'signedLaunch'
  /** мост есть, подписанного запуска нет — вход не из Telegram-кнопки или клиент без `initData` */
  | 'noInitData'
  /** подписанный запуск в адресе есть, но SDK не доехал: читаем `initData` из адреса */
  | 'signedLaunchWithoutSdk'
  /** ни SDK, ни подписанного запуска: это обычный браузер */
  | 'noBridge'
  /** страница открыта как веб-дверь (`/web`) — мост не опрашивается вовсе */
  | 'forcedWebEntry';

/** Адрес запуска. Имя не `LocationLike`: оно уже занято `joinToken.ts`, а два одинаковых
 *  экспорта из одного пакета — это TS2308, а не «ну и ладно». */
export interface LaunchLocation { hash?: string; search?: string }

/** Минимальный набор признаков моста; fields optional — проверяем presence, а не тип. */
export interface BridgeWindowLike {
  TelegramWebviewProxy?: unknown;
  external?: { notify?: unknown } | null;
  parent?: unknown;
  self?: unknown;
}

/**
 * Параметры запуска. Фрагмент — основной способ (так делает официальный SDK: `urlParseHashParams
 * (location.hash)`), query — запасной для старых клиентов. Ничего не удаляем из адреса: очистка
 * чужого фрагмента — отдельная ответственность (`joinToken.ts`), и на `/mini` она не запускается.
 */
function parseParamBag(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const trimmed = body.replace(/^[#?]/, '').trim();
  if (!trimmed) return out;
  let params: URLSearchParams;
  try { params = new URLSearchParams(trimmed); } catch { return out; }
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

export function readLaunchParams(loc: LaunchLocation): Record<string, string> {
  // порядок слияния = приоритет: сначала query, затем фрагмент перезаписывает то же имя
  return { ...parseParamBag(loc.search ?? ''), ...parseParamBag(loc.hash ?? '') };
}

/**
 * Подписанная строка запуска, если она в адресе есть. Пустая строка — это «нет запуска», а не
 * «есть пустой запуск»: сервер на пустой отвечает `initDataMissing`, и полагаться на это в UI
 * нельзя.
 */
export function readInitData(loc: LaunchLocation): string | null {
  const value = readLaunchParams(loc).tgWebAppData;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Есть ли Telegram-мост. Три признака — ровно те три транспорта, которые использует официальный
 * SDK (`postEvent`): нативный `TelegramWebviewProxy` (Android/iOS/Desktop), `external.notify`
 * (Windows-оболочки), окно внутри `web.telegram.org` (WebA/WebK). Никакого user-agent: сторонний
 * клон с честным мостом работает, браузер с «Telegram» в строке пользователя — нет.
 */
export function telegramBridgePresent(win: BridgeWindowLike = {}): boolean {
  if (win.TelegramWebviewProxy !== undefined) return true;
  if (win.external && typeof win.external.notify !== 'undefined') return true;
  try {
    if (win.self && win.parent && win.parent !== win.self) return true;
  } catch { /* кросс-окно без доступа: считаем, что моста нет */ }
  return false;
}

export interface LaunchInput {
  /** что известно о скрипте SDK */
  sdkState: SdkState;
  /** `window.Telegram.WebApp`, если SDK успел что-то объявить */
  webApp?: { initData?: unknown } | null;
  /** адрес запуска: фрагмент/запрос страницы */
  location: LaunchLocation;
  /** есть ли нативный мост (см. telegramBridgePresent) */
  bridge: boolean;
  /** страница открыта как веб-дверь `/web` */
  forceBrowser?: boolean;
}

export interface LaunchDecision {
  mode: LaunchMode;
  reason: LaunchReason;
  /** что отправлять на `POST /api/mini/auth`; null — когда Telegram-ветки нет вовсе */
  initData: string | null;
  /** SDK доступен: можно брать тему/кнопки, но только по feature detection ниже */
  sdkReady: boolean;
  /** строка состояния на двери: «Telegram integration unavailable» или ничего */
  notice: LaunchNotice;
}

/**
 * Когда извиняться за Telegram. Правило держится на трёх фактах, а не на догадке:
 *  • подпись запуска есть, а скрипта нет — человек явно пришёл из Telegram (`*WithoutSdk`);
 *  • скрипт жив и мост жив, но подписи нет — клиент не дал `initData`;
 *  • мост есть, скрипта нет — мы внутри клиента, у которого не встало приложение (школьная
 *    сеть, заблокированный telegram.org): это именно тот случай, где человек имеет право
 *    знать, что автовхода не будет.
 * Обычный браузер (моста нет, подписи нет) — не поломка: там `none`, и экран входа говорит
 * только про вход.
 */
export function launchNotice(
  input: Pick<LaunchInput, 'sdkState' | 'bridge'>,
  reason: LaunchReason,
): LaunchNotice {
  if (reason === 'signedLaunchWithoutSdk' || reason === 'noInitData') return 'telegramUnavailable';
  if (reason === 'noBridge' && input.bridge && input.sdkState !== 'ready') return 'telegramUnavailable';
  return 'none';
}

/**
 * Единственная точка, где решается «Telegram или браузер». Порядок именно такой: подписанный
 * запуск из адреса сильнее наличия SDK (заблокированный скрипт не должен превращать Telegram в
 * требование пароля), а отсутствие подписи при живом SDK — НЕ повод выдавать доступ: такой
 * запуск уходит на обычный вход (постановка, §5).
 */
export function resolveLaunch(input: LaunchInput): LaunchDecision {
  const sdkReady = input.sdkState === 'ready';
  const fromSdk = typeof input.webApp?.initData === 'string' ? input.webApp.initData : '';
  const fromUrl = readInitData(input.location);
  const initData = fromSdk.trim() || (fromUrl ?? '');

  const decide = (mode: LaunchMode, reason: LaunchReason, signed: string | null): LaunchDecision => ({
    mode,
    reason,
    initData: signed,
    sdkReady,
    notice: launchNotice(input, reason),
  });

  if (input.forceBrowser) return decide('browser', 'forcedWebEntry', null);
  if (initData) {
    return decide('telegram', sdkReady ? 'signedLaunch' : 'signedLaunchWithoutSdk', initData);
  }
  if (sdkReady && input.bridge) {
    // SDK внутри Telegram, но подписи нет: доверять нечему, и Telegram mode здесь невозможен.
    return decide('browser', 'noInitData', null);
  }
  return decide('browser', 'noBridge', null);
}

/**
 * Feature detection Telegram-API. Экран спрашивает «можно ли это», а не «похоже ли на Telegram»:
 * отсутствующая функция просто не предлагается, и приложение работает без неё.
 */
export interface TelegramCapabilities {
  backButton: boolean;
  mainButton: boolean;
  haptic: boolean;
  theme: boolean;
  openLink: boolean;
  close: boolean;
  writeAccess: boolean;
  viewportEvents: boolean;
}

export function telegramCapabilities(wa: unknown): TelegramCapabilities {
  const w = wa as Record<string, unknown> | null | undefined;
  const obj = (name: string) => (w && typeof w[name] === 'object' ? (w[name] as Record<string, unknown>) : null);
  const bb = obj('BackButton');
  const mb = obj('MainButton');
  const hf = obj('HapticFeedback');
  return {
    backButton: Boolean(bb && typeof bb.onClick === 'function' && typeof bb.show === 'function'),
    mainButton: Boolean(mb && typeof mb.setText === 'function' && typeof mb.onClick === 'function'),
    haptic: Boolean(hf && typeof hf.impactOccurred === 'function'),
    theme: Boolean(w && (typeof w.themeParams === 'object' || typeof w.colorScheme === 'string')),
    openLink: Boolean(w && typeof w.openLink === 'function'),
    close: Boolean(w && typeof w.close === 'function'),
    writeAccess: Boolean(w && typeof w.requestWriteAccess === 'function'),
    viewportEvents: Boolean(w && typeof w.onEvent === 'function'),
  };
}

/**
 * Что показать человеку вместо прежнего «Telegram did not load». Формулировки — интерфейс, а не
 * диагностика: причина известна (скрипт/мост/подпись), но человек чинит не её, а вход.
 */
export type LaunchNotice = 'telegramUnavailable' | 'none';
