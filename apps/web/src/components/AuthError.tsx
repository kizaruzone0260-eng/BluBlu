import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * One auth error, three languages, and a code the pupil can send.
 *
 * Task B (2026-10-23): a registration failure used to end in «Something went wrong. Please try
 * again.» — true only for the person watching, useless for the teacher who gets the complaint.
 * Every server answer now carries a short request id (`reqId`), it is in the access log under
 * the same value, and it is printed here in small type with a copy button, so the message that
 * reaches the teacher is «вот мой код: k3f9d2xq1m» instead of «что-то не работает».
 *
 * `code` is the raw server code — never shown, only translated. An unknown code falls back to
 * the generic sentence, but the id still shows, because that is the part that makes it fixable.
 */
export default function AuthError({ code, reqId, children }: {
  code: string;
  reqId?: string;
  /** optional action under the sentence, e.g. a link to the sign-in screen */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!reqId) return;
    try {
      await navigator.clipboard.writeText(reqId);
      setCopied(true);
    } catch {
      /* a browser without clipboard permission: the id is still on screen to read aloud */
    }
  }

  return (
    <>
      <p className="error" role="alert" data-testid="auth-error">{t(`auth.${code}`, { defaultValue: t('common.errorGeneric') })}</p>
      {children}
      {reqId ? (
        <p className="muted auth-req-id" data-testid="auth-error-code" style={{ marginTop: '-6px', fontSize: '.78rem' }} dir="ltr">
          {t('auth.errorCodeLabel')}: <code>{reqId}</code>
          {' '}
          <button
            type="button" className="ghost link-button" data-testid="auth-error-copy"
            onClick={copy} aria-label={`${t('auth.copyCode')}: ${reqId}`}
          >
            {copied ? t('auth.copied') : t('auth.copyCode')}
          </button>
        </p>
      ) : null}
    </>
  );
}
