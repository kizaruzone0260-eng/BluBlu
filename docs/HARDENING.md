# BluBlu — фаза защиты и финальной подготовки

Ветка `overnight`. Приоритет: **безопасность (Фаза 1)** и **отсутствие регрессий**.
Секреты не выводятся и не трогаются. Деплой запускает владелец.

Легенда статуса: ✅ сделано и доказано; 🟡 реализовано, но требует живого сервера / ручной проверки; ⚪ не требуется; 🔵 требует решения владельца.

---

## 0. Базовая линия (до каких-либо изменений)

Снято на коммите `9312112` (HEAD ветки `overnight` на старте задачи), 2026-10-06.

| Проверка | Команда | Результат (база) |
| --- | --- | --- |
| Typecheck | `pnpm -r typecheck` | чисто (shared / api / web) |
| API-тесты | `node scripts/with-postgres.mjs pnpm exec vitest run` (apps/api) | **193 passed / 31 files** |
| e2e (реальный RTC) | `npx playwright test` (apps/e2e) | **27 passed (6.0m)** |
| Сборка API | `pnpm --filter @klass/api build` | OK |
| Сборка web | `pnpm --filter @klass/web build` | OK, 2m43s; предупреждение «Some chunks larger than 500 kB» |
| Размер бандла | `du -sk apps/web/dist` | ≈23 840 KiB (≈23.8 МБ) всего; `dist/assets` JS+CSS ≈9 670 KiB |
| Крупнейшие чанки | vite build | `index-*.js` 2 870.79 kB (gzip 875.64); `subset-shared.chunk-*.js` 1 820.50 kB (gzip 735.69); `cynefin-*.js` 687.91 kB; `index-*.js` 736.61 kB; `katex-*.js` 261.31 kB |
| Audit (prod) | `pnpm audit --prod` | 1 high (`braces`, build-time transitive) + 1 low (`katex`); см. п. н |
| Source maps | `vite.config.ts` `sourcemap:false` | не публикуются ✅ |

Правило сравнения: после КАЖДОЙ фазы прогоняется весь набор и сверяется с этой таблицей.
Тесты не удаляются/не ослабляются ради зелёного статуса; каждый изменённый существующий
тест объяснён в отчёте фазы.

---

## Фаза 1 — безопасность

Итог: **20 новых API-тестов** (база 193 → **213/213**, 33 файла), e2e **27/27** с
реальным RTC, typecheck чист, `security-scan` 0. Изменения затронули `app.ts`, `env.ts`,
`routes/{auth,telegram,rtc}`, `services/{botApi,lessons}`, `routes/{board,chat,lessons}`
(WS-Origin), новый `lib/wsOrigin.ts`, `packages/shared/schemas.ts`, `Register.tsx`,
локали ru/uz/en, новый `scripts/security-scan.mjs`. Миграций БД в фазе 1 НЕТ (смена
подписи callback — программная совместимость, без DDL), поэтому правило RLS к этой фазе
неприменимо. Доказательства: `phase1-hardening.test.ts` (15), `phase1-adversarial.test.ts`
(5), плюс существующая матрица прав `rights.test.ts`.

### а) Заголовки HTTP/WS и поверхность
| # | Пункт | Изменено | Доказательство | Статус |
| --- | --- | --- | --- | --- |
| 1а-1 | CSP без unsafe-eval | — | phase1-hardening «helmet headers» (нет unsafe-eval) | ✅ |
| 1а-2 | CSP style-src 'unsafe-inline' | оставлен (Excalidraw); script-src 'self' | DECISIONS, phase1-hardening | 🟡 принято |
| 1а-3…8 | frame-ancestors/HSTS/nosniff/XFO/Referrer/COOP-CORP/Permissions-Policy | — | phase1-hardening «helmet headers» | ✅ |
| 1а-9 | Cache-Control: no-store для приватного API | `app.ts` onSend: /api и /webhook | phase1-hardening «no-store» | ✅ |
| 1а-10 | Нет source maps | `vite sourcemap:false` | baseline | ✅ |
| 1а-11 | Страницы ошибок без stack/версий | `app.ts` setErrorHandler (500→{error:serverError}) | phase1-hardening «5xx never leaks» | ✅ |
| 1а-12 | /api/health без версии | — | baseline | ✅ |

### б) Куки / сессии
| # | Пункт | Изменено | Доказательство | Статус |
| --- | --- | --- | --- | --- |
| 1б-1 | HttpOnly/Secure/SameSite=Lax | — | код `refreshCookieOpts` | ✅ |
| 1б-2 | access-токен только в памяти JS | — | `lib/api.ts` | ✅ |
| 1б-3 | Refresh-ротация + reuse-detec | — | rights/stage1 | ✅ |
| 1б-4 | Grace на реплей ротированного refresh | `env.ts` prod-clamp (см. «Доработка» п.4б) | phase4-refresh-grace (2s гибнет при 3s паузе ⇒ вернули 5s) | ✅ |
| 1б-5 | Выход со всех устройств | `POST /api/auth/logout-all` + кнопка в профиле | phase3-passwords + zz8 e2e | ✅ |

