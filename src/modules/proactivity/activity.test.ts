import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { initSessionFolder, withMailboxSession, destroySessionMailbox } from '../../session-manager.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../mailbox/sqlite/schema.js';
import { wrapSqliteInbound, wrapSqliteOutbound } from '../../mailbox/sqlite/index.js';
import { readActivitySnapshot } from '../../mailbox/sqlite/activity.js';
import type { MailboxSession } from '../../mailbox/types.js';
import type { Session } from '../../types.js';
import { activityCursor, ReviewLedger, type ReviewDecision } from './ledger.js';
import { insertContinuation, insertMailReview, ensureNotificationDestination } from './activity.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
const start = '2026-10-19T10:00:00.000Z';
const later = '2026-10-19T10:06:00.000Z';
const decision: ReviewDecision = {
  action: 'investigate',
  reason: 'Repair the requested failed build.',
  evidence: ['build exited 1'],
  followUpAfterSeconds: null,
};
const session: Session = {
  id: 'session-a',
  agent_group_id: 'agent',
  messaging_group_id: 'discord-home',
  thread_id: 'discord:123:456:789',
  agent_provider: null,
  status: 'active',
  container_status: 'idle',
  created_at: start,
  last_active: start,
};

async function fixture() {
  const inbound = new Database(':memory:');
  const outbound = new Database(':memory:');
  inbound.exec(INBOUND_SCHEMA);
  outbound.exec(OUTBOUND_SCHEMA);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-review-'));
  const ledger = new ReviewLedger(dir);
  cleanup.push(() => {
    inbound.close();
    outbound.close();
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const mailbox: MailboxSession = {
    ...wrapSqliteInbound(inbound),
    ...wrapSqliteOutbound(
      () => outbound,
      () => outbound,
    ),
    getActivitySnapshot: (cursor) => readActivitySnapshot(inbound, outbound, cursor),
    hasInboundMessage: (id) => Boolean(inbound.prepare('SELECT 1 FROM messages_in WHERE id=?').get(id)),
  };
  const input = async (id: string) =>
    mailbox.insertMessage({
      id,
      kind: 'chat',
      timestamp: start,
      platformId: 'discord:123:456',
      channelType: 'discord',
      threadId: session.thread_id,
      content: JSON.stringify({ text: 'Build and fix this project', attachments: [{ data: 'PRIVATE_ATTACHMENT' }] }),
      processAfter: null,
      recurrence: null,
      trigger: true,
    });
  await input('user-a');
  inbound.prepare("UPDATE messages_in SET status='completed'").run();
  const snapshot = () => mailbox.getActivitySnapshot(activityCursor(ledger.watch(session.id)));
  ledger.collectSession(session.id, snapshot(), start);
  let resultCount = 0;
  const result = async (text = 'build exited 1') =>
    mailbox.writeDirect({
      id: `result-${resultCount++}`,
      kind: 'agent_observation',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ name: 'terminal', result: text }),
    });
  const reviewed = async () => {
    await result();
    expect(ledger.collectSession(session.id, snapshot(), later)).toBe(true);
    const event = ledger.next(later)!;
    ledger.finish(
      event.id,
      ledger.begin(event.id, later, 100)!,
      decision,
      { inputTokens: 100, outputTokens: 20 },
      later,
    );
    return event;
  };
  return { inbound, outbound, ledger, mailbox, input, snapshot, result, reviewed };
}

