# Video Lesson Follow-up Report — остатки инцидента

Дата: 2026-10-07 · Ветка: `overnight` · Предыстория: `896d355` (причина — Origin-гейт),
`075e8a6` (RLS-гипотеза, для боя опровергнута)

Коротко: части 1–5 закрыты и закоммичены (`b6355a3 … fd1934e`, `a75670b`), часть 6 — проверки,
и на ней нашёлся **второй** дефект, не связанный с входом: клиентский краш rich-text под
`ErrorBoundary` (§11, фикс `a281930`). Он и держал `material.spec` красным; тест при этом не
правился ни на строку.

---

## 1. Миграция 0021: политики `app_trusted_access` сняты

### 1.1 Что доказывали

Гипотеза `075e8a6` была: «бэкенд ходит в БД НЕ-владеющей ролью, и policy-less RLS из `0019`
режет ему все SELECT в 0 строк → `plugins/auth.ts` не находит пользователя → 401 → logout».
Это проверяется четырьмя фактами о роли, которой реально подключается бэкенд. Инструмент —
новый read-only `apps/api/scripts/rls-audit.mjs` (`pnpm db:audit`): он подключается тем же
`DATABASE_URL`, что и приложение, и печатает только факты каталога и счётчики строк; строки
подключения, пароли и значения токенов не печатаются (красная цензура на всех выводах).

### 1.2 Замеры

Локальный кластер и CI (embedded Postgres 16 / `postgres:16-alpine` с `POSTGRES_USER=klass`
в `.github/workflows/ci.yml`):

```
backend role: { role: 'klass', is_super: true, bypassrls: true, createrole: true }
public tables: { total: 35, owned_by_backend: 35, rls_on: 35, rls_forced: 0 }
policies in public: 35 rows across 1 name(s): app_trusted_access   ← до 0021
AUDIT: all checks PASS
```

Бой (Supabase, Session pooler, ровно тот `DATABASE_URL`, что у Render):

```
backend role: current_user = postgres, rolsuper = false, rolbypassrls = true
public tables: { total: 35, owned_by_backend: 35, rls_on: 35, rls_forced: 0 }
policies in public: 35 × app_trusted_access, roles=[public], USING=[true]   ← до 0021
rows visible to the backend role: { users_live: 1, classes: 4, sessions: 4, refresh_tokens: 28 }
role anon          (bypassrls=false) privileges over 35 tables: { sel: 0, ins: 0, upd: 0, del: 0 }
role authenticated (bypassrls=false) privileges over 35 tables: { sel: 0, ins: 0, upd: 0, del: 0 }
set local role anon/authenticated → SELECT users, classes, chat_messages, posts, files,
  teacher_notes: отказан на уровне привилегий (12/12 отказов)
PostgREST c публичным ключом: 401 на каждой из шести таблиц (users, classes, chat_messages,
  posts, files, teacher_notes) — ни одной строки
```

Вывод: во **всех** конфигурациях роль приложения либо superuser, либо владелец всех таблиц с
`BYPASSRLS`, и ни на одной таблице нет `FORCE ROW LEVEL SECURITY`. Значит RLS не может
отфильтровать её чтения — политики `TO PUBLIC USING (true)` были достижимы только тем, кто их
обходит, и недостижимы тем, кого они «не должны пускать». `0020` не лечила бой и ничего в нём
не значила.

### 1.3 Миграция

`0021_rls_drop_app_policies.sql`: один `DO`-блок, цикл по `pg_class` (`relkind in ('r','p')`,
схема `public`), `DROP POLICY IF EXISTS app_trusted_access`. RLS остаётся `ENABLED`,
права не выдаются и не отзываются, роли не создаются, данные не читаются наружу и не
изменяются, nothing destructive. Журнал Drizzle + снапшот `0021_snapshot.json` (`prevId` =
`0020`). Решение и последствия — `docs/DECISIONS.md`, раздел «2026-10-07».

### 1.4 Тест из 0020 преобразован, не удалён

`test/integration/phase1-rls-approle.test.ts` — те же 1 файл и 1 сторожевая роль, 6 тестов
было → стало:

1. инвариант, из-за которого политики не нужны: роль подключения — superuser/BYPASSRLS/
   владелец 35 из 35, `rls_forced = 0`, `rls_on = 35/35`;
2. в `public` нет ни одной политики, плюс отдельная проверка на уровне `pg_policy`, что ничего
   не оформлено на всех ролей сразу (`cardinality(polroles) = 0`) — **это и есть assertion,
   который падает на состоянии `0020`**;
3. у `anon`/`authenticated` нулевые привилегии по **всем** таблицам (роли создаются в тесте,
   если их нет в кластере, — чтобы проверка работала и в CI, а не «пропускалась»), и ноль
   прочитанных строк из шести таблиц API при том, что приложение видит их;
