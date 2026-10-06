import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { acceptPolicy, logout } from '../lib/api';
import { POLICY_VERSION } from '@klass/shared';

/**
 * Legal gate (Hardening Phase 2): shown right after login/session-restore while
 * the account has not accepted the CURRENT privacy+terms bundle (their stored
 * version differs — new teacher, existing user after a version bump). It
 * REPLACES the authenticated UI like the name screen (no route to sneak past);
 * the standalone /privacy and /terms pages remain reachable through these links
 * because App renders them even while the gate is active. Accepting records the
 * version+time on the server; declining signs the user out (consent is required).
 */
export default function AcceptPolicies({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function accept() {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await acceptPolicy(POLICY_VERSION);
      onDone(); // re-fetch /api/me → policyAccepted true → the app unlocks
    } catch {
      setErr(t('common.errorGeneric'));
      setBusy(false);
    }
  }

  return (
    <div className="card legal-gate" style={{ maxWidth: 560, margin: '40px auto' }} data-testid="policy-gate" role="dialog" aria-modal="true" aria-labelledby="policy-gate-title">
      <h1 id="policy-gate-title">{t('consent.gateTitle')}</h1>
      <p className="muted">{t('consent.gateBody')}</p>
      <p className="muted" style={{ fontSize: '.85rem' }}>{t('consent.versionNote', { version: POLICY_VERSION })}</p>
      <p>
        <Link to="/privacy" data-testid="gate-privacy-link">{t('consent.privacyLink')}</Link>
        {' · '}
        <Link to="/terms" data-testid="gate-terms-link">{t('consent.termsLink')}</Link>
      </p>
      {err && <p className="error" data-testid="gate-policies-error">{err}</p>}
      <div className="row">
        <button type="button" data-testid="gate-accept" disabled={busy} onClick={() => void accept()}>{t('consent.accept')}</button>
        <button type="button" className="ghost" style={{ marginTop: 0 }} data-testid="gate-decline"
          onClick={() => void logout()}>{t('consent.decline')}</button>
      </div>
    </div>
  );
}
