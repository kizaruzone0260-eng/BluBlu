# Чеклист безопасности (ТЗ §4) — фактическое состояние

Легенда: ✅ проверено тестом/кодом; 🟡 реализовано, проверка требует сервера; ❌ не сделано.

| Пункт | Статус | Доказательство / где |
| --- | --- | --- |
| HTTPS везде | 🟡 | Caddyfile: автоматический Let's Encrypt; HSTS-заголовок задан (`deploy/Caddyfile`) — проверить на сервере |
| Валидация входа (Zod) на каждом эндпоинте | ✅ | схемы в `packages/shared`, разбор во всех маршрутах (`safeParse`), тесты на invalidInput |
| Rate limit: вход | ✅ | config rateLimit 10/мин (`app.ts` onRoute) |
| Rate limit: регистрация/ввод кода | ✅ | 8/мин HTTP + собственный блок 5 попыток/мин → 15 мин (`lib/throttle.ts`), тест 429 в `stage1 http.test` |
| Rate limit: загрузка файлов | 🟡 | лимит размера 100 МБ + ≤4 файла (multipart limits, тест 413); частотная — общий 300/мин; серверная приёмка |
| CSRF | ✅ | refresh-cookie SameSite=Lax + POST-only + проверка Origin (тест `stage7: CSRF`) |
| Строгий CORS | ✅ | allowlist: прод — только https://домен; dev — localhost (app.ts) |
| Заголовки безопасности | ✅ | helmet: CSP default-src 'self', frame-ancestors 'none', nosniff, Referrer-Policy (тест `stage7: security headers`) |
| Проверка прав в каждом запросе | ✅ | preHandler-и + resolveClass→404 (права: тесты stage1/2/3/4/5; чужой объект = 404, не 403) |
| Файлы не исполняются, отдаются с nosniff | ✅ | только attachment/inline по белому списку mime; SVG никогда inline (тест magic/stage5); Content-Disposition; storage-ключ UUID |
| Секреты только в .env | ✅ | `.env.example`, .gitignore; grep git-истории на токены — чисто; JWT/LiveKit/Telegram читаются из env |
| npm audit | 🟡 | `pnpm audit --prod` прогоняется (результат в MORNING_REPORT); периодичность — в cron деплоя |
| Минимум персональных данных | ✅ | поля только имя/email/chat_id; ученик не вводит лишнего; возраст не запрашиваем (политика §4 — страница /privacy) |
| Полное удаление аккаунта | ✅ | DELETE /api/me: soft-delete+сброс email, каскад членств/листков, отзыв сессий (тест stage7) |
| Без аналитики/трекеров | ✅ | внешних скриптов нет; SW кэширует только собственный origin; pwa-иконки локальные |
| Healthcheck + структурные логи | ✅ | /api/health(+live), pino JSON stdout, docker healthcheck в compose; log-ротация — journald/docker (сервер) |
| Бэкапы ежедневно + вне сервера | ✅/🟡 | `deploy/scripts/backup.sh` (проверен локально: dump→шифрование→restore→сверка счётчиков); scp в off-site — инструкция DEPLOY.md §6 |
| Проверка восстановления | ✅ | restore.sh прогнан на тестовых данных в чистую БД (klass_r) — счётчики MATCH (см. PROGRESS этап 7) |
| Внутренние сетевые границы | ✅ | api/postgres/livekit только в docker-сети; наружу 80/443 + RTC/TURN порты; api не публикуется |
| Сессии: короткий access + refresh-ротация | ✅ | 15 мин JWT + cookie-ротация с family-убийством (тест stage1) |
| LiveKit: токен только участнику и только активной сессии | ✅ | тесты stage4 (join 404 после конца/чужой), grants по ролям |
| Ограничение child-данных (несовершеннолетние) | 🟡 | минимизация полей + политика; решение заказчика о подтверждении возраста — открытый вопрос ТЗ §12.5 |