4. контракт будущего: не-владелец **с выданными GRANT** при policy-less RLS видит 0 строк,
   а роль без привилегий получает отказ до обращения к RLS;
5. (было) роль без грантов отказана; (было) роль не владелец и не BYPASSRLS.

### 1.5 Приложение под боевой ролью работает после 0021

`node scripts/cloud-verify.mjs <cloud.env>` — прогон против живой Supabase-базы:

```
phase 1: API boots on cloud DB · 35 tables · pgboss schema · advisory lock ok · persistent
         session (pooler) · users readable, seed teacher present (rows=1) · anon/auth exist
phase 2: secure-db exit 0 · RLS on ALL tables (без RLS = 0) · anon/auth: no table/sequence/
         function privileges · default privileges: fresh table закрыта
phase 3: REST users?select=id&limit=5 → status=401 (код 42501, insufficient_privilege),
         строк наружу 0, при том что приложение видит 1 строку
phase 4: login 200 · write class 201 · read back 200 · note 201 · pin 200 · delete 200 ·
         cleanup archive 200
ALL CHECKS PASSED
```

Порядок действий и побочные эффекты:

* прогон сам применил миграции к боевой базе, то есть **`0021` уже применена в Supabase** до
  деплоя кода. Для текущего задеплоенного релиза это безразлично (его роль обходит RLS),
  откат — повторный прогон `0020` (идемпотентен) или `git revert` файла `0021`;
* фикстуры прогона: архивированный класс `Проверка cloud …` и refresh-сессии. Перечислены и
  удалены: `cloud-fixtures --delete` → `AFTER DELETE: my classes left=0, my students left=0`,
  `deleted refresh_tokens near my runs: 1`. Дополнительно удалены 2 refresh-сессии, которые
  создал мой `cloud:smoke`-прогон (их не удалось отозвать по HTTP — см. §4.3);
* попутно найдено и исправлено: `cloud-verify.mjs` запускал API с унаследованным
  `TELEGRAM_BOT_TOKEN` и `PUBLIC_URL` из cloud.env, то есть локальная проверка могла
  перепривязать вебхук **живого** бота на адрес, который вебхук не принимает. Теперь для
  этого дочернего процесса токен обнуляется и транспорт `log`; значения нигде не печатаются.

---

## 2. Origin и CSRF

### 2.1 (а) Сравнение идёт по сырому `Host`

`requestOriginAllowed()` читает `req.headers.host`. `req.hostname`/`req.host` в Fastify при
`trustProxy=1` строятся из `X-Forwarded-Host`, и в gate они не участвуют — проверено
поддельным заголовком:

* integration `prod-config.test.ts`: `Host: render.example`, `X-Forwarded-Host:
  internal-service:10000`, `Origin: https://render.example` → **200** (подделка не сужает);
  `Host: render.example`, `X-Forwarded-Host: evil.example`, `Origin: https://evil.example` →
  **403** (подделка не расширяет);
* unit `origin-gate.test.ts` — те же три ветки на чистой функции, плюс «пустой Host не
  совпадает с `about:blank`/`null`».

### 2.2 (б) Второй слой и атрибуты куки

* `Sec-Fetch-Site: cross-site` → отказ, даже если Origin в allowlist. `same-site` не
  отказывается (наше же развертывание может быть доступно с соседнего адреса), отсутствие
  заголовка оставляет решение за Origin. Доказательство: unit + integration (403 против 200
  на том же Origin) + `cloud:smoke` (в бою уже сейчас 403).
* Кука refresh: `HttpOnly`, `SameSite=Lax`, `Path=/api/auth`, `Secure` только в production
  (`cookieIsSecure`). Проверяется трижды: регулярками по `Set-Cookie` в integration-тесте,
  живыми атрибутами из браузерного контекста в `zz9-prod-shape.spec.ts` (`secure`,
  `httpOnly`, `sameSite: 'Lax'`, `path`) и `cloud:smoke` в бою.

### 2.3 (в) `PUBLIC_WEB_ORIGIN` в production пуст по умолчанию

Схема: `z.string().default('')`, и `effectiveWebOrigin(process.env.PUBLIC_WEB_ORIGIN,
NODE_ENV)` возвращает dev-`http://localhost:5173` только вне production. Плюс
`configuredOrigins()` больше не подмешивает localhost вообще — он может попасть в список,
только если оператор его явно укажет.

Замер в бою **до** этого изменения (я его сделал специально, чтобы не рассуждать):
`POST /api/auth/refresh` с `Origin: http://localhost:5173` отвечал **401**, то есть dev-адрес
сидел в allowlist боевого сервиса. После изменения и деплоя тот же запрос обязан дать **403** —
это одна из строк `cloud:smoke`.

