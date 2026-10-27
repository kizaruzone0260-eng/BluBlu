/**
 * Идентификатор запроса принадлежит разборам на сервере, а не экрану (2026-10-27).
 *
 * Раньше `AuthError` печатал «Код обращения: k3f9d2xq1m» с кнопкой «Скопировать»: жалоба ученика
 * превращалась в строку, которую учитель мог найти в access-логе. Это было правильно, но не для
 * того, кто стоит перед классом: набор букв под красным предложением выглядит как часть поломки.
 *
 * Требование владельца — убрать показ, НЕ трогая контракт. Разница между «убрали из UI» и
 * «убрали из продукта» ровно здесь и опасна: если кто-то однажды вычистит `reqId` из `errorBody`
 * или из access-лога, жалобы снова станут неразрешимыми, и никакой тест об этом не скажет. Поэтому
 * тест двусторонний: он запрещает идентификатору возвращаться на экран и требует, чтобы он
 * по-прежнему жил там, где его видит владелец.
 *
 * Это скан исходников, а не прогон браузера — так же, как `no-raw-error-logging.test.ts`: у
 * репозитория нет раннера для React-компонентов, а проверять надо форму кода, а не его рендер.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ru from '@klass/shared/locales/ru.json';
import uz from '@klass/shared/locales/uz.json';
import en from '@klass/shared/locales/en.json';
import { errorBody } from '../../src/lib/requestId.js';

// от apps/api/test/unit — четыре уровня вверх до корня монорепозитория
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const WEB_SRC = path.join(ROOT, 'apps', 'web', 'src');
const API_SRC = path.join(ROOT, 'apps', 'api', 'src');

function filesUnder(dir: string, ext: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...filesUnder(p, ext)); continue; }
    if (ext.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

/**
 * Что запрещено на экране. Каждое — конкретная строка разметки или вызов, который её возвращает:
 * матчить надо то, что человек увидит, а не слово `reqId` вообще (оно живёт в API-слое и должно
 * жить — см. вторую половину теста).
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/data-testid="auth-error-code"/, 'абзац «Код обращения» на экране'],
  [/data-testid="auth-error-copy"/, 'кнопка копирования кода обращения'],
  [/t\(['"]auth\.errorCodeLabel['"]\)/, 'подпись «Код обращения» / "Reference code"'],
  [/t\(['"]auth\.copyCode['"]\)/, 'текст кнопки «Скопировать код»'],
  [/reqId=\{/, 'prop `reqId`, переданный компоненту ошибки'],
];

describe('идентификатор запроса не показывается человеку', () => {
  it('ни один файл apps/web не выводит reqId, «Код обращения» или кнопку копирования к нему', () => {
    const hits: string[] = [];
    for (const file of filesUnder(WEB_SRC, ['.tsx', '.ts'])) {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, label] of FORBIDDEN) {
        if (pattern.test(text)) hits.push(`${path.relative(ROOT, file)}: ${label}`);
      }
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('ключи локалей «Код обращения» и «Скопировать код» выведены из всех трёх языков', () => {
    for (const [lang, dict] of [['ru', ru], ['uz', uz], ['en', en]] as const) {
      const auth = (dict as Record<string, Record<string, string>>).auth;
      expect('errorCodeLabel' in auth, `${lang}.auth.errorCodeLabel`).toBe(false);
      expect('copyCode' in auth, `${lang}.auth.copyCode`).toBe(false);
      // «Скопировано» остаётся: им пользуется кнопка копирования ссылки-приглашения, а не код
      // обращения, и удалить её — значит сломать другой экран
      expect(auth.copied, `${lang}.auth.copied`).toBeTruthy();
    }
  });

  it('компонент ошибки больше не принимает идентификатор — молча выбрасывать его он не сможет', () => {
    const raw = readFileSync(path.join(WEB_SRC, 'components', 'AuthError.tsx'), 'utf8');
    // комментарий имеет право объяснять, почему поля нет; проверяем код, а не прозу
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'идентификатор не должен остаться непрошеным prop’ом').not.toContain('reqId');
    expect(code).not.toContain('useState');
    expect(code, 'экран обязан остаться: переводимое предложение — не про опциональность').toContain('data-testid="auth-error"');
    expect(code).toContain('role="alert"');
  });
});

describe('а внутри продукта идентификатор остаётся', () => {
  it('тело каждой ошибки по-прежнему несёт reqId — по нему жалоба находится в access-логе', () => {
    expect(errorBody('k3f9d2xq1m', 'invalidInput')).toEqual({ error: 'invalidInput', reqId: 'k3f9d2xq1m' });
    // пустой id — это «не откуда брать», а не «не показывать»; helper обязан держать поле
    expect(errorBody(undefined, 'serverError')).toEqual({ error: 'serverError', reqId: '' });
  });

  it('маршруты, ответы которых переводит экран, по-прежнему зовут errorBody', () => {
    /*
     * Не «всякий отказ обязан нести id» — это было бы правкой чужого контракта: `notFound` и
     * `forbidden` отправляются голым кодом с самого начала, и UI их не показывает. Речь ровно о
     * трёх файлах, чьи ответы человек видит на экране входа, приглашения и класса: там `errorBody`
     * появился специально, и потерять его значит снова сделать жалобу неразрешимой.
     */
    for (const route of ['auth.ts', 'invitations.ts', 'classes.ts']) {
      const text = readFileSync(path.join(API_SRC, 'routes', route), 'utf8');
      expect(text, `${route} обязан отвечать ошибки через errorBody`).toContain('errorBody(');
    }
    const auth = readFileSync(path.join(API_SRC, 'routes', 'auth.ts'), 'utf8');
    expect(auth, 'выведенный способ отвечает через тот же helper, а не голым текстом')
      .toContain('retiredEnrollment');
  });
});
