import LegalDoc from './LegalDoc';

/** Legal task (Phase 2): terms of service rendered from i18n. */
export default function Terms() {
  return <LegalDoc ns="terms" back="/login" />;
}
