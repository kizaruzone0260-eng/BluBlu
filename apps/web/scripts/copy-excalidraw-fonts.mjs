/**
 * Self-host the Excalidraw fonts (camera-task side fix).
 * The @excalidraw/excalidraw package loads its handwriting fonts from
 * https://esm.sh/… by default; our CSP (font-src 'self' data:) blocked every
 * one of them → a wall of CSP console errors on entering a lesson.
 * vite build copies them into public/ and main.tsx points
 * window.EXCALIDRAW_ASSET_PATH at '/excalidraw-assets' — fonts are served
 * same-origin, no CDN. Run before `vite build` (wired into the web build script).
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  path.join(webDir, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts'),
  path.resolve(webDir, '..', '..', 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts'),
];
const src = candidates.find((s) => existsSync(s));
const dest = path.join(webDir, 'public', 'excalidraw-assets', 'fonts');

if (!src) {
  console.warn('copy-excalidraw-fonts: package fonts not found — skipping (Excalidraw falls back to system fonts)');
  process.exit(0);
}
rmSync(path.join(webDir, 'public', 'excalidraw-assets'), { recursive: true, force: true });
mkdirSync(path.dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`copy-excalidraw-fonts: ${src} → ${dest}`);