### 2.4 (г) Итоговый allowlist в логе старта

`server.ts` перед `listen` печатает `originBootSummary()` (только публичные адреса, без
значений переменных) и предупреждения: `PUBLIC_URL` пуст (вместе с `DOMAIN`), `PUBLIC_URL` не
https, хвостовой слэш, пустой `PUBLIC_WEB_ORIGIN` в production. Живое подтверждение из e2e-стека:

```
origins: allowed=[http://127.0.0.1:3123] sameHost=on
origin config warning: PUBLIC_URL and DOMAIN are both empty: only the request's own Host is trusted as an origin. …
origins: allowed=[http://127.0.0.1:3124] sameHost=on
origin config warning: PUBLIC_URL is not an https origin ("http://127.0.0.1:3124") — a real deployment must be https.
```

---

## 3. Тесты в боевой конфигурации

### 3.1 Матрица

Полный перечень правил, зависящих от `NODE_ENV=production` или от наличия переменной, теперь
живёт в `apps/api/src/lib/prodConfig.ts` (чистые функции) и покрыт парами assert'ов «dev vs
prod». Строка «покрыто» — название теста, который это доказывает.

| # | Поведение | Правило в production | Покрыто |
| --- | --- | --- | --- |
| 1 | `PUBLIC_WEB_ORIGIN` | unset ⇒ пусто (localhost не в allowlist и не в CORS) | unit `prod-config` (3 case), integration (localhost→403), `cloud:smoke` |
| 2 | Кап login | строго 10/мин, `RATE_LOGIN_MAX` **игнорируется** | unit + integration (12 логинов, `RATE_LOGIN_MAX=10000`, 429 после 10) |
| 3 | Кап code-проб | строго 8/мин, `RATE_CODE_MAX` игнорируется | unit (+ существующие `rate-limit`, `registration`) |
| 4 | Grace повторного refresh | ≤ 5000 мс | unit + `phase4-refresh-grace` |
| 5 | TTL токена урока | пол 2 ч (`lib/tokenTtl`) | unit `tokenTtl` + `phase4-token-ttl` |
| 6 | Кука refresh | `Secure` (+ HttpOnly, SameSite=Lax, Path) | unit + integration + `zz9-prod-shape` + `cloud:smoke` |
| 7 | Spike `/api/rtc/token` | 404 | unit + integration + `cloud:smoke` |
| 8 | CORS allowlist | ничего кросс-оригинного, если нет `DOMAIN`/явного `PUBLIC_WEB_ORIGIN`; явный адрес уважается | unit (4 case) + integration (нет ACAO чужому) |
| 9 | Дефолтные секреты | boot запрещён (`JWT_SECRET`, `LIVEKIT_API_*`) | unit `productionSecretProblems` (4 case, значения не печатаются) |
| 10 | Папка миграций | `dist/db/migrations` | unit + **фактически**: e2e-процесс в боевой конфигурации создаёт пустую `klass_prod` из dist |
| 11 | Логи (`logger`) | pino JSON вместо pretty; presentation-only | косвенно: живой лог прод-вида в e2e-стеке |
| presence-правила | | | |
| 12 | `PUBLIC_URL` → `siteUrl()` | `PUBLIC_URL` → `https://DOMAIN` → `PUBLIC_WEB_ORIGIN` → пусто | unit `effectiveSiteBase` (5 case) |
| 13 | `PUBLIC_URL`/`DOMAIN` → вебхук Telegram | только эти два, никогда `PUBLIC_WEB_ORIGIN` | unit `effectiveWebhookBase` |
| 14 | `LIVEKIT_URL` | перебивает `LIVEKIT_WS_URL` и RoomService base, `wss→https` | unit (4 assert) |
| 15 | `WEB_DIST` | статика SPA отдаётся API | e2e (в т. ч. прод-вид грузит UI) + `phase1-headers` |
| 16 | `TELEGRAM_BOT_TOKEN`+`NAME` | пара обязательна, иначе «не настроено» без фолбэка | существующий bot-тест «item 5» |
| 17 | `SEED_TEACHER_*` | сид только при пустой базе, пароль не логируется | существующие seed/`phase3` тесты |
| 18 | `TRUST_PROXY` | XFF формирует bucket IP (и не участвует в Origin-решении) | `rate-limit.test.ts` (off/on) + §2.1 |
| 19 | Сжатие | `/api/auth/*` и token/ticket исключены на **источнике** | integration `prod-config` (200-login и refresh не сжаты; `/api/health` сжат) |
| 20 | `Cache-Control` | приватное — `no-store`, `/assets/*` — `immutable` | `phase1-headers`, `phase1-hardening` + integration `prod-config` |