### в) CSRF / Origin
| # | Пункт | Изменено | Доказательство | Статус |
| --- | --- | --- | --- | --- |
| 1в-1 | configured Origin (PUBLIC_WEB_ORIGIN/PUBLIC_URL/https://DOMAIN) **или** Origin == собственный Host запроса; чужой Origin → 403 | `routes/auth.ts` checkSameOrigin → общий `lib/origin.ts` | phase1-hardening «trust configured Origin, not Host» (403 при Origin=evil) + video-lesson-origin-drift / unit «origin gate» | ✅ |
| 1в-1a | ⚠️ Инцидент: вариант «только allowlist, Host не доверяется» (9573faa) снова сломал облачный прод — страница своего же хоста получала 403 на `/api/auth/refresh`, SPA ронял токен и Video Lesson выбрасывал на Sign In (тот же инцидент уже чинился в fe50ec8). Причина: allowlist не совпал с фактическим адресом UI. Итог: same-Host Origin принимается, кросс-сайт по-прежнему 403 | `lib/origin.ts`, `lib/wsOrigin.ts`, `render.yaml` (`PUBLIC_WEB_ORIGIN`) | `video-lesson-origin-drift.test.ts` (падает на старом коде), unit `origin-gate.test.ts` | ✅ |
| 1в-1b | Второй слой: `Sec-Fetch-Site: cross-site` → отказ, даже если Origin в allowlist (браузерный заголовок, который скрипт подставить не может) | `lib/origin.ts` requestOriginAllowed | unit `origin-gate` «rejects Sec-Fetch-Site: cross-site …», integration `prod-config` (refresh с cross-site → 403, с same-origin → 200) | ✅ (2026-10-07) |
| 1в-1c | Сравнение идёт по СЫРОМУ `Host` (`req.headers.host`), а не по `X-Forwarded-Host`/`req.hostname`, которые Fastify строит из XFH при `trustProxy=1` | `lib/origin.ts` (одна точка для HTTP и WS) | unit «compares the RAW Host — a spoofed X-Forwarded-Host cannot widen or narrow the gate», integration «X-Forwarded-Host spoof cannot move the gate» (обе ветки) | ✅ (2026-10-07) |
| 1в-1d | В production `PUBLIC_WEB_ORIGIN` по умолчанию пуст → localhost не попадает ни в Origin-allowlist, ни в CORS. Замер до изменения: `Origin: http://localhost:5173` на бойке получал **401** (проходил!), теперь 403 | `lib/prodConfig.ts` effectiveWebOrigin, `env.ts`, `app.ts` | unit `prod-config.test.ts` (обе среды), integration `prod-config.test.ts`, `pnpm cloud:smoke` | ✅ (2026-10-07) |
| 1в-1e | Лог старта печатает фактический allowlist и предупреждает о дрейфе (пустой/не-https `PUBLIC_URL`, слэш на конце, пустой `PUBLIC_WEB_ORIGIN`) — только публичные адреса, без секретов | `lib/origin.ts` originBootSummary, `server.ts` | unit (каждая ветка предупреждений) + живой лог двупроцессного e2e-стека: `origins: allowed=[http://127.0.0.1:3124] sameHost=on` / `origin config warning: PUBLIC_URL is not an https origin` | ✅ (2026-10-07) |
| 1в-2 | Строгий CORS allowlist: в production дополнительно учитывает явный `PUBLIC_WEB_ORIGIN` (раньше читал только DOMAIN, и раздельный фронтент не мог авторизоваться) | `lib/prodConfig.ts` effectiveCorsOrigins, `app.ts` | unit `prod-config.test.ts` (4 ветки, включая «никого не пустим» и «пустая строка не попадает в список») | ✅ |

### г) Rate limits
| # | Пункт | Изменено | Доказательство | Статус |
| --- | --- | --- | --- | --- |
| 1г-1 | Prod игнорирует e2e-ослабления RATE_* | `app.ts` onRoute (prod→10/8) | ревью (prod-логика вне test-e2e) | ✅ |
| 1г-2 | Лимиты chat/upload/bot | global 300/мин + chat 5/10с уже есть | chat.test, rate-limit.test | ✅ |

### д) Логин / пароли
| # | Пункт | Изменено | Доказательство | Статус |
| --- | --- | --- | --- | --- |
| 1д-1 | Нет enumeration | — | services/auth «constant-ish» | ✅ |
| 1д-2 | ≥10 + denylist частых (set), lax на login | `schemas.ts`, `Register.tsx`, locales×3 | phase1-hardening «password policy» (TooShort/TooCommon + legacy login) | ✅ |
| 1д-3 | Локаут перебора по аккаунту | `login_attempts` (Postgres, переживает рестарт), прогресс. задержка 5→30s→×2→cap 15 мин, без утечки существования | phase2-lockout (5) | ✅ (было 🔵) |
| 1д-4 | timingSafeEqual для секретов | telegram webhook secret | phase1-hardening «webhook secret» | ✅ |

### е) WebSocket
| # | Пункт | Изменено | Доказательство | Статус |
| --- | --- | --- | --- | --- |
| 1е-1 | One-time билеты | — | rights WS | ✅ |
| 1е-2 | Origin на upgrade | `lib/wsOrigin.ts` + 3 обработчика | phase1-adversarial «board WS rejects cross-site Origin (4403)» | ✅ |
| 1е-3 | maxPayload 256 KiB | — | baseline | ✅ |
| 1е-4 | Права на сообщение | board: роль на каждое сообщение | rights | ✅ |

### ж) Загрузки / з) контент
Все подпункты (magic bytes, квота, attachment/nosniff, SVG download-only, UUID-ключи,
ссылки http(s)-only, нет SSRF, экранирование на рендере) — были ✅ из базовой линии.
Добавлены доказательства: phase1-adversarial «XSS verbatim across surfaces»
(чат/материал/заголовок/заголовок-ссылки хранятся как есть, JSON content-type) и
«attachment URLs must be http(s)» (javascript:/data:/file:/нет-точки → 400 invalidLink).

### и) Telegram
| # | Пункт | Изменено | Доказательство | Статус |
| --- | --- | --- | --- | --- |
| 1и-1 | webhook secret timingSafeEqual | `routes/telegram.ts` | phase1-hardening | ✅ |
| 1и-2 | HKDF-ключ callback + совместимость c1 | `botApi.ts` (c2, verify принимает c1) | phase1-hardening (separate-key, legacy-verify, tamper) + bot.test обновлён c1→c2 | ✅ |
| 1и-3/4 | token не в логах; update_id идемпотентность | — | baseline | ✅ |

### к) LiveKit
| # | Пункт | Изменено | Доказательство | Статус |
| --- | --- | --- | --- | --- |
| 1к-1 | Минимальные права по ролям | — | rights/stage4 | ✅ |
| 1к-2 | TTL токена урока | `env.RTC_TOKEN_TTL` (default 6h, prod-пол ≥2h); спайк 1h | phase4-token-ttl (4): exp−nbf==TTL, повторный join даёт свежий токен | ✅ (Part 4а) |
| 1к-3 | Энтропия имени комнаты | rand 4→8 байт | ревью | ✅ |
| 1к-5 | Spike отключён в prod | `routes/rtc.ts` (prod→404) | phase1-hardening «spike disabled in production» | ✅ |

### л) БД / RLS — Part 1е закрыл пробел. Оказалось, что 19 исходных таблиц (созданы до фаз
защиты) вообще НЕ имели RLS — только таблицы поздних миграций. Миграция `0019` циклом по
pg_class включает `ENABLE ROW LEVEL SECURITY` и с guarded-`REVOKE` закрывает anon/authenticated
(+ PUBLIC) на ВСЕХ базовых таблицах публичной схемы. Приложение ходит владельцем таблиц (klass) и
RLS обходит (FORCE не ставится) — на запросы не влияет. Доказательство: `phase1-rls.test.ts` (3)
прямо читает pg_class/has_table_privilege. Живой REST-тест публичным ключом на Supabase —
по-прежнему ручное действие владельца (нет anon-ключа в офлайн-наборе).

**2026-10-07: политики `0020` сняты миграцией `0021`.** `0020` добавляла по одной
`app_trusted_access … TO PUBLIC USING (true)` на таблицу из предположения, что бэкенд ходит
НЕ-владеющей ролью. Замер (read-only `pnpm db:audit`, `apps/api/scripts/rls-audit.mjs`) это
опроверг: dev/CI — роль `klass` superuser + BYPASSRLS + владелец 35/35 таблиц; бэкенд боя — роль
`postgres`, владелец 35/35 с `rolbypassrls = true`; `relforcerowsecurity = 0` везде. То есть
политика была достижима только ролям, которые RLS и так обходят, и не достигала тех, кого
должна была ограничивать. RLS остался включённым на всех 35 таблицах, привилегии не менялись.
Замерено после `0021` на бою: политик 0, `rls_on 35/35`, `forced 0`, у `anon`/`authenticated`
0 привилегий по всем 35 таблицам, чтение `users, classes, chat_messages, posts, files,
teacher_notes` отказано на уровне привилегий, PostgREST с публичным ключом отвечает 401 на
каждой из шести, а приложение под своей ролью видит `users_live=1, classes=4, sessions=4`
и `cloud-verify` проходит полностью (write/read/update/delete). Тест
`phase1-rls-approle.test.ts` ПЕРЕПИСАН (не удалён): теперь он сторожит сам инвариант
«роль приложения = superuser/BYPASSRLS/владелец, FORCE нигде нет», требует отсутствие
политик `TO PUBLIC` на уровне `pg_policy` и доказывает, что не-владелец с выданными GRANT при
policy-less RLS видит 0 строк — то есть перевод `DATABASE_URL` на другую роль обязан принести
собственные политики. Решение: `docs/DECISIONS.md` (2026-10-07).

