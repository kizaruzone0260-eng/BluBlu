/**
 * Task G (2026-10-29): the Mini App controls that talk to new server surfaces.
 *
 * Everything here follows one rule from the brief: the page may only show what the server
 * actually did. A code is not «connected» until Telegram spent it, a file is not «uploaded»
 * until the library row exists, and an AI failure never replaces the teacher's own text.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGE_CHOICES } from '@klass/shared';
import { chooseLocale } from '../../i18n';
import { getThemeChoice, setTheme, type ThemeChoice } from '../../lib/theme';
import {
  applyMiniTheme, haptic, miniApi, uploadMiniFile,
  type MiniBootstrap, type MiniConnectStart, type MiniConnectState, type MiniGroupHealth,
  type MiniLegalStatus, type MiniUploadResponse, type TelegramWebApp,
} from '../../lib/miniApp';

type Translate = (key: string, vars?: Record<string, unknown>) => string;

// ─── shared shell and error text ────────────────────────────────────────────

/** Small shared shell: safe areas, max width, a brand line, one `<main>`. */
export function MiniFrame({ testid, children }: { testid: string; children: ReactNode }) {
  return (
    <div className="mini-app">
      <main className="mini-screen" data-testid={testid}>{children}</main>
    </div>
  );
}

/** Interface codes → human sentences; never a raw code and never a request id. */
export function errorText(code: string, t: Translate, bootstrap?: MiniBootstrap): string {
  const limits = bootstrap?.limits;
  switch (code) {
    case 'networkError': return t('mini.errorNetwork');
    case 'tooManyRequests': return t('mini.errorRate');
    case 'groupsRequired': return t('mini.errorGroups');
    case 'tooManyLinks': return t('mini.errorTooManyLinks', { n: limits?.links ?? 5 });
    case 'tooManyMaterials':
    case 'tooManyGroups': return t('mini.errorTooManyMaterials', { n: limits?.materials ?? 8 });
    case 'materialNotAllowed': return t('mini.errorMaterials');
    case 'groupNotAllowed': return t('mini.errorGroups');
    case 'draftLocked': return t('mini.errorLocked');
    case 'emptyHomework': return t('mini.errorEmpty');
    case 'notReady': return t('mini.errorNotReady');
    case 'aiUnavailable': return t('mini.aiStatusOff');
    case 'policyRequired':
    case 'policyVersionStale': return t('mini.errorPolicy');
    case 'unsupportedFile': return t('mini.errorFileType');
    case 'fileTooLarge': return t('mini.errorFileLarge');
    case 'quotaExceeded': return t('mini.errorQuota');
    case 'materialsLimit': return t('mini.errorLibraryLimit');
    case 'telegramLinkRequired': return t('mini.errorTelegramLink');
    case 'telegramUploadFailed': return t('mini.errorTelegramUpload');
    case 'uploadBusy': return t('mini.errorUploadBusy');
    case 'groupsLimit': return t('mini.errorGroupsLimit');
    case 'notFound': return t('mini.errorNotFound');
    case 'invalidInput':
    case 'invalidLink': return t('mini.errorInvalidLink');
    case 'serverError': return t('mini.errorGeneric');
    case 'miniUnavailable': return t('mini.errorUnavailable');
    case 'sessionExpired': return t('mini.errorExpired');
    default: return t('mini.errorGeneric');
  }
}

function fmtBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function fmtWhen(iso: string, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
  } catch { return iso; }
}

// ─── appearance and language ────────────────────────────────────────────────

/**
 * System / Light / Dark, using the same `klass_theme` key as the web app. «System» inside
 * Telegram means Telegram's own theme (and its `themeChanged` event), not the OS guess.
 */
