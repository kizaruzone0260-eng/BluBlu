import { getToken } from './api';

/**
 * Media/file previews need the Authorization header, which <img>/<video>/<iframe>
 * cannot send. Fetch as blob with auth and use an object URL instead.
 */
export async function blobUrlFor(path: string): Promise<{ url: string; revoke: () => void }> {
  const token = getToken();
  const res = await fetch(path, {
    credentials: 'include',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`preview ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

export async function downloadFile(id: string, name: string) {
  const { url, revoke } = await blobUrlFor(`/api/files/${id}`);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(revoke, 4000);
}