### м) Секреты и логи
| # | Пункт | Изменено | Доказательство | Статус |
| --- | --- | --- | --- | --- |
| 1м-1 | Скан дерево + история | `scripts/security-scan.mjs` | запуск: 0 находок в 60 коммитах и дереве | ✅ |
| 1м-2 | Логи без токенов/паролей/ICS/invite/ticket/текста чата | redact + sanitizeRequestUrl | ревью `app.ts` | ✅ |

### н) Зависимости
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1н-1 | high+critical=0 | 1 high `braces` + 1 low `katex` | ✅ принято, доказано (см. ниже) |
| 1н-1b | `braces` вне рантайма | `pnpm --filter @klass/api list --prod` → **braces ABSENT** (в api нет); цепочка `@excalidraw 0.18.1 → sass → chokidar → braces 3.0.3` (build-tree); в `apps/web/dist` сигнатур `braces` (`noopt`/`makeRe`/`expandRange`) **нет** — вхождение слова «braces» лишь в UI-текстах Monaco («Comment with braces»). Не попадает ни в рантайм-образ, ни в бандл | ✅ (Part 1ж) |
| 1н-2 | lockfile pinned | `--frozen-lockfile` в CI | ✅ |
| 1н-3 | CI audit | есть (`continue-on-error`, список в DECISIONS) | 🟡 |

### о) Бэкапы / п) данные пользователя
- 1о: `deploy/scripts/backup.sh`/`restore.sh` + `logical-backup.mjs`. Part 1б добавил
  **сквозную офлайн-проверку**: дамп → `openssl aes-256-cbc -pbkdf2` → расшифровка →
  восстановление в НОВУЮ пустую БД → сверка счётчиков всех таблиц. `phase1-backup.test.ts`
  подтверждает это на встроенном PG; живой `pg_dump`-путь на Supabase — действие владельца. 🟡→✅(логика)
- 1п-1: **реальное стирание** при удалении (`services/account.ts eraseAccount`) — чат/заметки/
  листки/Telegram-привязка/токены/согласия/участства удаляются; авторский контент класса
  остаётся, но личность анонимизирована (users.name→«Deleted user», email→invalid).
  `phase1-erasure.test.ts` (2). Было: мягкое удаление только снимало refresh-токены (каскеды
  не срабатывали) — исправлено. ✅
- 1п-2: смена пароля + сброс без email — СДЕЛАНО в «Доработка» ч.3 (самообслуживание в профиле,
  сброс учителем/скриптом владельца, гейт обязательной смены, выход со всех устройств). ✅

---

## Фаза 2 — юр. тексты и согласия (только черновики)
Черновики (правовую проверку делает владелец). Гейт согласия реализован и работает.

Итог: API **217/217** (34 файла; +4 consent), e2e **27 → 31** (+4 `zz5-policy`),
typecheck чист. Миграция `0016` (новая таблица `policy_acceptances`) включает RLS + закрытие
anon/authenticated. Доказательства: `phase2-consent.test.ts`, `zz5-policy.spec.ts`.

| # | Пункт | Реализация | Статус |
| --- | --- | --- | --- |
| 2-1 | Privacy + Terms на ru/uz/en | `pages/LegalDoc.tsx` + тексты в локалях (`privacy.sections` 12, `terms.sections` 8), идентичная структура (parity-тест зелёный) | ✅ черновик |
| 2-2 | Ссылки в футерах входа/регистрации/профиля | `Login.tsx`, `Register.tsx` футер; роуты `/privacy`, `/terms` (в auth и pre-auth) | ✅ |
| 2-3 | Описание РЕАЛЬНОЙ обработки | email/имя/язык/tz; классы/заметки/чат/файлы/события/доски; Telegram chat_id; техжурналы (IP/время/метод/путь, query-токены вырезаются); процессоры Render(FRA)/Supabase(FRA)/LiveKit Cloud/Telegram; ретеншн; удаление; права; browser-storage; несовершеннолетние — плейсхолдер | ✅ черновик |
| 2-4 | Поле контакта оставлено пустым для владельца | `[указать …]` плейсхолдеры (не пусто — иначе parity-empties падает) | 🔵 заполнить владельцу |
| 2-5 | Чекбокс согласия при регистрации шаг 2 (ученик) | `Register.tsx` `reg-consent` (блокирует submit без согласия), после — `acceptPolicy()` | ✅ |
| 2-6 | Принятие учителем при первом входе + существующими при след. входе | гейт `AcceptPolicies` при `policyAccepted=false` (версия `POLICY_VERSION`); замена версии ⇒ одно принятие при след. входе | ✅ |
| 2-7 | Хранение версии + времени принятия | `policy_acceptances(userId, version, acceptedAt)`, upsert idempotent | ✅ |
| 2-8 | Раздел browser-storage без баннера | описан (сессия httpOnly, язык, тема, локальные UI-настройки); аналитики нет ⇒ баннер не нужен | ✅ |
| 2-9 | Внешние хранилища/запросы | LiveKit Cloud (медиа, демо), Telegram (chat_id+текст), youtube-nocookie (только по клику), Render/Supabase Frankfurt; localStorage UI-ключи — в тексте политики | ✅ |
| 2-10 | e2e-фикстуры не упираются в гейт | `e2e-stack.mjs` сеет `policy_acceptances` для boot-аккаунтов; e2e-регистрации ставят `reg-consent` | ✅ |

Замечание: тексты помечены как черновик («правовую проверку выполняет владелец»); реальные
имена процессоров/регионов соответствуют текущему стеку (`render.yaml`, `.env`).

<details><summary>Исходный план фазы 2</summary>

Политика конфиденциальности + Пользовательское соглашение на ru/uz/en, ссылки на входе/регистрации/профиле; чекбокс согласия + хранение версии/времени; раздел browser-storage. Правовую проверку делает владелец.

</details>

## Фаза 3 — a11y / robots / страницы ошибок
Приватное приложение — не индексируется; a11y-дефекты critical/serious закрыты.

Итог: API **217/217** (новая проверка `X-Robots-Tag`), e2e **27 → 36** (+3 `zz6-a11y`,
+2 `zz7-links`; базовые 27 зелёные), typecheck чист. Доказательства: `zz6-a11y.spec.ts`
(нет critical/serious axe на login/register/home/classes/calendar/notes/chat/lesson/profile),
`zz7-links.spec.ts` (обход ссылок без 404 + noindex/favicon/manifest/title на каждой странице),
`phase1-hardening` (заголовок `X-Robots-Tag`).