Открытый пункт (не моё решение, а наблюдение): в бою `content-encoding: br` на ответе
`/api/auth/login` **есть**, хотя источник эти маршруты исключает. Это перекодировка на
грани CDN (`server: cloudflare`). Исключение на источнике доказано тестом; если хочется
гарантии «от токена до браузера без сжатия», нужно отключать сжатие на стороне CDN — помечаю
как решение владельца.

### 3.2 Integration в боевой конфигурации

`test/integration/prod-config.test.ts` (7 тестов) поднимает **тот же самый** `buildApp`, но с
`NODE_ENV='production'`, `TRUST_PROXY=true`, `PUBLIC_URL = адрес страницы`,
`PUBLIC_WEB_ORIGIN=''` (боевой дефолт) и абсурдно мягкими `RATE_*` (чтобы доказать, что они
игнорируются). Цепочка: login → атрибуты куки → refresh → `/api/me` → класс →
`lessons/active` → `lessons/start` → `lessons/:id/join` (токен LiveKit) → `/api/ws/ticket` →
**реальный** WebSocket-upgrade; затем отказные ветки.

### 3.3 E2E в боевой конфигурации

`apps/e2e/tests/zz9-prod-shape.spec.ts` + выделенный API-процесс (`apps/e2e/scripts/prod-shape-api.mjs`,
его запускает сам этот spec в `beforeAll` и гасит в `afterAll`) на порту 3124,
`NODE_ENV=production`, `TRUST_PROXY=1`, `PUBLIC_URL = http://127.0.0.1:3124` (адрес страницы),
**отдельная база `klass_prod`** и свой `STORAGE_DIR`. Отдельная база не косметика: первой же
версией я поймал на одной базе два pg-boss-воркера и две гонки миграций — `material.spec`
(пост «по расписанию») покраснел с 500/таймаутом, пока второй процесс не был изолирован. В бою
процесс один, так что разделение баз убирает артефакт теста, а не прячет баг продукта.

Второй шаг: процесс, который раньше стартовал вместе со всем стеком, теперь принадлежит одному
сценарию (`beforeAll`/`afterAll`). Стеку (`e2e-stack.mjs`) осталось только создавать `klass_prod`
и `3123`; `prodPort` spec'у больше не нужен — адрес возвращает `startProdShapeApi()`.

Про приоры этого шага я сначала написал «два pg-boss-воркера съедают CPU, и `material.spec` не
успевает в свой 240-секундный бюджет». Это было **проверкой, а не выводом**, и проверка его
опровергла: после переноса процесса в spec тот же тест остался красным. Настоящая причина —
клиентский краш rich-text, разобран в §11; перенос процесса сам по себе всё равно правильный
шаг (один сценарий платит за свой сервер), но к красноте он отношения не имел.

Сценария: UI-логин → проверка атрибутов куки **из контекста браузера** → **полная
перезагрузка** страницы (session restore через refresh; это ровно тот шаг, что давал 403) →
`/lesson` → `check-devices` → `join-lesson` → WS-апгрейд урока → при доступном LiveKit
собственная плитка камеры с реальными пикселями (то есть `room.connect()` состоялся);
отдельно — чужой Origin даёт 403 на том же сервере, и ни одного 401/403 в аутентифицированной
части.

---

## 4. `pnpm cloud:smoke` — проверка после деплоя

`apps/api/scripts/cloud-smoke.mjs` (+ `pnpm cloud:smoke`, шаг добавлен в `docs/DEPLOY.md` §8 и
в «Проверку после деплоя» в `docs/CLOUD_DEMO.md`). Только чтение, данных не пишет: здоровье и
заголовки, четыре ветки Origin-гейта (свой адрес, чужой, похожий на домен, `localhost`,
`Sec-Fetch-Site`), атрибуты куки, `/api/me`, `/api/classes`, `/api/lessons/active`, билет WS
как «авторизован и отказан поиском» (404) вместо запуска урока, закрытый spike (404), анонимный
и поддельный bearer (401), затем отзыв собственной сессии.

### 4.3 Фактический прогон по текущему бою (релиз `075e8a6`)

