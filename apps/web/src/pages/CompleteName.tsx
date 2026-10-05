import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, logout, type Me } from '../lib/api';

/**
 * Name screen (task 2): shown right after login/session-restore while the
 * account has no complete name pair (users.profile_completed_at IS NULL).
 * It REPLACES the whole authenticated UI — there is no route to sneak past and
 * nothing to redirect-loop through. Logout stays available. Both fields are
 * required (2+ chars); saving goes straight to Home (a student who registered
 * two-step never sees this screen — step 2 already collected the names).
 */
export default function CompleteName({ me, onDone }: { me: Me; onDone: () => void }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [first, setFirst] = useState(me.name ?? '');
  const [last, setLast] = useState(me.lastName ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const ok = first.trim().length >= 2 && last.trim().length >= 2;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setErr('');
    try {
      await api('/api/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name: first.trim(), lastName: last.trim(), locale: me.locale, tz: me.tz }),
      });
      onDone();
      nav('/');
    } catch {
      setErr(t('common.errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 420, margin: '40px auto' }} data-testid="name-gate">
      <h1>{t('auth.nameGateTitle')}</h1>
      <p className="muted">{t('auth.nameGateHint')}</p>
      <form onSubmit={save}>
        <label htmlFor="gate-first">{t('auth.firstName')}</label>
        <input id="gate-first" data-testid="gate-first" value={first} onChange={(e) => setFirst(e.target.value)}
          required minLength={2} autoComplete="given-name" />
        <label htmlFor="gate-last">{t('auth.lastName')}</label>
        <input id="gate-last" data-testid="gate-last" value={last} onChange={(e) => setLast(e.target.value)}
          required minLength={2} autoComplete="family-name" />
        {err && <p className="error" data-testid="gate-error">{err}</p>}
        <button type="submit" data-testid="gate-save" disabled={!ok || busy}>{t('common.save')}</button>
        <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="gate-logout"
          onClick={() => void logout()}>
          {t('common.logout')}
        </button>
      </form>
    </div>
  );
}
