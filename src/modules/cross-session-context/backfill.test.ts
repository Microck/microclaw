import { describe, expect, it } from 'vitest';
import { selectEchoTargets, selectHotSessions, truncateEchoText, buildDeliveredEchoLabel } from './fan.js';
import { ECHO_MAX_AGE_MS, HOT_SESSION_LIMIT } from './config.js';

/** Ranking receives candidates already scoped by the database to one exact conversation. */
describe('bounded context selection within a conversation', () => {
  const now = Date.now();
  const candidate = (id: string, age = 0) => ({
    id,
    status: 'active',
    messaging_group_id: 'room',
    thread_id: 'thread-a',
    last_active: new Date(now - age).toISOString(),
  });
  it('excludes the source, closed, stale and unrelated audience candidates', () => {
    const rows = [
      candidate('source'),
      candidate('target'),
      { ...candidate('closed'), status: 'closed' },
      candidate('stale', ECHO_MAX_AGE_MS + 1),
      { ...candidate('foreign'), messaging_group_id: 'elsewhere' },
    ];
    expect(selectEchoTargets(rows, 'source', 'room', now).map((s) => s.id)).toEqual(['target']);
  });
  it('bounds context work and excludes duplicate candidates', () => {
    const rows = Array.from({ length: 20 }, (_, i) => candidate(String(i), i * 1000));
    expect(selectHotSessions([...rows, rows[0]], 'room', now).map((s) => s.id)).toEqual(
      Array.from({ length: HOT_SESSION_LIMIT }, (_, i) => String(i)),
    );
  });
  it('keeps the text budget and identifies an actual scheduled delivery', () => {
    expect(truncateEchoText('short')).toBe('short');
    expect(truncateEchoText('x'.repeat(600))).toHaveLength(501);
    expect(buildDeliveredEchoLabel({ is_group: 1 }, true)).toBe('this room, posted by your scheduled task');
  });
});
