import { describe, it, expect } from 'vitest';
import { TrackSource } from 'livekit-server-sdk';
import { lecturePreDevices } from '../../src/services/lessons.js';

/**
 * Часть 1 (2026-10-13): серверный снимок «что горело до лекции».
 *
 * Функция решает, что именно вернётся ученику после лекции, и она невидима браузерному тесту:
 * решение принимается по `listParticipants` ДО отзыва публикации, когда ни один клиент ещё ничего
 * не знает. Ошибиться здесь в две стороны одинаково плохо: пустая карта — тот, кто говорил до
 * лекции, остаётся без голоса; полная — включается и тот, кто выключил себя сам.
 *
 * `muted` здесь не просто «false/true»: protobuf опускает значение по умолчанию из JSON, поэтому
 * живой трек приходит либо без поля, либо с `muted: false`, а выключенный — с `muted: true`.
 */
const mic = (muted?: boolean) => ({ source: TrackSource.MICROPHONE, muted });
const cam = (muted?: boolean) => ({ source: TrackSource.CAMERA, muted });
const screen = (muted?: boolean) => ({ source: TrackSource.SCREEN_SHARE, muted });

describe('lecturePreDevices — the snapshot the server takes before it revokes (part 1)', () => {
  it('a live microphone and a live camera are recorded as on', () => {
    const map = lecturePreDevices([{ identity: 's1', tracks: [mic(), cam()] }], 'teacher');
    expect(map).toEqual({ s1: { mic: true, cam: true } });
  });

  it('a muted track is OFF: somebody who muted themselves before the lecture stays muted', () => {
    const map = lecturePreDevices([{ identity: 's1', tracks: [mic(true), cam()] }], 'teacher');
    expect(map.s1).toEqual({ mic: false, cam: true });
  });

  it('a source that is not published at all is OFF, not undefined', () => {
    const map = lecturePreDevices([{ identity: 's1', tracks: [mic()] }], 'teacher');
    expect(map.s1).toEqual({ mic: true, cam: false });
  });

  it('the teacher is never in the snapshot — the teacher always speaks', () => {
    const map = lecturePreDevices([{ identity: 'teacher', tracks: [mic(), cam()] }], 'teacher');
    expect(map).toEqual({});
  });

  it('a screen share is not a device and does not turn into a microphone', () => {
    const map = lecturePreDevices([{ identity: 's1', tracks: [screen(), cam(true)] }], 'teacher');
    expect(map.s1).toEqual({ mic: false, cam: false });
  });

  it('a participant without a track list (LiveKit answered nothing) is recorded as all off', () => {
    const map = lecturePreDevices([{ identity: 's1' }], 'teacher');
    expect(map.s1).toEqual({ mic: false, cam: false });
  });

  it('every student in the room gets their own entry, so one snapshot describes the whole class', () => {
    const map = lecturePreDevices([
      { identity: 'teacher', tracks: [mic(), cam()] },
      { identity: 'anna', tracks: [mic(), cam(true)] },
      { identity: 'boris', tracks: [mic(true), cam()] },
      { identity: 'veronica', tracks: [] },
    ], 'teacher');
    expect(map).toEqual({
      anna: { mic: true, cam: false },
      boris: { mic: false, cam: true },
      veronica: { mic: false, cam: false },
    });
  });
});
