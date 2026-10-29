/**
 * Task F (2026-10-28): the Telegram Mini App for homework.
 *
 * The page is a standalone early render (like /guest): no account gate, no cookie session, no
 * app chrome. It authenticates ONLY by exchanging Telegram's signed `initData` for a limited
 * token, then works through the same `/api/mini` endpoints the bot's homework engine serves.
 *
 * The wizard is deliberately five screens (groups → task → library → preview → confirmation),
 * because the brief's central safety rule is that the teacher sees and confirms the exact text
 * and the exact groups before anything is sent. Publication is a separate, explicit tap; a
 * failed or unknown outcome is never retried automatically.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { applyLocale } from '../i18n';
import { DateTimeField } from '../components/DateTimeField';
import { getThemeChoice } from '../lib/theme';
import {
  applyMiniTheme, haptic, loadTelegramWebApp, miniApi, readMiniToken, resetMiniSdk,
  writeMiniToken,
  type MiniAuthResponse, type MiniBootstrap, type MiniDraft, type MiniDraftSummary,
  type MiniFormatResponse, type MiniGroup, type MiniGroupHealth, type MiniHistory as MiniHistoryDto,
  type MiniMaterialHit, type MiniMaterialSnapshot,
  type MiniPublication, type MiniPublishResponse, type MiniUploadResponse, type TelegramWebApp,
} from '../lib/miniApp';
import {
  GroupHealthBadge, MiniConnectCard, MiniFrame, MiniLegalGate, MiniSettings, MiniUploader,
  errorText,
} from './mini/controls';

type Phase = 'loading' | 'ready' | 'outside' | 'sdkFailed' | 'unlinked'
  | 'teacherOnly' | 'password' | 'error';

type Boot =
  | { kind: 'ready'; wa: TelegramWebApp | null; bootstrap: MiniBootstrap }
  | { kind: 'outside' }
  | { kind: 'sdkFailed' }
  | { kind: 'unlinked' }
  | { kind: 'teacherOnly' }
  | { kind: 'password' }
  | { kind: 'error'; code: string };

type Step = 1 | 2 | 3 | 4 | 5;

/**
 * Task F.1 (2026-10-29): the home screen now has real sections instead of one long scroll —
 * every section reads the same server data the wizard uses, and every one has a way back.
 */
type Section = 'groups' | 'materials' | 'history';
type View =
  | { kind: 'home' }
  | { kind: Section }
  | { kind: 'wizard'; draft: MiniDraft; step?: Step }
  | { kind: 'result'; draft: MiniDraft; resultKind?: MiniPublishResponse['kind'] };

/**
 * Boot is cached at module scope: React StrictMode runs the mount effect twice in development,
 * and a second `/api/mini/auth` exchange would mint a second token and write a second audit line
 * for one launch. A retry resets this cache explicitly.
 */
let bootPromise: Promise<Boot> | null = null;

function bootMiniApp(): Promise<Boot> {
  bootPromise ??= (async (): Promise<Boot> => {
    const sdk = await loadTelegramWebApp();
    if (sdk.failed && !sdk.wa) return { kind: 'sdkFailed' };
    const wa = sdk.wa;
    if (!wa || !wa.initData) return { kind: 'outside' };
    try {
      wa.ready();
      wa.expand();
      wa.disableVerticalSwipes?.();
    } catch { /* older clients: the page still works */ }
    // Task G: «System» follows Telegram's themeParams; an explicit Light/Dark wins over it.
    applyMiniTheme(wa);

    // A token from this tab is tried first: an ordinary reload inside Telegram must not mint a
    // new session, and an unlinked account must lose it immediately (the server re-checks).
    if (readMiniToken()) {
      const kept = await miniApi<MiniBootstrap>('/api/mini/bootstrap');
      if (kept.ok && kept.data) return { kind: 'ready', wa, bootstrap: kept.data };
      if (kept.error !== 'sessionExpired' && kept.error !== 'miniNotLinked'
        && kept.error !== 'miniTeacherOnly' && kept.error !== 'passwordChangeRequired') {
        return { kind: 'error', code: kept.error };
      }
      writeMiniToken(null);
    }

    const auth = await miniApi<MiniAuthResponse>('/api/mini/auth', {
      method: 'POST', body: { initData: wa.initData }, auth: false,
    });
    if (!auth.ok || !auth.data) {
      if (auth.error === 'miniNotLinked') return { kind: 'unlinked' };
      if (auth.error === 'miniTeacherOnly') return { kind: 'teacherOnly' };
      if (auth.error === 'passwordChangeRequired') return { kind: 'password' };
      return { kind: 'error', code: auth.error };
    }
    writeMiniToken(auth.data.token);
    const boot = await miniApi<MiniBootstrap>('/api/mini/bootstrap');
    if (!boot.ok || !boot.data) {
      writeMiniToken(null);
      return { kind: 'error', code: boot.error };
    }
    return { kind: 'ready', wa, bootstrap: boot.data };
  })().catch((): Boot => ({ kind: 'error', code: 'networkError' }));
  return bootPromise;
}

function retryBoot(): void {
  bootPromise = null;
  resetMiniSdk();
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(iso: string | null | undefined, lang: string, tz?: string): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(lang, {
      dateStyle: 'short', timeStyle: 'short', ...(tz ? { timeZone: tz } : {}),
    }).format(new Date(iso));
  } catch { return iso; }
}

function useTelegramBack(wa: TelegramWebApp | null, handler: () => void, visible = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const bb = wa?.BackButton;
    if (!bb) return;
    const cb = () => ref.current();
    try {
      bb.onClick(cb);
      if (visible) bb.show(); else bb.hide();
    } catch { /* an older Telegram client may not expose BackButton */ }
    return () => {
      try { bb.offClick(cb); bb.hide(); } catch { /* ignore */ }
    };
  }, [wa, visible]);
}

function useTelegramMain(
  wa: TelegramWebApp | null,
  button: { text: string; enabled: boolean; onClick: () => void; progress?: boolean } | null,
): void {
  const ref = useRef<() => void>(() => {});
  ref.current = button?.onClick ?? (() => {});
  const text = button?.text ?? '';
  const enabled = button?.enabled ?? false;
  const progress = button?.progress ?? false;
  const visible = button !== null;
  useEffect(() => {
    const mb = wa?.MainButton;
    if (!mb) return;
    if (!visible) { try { mb.hide(); } catch { /* ignore */ } return; }
    const cb = () => ref.current();
    try {
      mb.setText(text);
      mb.onClick(cb);
      if (enabled) mb.enable(); else mb.disable();
      if (progress) mb.showProgress?.(true); else mb.hideProgress?.();
      mb.show();
    } catch { /* ignore */ }
    return () => {
      try { mb.offClick(cb); mb.hide(); } catch { /* ignore */ }
    };
  }, [wa, visible, text, enabled, progress]);
}

// ─── root ────────────────────────────────────────────────────────────────────

