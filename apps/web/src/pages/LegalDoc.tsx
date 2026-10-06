import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

/**
 * Renders a legal document (privacy / terms) from the locale dictionary. The
 * body is an array of { h, b: string[] } sections, read with returnObjects so a
 * document can be as long as it needs without adding per-paragraph keys. Links
 * back are provided so the pages are crawlable and reachable from the footers.
 */
export default function LegalDoc({ ns, back }: { ns: 'privacy' | 'terms'; back: string }) {
  const { t } = useTranslation();
  const doc = t(`${ns}.sections`, { returnObjects: true }) as { h: string; b: string[] }[];
  const sections = Array.isArray(doc) ? doc : [];
  return (
    <article className="card legal-doc" style={{ maxWidth: 760 }}>
      <h1>{t(`${ns}.title`)}</h1>
      <p className="muted" style={{ fontSize: '.85rem' }}>{t(`${ns}.version`)}</p>
      <p>{t(`${ns}.intro`)}</p>
      {sections.map((sec, i) => (
        <section key={i} aria-labelledby={`legal-${ns}-h-${i}`}>
          <h2 id={`legal-${ns}-h-${i}`}>{sec.h}</h2>
          {sec.b.map((para, j) => <p key={j}>{para}</p>)}
        </section>
      ))}
      <nav className="row" aria-label={t('legalLinks.back')}>
        <Link to={back === 'login' ? '/login' : back}>{t('legalLinks.back')}</Link>
        {ns === 'privacy'
          ? <Link to="/terms">{t('consent.termsLink')}</Link>
          : <Link to="/privacy">{t('consent.privacyLink')}</Link>}
      </nav>
    </article>
  );
}
