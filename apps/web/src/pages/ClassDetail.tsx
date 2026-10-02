import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../App';

interface InviteRow {
  id: string; status: 'active' | 'used' | 'expired' | 'revoked';
  expiresAt: string; usedAt: string | null; usedByName: string | null; createdAt: string;
}
interface MemberRow { userId: string; name: string; email: string; joinedAt: string }

export default function ClassDetail() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [newCode, setNewCode] = useState<string | null>(null);
  const [ttlDays, setTtlDays] = useState(7);

  const invites = useQuery({
    queryKey: ['invites', id],
    queryFn: () => api<InviteRow[]>(`/api/classes/${id}/invites`),
    enabled: me?.role === 'teacher',
  });
  const members = useQuery({
    queryKey: ['members', id],
    queryFn: () => api<MemberRow[]>(`/api/classes/${id}/members`),
    enabled: me?.role === 'teacher',
  });

  const createInvite = useMutation({
    mutationFn: () => api<{ code: string }>(`/api/classes/${id}/invites`, {
      method: 'POST', body: JSON.stringify({ ttlDays }),
    }),
    onSuccess: (r) => { setNewCode(r.code); void qc.invalidateQueries({ queryKey: ['invites', id] }); },
  });
  const revoke = useMutation({
    mutationFn: (inviteId: string) => api(`/api/classes/${id}/invites/${inviteId}/revoke`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invites', id] }),
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => api(`/api/classes/${id}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members', id] }),
  });

  return (
    <div>
      <p><Link to="/classes">← {t('classes.title')}</Link></p>

      {me?.role === 'teacher' && (
        <>
          <div className="card">
            <h2>{t('classes.invite.title')}</h2>
            <div className="row">
              <label style={{ margin: 0 }}>{t('classes.invite.ttlDays')}</label>
              <input type="number" min={1} max={30} value={ttlDays} style={{ width: 80 }}
                onChange={(e) => setTtlDays(Number(e.target.value))} />
              <button style={{ marginTop: 0 }} onClick={() => createInvite.mutate()} disabled={createInvite.isPending}>
                {t('classes.invite.create')}
              </button>
            </div>
            {newCode && (
              <div style={{ marginTop: 12 }}>
                <div className="code-box">{newCode}</div>
                <p className="muted">{t('classes.invite.showOnce')}</p>
              </div>
            )}
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>{t('classes.invite.title')}</th><th>{t('classes.invite.expires')}</th>
                  <th>{t('classes.invite.usedBy')}</th><th />
                </tr>
              </thead>
              <tbody>
                {(invites.data ?? []).map((i) => (
                  <tr key={i.id}>
                    <td><span className={`badge ${i.status}`}>{t(`classes.invite.${i.status}`)}</span></td>
                    <td>{new Date(i.expiresAt).toLocaleString()}</td>
                    <td>{i.usedByName ?? '—'}{i.usedAt ? ` · ${new Date(i.usedAt).toLocaleString()}` : ''}</td>
                    <td>
                      {i.status === 'active' && (
                        <button className="danger" style={{ marginTop: 0 }} onClick={() => revoke.mutate(i.id)}>
                          {t('classes.invite.revoke')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>{t('classes.members')}</h2>
            {(members.data ?? []).length === 0 && <p className="muted">{t('classes.noMembers')}</p>}
            <table>
              <tbody>
                {(members.data ?? []).map((m) => (
                  <tr key={m.userId}>
                    <td>{m.name}</td>
                    <td className="muted">{m.email}</td>
                    <td className="muted">{new Date(m.joinedAt).toLocaleDateString()}</td>
                    <td>
                      <button className="danger" style={{ marginTop: 0 }} onClick={() => removeMember.mutate(m.userId)}>
                        {t('classes.removeMember')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