test('baselines history, retains busy activity, and queues changes once without attachments', async () => {
  const f = await fixture();
  expect(f.ledger.next(later)).toBeUndefined();
  await f.result();
  f.outbound.prepare("INSERT INTO processing_ack VALUES ('user-a','processing',?)").run(start);
  expect(f.ledger.collectSession(session.id, f.snapshot(), later)).toBe(false);
  f.outbound.prepare("UPDATE processing_ack SET status='completed'").run();
  expect(f.ledger.collectSession(session.id, f.snapshot(), later)).toBe(true);
  const event = f.ledger.next(later)!;
  expect(event.payload).toContain('build exited 1');
  expect(event.payload).not.toContain('PRIVATE_ATTACHMENT');
  f.ledger.finish(
    event.id,
    f.ledger.begin(event.id, later, 10)!,
    { ...decision, action: 'ignore' },
    { inputTokens: 10, outputTokens: 5 },
    later,
  );
  expect(f.ledger.collectSession(session.id, f.snapshot(), later)).toBe(false);
});
test('reviews the first turn of a new conversation', async () => {
  const f = await fixture();
  const snap = f.mailbox.getActivitySnapshot({ inbound: 0, outbound: 0 });
  expect(f.ledger.collectSession('new-session', snap, later)).toBe(true);
  expect(f.ledger.next(later)?.origin_id).toBe('user-a');
});
test('retains the exact thread and survives the insertion/ledger crash window', async () => {
  const f = await fixture();
  const event = await f.reviewed();
  const watch = f.ledger.watch(session.id)!;
  expect((await insertContinuation(f.mailbox, session, event, watch, decision, false, later)).state).toBe('admitted');
  expect((await insertContinuation(f.mailbox, session, event, watch, decision, false, later)).state).toBe('admitted');
  const rows = f.inbound
    .prepare("SELECT platform_id,thread_id,content FROM messages_in WHERE kind='system'")
    .all() as Array<{ platform_id: string; thread_id: string; content: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0].thread_id).toBe(session.thread_id);
  expect(rows[0].platform_id).toBe('discord:123:456');
  expect(rows[0].content).toContain('untrusted report');
});
test('stop cancels queued continuations and persists until a new user request', async () => {
  const f = await fixture();
  const event = await f.reviewed();
  const watch = f.ledger.watch(session.id)!;
  await insertContinuation(f.mailbox, session, event, watch, decision, false, later);
  f.mailbox.cancelConversation('2026-10-19T10:07:00.000Z');
  expect(f.mailbox.getActivitySnapshot().stopped).toBe(true);
  expect(f.inbound.prepare('SELECT status FROM messages_in WHERE id=?').get(`proactive-${event.id}`)).toEqual({
    status: 'cancelled',
  });
  f.ledger.collectSession(session.id, f.snapshot(), '2026-10-19T10:08:00.000Z');
  expect(f.ledger.pendingWakes()).toHaveLength(0);
  await f.input('user-b');
  expect(f.mailbox.getActivitySnapshot().stopped).toBe(false);
});
test.each(['busy', 'waiting_for_user', 'closed', 'superseded', 'wake_limit', 'duplicate', 'cooldown'])(
  'blocks continuation when %s',
  async (condition) => {
    const f = await fixture();
    const event = await f.reviewed();
    const watch = { ...f.ledger.watch(session.id)! };
    let target = session;
    if (condition === 'busy')
      f.outbound.prepare("INSERT INTO processing_ack VALUES ('user-a','processing',?)").run(later);
    if (condition === 'closed') target = { ...session, status: 'closed' };
    if (condition === 'superseded') {
      await f.input('user-b');
      f.inbound.prepare("UPDATE messages_in SET status='completed'").run();
    }
    if (condition === 'wake_limit') watch.wakes = 3;
    if (condition === 'cooldown') watch.last_wake = later;
    if (condition === 'duplicate') {
      const admitted = await insertContinuation(f.mailbox, session, event, watch, decision, false, later);
      watch.fingerprint = admitted.fingerprint;
      f.inbound.prepare('DELETE FROM messages_in WHERE id=?').run(`proactive-${event.id}`);
    }
    expect(
      (await insertContinuation(f.mailbox, target, event, watch, decision, condition === 'waiting_for_user', later))
        .state,
    ).toBe(condition);
    expect(f.inbound.prepare("SELECT count(*) AS count FROM messages_in WHERE kind='system'").get()).toEqual({
      count: 0,
    });
  },
);
test('pending commitments retain evidence and stop after three timer reviews', async () => {
  const f = await fixture();
  await f.result('Build still running in background');
  f.ledger.collectSession(session.id, f.snapshot(), later);
  for (let i = 0; i <= 3; i++) {
    const now = `2026-10-19T10:${String(6 + i * 3).padStart(2, '0')}:00.000Z`;
    const event = f.ledger.next(now)!;
    expect(event).toBeDefined();
    if (i > 0) expect(event.payload).toContain('Build still running');
    f.ledger.finish(
      event.id,
      f.ledger.begin(event.id, now, 100)!,
      { action: 'investigate', reason: 'Wait for build', evidence: ['Build still running'], followUpAfterSeconds: 120 },
      { inputTokens: 10, outputTokens: 5 },
      now,
    );
    expect(f.ledger.pendingWakes()).toHaveLength(0);
    expect(
      f.ledger.collectSession(session.id, f.snapshot(), `2026-10-19T10:${String(9 + i * 3).padStart(2, '0')}:00.000Z`),
    ).toBe(i < 3);
  }
});