```
PASS  /api/health 200 · нет версий · no-store · CSP/nosniff/frame-ancestors
FAIL  refresh с СОБСТВЕННЫМ Origin не 403            — status=403 {"error":"forbidden"}
PASS  чужой Origin 403 · look-alike «.evil.example» 403 · Sec-Fetch-Site 403
FAIL  localhost в allowlist боевого сервиса           — status=401 (то есть пропускается!)
PASS  login 200 · HttpOnly · Secure · SameSite=Lax · Path=/api/auth · accessToken
PASS  /api/me 200 (teacher) · /api/classes 200 (2) · /api/lessons/active 200
PASS  /api/ws/ticket: 404 на несуществующую сессию (авторизация есть, записи нет)
SKIP  живой WS урока — открытой сессии нет (запуск урока записал бы данные)
FAIL  /api/auth/logout 200                            — status=403
FAIL  отозванная кука не refresh'ится                 — status=403
PASS  анонимный /api/me 401 · поддельный bearer 401 · spike /api/rtc/token 404
INFO  content-encoding на ответе login: br (источник исключает; CDN может перекодировать)
SMOKE FAILED: 4 check(s)
```

Что это даёт практически:

* первые два FAIL — сам инцидент, зафиксированный инструментом;
* FAIL про `localhost` подтверждает §2.3: в боевом allowlist сейчас сидит dev-адрес;
* FAIL'ы про logout — **новое наблюдение этого прогона**: отказ гейта ломает не только вход в
  урок, но и выход из аккаунта (кнопка «Выйти» тоже cross-POST → 403). Это надо ждать
  починенным тем же фиксом;
* из-за того же отзыва по HTTP не прошли: две refresh-сессии прогона отозваны напрямую в БД
  (§1.5), значений наружу не выводилось.

Ожидаемый вывод после деплоя: все PASS, `SKIP` на живом WS (или PASS, если в момент проверки
идёт урок), `INFO` про сжатие — справочно.

---

## 5. Документы

* `VIDEO_CALL_REGRESSION_REPORT.md` — вверху баннер «ЗАМЕНЁН»: RLS-гипотеза для прода опровергнута
  замером, причина — Origin-гейт;
* `VIDEO_CALL_FIX_REPORT.md` — баннер «ЗАМЕНЁН»: `0020` не была причиной, снята `0021`, тест
  переписан;
* `VIDEO_CALL_FINAL_FIX_REPORT.md` — баннер «Дополнен»: причина и фикс `896d355` верны, остатки
  закрыты здесь;
* `docs/DECISIONS.md` — решение по `0021` с замерами, риском и откатом;
* `docs/HARDENING.md` — строки 1в-1b…1в-1e (второй слой, сырой Host, пустой prod-дефолт, лог
  старта), переписанная строка CORS и расширенный раздел «л) БД / RLS» историей `0020` → `0021`;
* `docs/DEPLOY.md` §8 и `docs/CLOUD_DEMO.md` — обязательная проверка после каждого деплоя.

⚠️ `VIDEO_LESSON_DEBUG_MASTER_CONTEXT.md` в репозитории **нет**: ни в рабочем дереве, ни в
истории git (`git log --all -- "*MASTER_CONTEXT*"` пуст). Пометить как заменённый можно только
те отчёты, которые есть; если этот файл лежит у вас вне репозитория — баннер для него тот же:
«RLS-гипотеза для прода опровергнута, причина — Origin-гейт, актуальный разбор:
`VIDEO_CALL_FINAL_FIX_REPORT.md` + `VIDEO_LESSON_FOLLOWUP_REPORT.md`».

---

## 6. Изменённые тесты и почему

| Файл | Было → стало | Причина |
| --- | --- | --- |
| `phase1-rls-approle.test.ts` | 4 → 6 тестов, файл переписан | `0020` отменена `0021`; старые assert'ы («не-владелец с грантами видит строки») стали бы ложью. Ни один тест не удалён и не освобождён: прежние проверки живут внутри новых (роль не владелец и не BYPASSRLS; роль без грантов отказана), добавлены инвариант роли, «политик нет», закрытость `anon`/`authenticated` по всем таблицам и контракт для не-владельца |
| `origin-gate.test.ts` | 8 → 14 тестов | второй слой `Sec-Fetch-Site`, сырой Host против XFH, пустой prod-`PUBLIC_WEB_ORIGIN`, `originBootSummary`, `about:blank`/пустой Host |
| `prod-config.test.ts` (unit) | новый, 24 теста | вся матрица §3.1 в обеих формах |
| `prod-config.test.ts` (integration) | новый, 7 тестов | матрица в боевом процессе, включая реальное сжатие, реальный WS и кап без оглядки на env |
| `zz9-prod-shape.spec.ts` | новый, 1 тест | боевая конфигурация в живом браузере + `room.connect()` |
| `material.spec.ts` | **без изменений** | падал по причине клиентского краша (§11); тест и его 240-секундный бюджет остались ровно теми, что были, — краснота снялась фиксом продукта, а не правкой теста |
| `zz10-richtext-boot.spec.ts` | новый, 3 теста | deterministic-воспроизведение окна «tiptap уже destroy'нул редактор, а рендер его держит»; красный до фикса, зелёный после |
| `phase1-hardening.test.ts` | без изменений | «trust configured Origin, not Host» остаётся правдой для чужих Origin — фикс ничего не ослабил |