export function MiniThemePicker({ wa }: { wa: TelegramWebApp | null }) {
  const { t } = useTranslation();
  const [choice, setChoiceState] = useState<ThemeChoice>(getThemeChoice());
  useEffect(() => {
    const h = (e: Event) => setChoiceState((e as CustomEvent).detail as ThemeChoice);
    window.addEventListener('klass-theme', h);
    return () => window.removeEventListener('klass-theme', h);
  }, []);
  const pick = (next: ThemeChoice) => {
    if (next === choice) return;
    // setTheme stores the choice and applies it; applyMiniTheme restores Telegram's colours
    // for «system» or removes them for an explicit one.
    setTheme(next);
    applyMiniTheme(wa, next);
    haptic(wa, 'tap');
  };
  const label = (c: ThemeChoice) => t(`common.theme${c === 'light' ? 'Light' : c === 'dark' ? 'Dark' : 'System'}`);
  return (
    <div className="mini-settings-row">
      <span className="mini-settings-label">{t('mini.appearance')}</span>
      <div className="mini-seg" role="group" aria-label={t('mini.appearance')}>
        {(['system', 'light', 'dark'] as const).map((c) => (
          <button key={c} type="button" className={`mini-seg-btn${choice === c ? ' is-on' : ''}`}
            aria-pressed={choice === c} data-testid={`mini-theme-${c}`} onClick={() => pick(c)}>
            {label(c)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A real language click: the server records it for the legal row, `chooseLocale` records it
 * on this device. The order matters — a failed server write must not pretend the choice was
 * saved, and the gate itself must be readable before acceptance.
 */
export function MiniLanguagePicker({ onChanged }: { onChanged?: () => void }) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pick = async (code: string) => {
    if (busy || code === i18n.language) return;
    setBusy(true); setError('');
    const r = await miniApi<{ ok: boolean; locale: string }>('/api/mini/locale', {
      method: 'POST', body: { locale: code },
    });
    if (!r.ok) { setBusy(false); setError(errorText(r.error || 'serverError', t)); return; }
    await chooseLocale(code);
    setBusy(false);
    onChanged?.();
  };
  return (
    <div className="mini-settings-row">
      <span className="mini-settings-label">{t('mini.language')}</span>
      <div className="mini-seg" role="group" aria-label={t('mini.language')}>
        {LANGUAGE_CHOICES.map((l) => (
          <button key={l.code} type="button"
            className={`mini-seg-btn${i18n.language === l.code ? ' is-on' : ''}`}
            aria-pressed={i18n.language === l.code} disabled={busy}
            data-testid={`mini-lang-${l.code}`} onClick={() => void pick(l.code)}>
            {l.native}
          </button>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export function MiniSettings({ wa, onLocaleChanged }: {
  wa: TelegramWebApp | null;
  onLocaleChanged?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="card mini-settings" data-testid="mini-settings" aria-label={t('mini.settings')}>
      <MiniThemePicker wa={wa} />
      <MiniLanguagePicker onChanged={onLocaleChanged} />
    </section>
  );
}

// ─── legal gate ─────────────────────────────────────────────────────────────

/**
 * The Mini App half of Task 5. It renders only what `bootstrap.legal` says; the button posts
 * the CURRENT versions and shows the server's answer. A stale tab (409) is told the documents
 * changed and is refreshed — it never claims an acceptance that was not written.
 */
export function MiniLegalGate({ wa, bootstrap, onRefresh }: {
  wa: TelegramWebApp | null;
  bootstrap: MiniBootstrap;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const legal: MiniLegalStatus = bootstrap.legal;
  const links = bootstrap.links ?? { privacy: '/privacy', terms: '/terms' };
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const ready = Boolean(legal.currentPrivacyVersion && legal.currentTermsVersion);

  // New versions mean new text: the tick that accepted the old text must not carry over.
  useEffect(() => {
    setChecked(false);
  }, [legal.currentPrivacyVersion, legal.currentTermsVersion]);

  const accept = async () => {
    if (!checked || busy || !ready) return;
    setBusy(true); setError(''); setStale(false);
    const r = await miniApi<{ ok: boolean; legal: MiniLegalStatus }>('/api/mini/accept-legal', {
      method: 'POST',
      body: {
        privacyVersion: legal.currentPrivacyVersion,
        termsVersion: legal.currentTermsVersion,
      },
    });
    setBusy(false);
    if (r.ok) { haptic(wa, 'success'); onRefresh(); return; }
    if (r.status === 409 || r.error === 'policyVersionStale') {
      setStale(true);
      onRefresh();
      return;
    }
    setError(r.error === 'tooManyRequests' ? 'tooManyRequests' : 'serverError');
  };

  const message = stale
    ? t('mini.legalGateStale')
    : error === 'tooManyRequests'
      ? t('mini.errorRate')
      : error
        ? t('mini.legalGateError')
        : '';

  return (
    <MiniFrame testid="mini-legal">
      <header className="mini-head">
        <div>
          <h1>{t('mini.legalGateTitle')}</h1>
          <p>{t('mini.legalGateBody')}</p>
        </div>
      </header>

      <p className="muted">
        {ready
          ? t('mini.legalGateVersions', {
            privacy: legal.currentPrivacyVersion, terms: legal.currentTermsVersion,
          })
          : t('mini.legalGateUnavailable')}
      </p>
      <p className="muted">{t('mini.legalGateReadHint')}</p>

      <div className="mini-legal-links">
        <a className="mini-link-button" href={links.privacy} target="_blank" rel="noreferrer"
          data-testid="mini-legal-privacy">{t('privacy.title')}</a>
        <a className="mini-link-button" href={links.terms} target="_blank" rel="noreferrer"
          data-testid="mini-legal-terms">{t('terms.title')}</a>
      </div>

      <label className="mini-check" htmlFor="mini-legal-check">
        <input id="mini-legal-check" data-testid="mini-legal-check" type="checkbox"
          checked={checked} disabled={!ready || busy}
          onChange={(e) => setChecked(e.target.checked)} />
        <span>{t('mini.legalGateCheck')}</span>
      </label>

      {message && <p className={stale || error ? 'error' : 'muted'} role="alert">{message}</p>}

      <button type="button" data-testid="mini-legal-accept"
        disabled={!checked || !ready || busy} onClick={() => void accept()}>
        {busy ? t('mini.legalGateSaving') : t('mini.legalGateAccept')}
      </button>

      <MiniSettings wa={wa} onLocaleChanged={onRefresh} />
    </MiniFrame>
  );
}

// ─── library upload ─────────────────────────────────────────────────────────

const UPLOAD_ACCEPT = [
  '.pdf', '.docx', '.pptx', '.xlsx', '.txt', '.md', '.csv',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff',
  '.mp3', '.m4a', '.mp4',
].join(',');

function uploadErrorText(code: string, t: Translate, bootstrap?: MiniBootstrap): string {
  switch (code) {
    case 'unsupportedFile': return t('mini.uploadUnsupported');
    case 'fileTooLarge': return t('mini.uploadTooLarge');
    case 'quotaExceeded': return t('mini.uploadQuota');
    case 'materialsLimit': return t('mini.uploadLimit');
    case 'groupsRequired': return t('mini.uploadNoGroups');
    case 'telegramLinkRequired':
      return t('mini.uploadNoChat', { bot: bootstrap?.bot.username || 'bot' });
    case 'telegramUploadFailed': return t('mini.uploadTelegramFailed');
    case 'uploadBusy':
    case 'tooManyRequests': return t('mini.uploadBusy');
    case 'networkError': return t('mini.errorNetwork');
    case 'invalidInput': return t('mini.uploadInvalid');
    case 'policyRequired': return t('mini.errorPolicy');
    case 'sessionExpired': return t('mini.errorExpired');
    default: return t('mini.errorGeneric');
  }
}

/**
 * One file → one real library row. The chosen `File` is kept on failure, so «retry» does not
 * make the teacher pick it again; the button is guarded by a ref as well as state, because a
 * double tap can fire two click handlers before React re-renders.
 */
export function MiniUploader({
  wa, bootstrap, groups, draftId, onUploaded,
}: {
  wa: TelegramWebApp | null;
  bootstrap: MiniBootstrap;
  groups: { id: string; title: string }[];
  draftId?: string;
  onUploaded: (result: MiniUploadResponse) => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sendingRef = useRef(false);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'book' | 'workbook' | 'other'>('other');
  const [selected, setSelected] = useState<string[]>(groups.map((g) => g.id));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [failedOnce, setFailedOnce] = useState(false);
  const groupKey = groups.map((g) => g.id).join(',');

  useEffect(() => {
    setSelected((prev) => {
      const valid = prev.filter((id) => groupsRef.current.some((g) => g.id === id));
      return valid.length ? valid : groupsRef.current.map((g) => g.id);
    });
  }, [groupKey]);

  const pickFile = (f: File | null) => {
    setFile(f);
    setError('');
    setDone('');
    setFailedOnce(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const toggleGroup = (id: string) => {
    haptic(wa, 'tap');
    setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const start = async () => {
    if (!file || sendingRef.current) return;
    if (!selected.length) { setError(t('mini.uploadNoGroups')); return; }
    sendingRef.current = true;
    setBusy(true); setError(''); setDone(''); setProgress(0);
    const outcome = await uploadMiniFile({
      file,
      title: title.trim(),
      kind,
      groupIds: selected,
      draftId,
      onProgress: (n) => setProgress(n),
    });
    sendingRef.current = false;
    setBusy(false); setProgress(null);
    if (!outcome.ok || !outcome.data) {
      setFailedOnce(true);
      setError(uploadErrorText(outcome.error, t, bootstrap));
      haptic(wa, 'error');
      return;
    }
    const result = outcome.data;
    setFile(null);
    setTitle('');
    if (inputRef.current) inputRef.current.value = '';
    setDone([
      t('mini.uploadDone', { title: result.material.title }),
      result.draftAttached ? t('mini.uploadAttached') : '',
      result.replaced ? t('mini.uploadReplaced') : '',
    ].filter(Boolean).join(' '));
    haptic(wa, 'success');
    onUploaded(result);
  };

  const canUpload = Boolean(file) && selected.length > 0 && !busy;

  return (
    <section className="card mini-upload" data-testid="mini-upload">
      <h2>{t('mini.uploadTitle')}</h2>
      <p className="muted">{t('mini.uploadIntro')}</p>
      {draftId && <p className="muted">{t('mini.uploadWizardHint')}</p>}
      {groups.length === 0 && <p className="error" role="status">{t('mini.uploadNoGroups')}</p>}

      <label htmlFor="mini-upload-file">{t('mini.uploadPick')}</label>
      <input ref={inputRef} id="mini-upload-file" data-testid="mini-upload-file" type="file"
        accept={UPLOAD_ACCEPT} disabled={busy}
        onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
      <p className="muted" data-testid="mini-upload-file-name">
        {file ? t('mini.uploadFileChosen', { name: file.name, size: fmtBytes(file.size) }) : t('mini.uploadNoFile')}
      </p>

      <label htmlFor="mini-upload-title">{t('mini.uploadName')}</label>
      <input id="mini-upload-title" data-testid="mini-upload-title" value={title}
        maxLength={120} placeholder={t('mini.uploadNamePlaceholder')} disabled={busy}
        onChange={(e) => setTitle(e.target.value)} />

      <label htmlFor="mini-upload-kind">{t('mini.uploadKind')}</label>
      <select id="mini-upload-kind" data-testid="mini-upload-kind" value={kind} disabled={busy}
        onChange={(e) => setKind(e.target.value === 'book' || e.target.value === 'workbook' ? e.target.value : 'other')}>
        <option value="book">{t('mini.materialKind.book')}</option>
        <option value="workbook">{t('mini.materialKind.workbook')}</option>
        <option value="other">{t('mini.materialKind.other')}</option>
      </select>

      {groups.length > 0 && (
        <fieldset className="mini-upload-groups">
          <legend>{t('mini.uploadGroups')}</legend>
          {groups.map((g) => (
            <label className="mini-check" key={g.id} htmlFor={`mini-upload-g-${g.id}`}>
              <input id={`mini-upload-g-${g.id}`} type="checkbox" checked={selected.includes(g.id)}
                disabled={busy} data-testid={`mini-upload-group-${g.id}`}
                onChange={() => toggleGroup(g.id)} />
              <span>{g.title}</span>
            </label>
          ))}
        </fieldset>
      )}

      {busy && progress !== null && (
        <p className="muted" role="status" data-testid="mini-upload-progress">
          {t('mini.uploadProgress', { n: progress })}
        </p>
      )}
      {error && <p className="error" role="alert" data-testid="mini-upload-error">{error}</p>}
      {done && <p className="mini-notice" role="status" data-testid="mini-upload-done">{done}</p>}

      <button type="button" data-testid="mini-upload-start" disabled={!canUpload} onClick={() => void start()}>
        {busy
          ? t('mini.uploadInProgress')
          : failedOnce && file
            ? t('mini.uploadRetry')
            : t('mini.uploadStart')}
      </button>
    </section>
  );
}

// ─── group connection ───────────────────────────────────────────────────────

export function healthLabel(health: MiniGroupHealth, t: Translate): string {
  if (health === 'ok') return t('mini.connectHealthOk');
  if (health === 'needsRights') return t('mini.connectHealthNeedsRights');
  if (health === 'botMissing') return t('mini.connectHealthBotMissing');
  return t('mini.connectHealthUnknown');
}

export function GroupHealthBadge({ health }: { health?: MiniGroupHealth }) {
  const { t } = useTranslation();
  if (!health) return null;
  const cls = health === 'ok'
    ? 'mini-badge--sent'
    : health === 'needsRights'
      ? 'mini-badge--uncertain'
      : health === 'botMissing'
        ? 'mini-badge--failed'
        : '';
  return (
    <span className={`mini-badge ${cls}`} data-testid="mini-group-health" data-health={health}>
      {healthLabel(health, t)}
    </span>
  );
}

/**
 * A one-time code and a watcher. The Mini App cannot add a bot to a group — Telegram offers no
 * such method — so the copy says exactly that, and the group appears only after the server
 * reads the real `/bind` update.
 */
export function MiniConnectCard({ wa, botUsername, onConnected }: {
  wa: TelegramWebApp | null;
  botUsername: string | null;
  onConnected: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [start, setStart] = useState<MiniConnectStart | null>(null);
  const [state, setState] = useState<MiniConnectState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [copied, setCopied] = useState(false);
  // The parent re-renders on every bootstrap refresh; keeping the callback in a ref stops the
  // 2 s poll from restarting (and re-arming its first tick) each time.
  const connectedRef = useRef(onConnected);
  connectedRef.current = onConnected;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // Poll only while the server says «pending». A network error keeps waiting (the code may
  // still be spent); it never turns into «connected».
  useEffect(() => {
    if (!start || state?.status !== 'pending') return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      const r = await miniApi<MiniConnectState>(`/api/mini/groups/connect/${start.id}`);
      if (cancelled) return;
      if (!r.ok || !r.data) {
        setPollError(r.error || 'serverError');
        timer = window.setTimeout(() => void tick(), 4_000);
        return;
      }
      setPollError('');
      if (r.data.status === 'pending') {
        timer = window.setTimeout(() => void tick(), 2_000);
        return;
      }
      setState(r.data);
      if (r.data.status === 'connected') {
        haptic(wa, 'success');
        connectedRef.current();
      }
    };
    timer = window.setTimeout(() => void tick(), 1_500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [start, state?.status, wa]);

  const begin = async () => {
    if (busy) return;
    setBusy(true); setError('');
    const r = await miniApi<{ connect: MiniConnectStart }>('/api/mini/groups/connect', { method: 'POST' });
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.error === 'groupsLimit' ? 'groupsLimit' : r.error || 'serverError');
      return;
    }
    setStart(r.data.connect);
    setState({ status: 'pending', id: r.data.connect.id, expiresAt: r.data.connect.expiresAt });
    setPollError('');
    setCopied(false);
    haptic(wa, 'tap');
  };

  const copy = async () => {
    if (!start) return;
    try {
      await navigator.clipboard.writeText(start.code);
      setCopied(true);
      haptic(wa, 'tap');
    } catch {
      setError('copyFailed');
    }
  };

  const showStart = !start || state?.status === 'expired' || state?.status === 'connected';
  const message = error === 'copyFailed'
    ? t('mini.connectCopyFailed')
    : error
      ? errorText(error, t)
      : '';

  return (
    <section className="card mini-connect" data-testid="mini-connect">
      <h2>{t('mini.connectTitle')}</h2>
      <p className="muted">{t('mini.connectIntro')}</p>
      {!botUsername && <p className="error" role="status" data-testid="mini-connect-no-bot">{t('mini.connectNoBot')}</p>}

      {showStart && (
        <button type="button" data-testid="mini-connect-start"
          disabled={busy || !botUsername} onClick={() => void begin()}>
          {busy ? t('mini.connectStarting') : start ? t('mini.connectNew') : t('mini.connectStart')}
        </button>
      )}
      {message && <p className="error" role="alert">{message}</p>}

      {start && (
        <div className="mini-connect-box" data-testid="mini-connect-code">
          <span className="muted">{t('mini.connectCodeLabel')}</span>
          <code className="mini-code" data-testid="mini-connect-code-value">{start.code}</code>
          <div className="mini-connect-actions">
            <button type="button" className="secondary" data-testid="mini-connect-copy"
              onClick={() => void copy()}>
              {copied ? t('mini.connectCopied') : t('mini.connectCopy')}
            </button>
            {start.botLink && (
              <a className="mini-link-button" href={start.botLink} target="_blank" rel="noreferrer"
                data-testid="mini-connect-open-bot">{t('mini.connectOpenBot', { bot: botUsername })}</a>
            )}
          </div>
          <p className="mini-connect-steps" data-testid="mini-connect-steps">
            {t('mini.connectSteps', { bot: botUsername, code: start.code })}
          </p>
          <p className="muted">{t('mini.connectCodeHint')}</p>

          {state?.status === 'pending' && (
            <>
              <p className="muted">{t('mini.connectExpires', { when: fmtWhen(state.expiresAt, i18n.language) })}</p>
              <p role="status" data-testid="mini-connect-waiting">{t('mini.connectWaiting')}</p>
              {pollError && <p className="muted" role="status">{t('mini.connectPollError')}</p>}
            </>
          )}
          {state?.status === 'expired' && (
            <p className="error" role="alert" data-testid="mini-connect-expired">{t('mini.connectExpired')}</p>
          )}
          {state?.status === 'connected' && (
            <div role="status" data-testid="mini-connect-done">
              <p><strong>{t('mini.connectDone', { title: state.group.title })}</strong></p>
              <p className={`mini-health mini-health--${state.health}`}>
                {healthLabel(state.health, t)}
              </p>
              {state.health === 'ok' && <p className="muted">{t('mini.connectDoneHealth')}</p>}
              {state.health === 'needsRights' && <p className="muted">{t('mini.connectNeedAdmin')}</p>}
              {state.health === 'botMissing' && <p className="muted">{t('mini.connectBotMissing')}</p>}
              {state.health === 'unknown' && <p className="muted">{t('mini.connectUnknown')}</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
