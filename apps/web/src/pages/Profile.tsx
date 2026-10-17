import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LOCALE, LANGUAGE_CHOICES, type Locale } from '@klass/shared';
import { api, logoutAll } from '../lib/api';
import { buildId } from '../lib/build';
import { useAuth } from '../App';
import { chooseLocale } from '../i18n';
import ChangePasswordForm from '../components/ChangePasswordForm';

export default function Profile() {
  const { t } = useTranslation();
  const { me, refresh } = useAuth();
  const [name, setName] = useState(me?.name ?? '');
  const [lastName, setLastName] = useState(me?.lastName ?? '');
  const [locale, setLocale] = useState<Locale>(me?.locale ?? DEFAULT_LOCALE);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [outAll, setOutAll] = useState(false);
  const [tg, setTg] = useState<{ linked: boolean; blocked: boolean; configured?: boolean } | null>(null);
  const [tgUrl, setTgUrl] = useState('');
  const [tgErr, setTgErr] = useState('');

  useEffect(() => {
    void api<{ linked: boolean; blocked: boolean; configured?: boolean }>('/api/me/telegram-status').then(setTg).catch(() => undefined);
  }, []);

  async function linkTelegram() {
    setTgErr('');
    try {
      const r = await api<{ url: string }>('/api/me/telegram-link', { method: 'POST' });
      setTgUrl(r.url);
      window.open(r.url, '_blank');
    } catch (e) {
      const code = (e as { code?: string }).code;
      // item 5: the server refuses to invent a bot address when nothing is configured
      setTgErr(code === 'telegramNotConfigured' ? t('tg.notConfigured') : t('common.errorGeneric'));
    }
    setTimeout(() => void api<{ linked: boolean; blocked: boolean }>('/api/me/telegram-status').then(setTg).catch(() => undefined), 2000);
  }

  async function unlinkTelegram() {
    await api('/api/me/telegram-link', { method: 'DELETE' });
    setTgUrl('');
    setTg({ linked: false, blocked: false });
  }

  if (!me) return null;

  async function save() {
    if (saving) return;
    setSaving(true);
    setSaved(false);
    try {
      // item 4: no manual timezone — App syncs it from the device automatically
      const dev = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tashkent';
      await api('/api/me/profile', { method: 'PATCH', body: JSON.stringify({ name, lastName, locale, tz: dev }) });
      // saving the profile with a language IS choosing it (task 1): the server flags the
      // account, this device remembers it, and the UI follows at once
      await chooseLocale(locale);
      refresh();
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  async function deleteAccount() {
    if (!confirm(t('common.deleteAccountConfirm'))) return;
    setDeleting(true);
    await api('/api/me', { method: 'DELETE' });
    const { logout } = await import('../lib/api');
    await logout();
  }

  // Part 3: revoke every refresh session — all devices INCLUDING this one, so
  // the user lands back on the login screen (the button literally says «выйти со
  // всех устройств»). logoutAll() nulls the access token, which fires the
  // onAuthChange listener App uses to re-fetch /api/me and unmount the Shell.
  async function signOutEverywhere() {
    if (!confirm(t('auth.logoutAllConfirm'))) return;
    setOutAll(true);
    await logoutAll();
  }

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <h1>{t('auth.profile')}</h1>
      <p className="muted">{me.email} · {me.role === 'teacher' ? t('common.roleTeacher') : t('common.roleStudent')}</p>
      <label htmlFor="profile-name">{t('common.name')}</label>
      <input id="profile-name" data-testid="profile-name" value={name} onChange={(e) => setName(e.target.value)} />
      {/* item 9 — family name, separate and editable; display is «Имя Фамилия» */}
      <label htmlFor="profile-last">{t('auth.lastName')}</label>
      <input id="profile-last" data-testid="profile-last-name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
      <label htmlFor="profile-locale">{t('common.language')}</label>
      {/* часть A: порядок и подписи — из одной константы shared, как в сайдбаре и на входе */}
      <select id="profile-locale" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
        {LANGUAGE_CHOICES.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}
      </select>
      {/* item 4: timezone is detected automatically (Intl) — no manual field */}
      <button onClick={save} disabled={saving} data-testid="profile-save">{t('common.save')}</button>
      {saved && <span className="ok"> ✓</span>}
      <hr />
      {/* Part 3: change your own password (verifies the current one server-side,
          revokes every other session and keeps this device signed in). */}
      <h2>{t('auth.changePassword')}</h2>
      <ChangePasswordForm />
      <hr />
      <h2>{t('tg.title')}</h2>
      {tg?.linked ? (
        <div className="row">
          <span className={tg.blocked ? 'error' : 'ok'}>
            {tg.blocked ? t('tg.blocked') : t('tg.linked')}
          </span>
          <button className="danger" style={{ marginTop: 0 }} onClick={unlinkTelegram}>{t('tg.disable')}</button>
        </div>
      ) : tg && tg.configured === false ? (
        // item 5: no bot token/name on the server → we do NOT invent a t.me address
        <p className="muted" data-testid="tg-not-configured">{t('tg.notConfigured')}</p>
      ) : (
        <>
          <button onClick={linkTelegram} data-testid="tg-connect">{t('tg.connect')}</button>
          {tgErr && <p className="error" data-testid="tg-error">{tgErr}</p>}
          {tgUrl && <p className="muted" style={{ wordBreak: 'break-all' }}>{tgUrl}</p>}
        </>
      )}
      {/* item 4: ICS subscription moved to the Calendar page (the link stays secret) */}
      <hr />
      <button className="ghost" onClick={signOutEverywhere} disabled={outAll} data-testid="logout-all">
        {t('auth.logoutAll')}
      </button>
      <button className="danger" onClick={deleteAccount} disabled={deleting}>
        {t('common.deleteAccount')}
      </button>
      {/* build stamp (task 1) — tiny, interface-only */}
      <p className="muted build-tag" data-testid="build-tag">build {buildId()}</p>
    </div>
  );
}
