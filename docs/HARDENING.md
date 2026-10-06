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
| 1б-4 | Grace ≤2 с в production | `env.ts` (prod-clamp 2000) | ревью кода (тест-окружение не prod) | ✅ |
| 1б-5 | Выход со всех устройств | — | см. «Требует решения» | 🔵 |

### в) CSRF / Origin
| # | Пункт | Изменено | Доказательство | Статус |
| --- | --- | --- | --- | --- |
| 1в-1 | При PUBLIC_URL/DOMAIN — только он, Host не доверяется | `routes/auth.ts` checkSameOrigin | phase1-hardening «trust configured Origin, not Host» (403 при Host=наш/Origin=evil) | ✅ |
| 1в-2 | Строгий CORS allowlist | — | baseline | ✅ |

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
| 1д-3 | Локаут перебора по аккаунту | НЕ сделан (конфликт с trustProxy-тестом; предложение в отчёте) | — | 🔵 |
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
| 1к-2 | Короткий TTL | урок 6h→3h, spike 6h→1h | ревью | ✅ |
| 1к-3 | Энтропия имени комнаты | rand 4→8 байт | ревью | ✅ |
| 1к-5 | Spike отключён в prod | `routes/rtc.ts` (prod→404) | phase1-hardening «spike disabled in production» | ✅ |

### л) БД / RLS — без изменений в фазе 1 (миграций нет). Живая REST-проверка публичным
ключом (1л-3/4) — ручное действие владельца на Supabase. Статусы базовой линии сохранены.

### м) Секреты и логи
| # | Пункт | Изменено | Доказательство | Статус |
| --- | --- | --- | --- | --- |
| 1м-1 | Скан дерево + история | `scripts/security-scan.mjs` | запуск: 0 находок в 60 коммитах и дереве | ✅ |
| 1м-2 | Логи без токенов/паролей/ICS/invite/ticket/текста чата | redact + sanitizeRequestUrl | ревью `app.ts` | ✅ |

### н) Зависимости
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1н-1 | high+critical=0 | 1 high `braces` (excalidraw→sass→chokidar, build-time, патча нет) + 1 low `katex` (mermaid) | 🔵 принято, documented |
| 1н-2 | lockfile pinned | `--frozen-lockfile` в CI | ✅ |
| 1н-3 | CI audit | есть (`continue-on-error`, список в DECISIONS) | 🟡 |

### о) Бэкапы / п) данные пользователя
- 1о: `deploy/scripts/backup.sh`/`restore.sh` (этап 7) — шифрование + сверка счётчиков; живое
  восстановление на Supabase — ручное действие владельца. 🟡
- 1п-1: удаление аккаунта (student) — каскады чата/листков/TG/токенов; контент учителя остаётся
  для класса (по дизайну). Ретеншн описан в политике (Фаза 2). 🟡
- 1п-2: смена пароля / восстановление без email — self-service отсутствует → 🔵 «Требует решения» (с предложением).

---

## Фаза 2 — юр. тексты и согласия (только черновики)
Политика конфиденциальности + Пользовательское соглашение на ru/uz/en, ссылки на входе/регистрации/профиле; чекбокс согласия + хранение версии/времени; раздел browser-storage. Правовую проверку делает владелец.

## Фаза 3 — a11y / robots / страницы ошибок
robots.txt `Disallow: /`, noindex, X-Robots-Tag; заголовки вкладок по экранам (3 яз.); 404/403/500/offline (3 яз.) с «На главную»; axe-core (dev-only) по экранам + фикс critical/serious; обход внутренних ссылок; favicon/manifest.

## Фаза 4 — производительность
Lighthouse (mobile) login/home/class/calendar/notes/lesson до/после; ленивая загрузка Excalidraw/FullCalendar/LiveKit/Tiptap; сплит бандла; сжатие; immutable-кэш; preload шрифтов; CWV на login+home; холодный старт Render — отметить.

## Фаза 5 — формы и финал
Все формы: клиент+сервер валидация, защита от двойной отправки, сообщения на 3 яз.; полный набор проверок + скриншоты 390/768/1280 × 3 × 2 темы; сравнение с базой; итоговая таблица.
