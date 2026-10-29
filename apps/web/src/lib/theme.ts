export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'klass_theme';

export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* private mode */ }
  return 'system';
}

export function resolvedTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Applies html[data-theme]; keeps listening to system changes while in 'system'. */
export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = resolvedTheme(choice);
}

export function setTheme(choice: ThemeChoice): void {
  try { localStorage.setItem(KEY, choice); } catch { /* ignore */ }
  applyTheme(choice);
  window.dispatchEvent(new CustomEvent('klass-theme', { detail: choice }));
}

if (typeof window !== 'undefined') {
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    // Task G: inside Telegram the Mini App follows `themeParams`/`themeChanged`, not the OS;
    // `applyTelegramTheme` marks the document so this listener cannot repaint it.
    if (document.documentElement.dataset.themeSource === 'telegram') return;
    if (getThemeChoice() === 'system') applyTheme('system');
  });
}
