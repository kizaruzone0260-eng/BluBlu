import { describe, it, expect } from 'vitest';
import { injectBuildMeta, currentBuildId } from '../../src/lib/build.js';

describe('build stamp (task 1)', () => {
  it('replaces the placeholder meta content only', () => {
    const html = '<head><meta name="app-build" content="dev" /><title>x</title></head>';
    expect(injectBuildMeta(html, '826555f')).toContain('content="826555f"');
    expect(injectBuildMeta(html, '826555f')).toContain('<title>x</title>');
    // unknown build → shell untouched
    expect(injectBuildMeta('<p>no meta</p>', 'abc1234')).toBe('<p>no meta</p>');
  });

  it('only accepts a real hex commit; anything else is "dev"', () => {
    const prev = process.env.RENDER_GIT_COMMIT;
    try {
      process.env.RENDER_GIT_COMMIT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      expect(currentBuildId()).toBe('a1b2c3d');
      process.env.RENDER_GIT_COMMIT = '';
      expect(currentBuildId()).toBe('dev');
      process.env.RENDER_GIT_COMMIT = 'not-a-hash';
      expect(currentBuildId()).toBe('dev');
    } finally {
      if (prev === undefined) delete process.env.RENDER_GIT_COMMIT;
      else process.env.RENDER_GIT_COMMIT = prev;
    }
  });
});
