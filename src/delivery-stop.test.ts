import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import { createMessagingGroup } from './db/messaging-groups.js';
import { resolveSession, withMailboxSession } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter, withSessionDeliveryPaused } from './delivery.js';
import './provider-contracts/index.js';

it('stops a cached delivery batch and flushes the replacement without another poll', async () => {
  const groupId = randomUUID();
  const folder = `delivery-stop-${groupId}`;
  const db = await initTestDb();
  await runMigrations(db);
  let release!: () => void;
  let started!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const sendBlocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: string[] = [];
  try {
    await createAgentGroup({
      id: groupId,
      name: 'Fixture',
      folder,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const messagingGroupId = randomUUID();
    await createMessagingGroup({
      id: messagingGroupId,
      channel_type: 'discord',
      platform_id: `discord:123:${groupId}`,
      name: 'Fixture',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    const { session } = await resolveSession(groupId, messagingGroupId, null, 'per-thread');
    await withMailboxSession(groupId, session.id, async (mailbox) => {
      for (const text of ['already-sending', 'must-be-suppressed'])
        await mailbox.writeDirect({
          id: randomUUID(),
          kind: 'chat',
          channelType: 'discord',
          platformId: `discord:123:${groupId}`,
          threadId: null,
          content: JSON.stringify({ text }),
        });
    });
    setDeliveryAdapter({
      async deliver(_type, _platform, _thread, _kind, content) {
        const text = JSON.parse(content).text;
        sent.push(text);
        if (text === 'already-sending') {
          started();
          await sendBlocked;
        }
        return randomUUID();
      },
    });
    const draining = deliverSessionMessages(session);
    await sendStarted;
    const cancelled = withSessionDeliveryPaused(session.id, async () => {
      await withMailboxSession(groupId, session.id, async (mailbox) => {
        for (const message of mailbox.getDueMessages(mailbox.getDeliveredIds())) mailbox.markDeliveryFailed(message.id);
        await mailbox.writeDirect({
          id: randomUUID(),
          kind: 'chat',
          channelType: 'discord',
          platformId: `discord:123:${groupId}`,
          threadId: null,
          content: JSON.stringify({ text: 'Stopped.' }),
        });
      });
    });
    release();
    await Promise.all([draining, cancelled]);
    await deliverSessionMessages(session);
    expect(sent).toEqual(['already-sending', 'Stopped.']);
  } finally {
    release?.();
    await closeDb();
    fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, 'v2-sessions', groupId), { recursive: true, force: true });
  }
});
