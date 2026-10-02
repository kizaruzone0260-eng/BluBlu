import { useCallback, useMemo, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
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
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [range, setRange] = useState<{ from: string; to: string }>({
    from: new Date(Date.now() - 45 * 864e5).toISOString(),
    to: new Date(Date.now() + 90 * 864e5).toISOString(),
  });
  const [classFilter, setClassFilter] = useState('');
  const [form, setForm] = useState<EventForm | null>(null);
  const [scopeChoice, setScopeChoice] = useState<'this' | 'following' | 'all'>('all');

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
        return api(`/api/events/${f.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            scope: f.occurrenceStart ? scopeChoice : 'all',
            occurrenceStart: scopeChoice === 'all' ? undefined : f.occurrenceStart,
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
          <button style={{ marginTop: 0 }} onClick={() => setForm({
            kind: 'lesson', title: '', description: '', startLocal: '', durationMin: 50,
            tz: me.tz, repeatWeekdays: [], repeatUntil: '',
          })}>{t('cal.newEvent')}</button>
        )}
      </div>

      {form && (
        <div className="card">
          <h2>{form.id ? t('cal.editEvent') : t('cal.newEvent')}</h2>
          <div className="row">
            <select style={{ width: 'auto' }} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as EventForm['kind'] })}>
              <option value="lesson">{t('cal.lesson')}</option>
              <option value="deadline">{t('cal.deadline')}</option>
              <option value="other">{t('cal.other')}</option>
            </select>
            <input placeholder={t('common.name')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ flex: 1, minWidth: 180 }} />
          </div>
          <textarea placeholder={t('classes.description')} rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div className="row" style={{ marginTop: 8 }}>
            <label style={{ margin: 0 }}>{t('cal.start')} ({form.tz})</label>
            <input type="datetime-local" value={form.startLocal} onChange={(e) => setForm({ ...form, startLocal: e.target.value })} style={{ width: 'auto' }} required />
            <input type="number" min={1} max={480} value={form.durationMin} title={t('cal.duration')}
              onChange={(e) => setForm({ ...form, durationMin: Number(e.target.value) })} style={{ width: 80 }} />
          </div>
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
            <button disabled={!form.title || !form.startLocal || save.isPending} onClick={() => save.mutate(form)}>{t('common.save')}</button>
            <button className="secondary" onClick={() => { setForm(null); setScopeChoice('all'); }}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      <div className="card">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
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
            if (me?.role === 'teacher') {
              setForm({
                id: o.eventId, kind: o.kind, title: o.title, description: o.description,
                startLocal: toLocalInput(o.startsAt, o.tz), durationMin: Math.round((+new Date(o.endsAt) - +new Date(o.startsAt)) / 60000),
                tz: o.tz, repeatWeekdays: [], repeatUntil: '', occurrenceStart: o.recurring ? o.startsAt : undefined,
              });
              setScopeChoice(o.recurring ? 'this' : 'all');
            }
          }}
          datesSet={onDatesSet}
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
            <button className="danger" onClick={() => del.mutate({ id: form.id!, scope: scopeChoice, occurrenceStart: scopeChoice === 'all' ? undefined : form.occurrenceStart })}>
              {t('cal.delete')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
