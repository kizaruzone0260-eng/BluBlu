import LegalDoc from './LegalDoc';

/** §4 privacy + Legal task (Phase 2): full privacy policy rendered from i18n. */
export default function Privacy() {
  return <LegalDoc ns="privacy" back="/login" />;
}
