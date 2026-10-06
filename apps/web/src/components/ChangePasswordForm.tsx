import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { changePassword } from '../lib/api';

/**
 * Part 3 — change-own-password form. Shared by the forced gate screen (shown
 * after a temporary password is issued: teacher reset or the owner script) and
 * the Profile page. Verifies the CURRENT password server-side, applies the
 * registration policy to the NEW one, clears the must-change flag and revokes
 * every other session. `onDone` re-fetches /api/me so the gate unlocks.
 */
export default function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  // client-side shape only; the authoritative policy runs on the server
  const valid = current.length > 0 && next.length >= 10 && next === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setErr('');
    if (next !== confirm) { setErr('passwordsMismatch'); return; }
    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      setDone(true);
      onDone?.();
    } catch (ex) {
      setErr((ex as { code?: string }).code ?? 'errorGeneric');
    } finally {
      setBusy(false);
    }
  }

  // Map a server/validation code to a translated message (falls back to generic).
  const msg = (code: string) =>
    code === 'passwordsMismatch' ? t('auth.passwordsMismatch')
      : code === 'wrongPassword' ? t('auth.wrongPassword')
      : code === 'passwordTooWeak' ? t('auth.passwordTooWeak')
      : code === 'errorGeneric' ? t('common.errorGeneric')
      : t(`auth.${code}`, { defaultValue: t('common.errorGeneric') });

  return (
    <form onSubmit={submit} data-testid="change-password-form">
      <label htmlFor="cp-current">{t('auth.currentPassword')}</label>
      <input id="cp-current" data-testid="cp-current" type="password" value={current}
        onChange={(e) => { setCurrent(e.target.value); setDone(false); }} required autoComplete="current-password" />
      <label htmlFor="cp-new">{t('auth.newPassword')}</label>
      <input id="cp-new" data-testid="cp-new" type="password" value={next}
        onChange={(e) => { setNext(e.target.value); setDone(false); }} required minLength={10} autoComplete="new-password" />
      <label htmlFor="cp-confirm">{t('auth.confirmPassword')}</label>
      <input id="cp-confirm" data-testid="cp-confirm" type="password" value={confirm}
        onChange={(e) => { setConfirm(e.target.value); setDone(false); }} required autoComplete="new-password" />
      {err && <p className="error" role="alert" data-testid="cp-error">{msg(err)}</p>}
      {done && !err && <p className="ok" data-testid="cp-done">{t('auth.passwordChanged')}</p>}
      <button type="submit" data-testid="cp-submit" disabled={!valid || busy}>{t('auth.changePassword')}</button>
    </form>
  );
}
