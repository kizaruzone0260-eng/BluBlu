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

### а) Матрица HTTP/WS-эндпоинтов и заголовки
Полная матрица эндпоинтов + adversarial two-tenant (A/B) тесты — см. `apps/api/test/integration/adversarial.test.ts` (добавляется в фазе).

Заголовки (helmet + onSend в `app.ts`): CSP, frame-ancestors 'none', HSTS, nosniff,
Referrer-Policy, X-Frame-Options, COOP/CORP — инвентаризация и правки ниже.

| # | Пункт | Находка при аудите | Статус |
| --- | --- | --- | --- |
| 1а-1 | CSP без unsafe-eval | `script-src 'self'` — ок | ✅ |
| 1а-2 | CSP style-src | `'unsafe-inline'` нужен Excalidraw; убрать нельзя без поломки доски | 🟡 принято (documented) |
| 1а-3 | frame-ancestors none | есть | ✅ |
| 1а-4 | HSTS | helmet по умолчанию | ✅ |
| 1а-5 | nosniff / X-Frame-Options / X-Download | helmet по умолчанию | ✅ |
| 1а-6 | Referrer-Policy | same-origin | ✅ |
| 1а-7 | COOP / CORP | helmet CORP same-origin; COOP по умолчанию helmet | ✅ |
| 1а-8 | Permissions-Policy camera/mic self | onSend-хук | ✅ |
| 1а-9 | Cache-Control no-store для приватного API | ОТСУТСТВУЕТ → добавить onSend для /api/* (кроме static) | ⬜ фикс |
| 1а-10 | Нет source maps публично | `sourcemap:false` | ✅ |
| 1а-11 | Страницы ошибок не выдают stack/version | НЕТ глобального setErrorHandler → 500 может вернуть `message` | ⬜ фикс |
| 1а-12 | /api/health без версии | `{status:ok}` | ✅ |

### б) Куки / сессии
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1б-1 | HttpOnly/Secure/SameSite refresh-cookie | httpOnly, secure в prod, SameSite=Lax | ✅ |
| 1б-2 | Хранение access-токена | только в памяти JS (не localStorage), 15 мин JWT | ✅ |
| 1б-3 | Refresh-ротация + reuse-детект | family-kill; grace REFRESH_REUSE_GRACE_MS | ✅ |
| 1б-4 | Сузить grace до 2 с в production | default 5000; свести к 2000 в prod, если тесты позволяют | ⬜ фикс |
| 1б-5 | Выход со всех устройств | logout удаляет только предъявленный токен | 🔵 требует решения (см. отчёт) |
| 1б-6 | Сессии умирают при смене пароля | setTempPassword удаляет все refresh (via bot); self-change нет | 🔵 (п.14) |

### в) CSRF / Origin / CORS
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1в-1 | Origin при PUBLIC_URL — только он + явный список, не Host | `checkSameOrigin` сейчас доверяет совпадению Host → ослабить | ⬜ фикс |
| 1в-2 | Строгий CORS allowlist | прод: только https://DOMAIN | ✅ |

### г) Rate limits
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1г-1 | Production игнорирует e2e-ослабления RATE_* | env используется всегда → в prod forces defaults | ⬜ фикс |
| 1г-2 | Лимиты на новых эндпоинтах (chat/materials/uploads/bot contact) | global 300/мин + chat 5/10с; upload — 300/мин; bot — 300/мин | 🟡 усилить точечно |

### д) Логин / пароли
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1д-1 | Одинаковые ответы (нет enumeration) | invalidCredentials для обоих | ✅ |
| 1д-2 | Политика пароля ≥10 + список частых | min 8 сейчас → ≥10 + denylist | ⬜ фикс |
| 1д-3 | Брутфорс-локаут | только HTTP 10/мин → добавить email+IP лок | ⬜ фикс |
| 1д-4 | timingSafeEqual для секретов | telegram secret через `!==` → timingSafeEqual | ⬜ фикс (см. и) |

### е) WebSocket
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1е-1 | One-time билеты | есть (lesson/board/chat, 30 с) | ✅ |
| 1е-2 | Проверка Origin при upgrade | нет → добавить | ⬜ фикс |
| 1е-3 | Ограничение размера кадра | maxPayload 256 KiB | ✅ |
| 1е-4 | Права на каждое сообщение (не только при connect) | board: роль на сообщение; chat socket read-only | ✅ |

### ж) Загрузка файлов
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1ж-1 | Magic bytes | detectFileType | ✅ |
| 1ж-2 | Размер/квота | MAX_FILE_MB + TEACHER_QUOTA_GB | ✅ |
| 1ж-3 | Content-Disposition attachment + nosniff | есть в serveFile | ✅ |
| 1ж-4 | SVG/HTML: запрещено или sanitized | SVG download-only (не inline); HTML в whitelist нет | ✅ |
| 1ж-5 | Безопасные имена / нет path traversal | storage-ключ UUID | ✅ |

### з) Санитизация контента
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1з-1 | Экранирование user text (chat/notes/material/заголовки/имена) | рендер через React + strip тегов в NoteBodyView, dangerouslySetInnerHTML нет | ✅ + ⬜ XSS-тесты |
| 1з-2 | Ссылки только http/https | safeExternalUrl | ✅ |
| 1з-3 | Нет SSRF | safeExternalUrl без fetch | ✅ |

### и) Telegram
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1и-1 | webhook secret через timingSafeEqual | `!==` → fix | ⬜ фикс |
| 1и-2 | Отдельный HKDF-ключ для callback_data | signCb = HMAC(JWT_SECRET) → HKDF-производный ключ + миграция (живые кнопки не ломаются) | ⬜ фикс |
| 1и-3 | Bot token не в логах | не логируется | ✅ |
| 1и-4 | Идемпотентность update_id | bot_updates ledger | ✅ |

### к) LiveKit
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1к-1 | Минимальные права (teacher roomAdmin; student camera/mic/data) | buildJoinToken grants | ✅ |
| 1к-2 | Короткий TTL | 6h → сократить | ⬜ фикс |
| 1к-3 | Неразгадываемые имена комнат | `lesson-<class8>-<rand4>` → rand8 (defense-in-depth) | ⬜ фикс |
| 1к-4 | Ученик не может выдать себе права | токены только серверные | ✅ |
| 1к-5 | spike-эндпоинт `/api/rtc/token` даёт 6h publish на произвольную spike-комнату | отключить в production | ⬜ фикс |

### л) База данных / RLS
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1л-1 | RLS на всех public-таблицах (вкл. новые) | миграции 0014/0015 включают RLS+REVOKE | ✅ |
| 1л-2 | anon/authenticated без привилегий | REVOKE ALL guard-DO | ✅ |
| 1л-3 | REST публичным ключом запрещает (на живом Supabase) | | 🟡 владелец |
| 1л-4 | Роль приложения без лишних прав | | 🟡 владелец |

### м) Секреты и логи
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1м-1 | Скан рабочего дерева И всей git-истории на секреты | | ⬜ фикс (скрипт-проверка) |
| 1м-2 | Логи без токенов/паролей/ICS/invite/WS-ticket/текста чата | redact auth/cookie + sanitizeRequestUrl | ✅ + аудит |

### н) Зависимости
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1н-1 | high+critical = 0 | 1 high `braces` (excalidraw→sass→chokidar→braces, build-time, патча нет) + 1 low `katex` (через mermaid) | 🔵 принято, documented |
| 1н-2 | lockfile pinned | `--frozen-lockfile` в CI | ✅ |
| 1н-3 | CI-проверка audit | есть с continue-on-error | 🟡 |

### о) Бэкапы
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1о-1 | pg_dump в зашифрованный файл + проверка восстановления в чистую БД | `deploy/scripts/backup.sh` / `restore.sh` (этап 7) | 🟡 |
| 1о-2 | Supabase free авто-бэкапы ограничены | инструкция | 🟡 владелец |

### п) Данные пользователя
| # | Пункт | Находка | Статус |
| --- | --- | --- | --- |
| 1п-1 | Удаление аккаунта убирает/анонимизирует чат/заметки/файлы/TG-привязку/токены | student: каскады; teacher: контент остаётся для класса (по дизайну); soft-delete+сброс email | 🟡 описание в политике |
| 1п-2 | Смена пароля + восстановление без email — если нет, НЕ реализовывать, в «Требует решения» | self-service отсутствует | 🔵 требует решения (с предложением) |
| 1п-3 | audit_log и ретеншн сообщений описать в политике | | Фаза 2 |

---

## Фаза 2 — юр. тексты и согласия (только черновики)
Политика конфиденциальности + Пользовательское соглашение на ru/uz/en, ссылки на входе/регистрации/профиле; чекбокс согласия + хранение версии/времени; раздел browser-storage. Правовую проверку делает владелец.

## Фаза 3 — a11y / robots / страницы ошибок
robots.txt `Disallow: /`, noindex, X-Robots-Tag; заголовки вкладок по экранам (3 яз.); 404/403/500/offline (3 яз.) с «На главную»; axe-core (dev-only) по экранам + фикс critical/serious; обход внутренних ссылок; favicon/manifest.

## Фаза 4 — производительность
Lighthouse (mobile) login/home/class/calendar/notes/lesson до/после; ленивая загрузка Excalidraw/FullCalendar/LiveKit/Tiptap; сплит бандла; сжатие; immutable-кэш; preload шрифтов; CWV на login+home; холодный старт Render — отметить.

## Фаза 5 — формы и финал
Все формы: клиент+сервер валидация, защита от двойной отправки, сообщения на 3 яз.; полный набор проверок + скриншоты 390/768/1280 × 3 × 2 темы; сравнение с базой; итоговая таблица.
