/**
 * Одноразовые ссылки-приглашения в класс (задача 2026-10-23, часть A).
 *
 * Здесь только чистые правила — форма токена, срок жизни, сборка публичного URL и разбор
 * фрагмента. Генерация токена и его хеширование живут в `apps/api/src/lib/inviteLink.ts`,
 * потому что им нужен `node:crypto`; здесь же то, что можно и нужно проверить без сервера
 * (юниты — `apps/api/test/unit/invite-links.test.ts`).
 *
 * Токен едет в ФРАГМЕНТЕ URL (`/join#<token>`), а не в `?token=`: фрагмент не уходит серверу,
 * не попадает в access-лог, в `Referer` и в историю промежуточных прокси. Расходится он ровно
 * одним POST-ом, и открытие ссылки (или предпросмотр в Telegram) его не сжигает.
 */

/** 24 байта → 32 символа base64url без паддинга: 192 бита энтропии. */
export const INVITE_TOKEN_BYTES = 24;
export const INVITE_TOKEN_LENGTH = 32;
/** base64url без паддинга: `-` и `_`, слэшей и `=` тут быть не должно. */
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** Выбор срока — три фиксированных варианта из постановки; по умолчанию неделя. */
export const INVITE_LINK_TTL_DAYS = [1, 7, 30] as const;
export const INVITE_LINK_DEFAULT_TTL_DAYS = 7;

/** Подпись приглашения (например имя ученика) — только для учителя, наружу она не нужна. */
export const INVITE_LABEL_MAX = 60;

export function isInviteToken(value: string): boolean {
  return INVITE_TOKEN_PATTERN.test(value);
}

/**
 * Что страница `/join` вытаскивает из `location.hash`. Лишнее (пробелы, `#`, чужие символы)
 * отсекается, а неподходящее по форме значение — это `null`: запрос с мусором не должен доходить
 * до сервера вообще, иначе счётчики неверных токенов наполняет любой мусорный линк.
 */
export function parseInviteToken(raw: string | null | undefined): string | null {
  // сначала trim, потом `#`: браузер отдаёт `location.hash` уже с решёткой и без пробелов, но
  // значение могло прийти из input, из clipboard или из «расшаренного» текста — там пробелы
  // ordinary, и порядок «срезать решётку, потом причесить» на « abc#token » вернул бы мусор
  const token = (raw ?? '').trim().replace(/^#/, '').trim();
  return isInviteToken(token) ? token : null;
}

/** Публичная ссылка приглашения: база берётся из `effectiveSiteBase` (PUBLIC_URL → DOMAIN). */
export function inviteUrlFor(base: string, token: string): string {
  const clean = base.trim().replace(/\/+$/, '');
  return `${clean}/join#${token}`;
}