export default function Mini() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('loading');
  const [bootstrap, setBootstrap] = useState<MiniBootstrap | null>(null);
  const [wa, setWa] = useState<TelegramWebApp | null>(null);
  const [errorCode, setErrorCode] = useState('');
  const [view, setView] = useState<View>({ kind: 'home' });
  const [homeBusy, setHomeBusy] = useState(false);
  const [homeError, setHomeError] = useState('');

  const run = useCallback(async () => {
    setPhase('loading');
    setErrorCode('');
    setHomeError('');
    const boot = await bootMiniApp();
    if (boot.kind === 'ready') {
      await applyLocale(boot.bootstrap.teacher.locale).catch(() => undefined);
      setBootstrap(boot.bootstrap);
      setWa(boot.wa);
      setView({ kind: 'home' });
      setPhase('ready');
      return;
    }
    if (boot.kind === 'error') setErrorCode(boot.code);
    setPhase(boot.kind);
  }, []);

  useEffect(() => { void run(); }, [run]);

  /*
   * Task G: inside Telegram «System» means the Telegram app theme, and Telegram announces a
   * change with `themeChanged`. An explicit Light/Dark choice must not be overridden by it.
   */
  useEffect(() => {
    if (!wa) return;
    const onTheme = () => {
      if (getThemeChoice() === 'system') applyMiniTheme(wa);
    };
    try { wa.onEvent?.('themeChanged', onTheme); } catch { /* older client */ }
    return () => { try { wa.offEvent?.('themeChanged', onTheme); } catch { /* ignore */ } };
  }, [wa]);

  const retry = useCallback(() => {
    retryBoot();
    void run();
  }, [run]);

  const refreshBootstrap = useCallback(async () => {
    const r = await miniApi<MiniBootstrap>('/api/mini/bootstrap');
    if (r.ok && r.data) { setBootstrap(r.data); setHomeError(''); return; }
    // The documents changed under this session: only a fresh bootstrap carries the gate's
    // current versions, and every functional request will keep answering 403 until accepted.
    if (r.error === 'policyRequired') { retry(); return; }
    if (r.error === 'sessionExpired' || r.error === 'miniNotLinked') { retry(); return; }
    setHomeError(r.error || 'serverError');
  }, [retry]);

  const startNew = useCallback(async () => {
    setHomeBusy(true);
    setHomeError('');
    const r = await miniApi<{ draft: MiniDraft }>('/api/mini/drafts', { method: 'POST' });
    setHomeBusy(false);
    if (!r.ok || !r.data) { setHomeError(r.error || 'serverError'); return; }
    setView({ kind: 'wizard', draft: r.data.draft, step: 1 });
  }, []);

  const openDraft = useCallback(async (id: string) => {
    setHomeBusy(true);
    setHomeError('');
    const r = await miniApi<{ draft: MiniDraft }>(`/api/mini/drafts/${id}`);
    setHomeBusy(false);
    if (!r.ok || !r.data) {
      if (r.error === 'sessionExpired') retry();
      else setHomeError(r.error || 'serverError');
      return;
    }
    const draft = r.data.draft;
    const closed = draft.status === 'published' || draft.status === 'failed'
      || draft.status === 'publish_unknown' || draft.status === 'cancelled'
      || draft.status === 'publishing';
    if (closed) { setView({ kind: 'result', draft }); return; }
    const step: Step = draft.status === 'preview' ? 4 : draft.groups.length ? 2 : 1;
    setView({ kind: 'wizard', draft, step });
  }, [retry]);

  const goHome = useCallback(() => {
    setView({ kind: 'home' });
    void refreshBootstrap();
  }, [refreshBootstrap]);

  if (phase === 'loading') return <MiniFrame testid="mini-loading"><p className="muted">{t('mini.loading')}</p></MiniFrame>;

  if (phase === 'outside') {
    return (
      <MiniFrame testid="mini-outside">
        <h1>{t('mini.outsideTitle')}</h1>
        <p>{t('mini.outsideText')}</p>
        <p className="muted">{t('mini.outsideHint')}</p>
      </MiniFrame>
    );
  }

  if (phase === 'sdkFailed') {
    return (
      <MiniFrame testid="mini-sdk-failed">
        <h1>{t('mini.sdkTitle')}</h1>
        <p>{t('mini.sdkText')}</p>
        <button type="button" onClick={retry}>{t('mini.retry')}</button>
      </MiniFrame>
    );
  }

  if (phase === 'unlinked') {
    return (
      <MiniFrame testid="mini-unlinked">
        <h1>{t('mini.unlinkedTitle')}</h1>
        <p>{t('mini.unlinkedText')}</p>
        <p className="muted">{t('mini.unlinkedSteps')}</p>
        <button type="button" className="secondary" onClick={retry}>{t('mini.retry')}</button>
      </MiniFrame>
    );
  }

  if (phase === 'teacherOnly') {
    return (
      <MiniFrame testid="mini-teacher-only">
        <h1>{t('mini.teacherOnlyTitle')}</h1>
        <p>{t('mini.teacherOnlyText')}</p>
      </MiniFrame>
    );
  }

  if (phase === 'password') {
    return (
      <MiniFrame testid="mini-password">
        <h1>{t('mini.passwordTitle')}</h1>
        <p>{t('mini.passwordText')}</p>
      </MiniFrame>
    );
  }

  if (phase === 'error' || !bootstrap) {
    return (
      <MiniFrame testid="mini-error">
        <h1>{t('mini.errorTitle')}</h1>
        <p className="error">{bootErrorText(errorCode, t)}</p>
        <button type="button" onClick={retry}>{t('mini.retry')}</button>
      </MiniFrame>
    );
  }

  /*
   * Task 5: the gate is decided by the server's `legal`, not by a local flag. Until it says
   * «accepted», no functional view is rendered at all — and the server refuses the same
   * requests with 403 `policyRequired`, so a direct link cannot jump ahead.
   */
  if (bootstrap.legal?.accepted === false) {
    return <MiniLegalGate wa={wa} bootstrap={bootstrap} onRefresh={() => void refreshBootstrap()} />;
  }

  if (view.kind === 'groups') {
    return (
      <MiniGroups wa={wa} bootstrap={bootstrap} onHome={goHome}
        onNew={() => void startNew()} busy={homeBusy} actionError={homeError}
        onGroupsChanged={() => void refreshBootstrap()} />
    );
  }

  if (view.kind === 'materials') {
    return (
      <MiniMaterials wa={wa} bootstrap={bootstrap} onHome={goHome}
        onNew={() => void startNew()} busy={homeBusy} actionError={homeError}
        onLibraryChanged={() => void refreshBootstrap()} />
    );
  }

  if (view.kind === 'history') {
    return <MiniHistory wa={wa} bootstrap={bootstrap} onHome={goHome} />;
  }

  if (view.kind === 'wizard') {
    return (
      <MiniWizard
        key={view.draft.id}
        wa={wa}
        bootstrap={bootstrap}
        initial={view.draft}
        initialStep={view.step}
        onExit={() => { setView({ kind: 'home' }); void refreshBootstrap(); }}
        onLibraryChanged={() => void refreshBootstrap()}
        onPublished={(draft, resultKind) => {
          setView({ kind: 'result', draft, resultKind });
          void refreshBootstrap();
        }}
      />
    );
  }

  if (view.kind === 'result') {
    return (
      <MiniResult
        key={view.draft.id}
        wa={wa}
        draft={view.draft}
        initialKind={view.resultKind}
        onHome={() => { setView({ kind: 'home' }); void refreshBootstrap(); }}
        onChanged={(draft) => setView({ kind: 'result', draft, resultKind: view.resultKind })}
      />
    );
  }

  return (
    <MiniHome
      wa={wa}
      bootstrap={bootstrap}
      busy={homeBusy}
      error={homeError}
      onNew={() => void startNew()}
      onOpen={(id) => void openDraft(id)}
      onRefresh={() => void refreshBootstrap()}
      onSection={(kind) => { setHomeError(''); setView({ kind }); }}
    />
  );
}

