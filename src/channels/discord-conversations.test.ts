import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DiscordConversations, type ConversationInteraction } from './discord-conversations.js';
import { initTestDb, closeDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { resolveSession, sessionDir, withExistingMailboxSession } from '../session-manager.js';
import { getSessionsByAgentGroup, updateSession } from '../db/sessions.js';
import type { Session } from '../types.js';
import '../modules/index.js';

const GUILD = '123456789012345678';
const PARENT = '223456789012345678';
const THREAD = '323456789012345678';
const FORK = '423456789012345678';
const OWNER = '523456789012345678';
let groupId: string;
let messagingId: string;
let session: Session;
let controller: DiscordConversations;
let calls: Array<{ route: string; method: string; body?: unknown }>;
let wakes: string[];
function interaction(name: string, options: Record<string, string | number> = {}): ConversationInteraction {
  return {
    id: randomUUID(),
    token: 'fixture',
    type: 2,
    application_id: 'app',
    guild_id: GUILD,
    channel_id: THREAD,
    data: { name, options: Object.entries(options).map(([name, value]) => ({ name, value })) },
  };
}
beforeEach(async () => {
  await runMigrations(await initTestDb());
  groupId = randomUUID();
  messagingId = randomUUID();
  await createAgentGroup({
    id: groupId,
    name: 'Researcher',
    folder: `fixture-${groupId}`,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createMessagingGroup({
    id: messagingId,
    channel_type: 'discord',
    platform_id: `discord:${GUILD}:${PARENT}`,
    instance: 'discord',
    name: 'home',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
  await createMessagingGroupAgent({
    id: randomUUID(),
    ignored_message_policy: 'drop',
    messaging_group_id: messagingId,
    agent_group_id: groupId,
    session_mode: 'per-thread',
    engage_mode: 'pattern',
    engage_pattern: '.',
    priority: 0,
    sender_scope: 'all',
    created_at: new Date().toISOString(),
  });
  ({ session } = await resolveSession(groupId, messagingId, `discord:${GUILD}:${PARENT}:${THREAD}`, 'per-thread'));
  await updateSession(session.id, { agent_provider: 'codex' });
  calls = [];
  wakes = [];
  controller = new DiscordConversations(
    GUILD,
    async <T>(route: string, method: string, body?: unknown) => {
      calls.push({ route, method, body });
      if (route === `channels/${PARENT}/threads`) return { id: FORK } as T;
      if (route === `channels/${THREAD}`) return { type: 11, parent_id: PARENT, name: 'Original conversation' } as T;
      if (route === `channels/${PARENT}`) return { type: 0, name: 'home' } as T;
      return { id: 'message', type: 11, parent_id: PARENT, name: 'Side question' } as T;
    },
    async (session) => {
      wakes.push(session.id);
      return true;
    },
  );
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(path.dirname(sessionDir(groupId, 'unused')), { recursive: true, force: true });
});

describe('Discord conversation commands', () => {
  it('persists queued inputs across command instances and edits/removes them through native modals', async () => {
    const queued = interaction('queue', { message: 'Do this later' });
    expect((await controller.command(queued, OWNER)).content).toContain('Do this later');
    const pending = await withExistingMailboxSession(groupId, session.id, (mailbox) => mailbox.getQueuedInputs());
    expect(pending).toEqual([{ id: queued.id, text: 'Do this later' }]);
    const edit = { ...interaction(''), type: 3, data: { custom_id: `ncc:edit:${queued.id}` } };
    expect(await controller.editModal(edit)).toMatchObject({ type: 9 });
    await controller.command(
      {
        ...edit,
        type: 5,
        data: {
          custom_id: `ncc:save:${queued.id}`,
          components: [{ components: [{ custom_id: 'text', value: 'Updated request' }] }],
        },
      },
      OWNER,
    );
    expect((await controller.command(interaction('queue'), OWNER)).content).toContain('Updated request');
    await controller.command({ ...edit, data: { custom_id: `ncc:remove:${queued.id}` } }, OWNER);
    expect((await controller.command(interaction('queue'), OWNER)).content).toContain('No pending');
    expect(wakes).toEqual([session.id]);
  });
  it('refuses editing a claimed input and clear-queue preserves the active turn', async () => {
    const active = interaction('queue', { message: 'Started' });
    await controller.command(active, OWNER);
    const outbound = new Database(path.join(sessionDir(groupId, session.id), 'outbound.db'));
    outbound
      .prepare("INSERT INTO processing_ack(message_id,status,status_changed) VALUES (?, 'processing', ?)")
      .run(active.id, new Date().toISOString());
    outbound.close();
    await expect(
      controller.command({ ...interaction(''), type: 3, data: { custom_id: `ncc:remove:${active.id}` } }, OWNER),
    ).rejects.toThrow('already started');
    await controller.command(interaction('queue', { message: 'Still pending' }), OWNER);
    await controller.command(interaction('clear-queue'), OWNER);
    expect(await withExistingMailboxSession(groupId, session.id, (mailbox) => mailbox.getQueuedInputs())).toEqual([
      { id: active.id, text: 'Started' },
    ]);
  });
  it('creates a sibling fork with a new mailbox, native context reference, and only the side question', async () => {
    const outbound = new Database(path.join(sessionDir(groupId, session.id), 'outbound.db'));
    outbound
      .prepare('INSERT INTO session_state(key,value,updated_at) VALUES (?,?,?)')
      .run('continuation:codex', 'codex-original', new Date().toISOString());
    outbound.close();
    const result = await controller.command(interaction('btw', { question: 'Why Next.js?' }), OWNER);
    expect(result.content).toContain(FORK);
    const sessions = await getSessionsByAgentGroup(groupId);
    const fork = sessions.find((item) => item.id !== session.id)!;
    expect(fork.thread_id).toBe(`discord:${GUILD}:${PARENT}:${FORK}`);
    const history = await withExistingMailboxSession(groupId, fork.id, (mailbox) => mailbox.getInboundHistory(10));
    const payload = JSON.parse(history![0].content);
    expect(payload.forkFrom).toBe('codex-original');
    expect(payload.text).toContain('Answer only the side question');
    expect(payload.text).toContain('Why Next.js?');
    expect(wakes).toEqual([fork.id]);
    expect(calls.some((call) => call.route === `channels/${PARENT}/threads` && call.method === 'POST')).toBe(true);
  });
  it('refuses a fork without native history and resumes only sessions in the same channel', async () => {
    await expect(controller.command(interaction('btw', { question: 'Side question' }), OWNER)).rejects.toThrow(
      'Wait for this Codex',
    );
    const picker = await controller.command(interaction('resume'), OWNER);
    expect(picker.components).toHaveLength(1);
    await expect(
      controller.command(
        { ...interaction(''), type: 3, data: { custom_id: 'ncc:resume', values: ['unrelated-session'] } },
        OWNER,
      ),
    ).rejects.toThrow('this agent and channel');
    const resumed = await controller.command(
      { ...interaction(''), type: 3, data: { custom_id: 'ncc:resume', values: [session.id] } },
      OWNER,
    );
    expect(resumed.content).toContain(THREAD);
    expect(calls).toContainEqual({ route: `channels/${THREAD}`, method: 'PATCH', body: { archived: false } });
    expect(wakes).toEqual([]);
  });
});

it('keeps valid resume choices when another thread has been deleted', async () => {
  const { session: missing } = await resolveSession(
    groupId,
    messagingId,
    `discord:${GUILD}:${PARENT}:${FORK}`,
    'per-thread',
  );
  const controller = new DiscordConversations(GUILD, async <T>(route: string) => {
    if (route === `channels/${THREAD}`) return { type: 11, parent_id: PARENT, name: 'Available thread' } as T;
    if (route === `channels/${FORK}`) throw Object.assign(new Error('Deleted'), { status: 404 });
    throw new Error('Unexpected route');
  });
  const picker = await controller.command(interaction('resume'), OWNER);
  expect(JSON.stringify(picker.components)).toContain(session.id);
  expect(JSON.stringify(picker.components)).not.toContain(missing.id);
});
