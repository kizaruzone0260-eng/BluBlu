import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LOCALE } from '@klass/shared';
import ru from '@klass/shared/locales/ru.json';
import uz from '@klass/shared/locales/uz.json';
import en from '@klass/shared/locales/en.json';

/**
 * Language (task 1, 2026-10-09).
 *
 * `klass_locale` used to be written on EVERY `languageChanged` — including the change the app
 * made itself after reading the profile. That made two things impossible to tell apart: "this
 * person chose a language on this device" and "some code applied a value". It is now written by
 * `chooseLocale()` only, i.e. by an actual click on a language.
 */
const STORE_KEY = 'klass_locale';

/** the choice made on THIS device, or null when nobody ever picked one here */
export function storedLocale(): string | null {
  try { return localStorage.getItem(STORE_KEY); } catch { return null; }
}

/** A real user action: remember it on this device. Persisting is the caller's business after. */
export async function chooseLocale(lng: string): Promise<void> {
  try { localStorage.setItem(STORE_KEY, lng); } catch { /* private mode */ }
  await i18n.changeLanguage(lng);
}

/** Apply a language WITHOUT claiming it was chosen (profile sync, session restore). */
export async function applyLocale(lng: string): Promise<void> {
  if (lng !== i18n.language) await i18n.changeLanguage(lng);
}

i18n.use(initReactI18next).init({
  resources: {
    ru: { translation: ru },
    uz: { translation: uz },
    en: { translation: en },
  },
  // A visitor who never picked anything gets the product default — English — regardless of what
  // navigator.language says (the task is explicit about this; there was no browser detection
  // before either, the fallback was simply 'ru').
  lng: storedLocale() ?? DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  interpolation: { escapeValue: false },
});

// <html lang> is static in index.html, so it follows the language here instead. It used to say
// "ru" forever, which is what a screen reader announces for an English interface.
const syncHtmlLang = (lng: string) => { document.documentElement.lang = lng.split('-')[0] || lng; };
syncHtmlLang(i18n.language);
i18n.on('languageChanged', syncHtmlLang);

export default i18n;