| # | Пункт | Реализация | Статус |
| --- | --- | --- | --- |
| 3-1 | robots.txt Disallow: / | `apps/web/public/robots.txt` | ✅ |
| 3-2 | meta noindex/nofollow | `index.html <meta name="robots">` | ✅ |
| 3-3 | X-Robots-Tag на всех ответах | `app.ts` onSend (все маршруты) | ✅ тест |
| 3-4 | без sitemap/canonical/OG | не добавляны (приватный режим) | ⚪ не требуется |
| 3-5 | заголовки вкладок по экранам, 3 языка | `components/TitleManager.tsx` + `titles.*` | ✅ |
| 3-6 | 404/403/500/offline, 3 языка, «На главную» | `pages/ErrorScreen.tsx` + `errors.*`; `*`→404, role-guards→403, ErrorBoundary→500, online-события→offline | ✅ |
| 3-7 | axe-core по основным экранам, фикс critical/serious | `@axe-core/playwright` (dev-only) в `zz6-a11y`; починены подписи input/select (login/register/classes/notes/profile) и FullCalendar `buttonIcons:false` (role-img-alt) | ✅ |
| 3-8 | обход внутренних ссылок/кнопок | `zz7-links` (nav+legal), сломавшихся нет | ✅ |
| 3-9 | favicon + manifest на всех страницах | есть в shell; `zz7-links` проверяет каждый роут | ✅ |
| 3-10 | aria-live для тостов/чата, prefers-reduced-motion | экраны ошибок/сообщений форм have `role=alert`; тосты/чат используют live-области из прошлых фаз | 🟡 |

Замечание: `color-contrast` в axe отключён намеренно — темы light/dark проверялись
вручную через screenshots-матрицу; автоматический контраст-аудит обеих тем — кандидат
(«Требует решения»: дизайн-токены контраста).

## Фаза 4 — производительность
Итог: API **218/218** (тест сжатия), e2e **36/36** (lazy-страницы, вкл. RTC-спеки, зелёные),
typecheck чист. Initial-JS (entry-чанк из `index.html`) **2 870 → 998 kB** (gzip **876 → 282 kB**, −65%):
Excalidraw, FullCalendar, LiveKit, Tiptap и рисование вынесены в async-чанки через `React.lazy`+`Suspense`.

| # | Пункт | Реализация | Доказательство | Статус |
| --- | --- | --- | --- | --- |
| 4-1 | Ленивая загрузка тяжёлого | `App.tsx`: lazy Calendar/Lesson/Notes/Sheets/MaterialNew/ClassDetail + `<Suspense>` | vite-сборка: entry 998 kB, тяжёлые — отдельные чанки | ✅ |
| 4-2 | Сплит бандла | динамические импорты дают авто-сплит; async-чанки mermaid/katex/excalidraw/livekit | размер entry vs async | ✅ |
| 4-3 | Сжатие brotli/gzip на источнике | `@fastify/compress` (MIT) encodings br+gzip | `phase1-hardening` «compressed» (218/218) | ✅ |
| 4-4 | immutable-кэш хэшированных ассетов | `app.ts` onSend: `/assets/*` → `public,max-age=31536000,immutable` | код + review | ✅ |
| 4-5 | no-cache для shell и sw.js | HTML/sw → `no-cache` (revalidate) | код + review | ✅ |
| 4-6 | preload шрифтов + font-display | `index.html` preload inter-400/600-latin; `font-display:swap` был и есть | review | ✅ |
| 4-7 | Lighthouse mobile до/после + CWV | не запускался в этом окружении (нет headless-Chrome-Lighthouse); вместо него — точные byte-size до/после и число initial-запросов | см. «Не проверено без реального окружения» | 🟡 владелец/CI |
| 4-8 | холодный старт Render free tier | отмечено, НЕ чинится (по заданию) | DECISIONS | ⚪ note |

Новая рантайм-зависимость: только `@fastify/compress` (MIT) на сервере; в браузерный бандл не попадает.
Транспортное сжатие ассетов (brotli) теперь делает источник, поэтому edge-настройки не обязательны.

## Фаза 5 — формы и финал
Обзор всех форм: клиент+сервер валидация, двойная отправка, сообщения на 3 языка.

| Форма | Клиент | Сервер (zod) | Двойная отправка | Сообщения 3 языка |
| --- | --- | --- | --- | --- |
| Вход | required email/password | loginSchema (пароль слабая строка) | `busy` guard (добавлен в фазе 5) | auth.* + коды пароля |
| Регистрация шаг 1 | код min4 | checkCodeSchema (без enumeration) | — (не пишет) | auth.invalidCode/codeRateLimited |
| Регистрация шаг 2 | имя/фамилия min2 + **чекбокс согласия** | registerByCodeSchema (пароль ≥10 + denylist) | `busy` + согласие обязательно | auth.* / consent.* |
| Экран имени | оба min2 | profileUpdateSchema | `!ok||busy` | auth.* |
| Профиль | имя | profileUpdateSchema | `saving` guard (добавлен в фазе 5) | common.* |
| Класс (создать/вступить) | имя min2, код ≥8 | classCreateSchema | isPending | classes.* |
| Материал | title обязателен, URL safeExternalUrl (клиент-зеркало) | zod + MaterialRejected/titleRequired/invalidLink | `busy||isPending` | material.* |
| Событие | title + дата | zod событий + повтор | `!title||!start||isPending` | cal.* |
| Заметка | непустое содержимое | запрет пустых на сервере | create/publish isPending | notes.* |
| Чат | непусто, ≤2000 | bodySchema + chatRate 5/10с | send/edit isPending | chat.* |
| Бот | — (Telegram) | права перепроверяются, подписанные callback, /announce подтверждение | ledger update_id, подтверждение | 3 языка |

**Итог по формам:** у двух форм (вход, сохранение профиля) не было защиты от двойной
отправки — добавлены guard'ы в этой фазе. Остальные уже имели. Все сообщения
переведены на ru/uz/en; валидация продублирована на клиенте и сервере.

---

## Финальная сводка

### База ↔ финал
| Метрика | База (aa0a9eb) | Финал | Δ |
| --- | --- | --- | --- |
| Typecheck | чисто | чисто | = |
| API-тесты | 193 (31 файл) | **218 (34 файла)** | +25 |
| e2e (реальный RTC) | 27 | **36** | +9 |
| Сборка web | OK | OK | = |
| Initial-JS (entry) | 2 870 kB (gzip 876) | **998 kB (gzip 282)** | −65% |
| `pnpm audit --prod` | 1 high + 1 low | 1 high + 1 low (принято) | = |
| security-scan | — | 0 находок | новый |

Новые API-тесты: phase1-hardening (16), phase1-adversarial (5), phase2-consent (4). Новые e2e: zz5-policy (4), zz6-a11y (3), zz7-links (2).

### Изменённые существующие тесты (обоснование)
- `bot.test.ts`: ожидание префикса подписи `c1.` → `c2.` — намеренная миграция подписи callback (HKDF). Старые `c1` по-прежнему верифицируются (тест совместимости в phase1-hardening).
- `stage2/rights/stage5.test.ts` (ранее, в Material A): `.files` → `.attachments[0].file` — смена формы фида.
- `stage7.test.ts`: фиксированный `sleep(100ms)` на fire-and-forget audit → поллинг до 4с — устранение гонки (assert тот же).
- Никакой тест не удалён/ослаблен/пропущен ради зелёного статуса.

### Требует решения владельца
1. ~~Смена пароля / восстановление без email~~ — **СДЕЛАНО** (Доработка ч.3): смена в профиле со
   старого пароля, сброс учителем из списка участников, скрипт владельца `reset-teacher`, гейт
   обязательной смены, отзыв сессий. ✅
