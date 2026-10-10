/**
 * Одноразовая разведка: что реально возвращает enumerateDevices в том браузере и с теми флагами,
 * которые использует e2e-стек (channel msedge + fake devices). Нужен фактический список id, чтобы
 * фильтр «ярлык вместо устройства» был написан по измеренным данным, а не по представлению.
 * Локальный http-сервер обязателен: mediaDevices есть только в защищённом контексте.
 */
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<title>devices</title>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  channel: process.env.CI ? undefined : 'msedge',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const page = await (await browser.newContext()).newPage();
await page.goto(`http://127.0.0.1:${port}/`);
const out = await page.evaluate(async () => {
  try { await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); } catch { /* отказа нет: флаг UI всё разрешает */ }
  const list = await navigator.mediaDevices.enumerateDevices();
  return list.map((d) => ({ kind: d.kind, deviceId: d.deviceId, label: d.label }));
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
