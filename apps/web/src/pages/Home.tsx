import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type Me } from '../lib/api';
import { useAuth } from '../App';

interface ClassView { id: string; name: string; color: string; archived: boolean; memberCount: number }
interface Occ {
  eventId: string; classId: string; className: string; classColor: string;
  kind: 'lesson' | 'deadline' | 'other'; title: string; startsAt: string; endsAt: string; recurring: boolean;
}
interface FeedPost { id: string; kind: 'material' | 'announcement'; title: string; body: string; createdAt: string; className?: string; classId?: string }

/**
 * «Есть ли сейчас живой урок» — для бейджа в навигации. Один такой цикл стоит 1 + N обращений
 * (класс, потом активный урок каждого класса), поэтому на странице урока он выключен: там и так
 * есть собственный статус-запрос и сокет. Замер до правки (`apps/e2e/scripts/lesson-perf.mjs`,
 * журнал API): 58 обращений к `/api/lessons/active` на двух клиентов за прогон ≈123 с — при том,
 * что сам статус урока опрашивается раз в 10 с. В журнале URL без query string, поэтому, какой
 * именно это запрос, видно только из арифметики окна (см. таблицу в docs/PERFORMANCE.md).
 */
export function useLiveClass(enabled = true): { liveClassId: string | null; liveClassName: string | null } {
  const { me } = useAuth();
  const q = useQuery({
    queryKey: ['live', me?.id],
    enabled: !!me && enabled,
    refetchInterval: 30_000,
    queryFn: async () => {
      const classes = await api<ClassView[]>('/api/classes');
      const active = await Promise.allSettled(classes
        .filter((c) => !c.archived)
        .slice(0, 6)
        .map(async (c) => ({ c, r: await api<{ session: { id: string } | null }>(`/api/lessons/active?classId=${c.id}`) })));
      for (const a of active) {
        if (a.status === 'fulfilled' && a.value.r.session) {
          return { liveClassId: a.value.c.id, liveClassName: a.value.c.name };
        }
      }
      return { liveClassId: null, liveClassName: null };
    },
  });
  return q.data ?? { liveClassId: null, liveClassName: null };
}

