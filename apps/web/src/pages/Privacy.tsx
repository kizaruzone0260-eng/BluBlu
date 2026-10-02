import { useTranslation } from 'react-i18next';

/** §4 privacy: no analytics, no trackers; data never leaves except Telegram (chat_id + text). */
export default function Privacy() {
  const { t } = useTranslation();
  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <h1>{t('privacy.title')}</h1>
      <p>{t('privacy.p1')}</p>
      <p>{t('privacy.p2')}</p>
      <p>{t('privacy.p3')}</p>
      <p>{t('privacy.p4')}</p>
      <p><a href="/login">← {t('common.login')}</a></p>
    </div>
  );
}
