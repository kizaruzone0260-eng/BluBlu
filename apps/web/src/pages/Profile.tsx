import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../App';

export default function Profile() {
  const { t, i18n } = useTranslation();
  const { me, refresh } = useAuth();
  const [name, setName] = useState(me?.name ?? '');
  const [lastName, setLastName] = useState(me?.lastName ?? '');
  const [locale, setLocale] = useState<'ru' | 'uz' | 'en'>(me?.locale ?? 'ru');
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
    setSaved(false);
    // item 4: no manual timezone — App syncs it from the device automatically
    const dev = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tashkent';
    await api('/api/me/profile', { method: 'PATCH', body: JSON.stringify({ name, lastName, locale, tz: dev }) });
    await i18n.changeLanguage(locale);
    refresh();
    setSaved(true);
  }

  async function deleteAccount() {
    if (!confirm(t('common.deleteAccountConfirm'))) return;
    setDeleting(true);
    await api('/api/me', { method: 'DELETE' });
    const { logout } = await import('../lib/api');
    await logout();
  }

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <h1>{t('auth.profile')}</h1>
      <p className="muted">{me.email} · {me.role === 'teacher' ? t('common.roleTeacher') : t('common.roleStudent')}</p>
      <label>{t('common.name')}</label>
      <input data-testid="profile-name" value={name} onChange={(e) => setName(e.target.value)} />
      {/* item 9 — family name, separate and editable; display is «Имя Фамилия» */}
      <label htmlFor="profile-last">{t('auth.lastName')}</label>
      <input id="profile-last" data-testid="profile-last-name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
      <label>{t('common.language')}</label>
      <select value={locale} onChange={(e) => setLocale(e.target.value as 'ru' | 'uz' | 'en')}>
        <option value="ru">Русский</option>
        <option value="uz">Oʻzbekcha</option>
        <option value="en">English</option>
      </select>
      {/* item 4: timezone is detected automatically (Intl) — no manual field */}
      <button onClick={save}>{t('common.save')}</button>
      {saved && <span className="ok"> ✓</span>}
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
      <button className="danger" onClick={deleteAccount} disabled={deleting}>
        {t('common.deleteAccount')}
      </button>
    </div>
  );
}