export default function Home({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const isTeacher = me.role === 'teacher';
  const { liveClassId, liveClassName } = useLiveClass();

  const data = useQuery({
    queryKey: ['home', me.id, i18n.language],
    queryFn: async () => {
      const classes = await api<ClassView[]>('/api/classes');
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 7 * 864e5).toISOString();
      const [events, feeds] = await Promise.all([
        api<Occ[]>(`/api/events?from=${from}&to=${to}`).catch(() => [] as Occ[]),
        Promise.allSettled(classes.filter((c) => !c.archived).slice(0, 6).map(async (c) =>
          ((await api<FeedPost[]>(`/api/classes/${c.id}/feed`)) ?? []).map((p) => ({ ...p, className: p.className ?? c.name, classId: p.classId ?? c.id }))
        )),
      ]);
      const posts = feeds.flatMap((f) => (f.status === 'fulfilled' ? f.value : []))
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).slice(0, 5);
      return { classes, events: events.slice(0, 8), posts };
    },
  });
  const { classes = [], events = [], posts = [] } = data.data ?? {};
  const fmt = (iso: string) => new Intl.DateTimeFormat(i18n.language === 'en' ? 'en-GB' : i18n.language === 'uz' ? 'uz-Latn-UZ' : 'ru-RU',
    { day: 'numeric', month: 'short', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  return (
    <div>
      <h1 style={{ marginTop: 0 }} data-testid="home-title">{t('home.title')}</h1>

      {liveClassId && (
        <div className="card live-card" data-testid="home-live">
          <div className="row">
            <span className="pulse" />
            <strong style={{ fontSize: '1.15rem' }}>{t('home.liveNow')} — {liveClassName}</strong>
            <div className="spacer" />
            <Link to={`/lesson?classId=${liveClassId}`}>
              <button style={{ marginTop: 0 }} data-testid="home-enter-lesson">{t('home.enterLesson')}</button>
            </Link>
          </div>
        </div>
      )}

      <div className="card flat" style={{ background: 'transparent', border: 'none', boxShadow: 'none', padding: 0 }}>
        <h2>{t('home.quick')}</h2>
        <div className="row" data-testid="home-quick">
          {isTeacher ? (
            <>
              <Link to="/classes?new=1"><button className="secondary" style={{ marginTop: 0 }} data-testid="qa-new-class">{t('home.newClass')}</button></Link>
              <Link to="/calendar?new=1"><button className="secondary" style={{ marginTop: 0 }} data-testid="qa-new-event">{t('home.newEvent')}</button></Link>
              <Link to={liveClassId ? `/lesson?classId=${liveClassId}` : '/classes'}>
                <button className="secondary" style={{ marginTop: 0 }} data-testid="qa-start-lesson">{t('home.startLesson')}</button>
              </Link>
              <Link to="/notes?new=1"><button className="secondary" style={{ marginTop: 0 }} data-testid="qa-new-note">{t('home.newNote')}</button></Link>
            </>
          ) : (
            <>
              <Link to="/classes"><button className="secondary" style={{ marginTop: 0 }} data-testid="qa-my-classes">{t('classes.title')}</button></Link>
              <Link to="/sheets?new=1"><button className="secondary" style={{ marginTop: 0 }} data-testid="qa-new-note">{t('home.newNote')}</button></Link>
            </>
          )}
        </div>
      </div>

      <div className="tiles">
        <div className="card" style={{ marginBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>{t('home.upcoming')}</h2>
          {data.isPending && <p className="muted">{t('common.loading')}</p>}
          {!data.isPending && events.length === 0 && (
            <div className="empty-state">
              <div className="big">🗓️</div>
              <p>{t('home.noEvents')}</p>
              {isTeacher && <Link to="/calendar?new=1"><button style={{ marginTop: 0 }}>{t('home.newEvent')}</button></Link>}
            </div>
          )}
          {events.map((e) => (
            <Link key={e.eventId + e.startsAt} to={`/calendar?focus=${encodeURIComponent(e.startsAt)}`}
              className="event-line" style={{ color: 'var(--text)' }} data-testid="home-event">
              <span className="dot" style={{ background: e.classColor }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.kind === 'lesson' ? '▶ ' : e.kind === 'deadline' ? '⏰ ' : ''}{e.title}
              </span>
              <span className="muted">{fmt(e.startsAt)}</span>
            </Link>
          ))}
        </div>

        <div className="card" style={{ marginBottom: 0 }}>
          <h2 style={{ marginTop: 0 }}>{t('home.myClasses')}</h2>
          {classes.length === 0 && !data.isPending && (
            <div className="empty-state">
              <div className="big">🎓</div>
              <p>{t('home.noClasses')}</p>
              <p className="muted">{isTeacher ? t('home.noClassesHint') : t('home.noClassesStudent')}</p>
              {isTeacher
                ? <Link to="/classes?new=1"><button style={{ marginTop: 0 }}>{t('home.newClass')}</button></Link>
                : <Link to="/register"><button style={{ marginTop: 0 }}>{t('auth.howToJoin')}</button></Link>}
            </div>
          )}
          <div>
            {classes.filter((c) => !c.archived).slice(0, 6).map((c) => (
              <Link key={c.id} to={`/classes/${c.id}`} className="event-line" style={{ color: 'var(--text)' }} data-testid="home-class">
                <span className="dot" style={{ background: c.color }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{c.name}</span>
                <span className="muted">{c.memberCount}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t('home.recent')}</h2>
        {posts.length === 0 && !data.isPending && (
          <div className="empty-state">
            <div className="big">📄</div>
            <p>{t('home.noPosts')}</p>
          </div>
        )}
        {posts.map((p) => (
          <Link key={p.id} to={`/classes/${p.classId}`}
            className="event-line" style={{ color: 'var(--text)' }} data-testid="home-post">
            <span className="badge">{p.kind === 'announcement' ? t('feed.announcement') : t('feed.material')}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
            <span className="muted">{new Intl.DateTimeFormat(i18n.language === 'en' ? 'en-GB' : i18n.language, { day: 'numeric', month: 'short' }).format(new Date(p.createdAt))}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
