import { describe, it, expect } from 'vitest';
import { POLICY_VERSION } from '@klass/shared';
import ru from '@klass/shared/locales/ru.json';
import uz from '@klass/shared/locales/uz.json';
import en from '@klass/shared/locales/en.json';

/**
 * Часть 8 (2026-10-14): новые персональные данные должны быть описаны в политике, а не только
 * заведены в базе.
 *
 * Это проверка не «есть ли ключ», а «что именно обещано пользователю»: в разделе «какие данные
 * мы обрабатываем» обязан быть факт прихода и ухода (и то, что ученики его не видят), в разделе
 * «сроки хранения» — архив уроков и переменная, которая его удаляет. Проверка идёт по трём
 * языкам сразу: расхождение юридического текста и кода — это не опечатка, а недействительное
 * согласие.
 */
const docs = { en, ru, uz } as const;

// [что обрабатываем, сроки хранения] — индексы те же, что и в en.json; паритет ключей держит их
// на месте по всем трём языкам (проверяет тест locale-keys).
const WHAT = 1;
const KEEP = 6;

/*
 * Часть F (2026-10-16): в «какие данные» добавлено подтверждение адреса, и оно проверяется здесь
 * же, а не новым тестом: политика и код разъезжаются именно тогда, когда за новое поле базы
 * забывают дописать обещание человеку. Три метки на язык — сам факт (код), его срок и то, что
 * незавершённая регистрация не оставляет адрес навечно.
 */
const MARKS: Record<keyof typeof docs, { what: string[]; keep: string[] }> = {
  en: {
    what: ['lesson attendance', 'joined', 'left', 'teacher of that class',
      'six-digit code', '15 minutes', 'deleted automatically'],
    keep: ['lesson archive', 'board_archive_retention_days', 'default is 0'],
  },
  ru: {
    what: ['присутствие на уроках', 'пришёл', 'ушёл', 'учителю этого класса',
      'шестизначный код', '15 минут', 'удаляется автоматически'],
    keep: ['архив уроков', 'board_archive_retention_days', 'по умолчанию 0'],
  },
  uz: {
    what: ['darslardagi qatnash', 'kelgani', 'ketgani', 'sinf oʻqituvchisiga',
      'olti xonali kod', '15 daqiqa', 'avtomatik oʻchiriladi'],
    keep: ['darslar arxivi', 'board_archive_retention_days', 'standart holat 0'],
  },
};

const body = (lang: keyof typeof docs, index: number) =>
  (docs[lang] as { privacy: { sections: { b: string[] }[] } }).privacy.sections[index].b.join(' ').toLowerCase();

describe('политика конфиденциальности про приход/уход и архив (часть 8)', () => {
  for (const lang of Object.keys(MARKS) as (keyof typeof docs)[]) {
    it(`${lang}: оба утверждения на месте`, () => {
      for (const mark of MARKS[lang].what) {
        expect(body(lang, WHAT), `${lang}: в «какие данные» нет «${mark}»`).toContain(mark);
      }
      for (const mark of MARKS[lang].keep) {
        expect(body(lang, KEEP), `${lang}: в «сроках хранения» нет «${mark}»`).toContain(mark);
      }
    });
  }

  it('показываемая версия документов равна POLICY_VERSION во всех трёх языках', () => {
    for (const lang of Object.keys(docs) as (keyof typeof docs)[]) {
      const d = docs[lang] as { privacy: { version: string }; terms: { version: string } };
      expect(d.privacy.version, `${lang}: версия в политике`).toContain(POLICY_VERSION);
      expect(d.terms.version, `${lang}: версия в условиях`).toContain(POLICY_VERSION);
    }
  });

  it('переключатель класса описан так, что ученику не положено ничего лишнего', () => {
    for (const lang of Object.keys(docs) as (keyof typeof docs)[]) {
      const c = (docs[lang] as { classes: Record<string, string> }).classes;
      expect(c.archiveSwitch, `${lang}: название переключателя`).toBeTruthy();
      expect(c.archiveSwitchOn.toLowerCase(), `${lang}: включённый = только доски`).toContain(lang === 'ru' ? 'без комментариев' : lang === 'uz' ? 'izohsiz' : 'without comments');
    }
  });
});
