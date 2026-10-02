import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../App';

export default function Profile() {
  const { t, i18n } = useTranslation();
  const { me, refresh } = useAuth();
  const [name, setName] = useState(me?.name ?? '');
  const [locale, setLocale] = useState<'ru' | 'uz'>(me?.locale ?? 'ru');
  const [tz, setTz] = useState(me?.tz ?? 'Asia/Tashkent');
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [icsUrl, setIcsUrl] = useState('');
  const [tg, setTg] = useState<{ linked: boolean; blocked: boolean } | null>(null);
  const [tgUrl, setTgUrl] = useState('');

  useEffect(() => {
    void api<{ linked: boolean; blocked: boolean }>('/api/me/telegram-status').then(setTg).catch(() => undefined);
  }, []);

  async function linkTelegram() {
    const r = await api<{ url: string }>('/api/me/telegram-link', { method: 'POST' });
    setTgUrl(r.url);
    window.open(r.url, '_blank');
    setTimeout(() => void api<{ linked: boolean; blocked: boolean }>('/api/me/telegram-status').then(setTg).catch(() => undefined), 2000);
  }

  async function unlinkTelegram() {
    await api('/api/me/telegram-link', { method: 'DELETE' });
    setTgUrl('');
    setTg({ linked: false, blocked: false });
  }

  async function getIcs() {
    const { token } = await api<{ token: string }>('/api/me/ical-token', { method: 'POST' });
    setIcsUrl(`${window.location.origin}/api/ical/${token}`);
  }

  if (!me) return null;

  async function save() {
    setSaved(false);
    await api('/api/me/profile', { method: 'PATCH', body: JSON.stringify({ name, locale, tz }) });
    await i18n.changeLanguage(locale);
    refresh();
    setSaved(true);
  }

  async function deleteAccount() {
    if (!confirm('Удалить аккаунт безвозвратно? / Hisobni butunlay o‘chirilsinmi?')) return;
    setDeleting(true);
    await api('/api/me', { method: 'DELETE' });
    const { logout } = await import('../lib/api');
    await logout();
  }

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <h1>{t('auth.profile')}</h1>
      <p className="muted">{me.email} · {me.role}</p>
      <label>{t('common.name')}</label>
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <label>{t('common.language')}</label>
      <select value={locale} onChange={(e) => setLocale(e.target.value as 'ru' | 'uz')}>
        <option value="ru">Русский</option>
        <option value="uz">O‘zbekcha</option>
      </select>
      <label>{t('common.timezone')}</label>
      <input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="Asia/Tashkent" />
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
      ) : (
        <>
          <button onClick={linkTelegram}>{t('tg.connect')}</button>
          {tgUrl && <p className="muted" style={{ wordBreak: 'break-all' }}>{tgUrl}</p>}
        </>
      )}
      <hr />
      <h2>{t('cal.ical')}</h2>
      <button className="secondary" onClick={getIcs}>{t('cal.icalGet')}</button>
      {icsUrl && (
        <>
          <input readOnly value={icsUrl} onFocus={(e) => e.target.select()} style={{ marginTop: 8, fontFamily: 'ui-monospace, monospace', fontSize: '.8rem' }} />
          <p className="muted">{t('cal.icalHint')}</p>
        </>
      )}
      <hr />
      <button className="danger" onClick={deleteAccount} disabled={deleting}>
        {t('common.delete')} ({t('auth.profile')})
      </button>
    </div>
  );
}
