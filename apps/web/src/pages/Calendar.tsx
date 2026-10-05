import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, getToken } from '../lib/api';
import { APP_NAME } from '../lib/brand';
import { useAuth } from '../App';

interface Occ {
  eventId: string; classId: string; className: string; classColor: string;
  kind: 'lesson' | 'deadline' | 'other'; title: string; description: string; tz: string;
  startsAt: string; endsAt: string; recurring: boolean; uid: string;
}

interface EventForm {
  id?: string;
  kind: 'lesson' | 'deadline' | 'other';
  title: string;
  description: string;
  startLocal: string; // datetime-local
  durationMin: number;
  tz: string;
  repeatWeekdays: number[]; // ISO 1..7
  repeatUntil: string; // YYYY-MM-DD or ''
  occurrenceStart?: string; // for scope edits
  scopeOverride?: 'this' | 'following' | 'all'; // drag & drop chooses its own scope
}

function toLocalInput(isoUtc: string, tz: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p: Record<string, string> = {};
  for (const x of dtf.formatToParts(new Date(isoUtc))) if (x.type !== 'literal') p[x.type] = x.value;
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}`;
}

export default function Calendar() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [range, setRange] = useState<{ from: string; to: string }>({
    from: new Date(Date.now() - 45 * 864e5).toISOString(),
    to: new Date(Date.now() + 90 * 864e5).toISOString(),
  });
  const [classFilter, setClassFilter] = useState('');
  const [form, setForm] = useState<EventForm | null>(null);
  const [scopeChoice, setScopeChoice] = useState<'this' | 'following' | 'all'>('all');
  // item 4: calendar subscription lives here (was in Profile). The link stays
  // secret — revealed only on demand, never rendered in lists.
  const [icsUrl, setIcsUrl] = useState('');
  const [icsCopied, setIcsCopied] = useState(false);
  // calendar task §5: per-event export buttons + a small actions card
  const [formOcc, setFormOcc] = useState<Occ | null>(null);
  const [actions, setActions] = useState<Occ | null>(null);

  const webcalUrl = icsUrl.replace(/^https:/, 'webcal:');
  function googleTemplate(o: Pick<Occ, 'title' | 'className' | 'description' | 'startsAt' | 'endsAt'>) {
    const fmt = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: `${o.title} (${o.className})`,
      dates: `${fmt(o.startsAt)}/${fmt(o.endsAt)}`, // UTC per the Google template spec
      details: `${o.description}\n${window.location.origin}/calendar`,
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }
  async function downloadIcs(eventId: string) {
    const token = getToken();
    const r = await fetch(`/api/events/${eventId}/ics`, { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: 'include' });
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `event-${eventId.slice(0, 8)}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  async function copyIcs() {
    try {
      await navigator.clipboard.writeText(icsUrl);
      setIcsCopied(true);
    } catch { /* field stays manually selectable */ }
  }

  async function getIcs() {
    const { token } = await api<{ token: string }>('/api/me/ical-token', { method: 'POST' });
    const url = `${window.location.origin}/api/ical/${token}`;
    setIcsUrl(url);
    setIcsCopied(false);
    try {
      await navigator.clipboard.writeText(url);
      setIcsCopied(true);
    } catch { /* no clipboard permission — field is selectable manually */ }
  }

  const classes = useQuery({ queryKey: ['classes'], queryFn: () => api<{ id: string; name: string }[]>('/api/classes') });
  const events = useQuery({
    queryKey: ['events', range, classFilter],
    queryFn: () => api<Occ[]>(`/api/events?from=${range.from}&to=${range.to}${classFilter ? `&classId=${classFilter}` : ''}`),
  });

  const save = useMutation({
    mutationFn: (f: EventForm) => {
      const payload = {
        kind: f.kind, title: f.title, description: f.description,
        startLocal: f.startLocal, durationMin: f.durationMin, tz: f.tz,
        repeat: f.repeatWeekdays.length ? { weekdays: f.repeatWeekdays, until: f.repeatUntil || undefined } : null,
      };
      if (f.id) {
        const scope = f.scopeOverride ?? (f.occurrenceStart ? scopeChoice : 'all');
        return api(`/api/events/${f.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            scope,
            occurrenceStart: scope === 'all' ? undefined : f.occurrenceStart,
            changes: payload,
          }),
        });
      }
      const classId = classFilter || classes.data?.[0]?.id;
      if (!classId) throw new Error('no class');
      return api(`/api/classes/${classId}/events`, { method: 'POST', body: JSON.stringify(payload) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['events'] }); setForm(null); setScopeChoice('all'); },
  });

  const del = useMutation({
    mutationFn: (p: { id: string; scope: string; occurrenceStart?: string }) =>
      api(`/api/events/${p.id}?scope=${p.scope}${p.occurrenceStart ? `&occurrenceStart=${encodeURIComponent(p.occurrenceStart)}` : ''}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['events'] }); setForm(null); setScopeChoice('all'); },
  });

  const fcEvents = useMemo(() => (events.data ?? []).map((o) => ({
    id: o.uid, title: `${o.kind === 'lesson' ? '▶ ' : ''}${o.title}`,
    start: o.startsAt, end: o.endsAt, color: o.classColor,
  })), [events.data]);

  const onDatesSet = useCallback((info: { start: Date; end: Date }) => {
    setRange({ from: info.start.toISOString(), to: info.end.toISOString() });
  }, []);

  const openOcc = (uid: string) => {
    const o = (events.data ?? []).find((x) => x.uid === uid);
    if (!o) return null;
    return o;
  };

  const fcLocale = useMemo(() => {
    // B.3 — FullCalendar has no uz bundle; build the locale object from Intl
    // (Edge/V8 full-ICU ships ru/uz/en) + i18n strings for buttons.
    const lng = i18n.language === 'uz' ? 'uz-UZ' : i18n.language === 'en' ? 'en-GB' : 'ru-RU';
    const days = (o: Intl.DateTimeFormatOptions, n: number, base: number) =>
      Array.from({ length: n }, (_, i) => new Date(2024, 0, 1 + i + base).toLocaleDateString(lng, o));
    return {
      code: i18n.language,
      week: { dow: 1, doy: 4 }, // Monday week start (B.3)
      dayNamesLong: days({ weekday: 'long' }, 7, 0),
      dayNamesShort: days({ weekday: 'short' }, 7, 0),
      dayNamesMin: days({ weekday: 'short' }, 7, 0).map((s) => s.slice(0, 2)),
      monthNamesLong: Array.from({ length: 12 }, (_, i) => new Date(2024, i, 15).toLocaleDateString(lng, { month: 'long' })),
      monthNamesShort: Array.from({ length: 12 }, (_, i) => new Date(2024, i, 15).toLocaleDateString(lng, { month: 'short' })),
      buttonText: {
        today: t('fc.today'), month: t('fc.month'), week: t('fc.week'), list: t('fc.list'), prev: t('fc.prev'), next: t('fc.next'),
      },
      weekLabel: t('fc.week'),
      allDayText: t('fc.allDay'),
      noEventsText: t('fc.noEvents'),
      moreLinkText: (n: number) => `+${n}`,
      // 24-hour clock everywhere (B.3)
      slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      slotLabelTextFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      slotColumnLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      dayHeaderFormat: { weekday: 'short' },
      listDayFormat: { year: 'numeric', month: 'long', day: 'numeric' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }, [i18n.language, t]);

  // A2 — quick action «Добавить событие» lands on /calendar?new=1
  const [sp] = useSearchParams();
  useEffect(() => {
    if (me?.role === 'teacher' && sp.get('new') === '1') {
      setForm({
        kind: 'lesson', title: '', description: '', startLocal: '', durationMin: 50,
        tz: me.tz, repeatWeekdays: [], repeatUntil: '',
      });
    }
  }, [sp, me]);

  return (
    <div>
      <div className="row">
        <h1 style={{ margin: 0 }}>{t('cal.title')}</h1>
        <div className="spacer" />
        <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} style={{ width: 'auto' }}>
          <option value="">{t('cal.allClasses')}</option>
          {(classes.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {me?.role === 'teacher' && (
          <button style={{ marginTop: 0 }} data-testid="new-event" onClick={() => setForm({
            kind: 'lesson', title: '', description: '', startLocal: '', durationMin: 50,
            tz: me.tz, repeatWeekdays: [], repeatUntil: '',
          })}>{t('cal.newEvent')}</button>
        )}
      </div>

      {/* calendar task §5 — «Добавить в мой календарь»: Google / Apple / Outlook / copy */}
      <div className="row card" style={{ alignItems: 'center' }}>
        <button className="secondary" style={{ marginTop: 0 }} data-testid="ics-add" onClick={() => void getIcs()} disabled={!me}>
          📅 {t('cal.icsAdd')}
        </button>
        <span className="muted" style={{ fontSize: 13 }}>{t('cal.icsExplain')}</span>
        {icsUrl && (
          <div className="row" style={{ width: '100%', flexWrap: 'wrap', alignItems: 'center' }}>
            <a href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`} target="_blank" rel="noreferrer">
              <button className="secondary" style={{ marginTop: 0 }} data-testid="ics-google">Google Calendar</button>
            </a>
            <a href={webcalUrl}>
              <button className="secondary" style={{ marginTop: 0 }} data-testid="ics-apple">🍎 {t('cal.icsApple')}</button>
            </a>
            <a href={`https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(icsUrl)}&name=${encodeURIComponent(APP_NAME)}`} target="_blank" rel="noreferrer">
              <button className="secondary" style={{ marginTop: 0 }} data-testid="ics-outlook">Outlook</button>
            </a>
            <button className="secondary" style={{ marginTop: 0 }} data-testid="ics-copy" onClick={() => void copyIcs()}>
              🔗 {icsCopied ? t('cal.icsCopied') : t('cal.icsCopy')}
            </button>
            <input readOnly value={icsUrl} onFocus={(e) => e.target.select()} data-testid="ics-url"
              style={{ flex: 1, minWidth: 200, fontFamily: 'ui-monospace, monospace', fontSize: '.8rem', margin: 0 }} />
            <p className="muted" style={{ fontSize: 13, width: '100%', margin: '4px 0 0' }}>{t('cal.icsSecret')}</p>
          </div>
        )}
      </div>

      {/* per-event actions card (students & non-lesson clicks): join + export */}
      {actions && (
        <div className="card" data-testid="event-actions">
          <h2>{actions.title} <span className="muted">({actions.className})</span></h2>
          <p className="muted">{new Date(actions.startsAt).toLocaleString()} · {actions.description || t('cal.noEvents')}</p>
          <div className="row">
            {actions.kind === 'lesson' && (
              <a href={`/lesson?eventId=${actions.eventId}`} data-testid="act-join"><button style={{ marginTop: 0 }}>{t('cal.joinLesson')}</button></a>
            )}
            <a href={googleTemplate(actions)} target="_blank" rel="noreferrer">
              <button className="secondary" style={{ marginTop: 0 }} data-testid="act-google">📅 {t('cal.evGoogle')}</button>
            </a>
            <button className="secondary" style={{ marginTop: 0 }} data-testid="act-ics" onClick={() => void downloadIcs(actions.eventId)}>⬇ {t('cal.evIcs')}</button>
            <button className="ghost" style={{ marginTop: 0 }} onClick={() => setActions(null)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      {form && (
        <div className="card">
          <h2>{form.id ? t('cal.editEvent') : t('cal.newEvent')}</h2>
          <div className="row">
            <select style={{ width: 'auto' }} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as EventForm['kind'] })}>
              <option value="lesson">{t('cal.lesson')}</option>
              <option value="deadline">{t('cal.deadline')}</option>
              <option value="other">{t('cal.other')}</option>
            </select>
            <input data-testid="event-title" placeholder={t('common.name')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ flex: 1, minWidth: 180 }} />
          </div>
          <textarea placeholder={t('classes.description')} rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          {/* item 6: time is the device timezone (auto-detected) — no tz in the label */}
          <div className="row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ margin: 0 }} htmlFor="event-start">{t('cal.start')}</label>
              <input id="event-start" type="datetime-local" value={form.startLocal} data-testid="event-start"
                onChange={(e) => setForm({ ...form, startLocal: e.target.value })} style={{ width: 'auto' }} required />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ margin: 0 }} htmlFor="event-duration">{t('cal.duration')}</label>
              <input id="event-duration" type="number" min={1} max={480} value={form.durationMin} data-testid="event-duration"
                onChange={(e) => setForm({ ...form, durationMin: Number(e.target.value) })} style={{ width: 80 }} />
            </div>
            {/* quick durations (item 6) */}
            <div className="row" style={{ gap: 6 }} role="group" aria-label={t('cal.duration')}>
              {[30, 45, 60, 90].map((m) => (
                <button key={m} type="button" className={form.durationMin === m ? undefined : 'secondary'} data-testid={`dur-${m}`}
                  style={{ marginTop: 0, minWidth: 44, minHeight: 44 }} onClick={() => setForm({ ...form, durationMin: m })}>{m}</button>
              ))}
            </div>
          </div>
          {/* item 6: native pickers follow the BROWSER locale — show a localized
              reading + format hint so the app language always wins */}
          {form.startLocal && (
            <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }} data-testid="event-start-hint">
              {t('cal.start')}: {new Intl.DateTimeFormat(i18n.language, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(form.startLocal))}
            </p>
          )}
          <p className="muted" style={{ fontSize: 12, margin: '2px 0 0' }}>{t('cal.dtFormatHint')}</p>
          <div className="row" style={{ marginTop: 8 }}>
            <span className="muted">{t('cal.repeatWeekly')}</span>
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <label key={d} className="muted" style={{ margin: 0 }}>
                <input
                  type="checkbox" style={{ width: 'auto' }}
                  checked={form.repeatWeekdays.includes(d)}
                  onChange={(e) => setForm({
                    ...form,
                    repeatWeekdays: e.target.checked ? [...form.repeatWeekdays, d] : form.repeatWeekdays.filter((x) => x !== d),
                  })}
                /> {t(`cal.wd${d}`)}
              </label>
            ))}
            <input type="date" value={form.repeatUntil} title={t('cal.until')}
              onChange={(e) => setForm({ ...form, repeatUntil: e.target.value })} style={{ width: 'auto' }} />
          </div>
          {save.isError && <p className="error">{t('common.errorGeneric')}</p>}
          <div className="row">
            <button data-testid="event-save" disabled={!form.title || !form.startLocal || save.isPending} onClick={() => save.mutate(form)}>{t('common.save')}</button>
            <button className="secondary" onClick={() => { setForm(null); setScopeChoice('all'); }}>{t('common.cancel')}</button>
            {form.id && (
              <button className="danger" data-testid="event-delete"
                onClick={() => {
                  if (!window.confirm(t('cal.deleteConfirm'))) return;
                  const scope = form.occurrenceStart ? scopeChoice : 'all';
                  del.mutate({ id: form.id!, scope, occurrenceStart: scope !== 'all' ? form.occurrenceStart : undefined });
                }}>{t('cal.delete')}</button>
            )}
            {form.kind === 'lesson' && form.id && (
              <a href={`/lesson?eventId=${form.id}`}><button type="button" className="secondary">{t('cal.joinLesson')}</button></a>
            )}
            {/* calendar task §5: per-event export buttons for the teacher too */}
            {form.id && formOcc && (
              <>
                <a href={googleTemplate(formOcc)} target="_blank" rel="noreferrer">
                  <button type="button" className="secondary" data-testid="ev-google">📅 {t('cal.evGoogle')}</button>
                </a>
                <button type="button" className="secondary" data-testid="ev-ics" onClick={() => void downloadIcs(form.id!)}>⬇ {t('cal.evIcs')}</button>
              </>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
          locale={fcLocale}
          initialView="dayGridMonth"
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,listWeek' }}
          views={{ listWeek: { listDayFormat: { year: 'numeric', month: 'long', day: 'numeric' } } }}
          events={fcEvents}
          height="auto"
          nowIndicator
          dateClick={me?.role === 'teacher' ? (info) => {
            if (form) return;
            setForm({
              kind: 'lesson', title: '', description: '', startLocal: `${info.dateStr}T19:00`,
              durationMin: 50, tz: me.tz, repeatWeekdays: [], repeatUntil: '',
            });
          } : undefined}
          eventClick={(info) => {
            const o = openOcc(info.event.id);
            if (!o) return;
            setActions(null);
            if (o.kind === 'lesson' && me?.role !== 'teacher') {
              const openAt = +new Date(o.startsAt) - 10 * 60_000; // §3.6: активна за 10 минут
              if (Date.now() >= openAt) { window.location.href = `/lesson?eventId=${o.eventId}`; return; }
              setActions(o); // too early → the actions card explains and still offers exports
              return;
            }
            if (me?.role === 'teacher') {
              setFormOcc(o);
              setForm({
                id: o.eventId, kind: o.kind, title: o.title, description: o.description,
                startLocal: toLocalInput(o.startsAt, o.tz), durationMin: Math.round((+new Date(o.endsAt) - +new Date(o.startsAt)) / 60000),
                tz: o.tz, repeatWeekdays: [], repeatUntil: '', occurrenceStart: o.recurring ? o.startsAt : undefined,
              });
              setScopeChoice(o.recurring ? 'this' : 'all');
              return;
            }
            setActions(o); // student viewing a deadline/other event
          }}
          datesSet={onDatesSet}
          editable={me?.role === 'teacher'}
          eventDrop={(info) => {
            // C.2 — drag to reschedule (teacher). Recurring series → move only this occurrence.
            const o = openOcc(info.event.id);
            if (!o || !info.event.start) return;
            const durationMin = Math.round((+new Date(o.endsAt) - +new Date(o.startsAt)) / 60000);
            save.mutate({
              id: o.eventId, kind: o.kind, title: o.title, description: o.description,
              startLocal: toLocalInput(info.event.start.toISOString(), o.tz), durationMin,
              tz: o.tz, repeatWeekdays: [], repeatUntil: '',
              occurrenceStart: o.recurring ? info.oldEvent.start?.toISOString() : undefined,
              scopeOverride: o.recurring ? 'this' : 'all',
            });
            info.revert();
          }}
          eventResize={(info) => {
            const o = openOcc(info.event.id);
            if (!o || !info.event.start || !info.event.end || o.recurring) return;
            save.mutate({
              id: o.eventId, kind: o.kind, title: o.title, description: o.description,
              startLocal: toLocalInput(info.event.start.toISOString(), o.tz),
              durationMin: Math.round((+info.event.end - +info.event.start) / 60000),
              tz: o.tz, repeatWeekdays: [], repeatUntil: '',
            });
            info.revert();
          }}
        />
      </div>

      {form?.id && form.occurrenceStart && (
        <div className="card">
          <p className="muted">{t('cal.scopeQuestion')}</p>
          <div className="row">
            {(['this', 'following', 'all'] as const).map((s) => (
              <button key={s} className={scopeChoice === s ? '' : 'secondary'} onClick={() => setScopeChoice(s)}>
                {t(`cal.scope${s === 'this' ? 'This' : s === 'following' ? 'Following' : 'All'}`)}
              </button>
            ))}
            <div className="spacer" />
            <button className="danger" onClick={() => { if (window.confirm(t('cal.deleteConfirm'))) del.mutate({ id: form.id!, scope: scopeChoice, occurrenceStart: scopeChoice === 'all' ? undefined : form.occurrenceStart }); }}>
              {t('cal.delete')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
