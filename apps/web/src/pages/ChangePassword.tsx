import { useTranslation } from 'react-i18next';
import { logout } from '../lib/api';
import ChangePasswordForm from '../components/ChangePasswordForm';

/**
 * Part 3 — forced password-change gate. Shown right after login/session-restore
 * while the account still carries a temporary password (a teacher reset it via
 * the member list, or the owner reset a teacher with the reset-teacher script —
 * users.must_change_password IS TRUE). Like the name screen it REPLACES the
 * whole authenticated UI, so there is no route to sneak past; logout stays
 * available. Changing the password clears the flag server-side and unlocks the
 * app on the next /api/me fetch (onDone).
 */
export default function ChangePasswordGate({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="card" style={{ maxWidth: 420, margin: '40px auto' }} data-testid="password-gate" role="dialog" aria-modal="true" aria-labelledby="password-gate-title">
      <h1 id="password-gate-title">{t('auth.changePasswordGateTitle')}</h1>
      <p className="muted">{t('auth.changePasswordGateHint')}</p>
      <ChangePasswordForm onDone={onDone} />
      <button type="button" className="ghost" style={{ marginTop: 12 }} data-testid="gate-logout"
        onClick={() => void logout()}>
        {t('common.logout')}
      </button>
    </div>
  );
}