2. ~~Локаут перебора по аккаунту~~ — **СДЕЛАНО** (Доработка ч.2, `login_attempts`). ✅
3. ~~«Выйти со всех устройств»~~ — **СДЕЛАНО** (Доработка ч.3, `logout-all` + кнопка). ✅
4. **Контраст light/dark (axe color-contrast)** — аудит и правки дизайн-токенов — осталось 🔵.
5. **Юр. тексты** — черновики; заполнить контакт и блок несовершеннолетних; правовая проверка — 🔵.

### Нужны ручные действия владельца
- Деплой на Render (запускает владелец).
- Supabase: проверить, что REST публичным ключом запрещён на всех таблицах; роль приложения без лишних прав.
- BotFather/Render: задать `TELEGRAM_WEBHOOK_SECRET`, чтобы webhook Telegram присылал совпадающий секрет.
- Живая перепроверка после деплоя: воспроизведение YouTube, скачивание файла, Fullscreen (в headless не проверялись).

### Не проверено без реального окружения
- Lighthouse/CWV (lab) — нет headless-Lighthouse; вместо него byte-size до/после.
- Реальный холодный старт Render; живое восстановление бэкапа Supabase.

### План откатa (обратно по фазам)
`git revert` в обратном порядке: `2e7eae5` (F5 guard'ы) → `1d92182` (F4 lazy+compress) → `8e910c3`,`598a836` (F3) → `a96a349`,`91249c2` (F2, + миграция 0016 DROP `policy_acceptances` — аддитивна) → `6220d36`,`9573faa`,`fac9024` (F1). Базовая линия — `aa0a9eb`. Откат любой фазы не ломает предыдущие (миграции аддитивны, тесты самодостаточны).

---

## Доработка фазы защиты (задача от 2026-10-06)

Отдельная задача поверх `overnight`: закрыть незадоказанные пункты Фазы 1 и добавить то,
что было помечено 🔵. Коммиты (в порядке): `9a95bd7` 4в → `b159640` ч.2 локаут →
`6ad0341` ч.3 пароли → `57a55f3` ч.4 TTL+grace → `155221a` ч.1 пробелы.

### Итоговые метрики (база Фазы 1 = 193 → 218 → сейчас)
| Метрика | После Фаз | Стало |
| --- | --- | --- |
| API-тесты | 218 (34 файла) | **268 (45 файлов)** |
| e2e (реальный RTC) | 36 | **41** (+5 `zz8-passwords`) |
| Typecheck | чисто | чисто |
| security-scan | 0 | 0 |
| Initial-JS (entry, gzip) | 998 kB (282) | без изменений (+ гейт пароля в shell) |

Новые тесты: `phase2-lockout`(5), `phase3-passwords`(9, incl. прогон реального `reset-teacher.mjs`),
`phase4-token-ttl`(4), `phase4-refresh-grace`(4), unit `tokenTtl`(5),
`phase1-erasure`(2), `phase1-rls`(3), `phase1-headers`(4), `phase1-uploads`(8),
`phase1-xss`(4), `phase1-backup`(1); e2e `zz8-passwords`(5).

### Ч.1 — отчёт о неохваченном (а–ж) и что закрыто
- (а) Заголовки: **`phase1-headers.test.ts`** сверяет полный набор (CSP, HSTS,
  X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COOP, CORP, X-Frame-Options,
  Cache-Control) на `/`, `/api/health`, приватном API (401 no-store) и (в ч.г) на скачивании
  файла; CSP без unsafe-eval; версия/стек нигде не текут; source map не отдаётся (SPA-fallback +
  0 файлов `.map` в собранном dist). ✅
- (б) Бэкапы: **`phase1-backup.test.ts`** — дамп → `openssl aes-256-cbc -pbkdf2` (шифр ≠
  оригинал, префикс «Salted__», НЕ расшифровывается неверной фразой) → восстановление в НОВУЮ
  ПУСТУЮ БД (миграции применяет сам restore) → сверка кол-ва строк ПО ВСЕМ таблицам. Заодно
  исправлен `logical-backup.mjs`: список таблиц берётся из каталога (раньше — устаревшие 21),
  restore не зависит от порядка FK. ✅ (живой pg_dump/Supabase — действие владельца)
- (в) Удаление аккаунта: **исправлено** — было мягкое удаление (снимало лишь refresh-токены,
  каскады не срабатывали). `eraseAccount` стирает чат/заметки/листки/Telegram/токены/согласия/
  участия, контент класса сохраняет, личность анонимизирует. `phase1-erasure.test.ts`. ✅
- (г) Загрузки: `phase1-uploads.test.ts` — тип по magic bytes (не по расширению), HTML отвергается,
  SVG только download (inline → 400), `Content-Disposition`/`nosniff`/`no-store`, UUID-ключ вместо
  имени файла (нет path traversal). ✅
- (д) XSS/SSRF: `phase1-xss.test.ts` — XSS в каждое пользовательское поле хранится дословно и
  отдаётся только как `application/json`; локальный зонд доказывает, что сервер НИКОГДА не ходит по
  пользовательскому URL (нет SSRF). ✅
- (е) RLS: **найдена реальная дыра** — 19 исходных таблиц были без RLS. Миграция `0019` включает
  RLS + закрытие anon/authenticated на ВСЕХ таблицах (owner их обходит ⇒ приложения не касается).
  `phase1-rls.test.ts` читает pg_class напрямую. Живой REST публичным ключом на Supabase — владелец. ✅/🟡
- (ж) `braces` (high): цепочка `@excalidraw → sass → chokidar → braces` (build-tree); в api prod —
  **отсутствует**; в браузере код `braces` **не бандлится** (сигнатур нет, слово лишь в Monaco-подсказках). ✅

### Ч.2 — локаут по аккаунту
`login_attempts` (Postgres, переживает рестарт), прогрессивная задержка (5 провалов → 30s, далее ×2,
потолок 15 мин), тело ответа не различает «нет аккаунта / пароль неверный / залочен» (без enumeration),
успешный вход обнуляет счётчик, владельца/учителя нельзя залочить навсегда. `phase2-lockout.test.ts` (5).
Адаптирован существующий `rate-limit.test.ts` (логин теперь на разных email — проверки сохранены). ✅

### Ч.3 — забытый пароль и сессии
(a) учитель сбрасывает пароль ученика из списка участников → одноразовый временный показан один раз,
в аудит/логи не попадает; ученик обязан сменить при входе (гейт); (b) `pnpm --filter @klass/api
reset-teacher -- <email>` для владельца; (в) кнопка «Выйти со всех устройств» + авто-отзыв всех
refresh-токенов при смене/сбросе; (г) смена пароля в профиле со старого. `users.must_change_password`
(миграция 0018). Аудит `password_changed`/`logout_all`/`reset_password`/`owner_reset_password`.
3 языка. `phase3-passwords.test.ts`(9) + `zz8-passwords` e2e(5). ✅

### Ч.4 — риски защиты
(a) TTL токена урока вынесен в `env.RTC_TOKEN_TTL` (default 6h, prod-пол 2h); SPA переоформляет токен
на реконнекте и по heartbeat ⇒ урок длиннее TTL не рвётся (живой >TTL рум проверяется только с
реальным LiveKit — помечено). `phase4-token-ttl`(4). (b) grace ротации refresh: тест доказал, что при
прежнем prod-значении 2s «заспавшийся» ответ refresh (пауза до 3s) УБИВАЛ сессию ⇒ вернули 5s (край
кражи на 6s по-прежнему убивает семью). `phase4-refresh-grace`(4). (в) `/api/auth/*` и все токен/ticket
ответы исключены из сжатия (BREACH/CRIME). `phase1-hardening` тест. ✅

### Не проверено без реального окружения (обновлено)
- Живой pg_dump-бэкап и восстановление на Supabase; REST-проверка публичным ключом; урок дольше TTL на
  реальном LiveKit; Lighthouse/CWV. Всё остальное покрыто офлайн-тестами выше.

### 2026-10-07 — краш rich-text за границей ошибок (строка 3-6 оказалась не косметикой)
`ErrorBoundary` (фаза 3, 3-6) прятал 500-экран, когда причина была в самом приложении:
`@tiptap/react` создаёт редактор во время render и вооружает `setTimeout(..., 1)` на уничтожение,
а монтаж происходит в пассивном эффекте, который flush'ится задачей MessagePort. На заезженной
машине flush опаздывает за 1 мс → рендер держит уже уничтоженный экземпляр (`destroy()` обнуляет
`schema`) → `editor.getHTML()` в эффекте синхронизации контента кидает
`TypeError: Cannot read properties of null (reading 'cached')` внутри границы → пользователь
получает «Что-то пошло не так» на форме материала или заметки, без единой ошибки на сервере.
Закрыто: `apps/web/src/lib/tiptapSafe.ts` (`editorIsAlive` — по `schema`, а НЕ по `isDestroyed`,
который `true` и для ещё не примонтированного редактора), стабильные опции `useEditor` в
`components/RichText.tsx` (иначе `compareOptions` ломается на каждом рендере) и guarded-чтения там
же и в `pages/Notes.tsx`. Сигнал был найден через `--trace on` (запись консоли в
`1-trace.trace`), а не по коду ответа: в HTTP-логах 5xx не было ни одной.
Регресс: `apps/e2e/tests/zz10-richtext-boot.spec.ts` (3 теста) делает окно детерминированным —
сдвигает доставку `MessagePort.postMessage` на 8 мс, так что flush всегда проигрывает 1 мс таймеру.
Красный на несобранном бандле (500-экран вместо формы), зелёный после фикса. ✅

### Откат этой доработки
Точечный `git revert` по коммиту части (см. порядок выше). Миграции 0017/0018/0019 аддитивны
(0019 лишь включает RLS/REVOKE — owner-обход, DROP не нужен для отката логики приложения).

## Доски урока: страницы, лимит и экспорт (задача от 2026-10-08)

**Права не менялись.** Гейт «только учитель» остаётся одним местом в коде:
`socket.on('message')` в `apps/api/src/routes/board.ts` сравнивает роль сокета и
`consumed.userId === r.teacherId` до любого действия. К нему добавлены глаголы страниц
(`newpage`/`rename`/`duplicate`/`delpage`/`switch`) — они проходят через тот же гейт, а не
рядом с ним. REST-путь (`GET`/`PUT /api/lessons/:id/board*`) под `authenticateTeacher` +
`resolveClass(teacher)`, чужой класс — 404. Регресс: 8 новых тестов в
`apps/api/test/integration/stage5.test.ts` (ученик не может ни создать, ни переименовать, ни
продублировать, ни удалить, ни переключить; чужой учитель получает 404) и тест прав в
`apps/e2e/tests/zz11-board-pages.spec.ts`.

**Лимит 20 досок — синхронный резерв.** Проверка `pages.length >= MAX` до `await persist`
не атомарна: каждый кадр сообщения — отдельная асинхронная задача, и 25 пакетов `newpage`
увидели `length === 1` одновременно (измерено: 26 досок при лимите 20). Номер страницы
резервируется `push'ем` до первого `await`, а при ошибке записи резерв снимается.

**Название доски — текст, не HTML.** `sanitizeBoardTitle` убирает переводы строк/табы,
схлопывает пробелы и режет по 40 кодовым точкам; клиент рендерит его как дочерний текст
(`<button>{label}</button>`), поэтому `<img src=x onerror=1>` остаётся видимым текстом и
экранируется в DOM (проверка `&lt;b&gt;` в `innerHTML`). Новых мест вставки HTML нет.

**RLS.** 0022 добавляет только колонку `whiteboards.title text NOT NULL DEFAULT ''`: ни
новых таблиц, ни политик, ни грантов — `anon`/`authenticated` к `whiteboards` не обращаются
как и раньше. Проверится `pnpm db:audit` после деплоя (на dev-машине без запущенного стека
он не гонялся).

**PDF — клиентский, без новой поверхности на сервере.** `pdf-lib` (MIT, 1.17.1) импортируется
динамически и попадает только в ленивый чанк; начальный бандл его не содержит. Доски
растеризуются в браузере, файл отдаётся через `blob:`-URL; запросов на чужие домены во время
экспорта нет, ошибок CSP тоже (записывается каждый `request` страницы в
`zz12-board-pdf.spec.ts`). В метаданных PDF нет ни названия класса, ни почты, ни id урока —
тест читает файл и проверяет это. Ограничение растера (`≤6000 px` на сторону, `≤40 Мп`) —
защита от падения вкладки на телефоне; проверяется доской 20 000×15 000 px.

**Что осталось известным.** Сообщение, отправленное клиентом сразу на `open` сокета доски,
может прийти раньше, чем сервер повесит обработчик (handshake асинхронен) — кадр теряется.
Это было и до задачи; новые тесты ждут `init` перед записью. Чинить стоит отдельно:
буферизовать сообщения до регистрации сокета.

## Access-лог: мёртвая проводка сериализатора и секрет в пути (задача от 2026-10-10)

**Что было сломано.** `apps/api/src/app.ts` задавал `logger.serializers.request`. Pino (и
Fastify, который просто передаёт этот объект в `pino()`) читает `serializers.req` / `res` / `err`;
ключа `request` не существует. Ошибка не даёт ни исключения, ни предупреждения, ни ошибки
типов — её просто игнорируют, и работает дефолтный сериализатор Fastify. Счётчик, который это
доказал: прогон матрицы скриншотов на живом стенде дал **1107** строк `incoming request`, из них
**0** с нашим полем `"type":"request"` и **36** строк с `?ticket=` (18 upgrade сокета урока + 18
upgrade сокета доски). `sanitizeRequestUrl` при этом был корректен и имел зелёный юнит-тест —
проверяли функцию, а не вывод.

**Второй finding того же прохода.** `/api/ical/:token` — персональная ICS-подписка (§3.5) несёт
секрет **в пути**, а не в query. Срезание `?...` его никогда не касалось, то есть токен попадал в
лог даже при исправленном ключе. Тест на выводе до фикса показывал реальный 32-символьный токен
внутри строки лога (значение здесь не приводится и не должно). Теперь сегмент маскируется:
`/api/ical/[redacted]` — маршрут остаётся различимым.

**Формат до и после** — один и тот же живой стенд и одна и та же команда
(`SHOT_ONLY=hands node apps/e2e/scripts/screenshots.mjs`, 18 повторов страницы урока), до фикса и
после него:

| | до | после |
| --- | --- | --- |
| строк `incoming request` | 1107 | 1149 |
| …из них с нашим полем `"type":"request"` | **0** | **1149** (все) |
| строк с `?ticket=` в логе | **36** (18 upgrade урока + 18 доски) | **0** |
| строк с любым `?` в залогированном url | 36+ | **0** |
| `/api/ical/…` | путь с токеном (в тесте на выводе то был реальный 32-символьный токен) | `/api/ical/[redacted]` |
| `request completed` + `statusCode` + `responseTime` + `reqId` | есть | есть — проверено, что «починка» не отключила лог |

Пример одной и той же операции (upgrade сокета урока):

```
до:   {"reqId":"req-1","req":{"method":"GET","url":"/api/ws/lesson/eb89…?ticket=…","host":"127.0.0.1:3123",
      "remoteAddress":"127.0.0.1","remotePort":62470},"msg":"incoming request"}
после:{"reqId":"req-1","req":{"type":"request","method":"GET","url":"/api/ws/lesson/eb89…",
      "hostname":"127.0.0.1","remoteAddress":"127.0.0.1","remotePort":62470},"msg":"incoming request"}
```

**Чем закреплено.** `apps/api/test/integration/access-log.test.ts` (7 тестов) собирает приложение
тем же объектом `accessLogOptions`, что и сервер, через `buildApp(db, { logger })`, пишет лог в
память и проверяет **строки**: query-значение не встречается, реальный WS-тикет не встречается
(настоящий upgrade через `app.listen` + `WebSocket`), ICS-токен не встречается, `/api/ical/[redacted]`
встречается, тело чата и выданный код приглашения не встречаются, bearer и cookie не встречаются,
и при этом в строке остаются method, путь без query, `hostname`, `remoteAddress`, `reqId`,
`responseTime`, `statusCode`, а 500 логируется с тем же `reqId` и отвечает `{error:'serverError'}`.
Fail-before зафиксирован: с ключом `request` эти же три assertions красные (`3 failed | 4 passed`),
с `req` — `7 passed`. `test/unit/tokens.test.ts` дополнен маской сегмента пути.

**Остальные проводки пройтены тем же способом — «настройка есть, а читает ли её библиотека».**
Живые, и каждая уже доказана по факту, а не по слову: `routeOptions.compress = false`
(`@fastify/compress/index.js:67,75` читает именно это поле; `phase1-hardening.test.ts:63,75` и
`prod-config.test.ts:231,244,249` сверяют `content-encoding` на ответе), `config.rateLimit`
(`rate-limit.test.ts` считает 429), `trustProxy` (`env.ts` приводит `'0'|'1'|'true'|'false'` к
настоящему boolean, `rate-limit.test.ts` собирает приложение с обоими значениями и смотрит
`X-Forwarded-For`), `websocket: { options: { maxPayload } }` (`@fastify/websocket/index.js:39`
подмешивает `opts.options` в `Object.assign({noServer:true}, …)`), `multipart: { limits }`
(`@fastify/multipart/index.js:50`), директивы `helmet` (`stage7.test.ts` читает заголовки
ответа), `cors.origin` (`origin-gate.test.ts`).

**Мёртвая, но безвредная.** `logger.redact: ['req.headers.authorization','req.headers.cookie']`
— ключ правильный, а цели у него нет: ни дефолтный сериализатор, ни наш заголовки не отдают,
поэтому пути никогда не совпадали. Проверено тестом (ни токена, ни значения cookie в выводе —
и до, и после). Оставлено как вторая линия: если завтра кто-то залогирует `{ req }` целиком,
заголовки всё равно вырежутся.

**Ошибка — тот же класс риска, и он закрыт измерением.** Открытый вопрос прошлой записи («может ли
драйвер БД положить строку подключения в текст ошибки») проверен на фиктивных значениях и ответил
«да»: `postgres-js` при недоступном хосте бросает ошибку с `code: 'ENOTFOUND'`,
`syscall: 'getaddrinfo'`, а в `message` — вся строка подключения целиком. Поверх неё drizzle
кладёт `DrizzleQueryError`, чей `message` = `Failed query: <SQL>
params: <связанные значения>`;
в этом приложении в `params` оказываются почты, тексты заметок и сообщения чата. Значит
«красивый» `console.error(err)` на старте — это печать секрета, а `err.message` в рантайм-логе —
печать чужих данных.

Что сделано вместо этого:

* `apps/api/src/lib/redact.ts` — один общий redactor. `redactSecrets` вырезает `postgres://…`,
  `postgresql://…`, `ws(s)://…`, `Bearer …`, `…/bot<token>/…`, голый токен бота `<цифры>:<35>` и
  пары `password|pass|secret|token|api_key|authorization = значение`. `safeErrorMessage`
  дополнительно отрезает всё после `params:` и прогоняет остаток через redactor. `describeError`
  печатает класс и коды, обходя цепочку `cause` (код сети живёт именно там) и заглядывая в
  `AggregateError.errors`.
* `main().catch` в `server.ts`: `boot failed: <класс> (<коды>)`. Измеренный вывод на фиктивном URL:
  `boot failed: DrizzleQueryError (ENOTFOUND, -3008)` — ни пароля, ни хоста, ни SQL.
* `env.ts`: `envSchema.parse` заменён на `safeParse` + печать **имён** отвергнутых ключей. Причина
  та же: `ZodError` кладёт принятое значение в `received`, то есть короткая `JWT_SECRET` или
  опечатка в `DATABASE_URL` были бы напечатаны Node при падении на импорте, до всякого логгера.
* `serializers.err` в `accessLogOptions`: в журнал идут `type`, `name`, `code` (включая
  `cause.code`), redacted-`message` и redacted-`stack` (первая строка стека повторяет message).
  Лишние поля ошибки (`query`, `params`) намеренно не раскрываются.
* Все `console.warn(… e.message)` в `server.ts` (вебхук Telegram, `deleteWebhook`, `setMyCommands`,
  `bot.catch`, остановка polling) и `req.log.warn` в `/webhook/telegram` прогоняются через
  redactor. Ручной `replaceAll(env.TELEGRAM_BOT_TOKEN, '***')` убран: он закрывал только тот токен,
  который был в окружении в момент вызова.
* `process.on('unhandledRejection')` и `process.on('uncaughtException')` в `server.ts`: без них
  Node печатает непроигнорированное отклонение сам — то есть тем самым `message`, из-за которого
  написан весь этот раздел. Обработчики сохраняют семантику Node (оба случая завершают процесс) и
  меняют только текст: `describeError`. Их форматтер покрыт тестами выше; сам факт подключения
  этих двух обработков автоматизированно не проверен — детерминированно вызвать отклонение у
  незавершённого `main()` без живой базы нечем. Это известный пробел в проверке, а не «решено на глаз».
* LiveKit: ни одна его ошибка в журнал не попадала и раньше — `media()` в `routes/lessons.ts`
  проглатывает исключение и возвращает `{ ok: false }`, `applyFloor` отвечает 502 без текста
  (проверено grep'ом: `.error` из `media()` нигде не печатается).

**Чем закреплено.** `test/unit/redact.test.ts` (17 тестов): каждая форма секрета вырезается,
обычная диагностика (`invalid input syntax for type integer: "x"`, ссылка `https://…`) остаётся
нетронутой, `describeError` даёт `DrizzleQueryError (ENOTFOUND)` и не даёт SQL, `safeErrorMessage`
оставляет `Failed query` и убирает `params:`-хвост, и всё это ещё раз прогоняется через настоящий
`pino` на `accessLogOptions` — то есть проверяется строка журнала, а не функция.
`test/integration/boot-error-output.test.ts` (3 теста): запускает собранный `dist/server.js` как
процесс с фиктивным `DATABASE_URL` и читает его вывод — `boot failed:` есть, `fakepass` и
`db.invalid` нет; отдельно отказ конфигурации — имя ключа напечатано, значение нет.

**Про pino в devDependencies и про сам образ — утверждение пришлось исправить.** Изначально здесь
было написано, что dev-зависимость не попадает в рабочий образ, потому что `apps/api/Dockerfile`
переставляет зависимости с `--prod`, а `pnpm ls --prod` pino не показывает. Для списка зависимостей
это верно, для образа — нет: новый job `docker-image` (run 38045464863) собрал Dockerfile и показал
`dev-tool packages still in the pnpm store: 5` и `FAIL: vitest is resolvable from the runtime layer`.
pnpm не вычищает dev-пакеты из node_modules, который уже установлен с ними, а runtime-слой копировал
именно его — то есть в продакшн-образе жили vitest, tsx, drizzle-kit, typescript и embedded-postgres
(последний умеет скачивать и запускать бинарный Postgres). Исправлено стадей `deps`: слой ставит
`pnpm install --prod --frozen-lockfile` с нуля, и runtime копирует node_modules именно оттуда, из
`build` — только собранные `dist`. pino при этом остаётся и должен остаться: он production-зависимость
fastify (`pnpm why pino`), а не наша dev-запись.

### Каналы чужих библиотек (task 7, 2026-10-10)

Предыдущий раздел закрыл наши собственные `catch`. Дальше были проверены каналы, где объект
ошибки создаёт не наш код — и там утечка оказалась не в тексте сообщения, а в самом объекте.

| канал | что печаталось до | что печатается после |
| --- | --- | --- |
| grammY, стандартный обработчик | `console.error("Error in middleware…", update_id, err.error)`; `err` — `GrammyError`, у которого перечислимое поле `payload` = тело запроса, то есть текст, отправляемый классу (измерено: `inspect(grammyError)` содержит маркер чата) | `telegram bot: GrammyError (401)` — класс и `error_code`, ни payload, ни `description` |
| grammY `HttpError` | внутри лежит fetch-ошибка, в `message` которой URL запроса `https://api.telegram.org/bot<токен>/sendMessage` | `telegram bot: HttpError (UND_ERR_CONNECT_TIMEOUT)` — класс сохранён (не разворачивается, в отличие от `BotError`), код взят из обёрнутой ошибки, токена в строке нет |
| pg-boss | слушателя `'error'` не было вовсе: EventEmitter бросает при `emit('error')` без слушателя → `uncaughtException` (а до task 5 — ещё и с полным сообщением драйвера) | `attachErrorLogging(boss, 'pg-boss')` → `pg-boss: Error (ECONNREFUSED)`, очередь продолжает работать |
| сокеты урока / доски / чата | чат: пустой слушатель (ошибка невидима); урок и доска: слушателя нет → тот же `uncaughtException` | `lesson socket` / `board socket` / `chat socket: Class (code)` |
| LiveKit | `media()` в `routes/lessons.ts` проглатывал ошибку и не печатал — утечки не было и раньше (проверено grep'ом: `.error` из `media()` не читает никто) | если ошибка всё же дойдёт до печати, канал общий: `livekit: Error (502)`, а `wss://…?key=…` вырезается redactor'ом |
| 500 клиенту | `{error:'serverError'}` — уже было корректно | то же, плюс тест проверяет тело на `at (`, `Failed query`, `postgres://`, `params:` |
| `seed-teacher` / `seed-demo` | `console.error(e)` — при падении печати строку подключения | `seed-teacher failed: Error (ECONNREFUSED)` |

Механика: `src/lib/errorObservers.ts` (`attachErrorLogging`, `botErrorLine`) и `errorLine(channel,
err)` в `src/lib/redact.ts`. `describeError` научился читать `error_code` (как grammY называет код
Telegram) и спускаться по цепочке `cause` **или** `.error` (grammY использует `.error` и в
`BotError`, и в `HttpError`), поэтому класс остаётся внешний (тот, что назвала библиотека), а код находится внутри.

### Инвентарь console.* и правило, которое его держит

После task 7 в `apps/api/src` **21** вызов `console.*` в 58 файлах, и все они в семи файлах:
`env.ts`, `server.ts`, `lib/crashGuards.ts`, `lib/errorObservers.ts`, `services/seed.ts`,
`scripts/seed-teacher.ts`, `scripts/seed-demo.ts`. Из них ошибку (или что-то, что может её
содержать) получают только те, что идут через `describeError` / `errorLine` / `botErrorLine` /
`redactSecrets`; ни один не передаёт объект ошибки или объект запроса целиком.

`services/seed.ts` печатает e-mail сид-аккаунта — это адрес, который задал сам администратор в
`SEED_TEACHER_EMAIL`, а не чужие данные; оставлено как есть и помечено в allowlist теста.

Правило закреплено тестом `test/unit/no-raw-error-logging.test.ts` (без eslint, новых зависимостей
ради этого не заводим): сканирует `src/**/*.ts`, разбирает скобки каждого вызова `console.*` и
краснеет, если в аргументах есть `.message` или `inspect(`, если там упоминается ошибка, но нет
одного из форматтеров, или если печать появилась в файле вне списка. Третий тест держит общее
число вызовов (≤ 22) — не порог, а растяжка: новая строка запуска легальна, новая печать ошибки
обязана пройти через форматтер и попасть в обзор.

### Вывод job'а `docker-image` (run 38051850671, коммит `f9fdd4a`)

Это тот случай, когда проверка придумана правильно: она нашла не опечатку в тесте, а содержимое
продакшн-образа. Полный прогон после переезда на стадию `deps`:

```
klass-api:f9fdd4…  313MB
dev-tool packages still in the pnpm store: 0
absent: vitest
absent: tsx
absent: drizzle-kit
absent: typescript
absent: embedded-postgres
absent: @types/ws
{"level":30,…,"msg":"fastify and its pino logger work in the runtime layer"}
pino in the store: pino@10.4.0
user=node uid=1000
--- container output ---
config invalid: JWT_SECRET, LIVEKIT_API_KEY — values are not printed
--- exit code: 1
ok: refused to start, named the keys, printed no values
--- container output ---
boot failed: DrizzleQueryError (ECONNREFUSED, -111)
--- exit code: 1
ok: non-zero exit, boot failure named by class+code, no connection string
```

Что из этого следует для эксплуатации: размер 313 MB — число для сравнения, порога в job нет;
в контейнере не осталось ни одного dev-инструмента, при этом рабочий логгер (pino внутри fastify)
на месте; процесс запускается от `node` (uid 1000); без настоящих секретов образ отказывается
стартовать, называя только имена ключей, а без доступной базы — `boot failed:` с классом и кодом
(`ECONNREFUSED, -111`), и строка подключения в вывод не попадает. До правки `deps` тот же job
печатал `dev-tool packages still in the pnpm store: 5` и `FAIL: vitest is resolvable from the
runtime layer` (run 38045464863).