test('routes automatic follow-ups to the configured DM without changing the session', async () => {
  const f = await fixture();
  const event = await f.reviewed();
  const watch = f.ledger.watch(session.id)!;
  const destination = { channelType: 'discord', platformId: 'discord:@me:987', threadId: null };
  expect((await insertContinuation(f.mailbox, session, event, watch, decision, false, later, destination)).state).toBe(
    'admitted',
  );
  const row = f.inbound.prepare("SELECT platform_id,thread_id FROM messages_in WHERE kind='system'").get();
  expect(row).toEqual({ platform_id: 'discord:@me:987', thread_id: null });
  expect(session.thread_id).not.toBeNull();
});

test('mail alerts require verification in DM and remain idempotent', async () => {
  const f = await fixture();
  const event = {
    id: 'mail-proof',
    source: 'mail' as const,
    payload: JSON.stringify({ id: '24', subject: 'Order' }),
    session_id: null,
    origin_id: null,
    attempts: 1,
    decision: JSON.stringify(decision),
  };
  const destination = {
    agentGroupId: 'g1',
    messagingGroupId: 'dm',
    channelType: 'discord',
    platformId: 'discord:@me:987',
    threadId: null,
    emailAccount: 'mail',
  };
  expect(await insertMailReview(f.mailbox, event, destination, later)).toBe('admitted');
  expect(await insertMailReview(f.mailbox, event, destination, later)).toBe('admitted');
  const rows = f.inbound
    .prepare("SELECT platform_id,thread_id,content FROM messages_in WHERE kind='system'")
    .all() as Array<{ platform_id: string; thread_id: string | null; content: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0].platform_id).toBe(destination.platformId);
  expect(rows[0].thread_id).toBeNull();
  expect(rows[0].content).toContain('--preview');
  expect(rows[0].content).toContain('untrusted data');
});

test('other personalities can address the owner DM in existing sessions without inbound rewiring', async () => {
  const db = await initTestDb();
  const groupId = 'proactive-dm-agent-proof';
  const sessionIds = ['proactive-dm-session-a', 'proactive-dm-session-b'];
  try {
    await runMigrations(db);
    await createAgentGroup({
      id: groupId,
      name: 'Other personality',
      folder: groupId,
      agent_provider: null,
      created_at: start,
    });
    await createMessagingGroup({
      id: 'owner-dm-proof',
      channel_type: 'discord',
      platform_id: 'discord:@me:987',
      name: 'Owner',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: start,
    });
    for (const id of sessionIds) {
      await createSession({ ...session, id, agent_group_id: groupId, messaging_group_id: null });
      initSessionFolder(groupId, id);
    }
    const destination = {
      agentGroupId: groupId,
      messagingGroupId: 'owner-dm-proof',
      channelType: 'discord',
      platformId: 'discord:@me:987',
      threadId: null,
    };
    await ensureNotificationDestination({ id: sessionIds[0], agent_group_id: groupId }, destination, later);
    // A prior process can commit the ACL and exit before every projection is written.
    await withMailboxSession(groupId, sessionIds[0], (mailbox) => mailbox.replaceDestinations([]));
    await ensureNotificationDestination({ id: sessionIds[0], agent_group_id: groupId }, destination, later);
    for (const id of sessionIds) {
      const inbound = new Database(inboundDbPath(groupId, id), { readonly: true });
      try {
        expect(inbound.prepare('SELECT name,platform_id FROM destinations').all()).toEqual([
          { name: 'proactive-owner-dm', platform_id: destination.platformId },
        ]);
      } finally {
        inbound.close();
      }
    }
    expect(await db.all('SELECT * FROM messaging_group_agents')).toEqual([]);
  } finally {
    for (const id of sessionIds) await destroySessionMailbox(groupId, id);
    await closeDb();
  }
});
