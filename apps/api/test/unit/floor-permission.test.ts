import { describe, it, expect } from 'vitest';
import { TrackSource } from 'livekit-server-sdk';
import { floorPermission, studentPermission } from '../../src/services/lessons.js';

/**
 * The permission arithmetic behind «дать слово» (task 2Б, 2026-10-10).
 *
 * This is the part that could silently break somebody, and it is the part no browser test can
 * see: LiveKit replaces the WHOLE permission object on an update (`RoomServiceClient.d.ts`:
 * "permissions are updated atomically — all desired permissions would need to be set"), so a grant
 * written as `{ canPublish: true, canPublishSources: [MICROPHONE] }` would take away a screen
 * share the teacher had already given, and a revoke written as "allow everything" would leave a
 * student publishing after their turn ended. Both are asserted here, per mode.
 */
const sourcesOf = (p: ReturnType<typeof floorPermission>) => (p.canPublishSources ?? []) as TrackSource[];

describe('floorPermission — giving and taking the word (task 2Б)', () => {
  it('lecture mode: a hand with the floor may publish the microphone and nothing else', () => {
    const p = floorPermission(studentPermission(true), true, true);
    expect(p.canPublish).toBe(true);
    expect(sourcesOf(p)).toEqual([TrackSource.MICROPHONE]);
  });

  it('lecture mode: revoking returns exactly the baseline that forbids publishing', () => {
    const granted = floorPermission(studentPermission(true), true, true);
    const back = floorPermission(granted, true, false);
    expect(back).toEqual(studentPermission(true));
    expect(back.canPublish).toBe(false);
    expect(sourcesOf(back)).toEqual([]);
  });

  it('an existing screen share survives both giving and taking the floor', () => {
    // the state a student can actually be in: lecture mode OFF, teacher let them share the screen
    const sharing = studentPermission(false, true);
    const granted = floorPermission(sharing, false, true);
    expect(sourcesOf(granted)).toContain(TrackSource.SCREEN_SHARE);
    expect(sourcesOf(granted)).toContain(TrackSource.MICROPHONE);
    expect(sourcesOf(granted)).toContain(TrackSource.CAMERA);
    const back = floorPermission(granted, false, false);
    expect(sourcesOf(back)).toEqual(sourcesOf(sharing));
    expect(sourcesOf(back)).toContain(TrackSource.SCREEN_SHARE);
  });

  it('outside lecture mode the floor does not invent rights the baseline already lacks', () => {
    // camera + mic are already allowed; the floor must not add SCREEN_SHARE or roomAdmin-ish fields
    const base = studentPermission(false);
    const granted = floorPermission(base, false, true);
    expect(sourcesOf(granted).sort()).toEqual([TrackSource.CAMERA, TrackSource.MICROPHONE].sort());
    expect(granted).not.toHaveProperty('roomAdmin');
    expect(granted.canSubscribe).toBe(base.canSubscribe);
    expect(granted.canPublishData).toBe(base.canPublishData);
  });

  it('a participant whose permission could not be read gets the lesson baseline plus the mic', () => {
    // LiveKit answers without a permission object for a participant that is not really there; the
    // route refuses the grant in that case, and this is what a revoke still restores correctly.
    const p = floorPermission(undefined, true, false);
    expect(p).toEqual(studentPermission(true));
    const granted = floorPermission(undefined, true, true);
    expect(granted.canPublish).toBe(true);
    expect(sourcesOf(granted)).toEqual([TrackSource.MICROPHONE]);
  });
});
