/** Build stamp for the UI (task 1): read from the <meta name="app-build"> the
 *  API injects at serve time ('dev' in vite dev / static builds). */
export function buildId(): string {
  if (typeof document === 'undefined') return 'dev';
  return document.querySelector('meta[name="app-build"]')?.getAttribute('content') || 'dev';
}
