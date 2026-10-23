/**
 * Часть C (2026-10-23) — правила окна показа экрана поверх других программ.
 *
 * Само окно открывается в браузере и локально не проверяется (браузерные спеки запрещены, а
 * `documentPictureInPicture` к тому же требует настоящего жеста). Здесь — всё, что решается ДО
 * вызова API: умеет ли этот браузер такое окно, свёрнут ли предпросмотр, когда показывать
 * подсказку про другой браузер и что именно переносится в пустый документ нового окна.
 */
import { describe, it, expect } from 'vitest';
import {
  PIP_HINT_KEY, PIP_HEIGHT, PIP_WIDTH, absolutizeCssUrls, canUseDocumentPip, collectStyleSources,
  pipHintDismissed, previewOpenByDefault, shouldShowPipHint,
} from '@klass/shared';
import ru from '@klass/shared/locales/ru.json';
import uz from '@klass/shared/locales/uz.json';
import en from '@klass/shared/locales/en.json';

const DICTS = { ru, uz, en } as const;
type Lesson = Record<string, Record<string, string>>;

const CHROME_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

describe('документ-PiP: где окно можно просить, а где нельзя', () => {
  it('решает наличие API, а не догадка по браузеру', () => {
    expect(canUseDocumentPip({ apiPresent: true, userAgent: CHROME_DESKTOP })).toBe(true);
    expect(canUseDocumentPip({ apiPresent: false, userAgent: CHROME_DESKTOP })).toBe(false);
    expect(canUseDocumentPip({ apiPresent: false, userAgent: SAFARI_MAC })).toBe(false);
    expect(canUseDocumentPip({ apiPresent: false, userAgent: FIREFOX_WIN })).toBe(false);
  });

  it('на телефоне окно не просит, даже если API однажды появится', () => {
    expect(canUseDocumentPip({ apiPresent: true, userAgent: CHROME_ANDROID })).toBe(false);
    expect(canUseDocumentPip({ apiPresent: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)' })).toBe(false);
    expect(canUseDocumentPip({ apiPresent: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X)' })).toBe(false);
  });

  it('размер по умолчанию тот, что в задаче: ~360×220', () => {
    expect(PIP_WIDTH).toBe(360);
    expect(PIP_HEIGHT).toBe(220);
  });
});

describe('«коридор зеркал»: предпросмотр по умолчанию', () => {
  it('весь монитор — свёрнут, окно и вкладка — показаны', () => {
    expect(previewOpenByDefault('monitor')).toBe(false);
    expect(previewOpenByDefault('window')).toBe(true);
    expect(previewOpenByDefault('browser')).toBe(true);
  });

  it('неизвестная поверхность трактуется в пользу показа: пустое окно хуже лишней плитки', () => {
    // Safari не отдаёт `displaySurface`, и это не повод оставлять человека без предпросмотра
    expect(previewOpenByDefault('')).toBe(true);
  });
});

describe('подсказка про Chrome/Edge', () => {
  it('просит другой браузер только там, где окна нет, и только пока её не закрыли', () => {
    expect(shouldShowPipHint({ apiPresent: true, dismissed: null })).toBe(false);
    expect(shouldShowPipHint({ apiPresent: false, dismissed: null })).toBe(true);
    expect(shouldShowPipHint({ apiPresent: false, dismissed: '1' })).toBe(false);
    expect(pipHintDismissed('1')).toBe(true);
    expect(pipHintDismissed(null)).toBe(false);
    expect(pipHintDismissed('0')).toBe(false);
  });

  it('ключ памяти не меняется молча', () => {
    expect(PIP_HINT_KEY).toBe('blublu.lesson.pipHintOff');
  });
});

describe('перенос стилей в пустый документ окна', () => {
  const BASE = 'https://school.example/lesson/42';

  it('ссылки абсолютятся от основной страницы — в окне своей базы нет', () => {
    const got = collectStyleSources([{ rel: 'stylesheet', href: '/assets/index.css' }], BASE);
    expect(got).toEqual([{ kind: 'link', href: 'https://school.example/assets/index.css' }]);
  });

  it('порядок тегов сохраняется: переопределения в styles.css едут в правильном порядке', () => {
    const got = collectStyleSources([
      { rel: 'stylesheet', href: 'https://cdn/fonts.css' },
      { textContent: ':root { --accent: #0f766e }' },
      { rel: 'stylesheet', href: '/assets/app.css' },
    ], BASE);
    expect(got.map((s) => s.kind)).toEqual(['link', 'style', 'link']);
    expect((got[1] as { css: string }).css).toContain('--accent');
  });

  it('пустой `<style>` не переносится, а битый href не утаскивает за собой остальные стили', () => {
    const got = collectStyleSources([
      { textContent: '   ' },
      { rel: 'stylesheet', href: '::not a url::' },
      { rel: 'stylesheet', href: '/assets/ok.css' },
    ], BASE);
    expect(got.some((s) => s.kind === 'style')).toBe(false);
    expect(got.length).toBe(2);
    expect(got[1]).toEqual({ kind: 'link', href: 'https://school.example/assets/ok.css' });
  });

  it('не-стилевой тег без текста не создаёт узла в окне', () => {
    expect(collectStyleSources([{ rel: 'preload', href: '/assets/font.woff2' }], BASE)).toEqual([]);
  });

  it('шрифты из инлайнового `<style>` доезжают абсолютными — в dev Vite вкладывает CSS именно так', () => {
    // `/fonts/inter-400-latin.woff2` из apps/web/src/fonts.css: без базы окно ушло бы за ним в
    // about:blank и показалось системным шрифтом (то есть потеряло бы `oʻ`/`gʻ`)
    const got = collectStyleSources(
      [{ textContent: "@font-face{src:url('/fonts/inter-400-latin.woff2') format('woff2-variations')}" }],
      BASE,
    );
    expect((got[0] as { css: string }).css)
      .toBe("@font-face{src:url('https://school.example/fonts/inter-400-latin.woff2') format('woff2-variations')}");
  });

  it('data:, blob:, http(s): и //host внутри CSS не переписываются', () => {
    const css = 'a{background:url(data:image/png;base64,AAA)}'
      + 'b{background:url("https://cdn.example/x.png")}'
      + 'c{background:url(//cdn.example/y.png)}'
      + 'd{background:url(blob:1234)}'
      + 'e{background:url(/local/z.png)}';
    expect(absolutizeCssUrls(css, BASE)).toBe(
      'a{background:url(data:image/png;base64,AAA)}'
      + 'b{background:url("https://cdn.example/x.png")}'
      + 'c{background:url(//cdn.example/y.png)}'
      + 'd{background:url(blob:1234)}'
      + 'e{background:url(https://school.example/local/z.png)}',
    );
  });
});

describe('окно показа говорит на трёх языках', () => {
  const KEYS = ['sharePipOpen', 'sharePipReturn', 'sharePipBarAria', 'sharePipWaiting',
    'sharePipCollapsed', 'sharePipHint', 'sharePipHintHide'];

  it('каждая новая строка есть в ru, uz и en', () => {
    for (const lang of ['ru', 'uz', 'en'] as const) {
      const lesson = (DICTS[lang] as unknown as Lesson).lesson;
      for (const key of KEYS) {
        expect(lesson[key], `${lang}.lesson.${key}`).toBeTruthy();
        expect(String(lesson[key]).trim().length, `${lang}.lesson.${key}`).toBeGreaterThan(3);
      }
    }
  });

  it('штатные подписи окна переиспользуют существующие ключи, а не плодят новые', () => {
    // «Вы показываете экран», «Остановить показ» и переключатели микрофона/камеры уже были —
    // второе название того же действия расходится в переводах и в тестах
    for (const lang of ['ru', 'uz', 'en'] as const) {
      const lesson = (DICTS[lang] as unknown as Lesson).lesson;
      for (const key of ['shareShowing', 'shareStop', 'toggleMic', 'toggleCamera', 'sharePreview']) {
        expect(lesson[key], `${lang}.lesson.${key}`).toBeTruthy();
      }
    }
  });
});