function bootErrorText(code: string, t: (key: string) => string): string {
  if (code === 'networkError') return t('mini.errorNetwork');
  if (code === 'miniUnavailable') return t('mini.errorUnavailable');
  if (code === 'invalidInitData') return t('mini.errorInvalidLaunch');
  if (code === 'sessionExpired' || code === 'miniNotLinked') return t('mini.errorExpired');
  if (code === 'tooManyRequests') return t('mini.errorRate');
  return t('mini.errorGeneric');
}

// ─── home ───────────────────────────────────────────────────────────────────

function MiniHome({
  wa, bootstrap, busy, error, onNew, onOpen, onRefresh, onSection,
}: {
  wa: TelegramWebApp | null;
  bootstrap: MiniBootstrap;
  busy: boolean;
  error: string;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRefresh: () => void;
  onSection: (kind: Section) => void;
}) {
  const { t } = useTranslation();
  const active = bootstrap.groups.filter((g) => g.status === 'active');
  const drafts = bootstrap.drafts.filter((d) => d.status !== 'cancelled');
  return (
    <MiniFrame testid="mini-home">
      <header className="mini-head">
        <div>
          <h1>{t('mini.homeTitle')}</h1>
          <p className="muted">{t('mini.greeting', { name: bootstrap.teacher.name })}</p>
        </div>
        <button type="button" className="ghost mini-refresh" onClick={onRefresh} aria-label={t('mini.refresh')}>
          ↻
        </button>
      </header>

      {error && <p className="error" role="alert">{errorText(error, t, bootstrap)}</p>}

      {/* The first screen answers «where do I start?» without scrolling: one primary action,
          the exact order of the wizard, and three doors to the data each step reads. */}
      <section className="card mini-cta-card">
        <button type="button" className="mini-cta" data-testid="mini-new" onClick={onNew} disabled={busy}>
          {t('mini.newHomework')}
        </button>
        <p className="muted">{t('mini.flowHint')}</p>
        <p className="muted">
          {t('mini.groupsCount', { n: active.length })} · {t('mini.materialsTotal', { n: bootstrap.materialsCount })}
        </p>
      </section>

      <nav className="mini-tiles" aria-label={t('mini.sections')}>
        <button type="button" className="mini-tile" data-testid="mini-nav-groups"
          onClick={() => onSection('groups')}>
          <span className="mini-tile-title">{t('mini.navGroups')}</span>
          <span className="mini-tile-count">{t('mini.groupsCount', { n: active.length })}</span>
        </button>
        <button type="button" className="mini-tile" data-testid="mini-nav-materials"
          onClick={() => onSection('materials')}>
          <span className="mini-tile-title">{t('mini.navMaterials')}</span>
          <span className="mini-tile-count">{t('mini.materialsTotal', { n: bootstrap.materialsCount })}</span>
        </button>
        <button type="button" className="mini-tile" data-testid="mini-nav-history"
          onClick={() => onSection('history')}>
          <span className="mini-tile-title">{t('mini.navHistory')}</span>
          <span className="mini-tile-count">{t('mini.sendsCount', { n: bootstrap.publications.length })}</span>
        </button>
      </nav>

      {active.length === 0 && (
        <p className="card mini-note" role="status">{t('mini.noGroups')}</p>
      )}

      <MiniSettings wa={wa} onLocaleChanged={onRefresh} />

      {drafts.length > 0 && (
        <section aria-labelledby="mini-drafts-title">
          <h2 id="mini-drafts-title">{t('mini.draftsTitle')}</h2>
          <div className="mini-list">
            {drafts.map((d) => <DraftRow key={d.id} draft={d} busy={busy} onOpen={onOpen} />)}
          </div>
        </section>
      )}
      {drafts.length === 0 && <p className="muted">{t('mini.noDrafts')}</p>}

      <footer className="mini-foot muted">
        {bootstrap.bot.username ? `@${bootstrap.bot.username}` : 'Telegram'} · {t('mini.footer')}
      </footer>
    </MiniFrame>
  );
}

// ─── sections (Task F.1) ────────────────────────────────────────────────────

/**
 * Groups: the real list, the bot's REAL rights in each one, and the connect flow. A group is
 * never painted as «connected» from a client guess — health comes from Bot API only.
 */
function MiniGroups({ wa, bootstrap, onHome, onNew, busy, actionError, onGroupsChanged }: {
  wa: TelegramWebApp | null;
  bootstrap: MiniBootstrap;
  onHome: () => void;
  onNew: () => void;
  busy: boolean;
  actionError: string;
  onGroupsChanged: () => void;
}) {
  const { t } = useTranslation();
  useTelegramBack(wa, onHome);
  const active = bootstrap.groups.filter((g) => g.status === 'active');
  const [health, setHealth] = useState<Record<string, MiniGroupHealth>>({});
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthError, setHealthError] = useState('');

  const loadHealth = useCallback(async () => {
    setHealthBusy(true); setHealthError('');
    const r = await miniApi<{ groups: { id: string; health: MiniGroupHealth }[] }>('/api/mini/groups/health');
    setHealthBusy(false);
    if (!r.ok || !r.data) { setHealthError(r.error || 'serverError'); return; }
    const map: Record<string, MiniGroupHealth> = {};
    for (const g of r.data.groups) map[g.id] = g.health;
    setHealth(map);
  }, []);
  useEffect(() => { void loadHealth(); }, [loadHealth]);

  const onConnected = useCallback(() => {
    void loadHealth();
    onGroupsChanged();
  }, [loadHealth, onGroupsChanged]);

  return (
    <MiniFrame testid="mini-groups">
      <header className="mini-head">
        <div>
          <h1>{t('mini.groupsTitle')}</h1>
          <p className="muted">{t('mini.groupsScreenHint')}</p>
        </div>
      </header>

      {/* «New homework» creates a draft; a failure must be said here, not swallowed */}
      {actionError && <p className="error" role="alert">{errorText(actionError, t, bootstrap)}</p>}

      {bootstrap.groups.length === 0
        ? <p className="card mini-note" role="status">{t('mini.groupsEmptyScreen')}</p>
        : (
          <ul className="mini-list">
            {bootstrap.groups.map((g) => (
              <li key={g.id} className="mini-row mini-row--static" data-testid={`mini-group-row-${g.id}`}>
                <span className="mini-row-main">
                  <strong>{g.title}</strong>
                  <small className="muted">
                    {g.kind === 'online' ? t('mini.groupOnline') : t('mini.groupOffline')}
                    {' · '}{t('mini.groupMaterials', { n: g.materialCount })}
                    {g.chatShort ? ` · ${g.chatShort}` : ''}
                  </small>
                  {g.status === 'active' && <GroupHealthBadge health={health[g.id]} />}
                </span>
                <span className={`mini-badge ${g.status === 'active' ? 'mini-badge--sent' : 'mini-badge--failed'}`}>
                  {g.status === 'active' ? t('mini.groupStatusActive') : t('mini.groupStatusRemoved')}
                </span>
              </li>
            ))}
          </ul>
        )}

      <section className="mini-health-section" aria-labelledby="mini-health-title">
        <div className="mini-head-inline">
          <h2 id="mini-health-title">{t('mini.connectHealthTitle')}</h2>
          <button type="button" className="ghost" data-testid="mini-groups-refresh"
            disabled={healthBusy} onClick={() => void loadHealth()}>
            {healthBusy ? t('mini.connectRefreshing') : t('mini.connectRefresh')}
          </button>
        </div>
        <p className="muted">{t('mini.connectHealthHint')}</p>
        {healthError && <p className="error" role="alert">{errorText(healthError, t, bootstrap)}</p>}
      </section>

      <p className="muted">{t('mini.groupsHowTo')}</p>

      <MiniConnectCard wa={wa} botUsername={bootstrap.bot.username} onConnected={onConnected} />

      <nav className="mini-nav">
        <button type="button" className="secondary" data-testid="mini-groups-home" onClick={onHome}>
          {t('mini.backHome')}
        </button>
        <button type="button" data-testid="mini-groups-new" onClick={onNew} disabled={busy || active.length === 0}>
          {t('mini.newHomework')}
        </button>
      </nav>
    </MiniFrame>
  );
}

