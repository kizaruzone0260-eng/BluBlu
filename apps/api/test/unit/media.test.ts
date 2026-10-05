import { describe, it, expect } from 'vitest';
import { cameraAttempts, microphoneAttempts, isRetryableMediaError, mediaErrorKey } from '@klass/shared';

describe('camera/microphone constraint chain (камера в уроке)', () => {
  it('soft ideal values only — never exact resolution/frameRate', () => {
    const [first] = cameraAttempts(null) as { width?: { ideal: number }; deviceId?: unknown }[];
    expect(first.width).toEqual({ ideal: 1280 });
    expect(first.height).toEqual({ ideal: 720 });
    expect(first.frameRate).toEqual({ ideal: 30 });
    expect(first.deviceId).toBeUndefined();
    expect(JSON.stringify(cameraAttempts(null))).not.toContain('"exact"');
  });

  it('saved device first, then default, then bare true', () => {
    const withDevice = cameraAttempts('abc');
    expect(withDevice[0]).toMatchObject({ deviceId: { exact: 'abc' } });
    expect(withDevice.at(-1)).toBe(true);
    expect(microphoneAttempts(null)).toEqual([true]);
    expect((microphoneAttempts('m1') as object[])[0]).toEqual({ deviceId: { exact: 'm1' } });
  });

  it('retryable device errors step down the chain; permission/busy errors do not', () => {
    expect(isRetryableMediaError('OverconstrainedError')).toBe(true);
    expect(isRetryableMediaError('NotFoundError')).toBe(true);
    expect(isRetryableMediaError('NotAllowedError')).toBe(false);
    expect(isRetryableMediaError('NotReadableError')).toBe(false);
  });

  it('error names map to visible localized keys', () => {
    expect(mediaErrorKey({ name: 'NotAllowedError' }, 'camera')).toBe('camDenied');
    expect(mediaErrorKey({ name: 'NotReadableError' }, 'camera')).toBe('camBusy');
    expect(mediaErrorKey({ name: 'NotFoundError' }, 'camera')).toBe('camNotFound');
    expect(mediaErrorKey({ name: 'Whatever' }, 'camera')).toBe('camUnavailable');
    expect(mediaErrorKey({ name: 'NotAllowedError' }, 'microphone')).toBe('micDenied');
    expect(mediaErrorKey(null, 'microphone')).toBe('micUnavailable');
  });
});
