import { useState } from 'react';
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
      <button className="danger" onClick={deleteAccount} disabled={deleting}>
        {t('common.delete')} ({t('auth.profile')})
      </button>
    </div>
  );
}
