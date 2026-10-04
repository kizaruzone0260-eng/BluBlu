import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve('..', '..');
const stack = spawn('node', ['scripts/e2e-stack.mjs'], { cwd: path.join(root, 'apps/e2e'), stdio: ['ignore', 'inherit', 'inherit'] });
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try { if ((await fetch('http://127.0.0.1:3123/api/health/live')).ok) break; } catch { /* up */ }
}
const creds = JSON.parse(fs.readFileSync(path.join(root, 'apps/e2e/.stack.json'), 'utf8'));

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:3123' });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
page.on('request', (r) => { if (r.url().includes('/api/auth/')) console.log('[req]', r.method(), r.url()); });
page.on('response', async (r) => { if (r.url().includes('/api/auth/')) console.log('[res]', r.status(), r.url(), (await r.text().catch(() => '')).slice(0, 80)); });

await page.goto('http://127.0.0.1:3123/login');
await page.getByTestId('email').fill(creds.teacherEmail);
await page.getByTestId('password').fill(creds.teacherPassword);
await page.getByTestId('login-submit').click();
await page.waitForTimeout(1500);
console.log('after login URL:', page.url());
console.log('cookies:', (await ctx.cookies()).map((c) => `${c.name}@${c.path}`).join(', '));

// emulate pickLang with the CURRENT UI (footer dropdown always visible)
for (const native of ['Oʻzbekcha', 'English']) {
  await page.locator('.lang-wrap').first().locator('> button').click();
  await page.locator('.lang-menu button', { hasText: native }).first().click();
  await page.waitForTimeout(900);
  console.log('switched to', native, 'url', page.url());
}

await page.goto('http://127.0.0.1:3123/calendar');
await page.waitForTimeout(2500);
console.log('after calendar goto URL:', page.url());
console.log('new-event count:', await page.locator('[data-testid="new-event"]').count());
console.log('today button:', await page.locator('.fc-today-button').textContent().catch(() => 'N/A'));

await page.reload();
await page.waitForTimeout(3000);
console.log('after reload URL:', page.url(), 'home-title:', await page.locator('[data-testid="home-title"]').count());
await page.goto('http://127.0.0.1:3123/notes');
await page.waitForTimeout(2000);
console.log('after notes goto URL:', page.url(), 'add btn:', await page.locator('[data-testid="notes-add"]').count());
await page.locator('[data-testid="notes-add"]').click();
await page.waitForTimeout(1200);
console.log('note-title visible:', await page.locator('[data-testid="note-title"]').count());
await page.locator('[data-testid="note-title"]').fill('Proba title 123');
await page.locator('.tiptap').click();
await page.keyboard.type('Проба body oʻ gʻ');
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 160)));
page.on('request', (r) => { if (r.method() === 'PATCH') console.log('[patch->]', r.url()); });
page.on('response', async (r) => { if (r.method() === 'PATCH') console.log('[patch<-]', r.status(), (await r.text().catch(() => '')).slice(0, 80)); });
await page.waitForTimeout(4000);
console.log('notes-saved text:', JSON.stringify(await page.locator('[data-testid="notes-saved"]').textContent()));
console.log('cookies:', (await ctx.cookies()).map((c) => `${c.name}@${c.path}`).join(', '));
const home = await page.locator('[data-testid="new-event"]').count();
console.log('new-event present:', home);

await browser.close();
try { stack.kill(); } catch { /* gone */ }
process.exit(0);