---

## 7. Что могло сломаться и как это проверялось

| Риск | Почему мог | Как проверено |
| --- | --- | --- |
| Ослабление CSRF-защиты | вернули допущение «Origin == Host» | чужой Origin, look-alike-домен, `about:blank`, пустой Host, порт-не-тот, `Sec-Fetch-Site` — всё 403 в unit и integration; кросс-сайт WS 4403 в `phase1-adversarial` |
| Открытие `anon`/`authenticated` | политика `TO PUBLIC` в `0020` выглядела страшно | `0021` их убирает; ноль привилегий по 35 таблицам + отказы на 6 таблицах + REST 401 (замер боя) |
| Регресс боевого RLS | снятие политик могло что-то сломать | `cloud-verify` на живой базе: read/write/update/delete OK, `ALL CHECKS PASSED`; RLS по-прежнему 35/35 |
| Поломка session restore | второй слой по `Sec-Fetch-Site` | `zz9` (перезагрузка + `same-origin`), integration (200 с `same-origin`, 403 с `cross-site`) |
| Разъезд CORS-политики | переписался allowlist | unit 4 случая + integration «нет ACAO чужому»; dev/демо-ветка сохранена |
| Продакшн не стартует | изменения в env-валидации | боевой процесс реально поднимается (e2e-стек, `cloud-verify`), `productionSecretProblems` покрыт unit'ом |
| Тихий пропуск миграции | папка миграций через хелпер | unit + факт: `klass_prod` создана с нуля прод-процессом из `dist` |
| Гонка двух API на одной базе в тестах | новый второй процесс | найдено на деле (`material.spec` краснел), исправлено изоляцией `klass_prod`; процесс вынесен из общего стека во владение spec'у (§3.3). Но этим краснота не лечилась: настоящая причина — клиентский краш rich-text, разобран и закрыт в §11, и только после него `material.spec` зелёный |
| Прогон cloud-verify перенастраивает живого бота | унаследованный `TELEGRAM_BOT_TOKEN` + `PUBLIC_URL` | убрано в самом скрипте (токен обнулён для дочернего процесса, транспорт `log`) |

---

## 8. Что НЕ проверено без Render

1. Сам деплой: `autoDeploy: false`, деплой запускает владелец. Пока он не запущен, бой
   по-прежнему отвечает 403 на собственный Origin — это подтверждено прогоном `cloud:smoke`
   выше (4 FAIL).
2. Живой WS урока через Render-прокси: `cloud:smoke` проверит его только если в момент
   запуска идёт открытый урок; иначе `SKIP`.
3. Реальный `POST /api/lessons/:id/join` и `room.connect()` в бою — локально доказано в
   боевой конфигурации конфигурации с LiveKit Cloud (`zz9-prod-shape`), на Render пока нет.
4. Поведение CDN-сжатия (см. открытый пункт §3.1) — вне нашего источника.
5. Отзывы/метрики Render-логов (`migrate()` на старте, строка `origins:`) — увидим после
   деплоя.
6. Что фикс §11 реально снял краш в бою: на задеплоенном сейчас бандле его нет (правка
   клиентская, а бой до вашего деплоя — предыдущий релиз). Проверяется после деплоя так:
   открыть «Создать материал» и «Заметки» на боевом адресе — экрана «Что-то пошло не так» быть
   не должно; локально это уже покрыто `zz10-richtext-boot.spec.ts` (3 теста) и зелёным
   `material.spec`.

После деплоя я прогоняю закоммиченные инструменты и присылаю фактические статусы:
`pnpm cloud:smoke` (чтение, §4), `pnpm db:audit -- <cloud.env> --require-data` (свой §1.2) и
`node apps/api/scripts/cloud-verify.mjs <cloud.env>` (стартует API на живой базе, делает
read/write/read-back и убирает свои фикстуры; §1.5). Временные repro-скрипты инцидента
(`apps/e2e/scripts/camera-repro.mjs`, `cloud-call-repro.mjs`, `apps/api/scripts/cloud-fixtures.mjs`,
`cloud-tokens-del.mjs`) в репозиторий не входили и не входят: то, что они доказали, здесь
зафиксировано цифрами, а повторяемая проверка боя — это три команды выше.

---

## 9. План отката

