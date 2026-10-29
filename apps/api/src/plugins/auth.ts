import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, isNull } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { verifyAccessToken, type AccessTokenClaims } from '../lib/tokens.js';
import type { DB } from '../db/index.js';
import type { UserRole } from '@klass/shared';

declare module 'fastify' {
  interface FastifyRequest {
    user: (AccessTokenClaims & { id: string }) | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
    authenticateTeacher: (req: FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
  }
}

export const authPlugin = fp(async (app: FastifyInstance, opts: { db: DB }) => {
  app.decorateRequest('user', null);

  /*
   * Принудительная смена пароля обязана держаться СЕРВЕРОМ, а не экраном. До этого
   * `must_change_password` только возвращался в профиле, и весь гейт жил в `App.tsx`: человек
   * с временным паролем, который знает URL API (curl, другой клиент, старый скрипт), получал
   * полноценный bearer и работал с классами, доской и чужими заметками, минуя смену пароля.
   * Клиентский барьер — это удобство, а не право.
   *
   * Список короткий и закрытый: сменить пароль, прочитать СВОЙ профиль (экрану нужно показать,
   * что происходит), принять документы и выйти. Всё остальное — 403, пока пароль не свой.
   *
   * Почему принятие документов в этом списке (2026-10-27). Порядок калиток в `App.tsx` —
   * документы → имя → пароль, и аккаунт, который создал учитель, обязан сначала пройти первую:
   * у него нет записи о согласии, а временный пароль ещё не свой. Если бы маршрут отвечал тут
   * 403, человек попадал бы в тупик: экран требует согласия, согласие требует смены пароля, а
   * смена пароля доступна только ПОСЕД согласия — ни хода назад, ни хода вперёд. Поймано
   * браузерным тестом `zz32-teacher-create`, а не ревью.
   *
   * Это не дыра в гейте: маршрут — идемпотентная запись одной строки
   * (`policy_acceptances.user_id`, только своё собственное согласие) с жёсткой проверкой версии
   * документа, и он не даёт тронуть ни класс, ни урок, ни чужие данные. Ровно за тем же держится
   * в списке `/api/me/profile`, который SPA зовёт для синхронизации часового пояса.
   *
   * Почему ключ — МЕТОД плюс путь (2026-10-28, аудит SEC-03). Прежний список сравнивал
   * `req.url` с множеством путей, а Fastify живёт парой «метод + путь». На `/api/me` висят ДВА
   * маршрута: `GET` (прочитать себя) и `DELETE` (стереть себя, `routes/auth.ts:298`). Значит
   * запись `'/api/me'` открывала и удаление: аккаунт с навязанной сменой пароля мог уничтожить
   * себя, так и не задав собственный пароль — не доступ к чужим данным, но ровно тот обход
   * правила, ради которого этот гейт и существует. Теперь в списке только те combinations,
   * которые действительно нужны первому входу, и `DELETE /api/me` отвечает 403.
   *
   * Отдельно: `HEAD` читается как `GET`. Он по определению не изменяет ничего, а строгая сверка
   * метода лишила бы смысла простую проверку доступности своим же профилем.
   */
  const TEMP_PW_ALLOWED = new Set([
    'GET /api/me',            // экрану нужно показать, что происходит
    'PATCH /api/me/profile',  // SPA синхронизирует часовой пояс и язык при каждом входе
    'POST /api/me/accept-policy', // первая калитка стоит ПЕРЕД сменой пароля: иначе вход в ловушке
    'POST /api/me/change-password',
    'POST /api/auth/logout',
    'POST /api/auth/logout-all',
  ]);

  /** Ключ списка: «МЕТод путь» без query. `HEAD` = `GET`. */
  function tempPwKey(req: FastifyRequest): string {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    return `${method} ${(req.url ?? '').split('?')[0] ?? ''}`;
  }

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const claims = await verifyAccessToken(header.slice(7));
      if (claims) req.user = { ...claims, id: claims.sub };
    }
  });

  async function loadAndCheck(req: FastifyRequest, reply: FastifyReply, role?: UserRole) {
    if (!req.user) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const [u] = await opts.db
      .select()
      .from(users)
      .where(and(eq(users.id, req.user.id), isNull(users.deletedAt)))
      .limit(1);
    if (!u) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (role && u.role !== role) {
      return reply.code(role === 'teacher' ? 403 : 401).send({ error: 'forbidden' });
    }
    if (u.mustChangePassword && !TEMP_PW_ALLOWED.has(tempPwKey(req))) {
      return reply.code(403).send({ error: 'passwordChangeRequired' });
    }
    return undefined;
  }

  app.decorate('authenticate', (req, reply) => loadAndCheck(req, reply));
  app.decorate('authenticateTeacher', (req, reply) => loadAndCheck(req, reply, 'teacher'));
});
