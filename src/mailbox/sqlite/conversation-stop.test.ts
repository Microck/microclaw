import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { INBOUND_SCHEMA } from './schema.js';
import { wrapSqliteInbound } from './index.js';
import { parseIsoTimestamp } from '../model.js';

it('cancels active and steered inputs, keeps history, and preserves later input and schedules', async () => {
  const db = new Database(':memory:');
  db.exec(INBOUND_SCHEMA);
  try {
    let seq = 0;
    const mailbox = wrapSqliteInbound(db, () => ++seq);
    const target = { platformId: 'discord:123:456', messageId: '123456789012345678' };
    const insert = async (
      id: string,
      timestamp: string,
      content = JSON.stringify({ text: id, feedbackTarget: target }),
    ) =>
      mailbox.insertMessage({
        id,
        kind: 'chat',
        timestamp,
        platformId: target.platformId,
        channelType: 'discord',
        threadId: 'thread',
        content,
        processAfter: null,
        recurrence: null,
        trigger: true,
      });
    await insert('old', '2026-10-15T10:00:00.000Z');
    db.prepare("UPDATE messages_in SET status='completed' WHERE id='old'").run();
    await insert('active', '2026-10-15T11:00:00.000Z');
    await insert('steered', '2026-10-15T11:00:01.000Z');
    db.prepare("UPDATE messages_in SET status='completed' WHERE id='steered'").run();
    await insert('plain', '2026-10-15T11:00:02.000Z', 'plain text');
    await insert('later', '2026-10-15T11:01:01.000Z');
    await mailbox.insertTask({
      id: 'reminder',
      seriesId: 'reminder',
      content: '{}',
      processAfter: '2099-01-01T00:00:00.000Z',
      recurrence: null,
    });
    expect(mailbox.cancelConversation('2026-10-15T11:01:00.000Z')).toEqual([target, target]);
    mailbox.applyProcessingAcks([
      { messageId: 'active', status: 'completed', statusChanged: parseIsoTimestamp('2026-10-15T11:02:00.000Z') },
    ]);
    expect(db.prepare('SELECT id,status FROM messages_in ORDER BY seq').all()).toEqual([
      { id: 'old', status: 'completed' },
      { id: 'active', status: 'cancelled' },
      { id: 'steered', status: 'cancelled' },
      { id: 'plain', status: 'cancelled' },
      { id: 'later', status: 'pending' },
      { id: 'reminder', status: 'pending' },
      { id: 'proactive-stop-2026-10-15T11:01:00.000Z', status: 'completed' },
    ]);
    expect(mailbox.getInboundHistory(20)).toHaveLength(7);
  } finally {
    db.close();
  }
});
