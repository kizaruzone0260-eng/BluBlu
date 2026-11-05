/*
 * Task G.2 (2026-11-04): офлайн-ускорение перестало быть точкой входа.
 *
 * Прежний вариант перехватывал ВСЕ GET — включая `https://telegram.org/js/telegram-web-app.js` —
 * и этим ломал Mini App. Проверено в живом Chromium (см. docs/MINI-MODE.md): второй заход на
 * `/mini` под управлением этого worker'а давал `net::ERR_FAILED` на SDK, потому что worker
 * повторял запрос ОТ СЕБЯ, а CSP документа (`connect-src 'self' blob:`) подключение к telegram.org
 * не разрешает: запрос отклонялся, в кеше копии не было, `respondWith` получал `undefined`, и
 * страница показывала «Telegram did not load». Первый заход (worker ещё не перехватывает)
 * работал — отсюда «то работает, то нет» на разных клиентах: у всех них worker живёт между
 * запусками.
 *
 * Что изменилось и почему это безопасно:
 *  • навигации и документы больше не перехватываются. HTML приходит из сети с его собственными
 *    заголовками — именно CSP ответа решает, можно ли чужой скрипт, и ни одна устаревшая копия
 *    не может подменить точку входа (проверка матрицы №14 становится структурной);
 *  • чужие домены не перехватываются вовсе: у них нет права на наш `connect-src`, и кеш
 *    непрозрачных ответов — это ещё и способ года держать старый SDK;
 *  • имя кеша поднято до v2: что накоплено прежним worker'ом (в том числе HTML-копии со строгой
 *    политикой), удаляется при activate;
 *  • API не кешировался и раньше, и ничего приватного в кеше не появляется; вдобавок размер
 *    кеша теперь ограничен — прежняя версия росла без потолка с каждым деплоем.
 *
 * Цена честная: без сети страница входа не отрисуется. Приложение приватное и под паролем, и
 * «офлайн-оболочка, которая обещает работать без соединения» ему не нужна — нужнее то, чтобы
 * Mini App открывался всегда.
 */
const CACHE = 'klass-shell-v2';
const MAX_ENTRIES = 160;

self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Кешируем только своё и только не-документы. Причина каждого отказа — в комментарии выше. */
function shouldHandle(request, url) {
  if (request.method !== 'GET') return false;
  if (request.mode === 'navigate' || request.destination === 'document') return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/webhook')) return false;
  return true;
}

self.addEventListener('fetch', (e) => {
  const request = e.request;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!shouldHandle(request, url)) return;
  e.respondWith(
    fetch(request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE)
          .then((c) => c.put(request, copy))
          .then(trim)
          .catch(() => undefined);
      }
      return res;
    }).catch(() => caches.match(request).then((hit) => hit ?? Response.error())),
  );
});

/**
 * Один деплой — новый набор хэшированных чанков, и старые не удаляются сами. Потолок грубый
 * (по числу записей), зато вебу негде раздуть кеш до сотен мегабайт на диске школы.
 */
async function trim() {
  const cache = await caches.open(CACHE);
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  for (const entry of keys.slice(0, keys.length - MAX_ENTRIES)) await cache.delete(entry);
}