| Шаг | Откат | Комментарий |
| --- | --- | --- |
| `0021` (политики) | повторно применить `0020` (идемпотентен) **или** `git revert` файла миграции | RLS не трогали ни там ни там; данных нет |
| Origin-гейт (`896d355`, `fd1934e`) | `git revert` коммита | бой вернётся к «свой Origin = 403», то есть к инциденту — только как аварийная мера |
| Второй слой/`prodConfig` (`8fdaa81…fd1934e`) | `git revert` | поведение бой-веток возвращается к прежнему |
| Тесты/док-файлы | `git revert` | тесты не удаляются, а возвращаются к прежней версии |
| Боевая БД (применённая `0021`) | повторный прогон `0020` | политики вернутся; ролям это ничего не меняет (обходят RLS) |
| Render | Manual Deploy на предыдущий successful release | миграции Drizzle не откатываются автоматически — при откате релиза схемы остаются применёнными |

---

## 10. Метрики

| Метрика | До этой задачи | Сейчас |
| --- | --- | --- |
| Typecheck | чисто | чисто |
| API-тесты | 272 / 46 | **322 / 50**, 0 skipped |
| e2e (с реальным RTC) | 41 | **45**, 0 skipped, 5.2 m (из них `material.spec` — зелёный, и 3 теста §11) |
| CI | зелёный | зелёный: run [`37655946635`](https://github.com/kizaruzone0260-eng/BluBlu/actions/runs/37655946635) completed/success — `build-test` и `e2e` (45 тестов: 42 passed + те же 3 real-RTC специ, что самопропускаются без доступного LiveKit: `zz-camera`, `zz2-moderation`, `zz4-layout`; `zz10` на CI-chromium зелёный) |
| Миграции | до `0020` | + `0021` (в бою уже применена) |
| `security-scan` | 0 | 0 |
| Сборки | зелёные | зелёные (`prodConfig.js` и `0021_*.sql` в dist) |
| Проверка боя | не было инструмента | `pnpm cloud:smoke` + `pnpm db:audit` |

## 11. Краш, из-за которого `material.spec` был красным (причина найдена в ПРОВЕРКЕ, §6)

Полный набор этой задачи дважды упал на одном и том же тесте: `material.spec.ts:150`
«draft is teacher-only; scheduled becomes visible after its time» — 240 с таймаут,
`locator.fill` ждёт `getByTestId('material-title')`. Тест не удалялся и не ослаблялся; он оказался
правильным индикатором чужого бага.

Доказательства по порядку:

1. `error-context.md` (Playwright пишет снапшот страницы в момент падения) — на экране
   `role="alert"` с `heading "500"` и кнопкой «Повторить». Это `ErrorBoundary`, а НЕ HTTP 500: в
   логах API за прогон ни одной 5xx (`grep statusCode":500` → 0 совпадений, 429 тоже 0).
2. Запуск того же файла изолированно (`npx playwright test material.spec.ts --trace on`) — та же
   краснота, но на другой строке (168 вместо 158), то есть падает не «конкретный шаг», а любой
   заход на страницу. Это гонка, а не детерминированная поломка.
3. Трейс изолированного прогона (`--trace on`, артефакт лежит вне репозитория, воспроизводится
   той же командой) — запись консоли из `1-trace.trace`, ровно та, что я искал:

   ```
   TypeError: Cannot read properties of null (reading 'cached')
       at Ot.fromSchema      (assets/index-Bpu2418u.js:4:6631)   ← prosemirror-model
       at Bs                  (assets/index-Bpu2418u.js:10:80410)
       at Ng.getHTML          (assets/index-Bpu2418u.js:96:9069)  ← editor.getHTML()
       at assets/RichText-DTU1sfGg.js:1:1278                     ← наш эффект синхронизации
       at Jl / qs / …        (assets/index-DDcx-2HD.js)          ← React commit
       at MessagePort.H      (assets/index-DDcx-2HD.js:2:10259)  ← scheduler-порт
   ```

   Колонка 1278 в собранном чанке — это `n&&e!==n.getHTML()` в `useEffect` компонента `RichText`
   (проверено по `apps/web/dist/assets/RichText-*.js`), то есть строка 24 исходника.

4. Механизм — из исходников библиотек, не из догадок:
   * `@tiptap/react` (`EditorInstanceManager`): конструктор создаёт редактор во время RENDER
     (`getInitialEditor()` → `new Editor(...)`) и тут же вооружает `setTimeout(..., 1)`, который
     убивает его, если `isComponentMounted === false` (`scheduleDestroy`). Монтаж происходит в
     **пассивном**эффекте React, а он исполняется в отдельной задаче, доставленной через
     MessagePort.
   * `@tiptap/core` `Editor.destroy()`: `this.extensionManager = null; this.schema = null;`, а
     `getHTML()` = `getHTMLFromFragment(this.state.doc.content, this.schema)` →
     `DOMSerializer.fromSchema(null)` → чтение `.cached` на `null`. Ровно сообщение из трея.
   * Значит: на заезженной машине задача flush припозднилась больше 1 мс → текущий рендер держит
     уже **уничтоженный** экземпляр → первый же его `getHTML()` кидает в эффекте → граница
     проглатывает (в боёвом билде React не пишет в консоль) и показывает 500-экран навсегда.
     Пользователь теряет форму материала/заметки без единой ошибки на сервере.

Фикс (три файла, продуктовый код, не тесты):

* `apps/web/src/lib/tiptapSafe.ts` — `editorIsAlive(editor)` = `!!editor && !!editor.schema`.
  `schema` создаётся в конструкторе (ещё до монтажа) и обнуляется в `destroy()`, поэтому это ровно
  нужный сигнал. `editor.isDestroyed` для этого **не** годится: он читает
  `editorView?.isDestroyed ?? true`, то есть `true` и для здорового редактора, который просто ещё
  не примонтирован, — защита на нём навсегда спрятала бы тулбар.
* `apps/web/src/components/RichText.tsx` — опции `useEditor` стали стабильными (`EXTENSIONS` на
  уровне модуля, `editorProps` в `useMemo`, `onUpdate` в `useCallback` + ref на `onChange`):
  свежий литерал на каждый рендер ломает `EditorInstanceManager.compareOptions` и заставляет
  библиотеку переконфигурировать редактор на каждом рендере. Все чтения экземпляра
  (`getHTML` в эффекте и в `onUpdate`, тулбар) идут через `editorIsAlive`.
* `apps/web/src/pages/Notes.tsx` — тот же паттерн был в собственном `Tiptap` заметок, лечится
  тем же (иначе «Заметки» падали бы ровно так же).

Регресс-тест: `apps/e2e/tests/zz10-richtext-boot.spec.ts`. Он не ждёт случая, а создаёт его:
инициал-скрипт сдвигает доставку каждого `MessagePort.postMessage` на 8 мс — пассивный flush
гарантированно опаздывает за 1 мс таймер, и окно «мёртвый экземпляр» возникает на каждом монтаже.

| Состояние | Прогон | Результат |
| --- | --- | --- |
| ДО фикса (тот же тест, несобранный бандл) | `npx playwright test zz10-richtext-boot.spec.ts` | **FAIL**: `the material form must render, not the error screen`, снапшот страницы в момент падения — `heading "500"` + «Повторить» (`error-context.md` этого прогона) |
| ПОСЛЕ фикса | тот же прогон на собранном бандле | **PASS**: 3/3 (setup, форма материала с печатью и `rt-bold`, заметки), 20.3 s |
| ПОСЛЕ фикса на CI | run `37655946635`, chromium | **PASS**: `✓ 22 … material form: the editor is alive… (1.1s)`, `✓ 23 … notes editor… (1.1s)` |

Тест дополнительно не даёт проверке «пройти впустую»: `expectCollector` требует, чтобы
внутристраничный сборщик ошибок (тот же init-скрипт, что и задержка) действительно был установлен.

Почему это НЕ регресс фазы защиты: ни одного 5xx в API, крах чисто клиентский, а сама гонка жила вприложении с момента появления редакторов. Нагрузка (второй API-процесс, другой spec, фоновые
процессы этой машины) не причина, а условие: она сдвигает flush пассивного эффекта за 1 мс таймер
`@tiptap/react`. Поэтому изолировать процесс было правильно, но красноту это не сняло — её снял
фикс продукта (§11), а `material.spec` при этом не изменён ни на строку.
Проверка «не изменён»: `git diff fd1934e HEAD -- apps/e2e/tests/material.spec.ts` пуст, а
последний коммит, который его трогал, — `91b3142` «fix a pre-existing flaky e2e»: то есть тест
и до этой задачи уже чинили как «плавающий» (тогда — закругление времени публикации на минуту).
Гонка редактора была вторым, не найденным тогда слоем.

## 12. Коммиты
`b6355a3` refactor(db): drop the 0020 permissive policies — proven unreachable for the app role
`8fdaa81` harden(auth): second Origin layer, raw-Host only, empty production web origin, boot summary
`50bd486` test(e2e): run the real browser flow against the deployed configuration
`c0492c1` feat(ops): pnpm cloud:smoke — the post-deploy check the outage should have had
`fd1934e` refactor(config): put every production-only rule in one tested module
`a75670b` test(e2e): give the deployed-shape api to the one spec that needs it
`a281930` fix(web): stop reading the tiptap editor it had already destroyed (§11)
+ коммит этого отчёта и баннеров документов (см. `git log`)
