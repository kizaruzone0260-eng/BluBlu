import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

type Kind = '404' | '403' | '500' | 'offline';

/**
 * Hardening Phase 3: friendly, translated status screens with a single
 * "На главную" action (and "Повторить" for the retryable ones). No stack, no
 * versions — just a heading, one sentence and navigation. Rendered for unknown
 * SPA routes (404), role-guarded routes (403), the app error boundary (500) and
 * the offline state.
 */
export default function ErrorScreen({ kind }: { kind: Kind }) {
  const { t } = useTranslation();
  const map: Record<Kind, { title: string; body: string; retry: boolean }> = {
    '404': { title: t('titles.notFound'), body: t('errors.notFoundBody'), retry: false },
    '403': { title: t('titles.forbidden'), body: t('errors.forbiddenBody'), retry: false },
    '500': { title: t('titles.serverError'), body: t('errors.serverErrorBody'), retry: true },
    offline: { title: t('titles.offline'), body: t('errors.offlineBody'), retry: true },
  };
  const s = map[kind];
  return (
    <div className="card error-screen" style={{ maxWidth: 460, margin: '48px auto', textAlign: 'center' }} role="alert">
      <h1 style={{ fontSize: kind === 'offline' ? '1.4rem' : '2.5rem', margin: '0 0 .2em' }}>
        {kind === 'offline' ? '⚠︎' : kind}
      </h1>
      <h2 style={{ fontSize: '1.15rem', margin: '0 0 .4em' }}>{s.title}</h2>
      <p className="muted">{s.body}</p>
      <div className="row" style={{ justifyContent: 'center' }}>
        <Link to="/" style={{ marginTop: 0 }}>{t('errors.home')}</Link>
        {s.retry && (
          <button type="button" className="ghost" style={{ marginTop: 0 }} onClick={() => location.reload()}>
            {t('errors.retry')}
          </button>
        )}
      </div>
    </div>
  );
}
