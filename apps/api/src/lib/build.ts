/**
 * Build stamp (task 1): the short commit hash shown ONLY in the interface
 * (Profile + Login footers). Render injects RENDER_GIT_COMMIT at runtime, so
 * the API stamps it into the served index.html <meta name="app-build"> — the
 * value never appears in /api/health or any JSON API response. Local dev and
 * static builds keep the placeholder.
 */
export function currentBuildId(): string {
  const c = process.env.RENDER_GIT_COMMIT ?? '';
  return /^[0-9a-f]{7,40}$/i.test(c) ? c.slice(0, 7) : 'dev';
}

/** Replace the placeholder meta content in index.html (pure, testable). */
export function injectBuildMeta(html: string, build: string): string {
  return html.replace(
    /(<meta\s+name="app-build"\s+content=")[^"]*(")/i,
    `$1${build}$2`,
  );
}