/**
 * The real library, searchable, with the Task G upload panel. Uploading here creates a library
 * row for the chosen groups; attaching it to homework happens in the wizard (or immediately,
 * when the flow is entered from step 3).
 */
function MiniMaterials({ wa, bootstrap, onHome, onNew, busy, actionError, onLibraryChanged }: {
  wa: TelegramWebApp | null;
  bootstrap: MiniBootstrap;
  onHome: () => void;
  onNew: () => void;
  busy: boolean;
  actionError: string;
  onLibraryChanged: () => void;
}) {
  const { t } = useTranslation();
  useTelegramBack(wa, onHome);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MiniMaterialHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const activeGroups = bootstrap.groups
    .filter((g) => g.status === 'active')
    .map((g) => ({ id: g.id, title: g.title }));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const timer = window.setTimeout(async () => {
      const q = query.trim();
      const r = await miniApi<{ materials: MiniMaterialHit[] }>(
        `/api/mini/materials${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      );
      if (cancelled) return;
      setLoading(false);
      if (!r.ok || !r.data) { setItems([]); setError(r.error || 'serverError'); return; }
      setItems(r.data.materials);
    }, query ? 250 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, reload]);

  const onUploaded = (_result: MiniUploadResponse) => {
    setReload((n) => n + 1);
    onLibraryChanged();
  };

  return (
    <MiniFrame testid="mini-materials">
      <header className="mini-head">
        <div>
          <h1>{t('mini.materialsTitle')}</h1>
          <p className="muted">{t('mini.materialsScreenHint', { n: bootstrap.limits.materials })}</p>
        </div>
      </header>

      {/* the draft action's failure is a different error from the library request's own */}
      {actionError && <p className="error" role="alert">{errorText(actionError, t, bootstrap)}</p>}

      <MiniUploader wa={wa} bootstrap={bootstrap} groups={activeGroups} onUploaded={onUploaded} />

      <label htmlFor="mini-library-search">{t('mini.searchMaterials')}</label>
      <input id="mini-library-search" data-testid="mini-library-search" type="search"
        value={query} onChange={(e) => setQuery(e.target.value)} />

      {error && <p className="error" role="alert">{errorText(error, t, bootstrap)}</p>}
      {loading && <p className="muted" role="status">{t('mini.materialsLoading')}</p>}
      {!loading && !error && items.length === 0 && (
        <p className="muted">
          {query.trim() ? t('mini.noMaterials') : t('mini.materialsEmptyLibrary')}
        </p>
      )}

      <ul className="mini-list">
        {items.map((m) => (
          <li key={m.id} className="mini-row mini-row--static" data-testid={`mini-library-${m.id}`}>
            <span className="mini-row-main">
              <strong>{m.title}</strong>
              <small className="muted">
                {t(`mini.materialKind.${m.kind}`)}{m.fileName ? ` · ${m.fileName}` : ''}
              </small>
            </span>
          </li>
        ))}
      </ul>

      <p className="muted">{t('mini.materialsCreateHint')}</p>

      <nav className="mini-nav">
        <button type="button" className="secondary" data-testid="mini-materials-home" onClick={onHome}>
          {t('mini.backHome')}
        </button>
        <button type="button" data-testid="mini-materials-new" onClick={onNew} disabled={busy}>
          {t('mini.newHomework')}
        </button>
      </nav>
    </MiniFrame>
  );
}

/** Sends across all groups — 40 rows from the server, not the 12 the home bootstrap carries. */
function MiniHistory({ wa, bootstrap, onHome }: {
  wa: TelegramWebApp | null;
  bootstrap: MiniBootstrap;
  onHome: () => void;
}) {
  const { t, i18n } = useTranslation();
  useTelegramBack(wa, onHome);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState<MiniHistoryDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await miniApi<MiniHistoryDto>('/api/mini/history');
      if (cancelled) return;
      setLoading(false);
      if (!r.ok || !r.data) { setError(r.error || 'serverError'); return; }
      setData(r.data);
    })();
    return () => { cancelled = true; };
  }, []);

  const publications = data?.publications ?? [];
  return (
    <MiniFrame testid="mini-history">
      <header className="mini-head">
        <div>
          <h1>{t('mini.historyTitle')}</h1>
          <p className="muted">{t('mini.historyHint')}</p>
        </div>
      </header>

      {error && <p className="error" role="alert">{errorText(error, t, bootstrap)}</p>}
      {loading && <p className="muted" role="status">{t('mini.historyLoading')}</p>}
      {!loading && !error && publications.length === 0 && (
        <p className="muted">{t('mini.noHistory')}</p>
      )}

      <ul className="mini-list mini-history">
        {publications.map((p) => (
          <li key={`${p.id}:${p.groupId}`} className="mini-row mini-row--static" data-testid="mini-history-row">
            <span className="mini-row-main">
              <strong>{p.groupTitle}</strong>
              <small className="muted">{fmtDate(p.updatedAt, i18n.language, bootstrap.teacher.tz)}</small>
            </span>
            <PubBadge status={p.status} />
          </li>
        ))}
      </ul>

      <nav className="mini-nav">
        <button type="button" className="secondary" data-testid="mini-history-home" onClick={onHome}>
          {t('mini.backHome')}
        </button>
      </nav>
    </MiniFrame>
  );
}

function DraftRow({ draft, busy, onOpen }: { draft: MiniDraftSummary; busy: boolean; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  return (
    <button type="button" className="mini-row mini-row--button" data-testid={`mini-draft-${draft.id}`}
      disabled={busy} onClick={() => onOpen(draft.id)}>
      <span className="mini-row-main">
        <strong>{draft.title || t('mini.untitled')}</strong>
        <small className="muted">
          {t(`mini.draftStatus.${draft.status}`)} · {t('mini.groupsCount', { n: draft.groupCount })}
          {' · '}{fmtDate(draft.updatedAt, i18n.language)}
        </small>
      </span>
      <span aria-hidden="true">›</span>
    </button>
  );
}

// ─── wizard ─────────────────────────────────────────────────────────────────

function MiniWizard({
  wa, bootstrap, initial, initialStep, onExit, onLibraryChanged, onPublished,
}: {
  wa: TelegramWebApp | null;
  bootstrap: MiniBootstrap;
  initial: MiniDraft;
  initialStep?: Step;
  onExit: () => void;
  onLibraryChanged: () => void;
  onPublished: (draft: MiniDraft, kind: MiniPublishResponse['kind']) => void;
}) {
  const { t, i18n } = useTranslation();
  const limits = bootstrap.limits;
  const [draft, setDraft] = useState<MiniDraft>(initial);
  const [step, setStep] = useState<Step>(initialStep ?? (initial.groups.length ? 2 : 1));
  const [groupIds, setGroupIds] = useState<string[]>(initial.groups.map((g) => g.id));
  const [title, setTitle] = useState(initial.title);
  const [instruction, setInstruction] = useState(initial.instruction);
  const [dueAt, setDueAt] = useState(toLocalInput(initial.dueAt));
  const [links, setLinks] = useState<{ url: string; label: string }[]>(
    initial.links.map((l) => ({ url: l.url, label: l.label })),
  );
  const [materialIds, setMaterialIds] = useState<string[]>(
    initial.materials.map((m) => m.materialId).filter((id): id is string => Boolean(id)),
  );
  const [text, setText] = useState(initial.formattedText);
  const [warnings, setWarnings] = useState<string[]>(initial.warnings);
  const [questions, setQuestions] = useState<string[]>(initial.questions);
  const [materials, setMaterials] = useState<MiniMaterialHit[]>([]);
  const [materialQuery, setMaterialQuery] = useState('');
  const [materialReason, setMaterialReason] = useState('');
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cancelArmed, setCancelArmed] = useState(false);
  const [materialReload, setMaterialReload] = useState(0);
  // Task G, step 4: an AI run must never overwrite the teacher's text on failure. The text
  // before the call is kept for «restore»; the server's plain fallback is offered separately.
  const [formatBusy, setFormatBusy] = useState<'ai' | 'manual' | null>(null);
  const [aiOff, setAiOff] = useState(!bootstrap.ai.remote);
  const [aiBackup, setAiBackup] = useState<string | null>(null);
  const [aiFallback, setAiFallback] = useState<string | null>(null);
  const hasMainButton = Boolean(wa?.MainButton);

  const activeGroups = bootstrap.groups.filter((g) => g.status === 'active');

  const explain = useCallback((code: string): string => errorText(code, t, bootstrap), [t, bootstrap]);

  const goBack = useCallback(() => {
    setError('');
    setNotice('');
    setStep((s) => {
      if (s === 1) { onExit(); return s; }
      return (s - 1) as Step;
    });
  }, [onExit]);

  useTelegramBack(wa, goBack);
  /*
   * Task G: one primary action, not two. When the Telegram client gives us its MainButton, the
   * page does NOT draw another Next/Publish at the bottom — that duplicate was exactly the
   * defect the brief names. The in-page bar then keeps only Back; without MainButton (old
   * clients) the page shows its own primary button instead.
   */
  useTelegramMain(wa, step === 5
    ? {
        text: busy ? t('mini.publishing') : t('mini.publishCount', { n: groupIds.length }),
        enabled: confirmChecked && !busy,
        progress: busy,
        onClick: () => { void publish(); },
      }
    : {
        text: busy ? t('mini.saving') : t('mini.next'),
        enabled: nextEnabled(step, groupIds, busy, materialReason),
        progress: busy,
        onClick: () => { void goNext(); },
      });

  const toggleGroup = (id: string) => {
    haptic(wa, 'tap');
    setGroupIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const saveGroups = async (): Promise<boolean> => {
    if (!groupIds.length) { setError('groupsRequired'); return false; }
    setBusy(true); setError('');
    const r = await miniApi<{ draft: MiniDraft; droppedMaterials: string[] }>(
      `/api/mini/drafts/${draft.id}/groups`, { method: 'PUT', body: { groupIds } },
    );
    setBusy(false);
    if (!r.ok || !r.data) { setError(r.error || 'serverError'); return false; }
    setDraft(r.data.draft);
    setGroupIds(r.data.draft.groups.map((g) => g.id));
    setMaterialIds(r.data.draft.materials.map((m) => m.materialId).filter((id): id is string => Boolean(id)));
    setNotice(r.data.droppedMaterials.length ? t('mini.noticeMaterialsDropped') : '');
    return true;
  };

  const saveFields = async (): Promise<boolean> => {
    const cleanLinks: { url: string; label: string }[] = [];
    for (const link of links) {
      const url = link.url.trim();
      if (!url) continue;
      if (!/^https?:\/\/\S+$/i.test(url)) { setError('invalidLink'); return false; }
      cleanLinks.push({ url, label: link.label.trim() });
    }
    if (cleanLinks.length > limits.links) { setError('tooManyLinks'); return false; }
    setBusy(true); setError('');
    const r = await miniApi<{ draft: MiniDraft }>(`/api/mini/drafts/${draft.id}`, {
      method: 'PATCH',
      body: {
        title,
        instruction,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        links: cleanLinks,
      },
    });
    setBusy(false);
    if (!r.ok || !r.data) { setError(r.error || 'serverError'); return false; }
    setDraft(r.data.draft);
    setLinks(r.data.draft.links.map((l) => ({ url: l.url, label: l.label })));
    return true;
  };

  const saveMaterials = async (): Promise<boolean> => {
    setBusy(true); setError('');
    const r = await miniApi<{ draft: MiniDraft }>(`/api/mini/drafts/${draft.id}/materials`, {
      method: 'PUT', body: { materialIds },
    });
    setBusy(false);
    if (!r.ok || !r.data) { setError(r.error || 'serverError'); return false; }
    setDraft(r.data.draft);
    setMaterialIds(r.data.draft.materials.map((m) => m.materialId).filter((id): id is string => Boolean(id)));
    return true;
  };

  const formatText = async (mode: 'ai' | 'manual') => {
    if (busy) return;
    setBusy(true); setFormatBusy(mode); setError(''); setNotice(''); setAiFallback(null);
    // The exact text before an AI call is preserved: on any failure the field is untouched,
    // and after a success the teacher can put her own wording back with one tap.
    if (mode === 'ai') setAiBackup(text);
    const r = await miniApi<MiniFormatResponse>(`/api/mini/drafts/${draft.id}/format`, {
      method: 'POST', body: { mode },
    });
    setBusy(false); setFormatBusy(null);
    if (!r.ok || !r.data) {
      if (mode === 'ai' && r.status === 502 && r.data && typeof r.data.fallback === 'string') {
        // The server did NOT save anything on an AI failure. The teacher's text stays exactly
        // as it was; the plain version is offered below and is applied only by an explicit tap.
        setAiFallback(r.data.fallback);
        setNotice(t('mini.aiFailedKeep'));
        haptic(wa, 'error');
        return;
      }
      if (mode === 'ai' && r.error === 'aiUnavailable') {
        // Configured in the UI but unavailable on the server right now: say so, keep the draft,
        // keep manual formatting available.
        setAiOff(true);
        setNotice(t('mini.aiStatusOff'));
        return;
      }
      setError(r.error || 'serverError');
      return;
    }
    setDraft(r.data.draft);
    setText(r.data.draft.formattedText);
    setWarnings(r.data.warnings);
    setQuestions(r.data.questions);
    if (!title.trim()) setTitle(r.data.draft.title);
    if (mode === 'manual') setAiBackup(null);
    setNotice(t('mini.noticeFormatted', { provider: r.data.provider || 'local' }));
    haptic(wa, 'success');
  };

  const useFallback = () => {
    if (aiFallback === null) return;
    setText(aiFallback);
    setAiFallback(null);
    setNotice(t('mini.aiFallbackUsed'));
    haptic(wa, 'tap');
  };

  const restoreText = () => {
    if (aiBackup === null) return;
    setText(aiBackup);
    setNotice(t('mini.aiRestored'));
    haptic(wa, 'tap');
  };

  const onMaterialUploaded = (result: MiniUploadResponse) => {
    if (result.draft) {
      setDraft(result.draft);
      setMaterialIds(result.draft.materials
        .map((m) => m.materialId)
        .filter((id): id is string => Boolean(id)));
    }
    setMaterialReload((n) => n + 1);
    onLibraryChanged();
  };

  const toConfirm = async (): Promise<boolean> => {
    if (!(await saveFields())) return false;
    setBusy(true); setError(''); setNotice('');
    const saved = await miniApi<{ draft: MiniDraft }>(`/api/mini/drafts/${draft.id}`, {
      method: 'PATCH', body: { formattedText: text },
    });
    if (!saved.ok || !saved.data) { setBusy(false); setError(saved.error || 'serverError'); return false; }
    setDraft(saved.data.draft);
    const preview = await miniApi<{ draft: MiniDraft }>(`/api/mini/drafts/${draft.id}/preview`, {
      method: 'POST',
    });
    setBusy(false);
    if (!preview.ok || !preview.data) { setError(preview.error || 'serverError'); return false; }
    setDraft(preview.data.draft);
    setText(preview.data.draft.formattedText);
    setWarnings(preview.data.draft.warnings);
    setQuestions(preview.data.draft.questions);
    return true;
  };

  const publish = async () => {
    if (!confirmChecked || busy) return;
    setBusy(true); setError(''); setNotice('');
    haptic(wa, 'tap');
    const r = await miniApi<MiniPublishResponse>(`/api/mini/drafts/${draft.id}/publish`, { method: 'POST' });
    setBusy(false);
    if (!r.ok || !r.data) { setError(r.error || 'serverError'); haptic(wa, 'error'); return; }
    const data = r.data;
    if (data.draft) setDraft(data.draft);
    if (data.kind === 'groupUnavailable') {
      setNotice(t('mini.resultGroupUnavailable', { groups: (data.unavailableGroups ?? []).join(', ') }));
      setStep(1);
      return;
    }
    if (data.kind === 'notReady') { setError('notReady'); return; }
    if (!data.draft) { setError('serverError'); return; }
    onPublished(data.draft, data.kind);
  };

  const goNext = async () => {
    if (step === 1) { if (await saveGroups()) { setStep(2); haptic(wa, 'success'); } return; }
    if (step === 2) { if (await saveFields()) { setStep(3); haptic(wa, 'success'); } return; }
    if (step === 3) { if (await saveMaterials()) { setStep(4); haptic(wa, 'success'); } return; }
    if (step === 4) { if (await toConfirm()) { setStep(5); haptic(wa, 'success'); } return; }
  };

  const cancelDraft = async () => {
    if (!cancelArmed) { setCancelArmed(true); return; }
    setBusy(true); setError('');
    const r = await miniApi<{ ok: boolean }>(`/api/mini/drafts/${draft.id}/cancel`, { method: 'POST' });
    setBusy(false);
    if (!r.ok) { setError(r.error || 'serverError'); return; }
    onExit();
  };

  // Library list: fetched when the step opens and when the search text settles. The server
  // filters by title/file name and by «recommended for every selected group» — the client
  // never widens that set.
  useEffect(() => {
    if (step !== 3) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const q = materialQuery.trim();
      const suffix = q ? `?q=${encodeURIComponent(q)}` : '';
      const r = await miniApi<{ materials: MiniMaterialHit[]; reason?: string }>(
        `/api/mini/drafts/${draft.id}/materials${suffix}`,
      );
      if (cancelled) return;
      if (!r.ok || !r.data) { setMaterials([]); setMaterialReason('notFound'); return; }
      setMaterials(r.data.materials);
      setMaterialReason(r.data.reason ?? '');
    }, materialQuery ? 250 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [step, materialQuery, draft.id, materialReload]);

  const toggleMaterial = (id: string) => {
    haptic(wa, 'tap');
    setMaterialIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= limits.materials) { setNotice(t('mini.errorTooManyMaterials', { n: limits.materials })); return prev; }
      return [...prev, id];
    });
  };

  return (
    <MiniFrame testid="mini-wizard">
      <header className="mini-head mini-head--sticky">
        <div>
          <p className="mini-step">{t('mini.stepOf', { n: step, total: 5 })}</p>
          <h1>{t(`mini.step.${step}`)}</h1>
        </div>
      </header>

      {error && <p className="error" role="alert" data-testid="mini-error-message">{explain(error)}</p>}
      {notice && <p className="mini-notice" role="status" data-testid="mini-notice">{notice}</p>}

      {step === 1 && (
        <section className="mini-section" data-testid="mini-step-1">
          <p className="muted">{t('mini.groupsHint')}</p>
          {activeGroups.length === 0
            ? <p className="card mini-note" role="status">{t('mini.noGroups')}</p>
            : (
              <div className="mini-list">
                {activeGroups.map((g) => (
                  <GroupRow key={g.id} group={g} checked={groupIds.includes(g.id)} onToggle={() => toggleGroup(g.id)} />
                ))}
              </div>
            )}
          {activeGroups.length > 0 && (
            <div className="row mini-row-actions">
              <button type="button" className="ghost" onClick={() => setGroupIds(activeGroups.map((g) => g.id))}>
                {t('mini.selectAll')}
              </button>
              <button type="button" className="ghost" onClick={() => setGroupIds([])}>
                {t('mini.clearAll')}
              </button>
            </div>
          )}
        </section>
      )}

      {step === 2 && (
        <section className="mini-section" data-testid="mini-step-2">
          <label htmlFor="mini-title">{t('mini.titleLabel')}</label>
          <input id="mini-title" data-testid="mini-title" value={title} maxLength={limits.title}
            placeholder={t('mini.titlePlaceholder')} onChange={(e) => setTitle(e.target.value)} />

          <label htmlFor="mini-instruction">{t('mini.instructionLabel')}</label>
          <textarea id="mini-instruction" data-testid="mini-instruction" rows={5}
            value={instruction} maxLength={limits.instruction}
            placeholder={t('mini.instructionPlaceholder')}
            onChange={(e) => setInstruction(e.target.value)} />

          <DateTimeField kind="datetime" id="mini-due" testid="mini-due" label={t('mini.dueLabel')}
            value={dueAt} onChange={setDueAt} />

          <fieldset className="mini-links">
            <legend>{t('mini.linksTitle')}</legend>
            {links.map((link, index) => (
              <div className="mini-link-row" key={index}>
                <div className="mini-link-fields">
                  <input aria-label={t('mini.linkUrl')} data-testid={`mini-link-url-${index}`}
                    value={link.url} inputMode="url" placeholder="https://"
                    maxLength={1000}
                    onChange={(e) => setLinks((prev) => prev.map((l, i) => i === index ? { ...l, url: e.target.value } : l))} />
                  <input aria-label={t('mini.linkLabel')} data-testid={`mini-link-label-${index}`}
                    value={link.label} maxLength={80} placeholder={t('mini.linkLabel')}
                    onChange={(e) => setLinks((prev) => prev.map((l, i) => i === index ? { ...l, label: e.target.value } : l))} />
                </div>
                <button type="button" className="ghost mini-link-remove"
                  aria-label={t('mini.removeLink')}
                  onClick={() => setLinks((prev) => prev.filter((_, i) => i !== index))}>✕</button>
              </div>
            ))}
            <button type="button" className="ghost" data-testid="mini-link-add"
              disabled={links.length >= limits.links}
              onClick={() => setLinks((prev) => [...prev, { url: '', label: '' }])}>
              + {t('mini.addLink')}
            </button>
          </fieldset>
        </section>
      )}

      {step === 3 && (
        <section className="mini-section" data-testid="mini-step-3">
          <p className="muted">{t('mini.materialsHint')}</p>
          <MiniUploader wa={wa} bootstrap={bootstrap}
            groups={draft.groups.map((g) => ({ id: g.id, title: g.title }))}
            draftId={draft.id} onUploaded={onMaterialUploaded} />
          <label htmlFor="mini-material-search">{t('mini.searchMaterials')}</label>
          <input id="mini-material-search" data-testid="mini-material-search" type="search"
            value={materialQuery} onChange={(e) => setMaterialQuery(e.target.value)} />
          {materialReason === 'noGroups' && <p className="card mini-note">{t('mini.noGroupMaterials')}</p>}
          {materialReason !== 'noGroups' && materials.length === 0 && (
            <p className="muted">{t('mini.noMaterials')}</p>
          )}
          <div className="mini-list">
            {materialReason !== 'noGroups' && materials.map((m) => (
              <MaterialRow key={m.id} material={m} checked={materialIds.includes(m.id)}
                disabled={!materialIds.includes(m.id) && materialIds.length >= limits.materials}
                onToggle={() => toggleMaterial(m.id)} />
            ))}
          </div>
          <p className="muted">{t('mini.selectedCount', { n: materialIds.length })} · {t('mini.maxMaterials', { n: limits.materials })}</p>
        </section>
      )}

      {step === 4 && (
        <section className="mini-section" data-testid="mini-step-4">
          <div className="row">
            <button type="button" className="secondary" data-testid="mini-format-manual"
              disabled={busy} onClick={() => void formatText('manual')}>
              {formatBusy === 'manual' ? t('mini.formatting') : t('mini.formatManual')}
            </button>
            <button type="button" className="secondary" data-testid="mini-format-ai"
              disabled={busy || aiOff}
              title={aiOff ? t('mini.aiStatusOff') : undefined}
              onClick={() => void formatText('ai')}>
              {formatBusy === 'ai' ? t('mini.aiProgress') : t('mini.formatAi')}
            </button>
          </div>

          {/* Honest availability, not a silently disabled button: the teacher always knows
              whether AI is configured and that manual text works regardless. */}
          <p className={aiOff ? 'mini-notice' : 'muted mini-ai-status'}
            role="status" data-testid="mini-ai-status">
            {aiOff ? t('mini.aiStatusOff') : t('mini.aiStatusOn')}
          </p>
          {formatBusy === 'ai' && (
            <p className="muted" role="status" data-testid="mini-ai-progress">{t('mini.aiProgress')}</p>
          )}
          {aiFallback !== null && (
            <div className="mini-ai-fallback" role="note" data-testid="mini-ai-fallback">
              <p>{t('mini.aiFailedKeep')}</p>
              <p className="muted">{t('mini.aiNoAutoRetry')}</p>
              <pre className="mini-fallback-text">{aiFallback}</pre>
              <div className="row">
                <button type="button" className="secondary" data-testid="mini-ai-use-fallback"
                  onClick={useFallback}>{t('mini.aiUseFallback')}</button>
                {aiBackup !== null && (
                  <button type="button" className="ghost" data-testid="mini-ai-restore"
                    onClick={restoreText}>{t('mini.aiRestore')}</button>
                )}
              </div>
            </div>
          )}
          {aiBackup !== null && aiFallback === null && (
            <button type="button" className="ghost mini-ai-restore" data-testid="mini-ai-restore"
              onClick={restoreText}>{t('mini.aiRestore')}</button>
          )}

          <label htmlFor="mini-text">{t('mini.finalTextLabel')}</label>
          <textarea id="mini-text" data-testid="mini-text" rows={10} value={text}
            maxLength={limits.text}
            onChange={(e) => setText(e.target.value)} />
          <p className="muted">{t('mini.finalTextHint')}</p>

          {warnings.length > 0 && (
            <div className="mini-warnings" role="note" data-testid="mini-warnings">
              <strong>{t('mini.warningsTitle')}</strong>
              <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          {questions.length > 0 && (
            <div className="mini-questions" role="note" data-testid="mini-questions">
              <strong>{t('mini.questionsTitle')}</strong>
              <ul>{questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </div>
          )}

          <p className="muted mini-fidelity">{t('mini.fidelityNote')}</p>
          <Summary draft={draft} bootstrap={bootstrap} groupCount={groupIds.length} />
        </section>
      )}

      {step === 5 && (
        <section className="mini-section" data-testid="mini-step-5">
          <p>{t('mini.confirmHint')}</p>
          <Summary draft={draft} bootstrap={bootstrap} groupCount={groupIds.length} />
          <pre className="mini-final-text" data-testid="mini-final-text">{text}</pre>
          <label className="mini-check" htmlFor="mini-confirm">
            <input id="mini-confirm" data-testid="mini-confirm" type="checkbox"
              checked={confirmChecked} onChange={(e) => setConfirmChecked(e.target.checked)} />
            <span>{t('mini.confirmCheck')}</span>
          </label>
        </section>
      )}

      <nav className={`mini-nav${hasMainButton ? ' mini-nav--single' : ''}`}
        aria-label={t('mini.navigation')}>
        <button type="button" className="secondary" data-testid="mini-back" disabled={busy} onClick={goBack}>
          {t('mini.back')}
        </button>
        {/* The Telegram MainButton is the primary action whenever it exists; drawing a second
            identical button here would be the duplication the brief forbids. */}
        {!hasMainButton && step < 5 && (
          <button type="button" data-testid="mini-next"
            disabled={busy || !nextEnabled(step, groupIds, busy, materialReason)}
            onClick={() => void goNext()}>
            {busy ? t('mini.saving') : t('mini.next')}
          </button>
        )}
        {!hasMainButton && step === 5 && (
          <button type="button" data-testid="mini-publish"
            disabled={busy || !confirmChecked}
            onClick={() => void publish()}>
            {busy ? t('mini.publishing') : t('mini.publishCount', { n: groupIds.length })}
          </button>
        )}
      </nav>

      {step === 1 && (
        <div className="mini-cancel">
          <button type="button" className={cancelArmed ? 'danger' : 'ghost'} disabled={busy}
            data-testid="mini-cancel" onClick={() => void cancelDraft()}>
            {cancelArmed ? t('mini.cancelConfirm') : t('mini.cancelDraft')}
          </button>
        </div>
      )}
    </MiniFrame>
  );
}

function nextEnabled(step: Step, groupIds: string[], busy: boolean, materialReason: string): boolean {
  if (busy) return false;
  if (step === 1) return groupIds.length > 0;
  if (step === 3) return materialReason !== 'noGroups';
  return true;
}

function GroupRow({ group, checked, onToggle }: { group: MiniGroup; checked: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <label className="mini-row mini-row--check" htmlFor={`mini-g-${group.id}`}>
      <input id={`mini-g-${group.id}`} type="checkbox" checked={checked} onChange={onToggle}
        data-testid={`mini-group-${group.id}`} />
      <span className="mini-row-main">
        <strong>{group.title}</strong>
        <small className="muted">
          {group.kind === 'online' ? t('mini.groupOnline') : t('mini.groupOffline')}
          {' · '}{t('mini.groupMaterials', { n: group.materialCount })}
          {' · '}{group.chatShort}
        </small>
      </span>
      {group.lastPublication && <PubBadge status={group.lastPublication.status} />}
    </label>
  );
}

function MaterialRow({
  material, checked, disabled, onToggle,
}: {
  material: MiniMaterialHit; checked: boolean; disabled: boolean; onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <label className={`mini-row mini-row--check${disabled ? ' is-disabled' : ''}`} htmlFor={`mini-m-${material.id}`}>
      <input id={`mini-m-${material.id}`} type="checkbox" checked={checked} disabled={disabled}
        onChange={onToggle} data-testid={`mini-material-${material.id}`} />
      <span className="mini-row-main">
        <strong>{material.title}</strong>
        <small className="muted">
          {t(`mini.materialKind.${material.kind}`)}{material.fileName ? ` · ${material.fileName}` : ''}
        </small>
      </span>
    </label>
  );
}

function Summary({ draft, bootstrap, groupCount }: {
  draft: MiniDraft; bootstrap: MiniBootstrap; groupCount: number;
}) {
  const { t, i18n } = useTranslation();
  const names = draft.groups.map((g) => g.title).join(', ');
  return (
    <dl className="mini-summary">
      <div>
        <dt>{t('mini.groupsValue')}</dt>
        <dd>{names || t('mini.groupsCount', { n: groupCount })}</dd>
      </div>
      <div>
        <dt>{t('mini.attachmentsValue')}</dt>
        <dd>{draft.materials.length}</dd>
      </div>
      <div>
        <dt>{t('mini.dueValue', { date: draft.dueAt ? fmtDate(draft.dueAt, i18n.language, bootstrap.teacher.tz) : '—' })}</dt>
        <dd />
      </div>
    </dl>
  );
}

// ─── result ────────────────────────────────────────────────────────────────

function MiniResult({
  wa, draft: initial, initialKind, onHome, onChanged,
}: {
  wa: TelegramWebApp | null;
  draft: MiniDraft;
  initialKind?: MiniPublishResponse['kind'];
  onHome: () => void;
  onChanged?: (draft: MiniDraft) => void;
}) {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState(initial);
  const [kind, setKind] = useState<MiniPublishResponse['kind'] | undefined>(initialKind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useTelegramBack(wa, onHome);

  // Publication started on another tap (or by the bot) may still be running. Poll the draft
  // itself — never re-send: the server owns the state machine, this screen only reads it.
  useEffect(() => {
    if (draft.status !== 'publishing') return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      const r = await miniApi<{ draft: MiniDraft }>(`/api/mini/drafts/${draft.id}`);
      if (cancelled) return;
      if (r.ok && r.data) {
        setDraft(r.data.draft);
        if (r.data.draft.status === 'publishing') timer = window.setTimeout(() => void tick(), 3_000);
      } else if (r.error === 'networkError') {
        timer = window.setTimeout(() => void tick(), 5_000);
      }
    };
    timer = window.setTimeout(() => void tick(), 2_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [draft.status, draft.id]);

  const retry = async () => {
    setBusy(true); setError(''); setNotice('');
    haptic(wa, 'tap');
    const r = await miniApi<MiniPublishResponse>(`/api/mini/drafts/${draft.id}/retry`, { method: 'POST' });
    setBusy(false);
    if (!r.ok || !r.data) { setError(r.error || 'serverError'); haptic(wa, 'error'); return; }
    if (r.data.draft) { setDraft(r.data.draft); onChanged?.(r.data.draft); }
    setKind(r.data.kind);
    if (r.data.kind === 'noTargets') setNotice(t('mini.nothingToRetry'));
    else if (r.data.kind === 'done') haptic(wa, 'success');
  };

  const headline = resultHeadline(draft, kind, t);
  const counts = {
    sent: draft.publications.filter((p) => p.status === 'sent').length,
    failed: draft.publications.filter((p) => p.status === 'failed').length,
    uncertain: draft.publications.filter((p) => p.status === 'uncertain').length,
  };

  return (
    <MiniFrame testid="mini-result">
      <header className="mini-head">
        <div>
          <h1>{t('mini.resultTitle')}</h1>
          <p className="muted">{headline}</p>
        </div>
      </header>

      {error && <p className="error" role="alert">{errorText(error, t, undefined)}</p>}
      {notice && <p className="mini-notice" role="status">{notice}</p>}

      <div className="mini-counts" data-testid="mini-result-counts">
        <span className="mini-count mini-count--ok">{t('mini.groupSent')}: {counts.sent}</span>
        <span className="mini-count mini-count--bad">{t('mini.groupFailed')}: {counts.failed}</span>
        <span className="mini-count mini-count--warn">{t('mini.groupUncertain')}: {counts.uncertain}</span>
      </div>

      <ul className="mini-list">
        {draft.publications.map((p) => <PublicationRow key={p.id} publication={p} />)}
      </ul>

      {draft.canRetry && draft.status !== 'publishing' && (
        <div className="mini-retry">
          <p className="muted">{t('mini.resultRetryHint')}</p>
          <button type="button" className="secondary" data-testid="mini-retry" disabled={busy}
            onClick={() => void retry()}>
            {busy ? t('mini.publishing') : t('mini.retryGroups')}
          </button>
        </div>
      )}
      {!draft.canRetry && counts.uncertain > 0 && (
        <p className="mini-notice" role="status">{t('mini.unknownHint')}</p>
      )}

      {draft.publishedAt && (
        <p className="muted">{fmtDate(draft.publishedAt, i18n.language)}</p>
      )}

      <nav className="mini-nav">
        <button type="button" className="secondary" data-testid="mini-home" onClick={onHome}>
          {t('mini.backHome')}
        </button>
      </nav>
    </MiniFrame>
  );
}

function resultHeadline(
  draft: MiniDraft, kind: MiniPublishResponse['kind'] | undefined, t: (key: string) => string,
): string {
  if (draft.status === 'publishing' || kind === 'inProgress') return t('mini.resultInProgress');
  if (kind === 'already') return t('mini.resultAlready');
  if (kind === 'noTargets') return t('mini.resultNoTargets');
  if (draft.status === 'publish_unknown') return t('mini.resultUnexpected');
  if (draft.status === 'failed') return t('mini.resultPartial');
  if (draft.status === 'cancelled') return t('mini.resultCancelled');
  return t('mini.resultDone');
}

function PublicationRow({ publication }: { publication: MiniPublication }) {
  const { t } = useTranslation();
  const failed = publication.parts.filter((p) => p.status === 'failed').length;
  const unknown = publication.parts.filter((p) => p.status === 'unknown').length;
  return (
    <li className={`mini-row mini-row--static mini-pub mini-pub--${publication.status}`}
      data-testid={`mini-pub-${publication.id}`}>
      <span className="mini-row-main">
        <strong>{publication.groupTitle}</strong>
        <small className="muted">
          {t(`mini.pubStatus.${publication.status}`)}
          {publication.delivered > 0 ? ` · ${t('mini.partSent')}: ${publication.delivered}` : ''}
          {failed > 0 ? ` · ${t('mini.partFailed')}: ${failed}` : ''}
          {unknown > 0 ? ` · ${t('mini.partUnknown')}: ${unknown}` : ''}
        </small>
        {publication.parts.length > 0 && (
          <ul className="mini-parts">
            {publication.parts.map((p, i) => (
              <li key={i}>
                {p.kind === 'text' ? t('mini.partText') : (p.label || p.kind)} — {t(`mini.partStatus.${p.status}`)}
              </li>
            ))}
          </ul>
        )}
        {publication.status === 'uncertain' && <span className="muted">{t('mini.unknownHint')}</span>}
      </span>
      <PubBadge status={publication.status} />
    </li>
  );
}

function PubBadge({ status }: { status: MiniPublication['status'] }) {
  const { t } = useTranslation();
  return <span className={`mini-badge mini-badge--${status}`}>{t(`mini.pubStatus.${status}`)}</span>;
}
