import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ru from '@klass/shared/locales/ru.json';
import uz from '@klass/shared/locales/uz.json';
import en from '@klass/shared/locales/en.json';

const stored = (() => {
  try { return localStorage.getItem('klass_locale'); } catch { return null; }
})();

i18n.use(initReactI18next).init({
  resources: {
    ru: { translation: ru },
    uz: { translation: uz },
    en: { translation: en },
  },
  lng: stored ?? 'ru',
  fallbackLng: 'ru',
  interpolation: { escapeValue: false },
});

i18n.on('languageChanged', (lng) => {
  try { localStorage.setItem('klass_locale', lng); } catch { /* ignore */ }
});

export default i18n;
