/**
 * Camera/microphone acquisition helpers (task «камера в уроке»).
 * The browser is asked with SOFT ideal constraints first (never exact
 * resolution/frameRate — webcams don't all offer 720p30); if a saved device id
 * is unavailable or the constraints are not satisfiable, the caller retries
 * with the default device and finally with the bare {video:true}/{audio:true}.
 * Failure names map to visible, localized messages — never a silent no.
 */

export interface MediaAttempt {
  deviceId?: { exact: string };
  width?: { ideal: number };
  height?: { ideal: number };
  frameRate?: { ideal: number };
}

/** Constraint chain for camera capture: saved device → default device → no constraints. */
export function cameraAttempts(savedDeviceId: string | null | undefined): (MediaAttempt | true)[] {
  const ideal: MediaAttempt = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  const list: (MediaAttempt | true)[] = [];
  if (savedDeviceId) list.push({ deviceId: { exact: savedDeviceId }, ...ideal });
  list.push(ideal);
  list.push(true); // last resort: whatever the browser gives us
  return list;
}

/** Constraint chain for microphone capture (echoCancellation/noise keep LiveKit defaults). */
export function microphoneAttempts(savedDeviceId: string | null | undefined): (MediaAttempt | true)[] {
  const list: (MediaAttempt | true)[] = [];
  if (savedDeviceId) list.push({ deviceId: { exact: savedDeviceId } });
  list.push(true);
  return list;
}

/** Device-level failures worth retrying one constraint step down. */
export function isRetryableMediaError(name: string | undefined): boolean {
  return name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError'
    || name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'NoSuchDeviceError';
}

/** gUM/RTCException name → lesson.* i18n key. */
export function mediaErrorKey(
  err: { name?: string; message?: string } | unknown,
  kind: 'camera' | 'microphone',
): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return kind === 'camera' ? 'camDenied' : 'micDenied';
  }
  // NotReadableError = the OS says the device is held by another application.
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return kind === 'camera' ? 'camBusy' : 'micBusy';
  }
  if (isRetryableMediaError(name) || name === 'NotSupportedError') {
    return kind === 'camera' ? 'camNotFound' : 'micNotFound';
  }
  return kind === 'camera' ? 'camUnavailable' : 'micUnavailable';
}
