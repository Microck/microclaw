import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_DIR } from '../../config.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder, withExistingMailboxSession } from '../../session-manager.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import { fanInboundMessage, fanOutboundMessage, settleEchoFans } from './fan.js';
import { backfillSession } from './backfill.js';

let group: AgentGroup;
let room: MessagingGroup;
let sessions: Record<string, Session>;
const now = () => new Date().toISOString();
function echoRows(id: string): Array<{ content: string; trigger: number; source_session_id: string }> {
  const db = new Database(inboundDbPath(group.id, id), { readonly: true });
  try {
    return db
      .prepare("SELECT content,trigger,source_session_id FROM messages_in WHERE channel_type='session-echo'")
      .all() as ReturnType<typeof echoRows>;
  } finally {
    db.close();
  }
}
async function addSession(name: string, thread: string | null, mg: string | null = room.id): Promise<Session> {
  const session: Session = {
    id: randomUUID(),
    agent_group_id: group.id,
    messaging_group_id: mg,
    thread_id: thread,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
  initSessionFolder(group.id, session.id);
  sessions[name] = session;
  return session;
}
beforeEach(async () => {
  await runMigrations(await initTestDb());
  group = {
    id: randomUUID(),
    name: 'Assistant',
    folder: 'fixture-' + randomUUID(),
    agent_provider: null,
    created_at: now(),
  };
  await createAgentGroup(group);
  room = {
    id: randomUUID(),
    channel_type: 'discord',
    platform_id: 'discord:123:456',
    instance: 'discord',
    name: 'Home',
    is_group: 1,
    unknown_sender_policy: 'strict',
    denied_at: null,
    created_at: now(),
  };
  await createMessagingGroup(room);
  sessions = {};
  await addSession('parent', null);
  await addSession('a', 'thread-a');
  await addSession('b', 'thread-b');
  await addSession('task', 'system:tasks:fixture', null);
});
afterEach(async () => {
  await settleEchoFans();
  await closeDb();
  fs.rmSync(path.join(DATA_DIR, 'v2-sessions', group.id), { recursive: true, force: true });
});
function delivered(id: string, thread: string | null) {
  return {
    id,
    kind: 'chat',
    platform_id: room.platform_id,
    channel_type: room.channel_type,
    thread_id: thread,
    content: JSON.stringify({ text: id }),
  };
}

describe('conversation context belongs to an exact thread', () => {
  it('never copies a user message into another thread or the parent channel', async () => {
    const written = await fanInboundMessage({
      session: sessions.a,
      mg: room,
      messageId: 'private-a',
      kind: 'chat-sdk',
      channelType: 'discord',
      content: JSON.stringify({ text: 'Only task A', sender: 'Owner', senderId: 'owner' }),
      timestamp: now(),
    });
    expect(written).toBe(0);
    for (const s of Object.values(sessions)) expect(echoRows(s.id)).toEqual([]);
  });
  it('never copies a reply into sibling threads, in either direction', async () => {
    expect(await fanOutboundMessage(delivered('reply-a', 'thread-a'), sessions.a, group)).toBe(0);
    expect(await fanOutboundMessage(delivered('parent-reply', null), sessions.parent, group)).toBe(0);
    for (const s of Object.values(sessions)) expect(echoRows(s.id)).toEqual([]);
  });
  it('records a scheduled notification only in its actual destination thread', async () => {
    const before = (await getSession(sessions.a.id))!.last_active;
    expect(await fanOutboundMessage(delivered('task-notification', 'thread-a'), sessions.task, group)).toBe(1);
    const rows = echoRows(sessions.a.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('task-notification');
    expect(rows[0].trigger).toBe(0);
    expect(rows[0].source_session_id).toBe(sessions.task.id);
    expect((await getSession(sessions.a.id))!.last_active).toBe(before);
    for (const name of ['parent', 'b', 'task']) expect(echoRows(sessions[name].id)).toEqual([]);
  });
  it('keeps a top-level scheduled notification out of every thread', async () => {
    expect(await fanOutboundMessage(delivered('parent-notification', null), sessions.task, group)).toBe(1);
    expect(echoRows(sessions.parent.id)).toHaveLength(1);
    expect(echoRows(sessions.a.id)).toEqual([]);
    expect(echoRows(sessions.b.id)).toEqual([]);
  });
  it('does not seed a fresh thread with another thread opener or parent-channel posts', async () => {
    await withExistingMailboxSession(group.id, sessions.a.id, (mailbox) =>
      mailbox.insertMessage({
        id: 'a-root',
        kind: 'chat',
        timestamp: now(),
        platformId: room.platform_id,
        channelType: 'discord',
        threadId: 'thread-a',
        content: JSON.stringify({ text: 'Secret task A', sender: 'Owner' }),
        processAfter: null,
        recurrence: null,
        trigger: true,
        sourceSessionId: null,
        onWake: false,
      }),
    );
    await fanOutboundMessage(delivered('parent-post', null), sessions.task, group);
    expect(echoRows(sessions.parent.id)).toHaveLength(1);
    const fresh = await addSession('fresh', 'thread-fresh');
    await backfillSession(group, fresh, room, { created: true });
    expect(echoRows(fresh.id)).toEqual([]);
  });
  it('does not seed an idle thread with newer activity from its siblings', async () => {
    const idle = { ...sessions.b, last_active: new Date(Date.now() - 2 * 86400000).toISOString() };
    await fanOutboundMessage(delivered('newer-task-a', 'thread-a'), sessions.task, group);
    await backfillSession(group, idle, room, { created: false });
    expect(echoRows(idle.id)).toEqual([]);
  });
});
