import { Card, Actions, Button } from 'chat';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryOutcomeUnknownError } from './adapter.js';

const receiptDirectories: string[] = [];
afterEach(() => {
  for (const directory of receiptDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
import { DiscordIdentity } from './discord-identity.js';

const BOT = '123456789012345678';
const PARENT = '223456789012345678';
const THREAD = '323456789012345678';
const ADDRESS = `discord:423456789012345678:${PARENT}:${THREAD}`;

/** Real SDK rendering, with an in-memory Discord HTTP service. */
class DiscordService {
  requests: Array<{ path: string; method: string; body: Record<string, unknown>; files?: FormData }> = [];
  created = 0;
  failRoles = false;
  sendFailure: 'accepted-timeout' | 'body-timeout' | 'rejected' | undefined;
  accepted = 0;
  authorId = '723456789012345678';
  authorIsBot = false;
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const form = init?.body instanceof FormData ? init.body : undefined;
    const body = JSON.parse(String(form?.get('payload_json') ?? init?.body ?? '{}')) as Record<string, unknown>;
    this.requests.push({ path: url.pathname + url.search, method: init?.method ?? 'GET', body, files: form });
    const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (init?.method === 'GET' && /^\/api\/v10\/channels\/[0-9]+\/messages\/[0-9]+$/.test(url.pathname))
      return reply({ webhook_id: this.hook.id, author: { id: this.authorId, bot: this.authorIsBot } });
    if (init?.method === 'POST' && url.pathname.endsWith('/threads')) return reply({ id: THREAD, name: body.name });
    if (url.pathname.endsWith('/roles'))
      return reply([{ id: 'own-role', tags: { bot_id: BOT } }, { id: 'unrelated-role' }], this.failRoles ? 403 : 200);
    if (url.pathname.endsWith('/webhooks')) {
      if (init?.method === 'GET') return reply(this.created ? [this.hook] : []);
      this.created++;
      return reply(this.hook);
    }
    if (url.pathname.includes('/webhooks/') || (init?.method === 'POST' && url.pathname.endsWith('/messages'))) {
      if (this.sendFailure === 'rejected') return reply({ message: 'Rate limited' }, 429);
      this.accepted++;
      if (this.sendFailure === 'accepted-timeout')
        throw new DOMException('Fixture acknowledgement lost', 'TimeoutError');
      if (this.sendFailure === 'body-timeout')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException('Fixture body lost', 'TimeoutError'));
            },
          }),
        );
      return reply({ id: '523456789012345678', ...body });
    }
    if (init?.method === 'GET') return reply({ webhook_id: this.hook.id });
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  hook = { id: '623456789012345678', token: 'fixture-only', name: 'NanoClaw agents', user: { id: BOT } };
}
function fixture(service = new DiscordService(), receipts = mkdtempSync(join(tmpdir(), 'discord-receipts-'))) {
  if (!receiptDirectories.includes(receipts)) receiptDirectories.push(receipts);
  const adapter = createDiscordAdapter({ botToken: 'fixture-token', applicationId: BOT, publicKey: '0'.repeat(64) });
  // This service replaces HTTP, not SDK behavior or a module.
  (
    adapter as unknown as { discordFetch: (path: string, method: string, body?: unknown) => Promise<Response> }
  ).discordFetch = (path, method, body) =>
    service.fetch(`https://discord.com/api/v10${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const identity = new DiscordIdentity('fixture-token', BOT, service.fetch, receipts);
  identity.install(adapter);
  return { adapter, identity, service, receipts };
}

describe('Discord sender identity and role mentions', () => {
  it('keeps concurrent agent names distinct and reuses one bot-owned channel webhook', async () => {
    const { adapter, identity, service } = fixture();
    await Promise.all(
      ['Researcher', 'Planner'].map((name) =>
        identity.run(ADDRESS, name, async () => {
          await Promise.resolve();
          await adapter.postMessage(ADDRESS, { markdown: `Hello from ${name}` });
        }),
      ),
    );
    expect(service.created).toBe(1);
    const posts = service.requests.filter((request) => request.path.includes('?wait='));
    expect(posts.map((post) => post.body.username).sort()).toEqual(['Planner', 'Researcher']);
    expect(posts.every((post) => post.path.includes(`thread_id=${THREAD}`))).toBe(true);
    expect(posts[0].body.allowed_mentions).toEqual({ parse: [], users: [], replied_user: false });
    // A process restart rediscovers the same hook rather than provisioning another.
    const restarted = fixture(service);
    await restarted.identity.run(ADDRESS, 'Researcher', () =>
      restarted.adapter.postMessage(ADDRESS, { markdown: 'After restart' }),
    );
    expect(service.created).toBe(1);
  });

  it('sends file bytes and edits previews through the matching webhook', async () => {
    const { adapter, identity, service } = fixture();
    await identity.run(ADDRESS, 'Researcher', async () => {
      await adapter.postMessage(ADDRESS, {
        markdown: 'File',
        files: [{ filename: 'proof.txt', data: Buffer.from('proof') }],
      });
      await adapter.editMessage(ADDRESS, '523456789012345678', { markdown: 'Updated preview' });
    });
    const upload = service.requests.find((request) => request.files)!;
    expect(upload.body.username).toBe('Researcher');
    expect(await (upload.files!.get('files[0]') as Blob).text()).toBe('proof');
    const edit = service.requests.find((request) => request.method === 'PATCH')!;
    expect(edit.path).toContain('/webhooks/');
    expect(edit.path).toContain(`thread_id=${THREAD}`);
    expect(edit.body.content).toBe('Updated preview');
  });

  it.each(['accepted-timeout', 'body-timeout'] as const)(
    'never replays an accepted POST after %s or a restart',
    async (failure) => {
      const { adapter, identity, service, receipts } = fixture();
      service.sendFailure = failure;
      await expect(
        identity.run(
          ADDRESS,
          'Researcher',
          () => adapter.postMessage(ADDRESS, { markdown: 'One answer' }),
          'outbound-1',
        ),
      ).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
      service.sendFailure = undefined;
      const restarted = fixture(service, receipts);
      await expect(
        restarted.identity.run(
          ADDRESS,
          'Researcher',
          () => restarted.adapter.postMessage(ADDRESS, { markdown: 'One answer' }),
          'outbound-1',
        ),
      ).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
      expect(service.accepted).toBe(1);
    },
  );

  it('reuses confirmed chunks across bookkeeping retries and permits distinct identical replies', async () => {
    const { adapter, identity, service, receipts } = fixture();
    const send = () => adapter.postMessage(ADDRESS, { markdown: 'Identical on purpose' });
    const original = await identity.run(ADDRESS, 'Researcher', send, 'outbound-1');
    const restarted = fixture(service, receipts);
    const repeated = await restarted.identity.run(
      ADDRESS,
      'Researcher',
      () => restarted.adapter.postMessage(ADDRESS, { markdown: 'Identical on purpose' }),
      'outbound-1',
    );
    expect(repeated.id).toBe(original.id);
    expect(service.accepted).toBe(1);
    await identity.run(ADDRESS, 'Researcher', send, 'outbound-2');
    expect(service.accepted).toBe(2);
  });

  it('replays a confirmed prefix locally when a later chunk has an uncertain outcome', async () => {
    const { adapter, identity, service } = fixture();
    await expect(
      identity.run(
        ADDRESS,
        'Researcher',
        async () => {
          await adapter.postMessage(ADDRESS, { markdown: 'First chunk' });
          service.sendFailure = 'accepted-timeout';
          await adapter.postMessage(ADDRESS, { markdown: 'Second chunk' });
        },
        'split-outbound',
      ),
    ).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
    service.sendFailure = undefined;
    await expect(
      identity.run(
        ADDRESS,
        'Researcher',
        async () => {
          await adapter.postMessage(ADDRESS, { markdown: 'First chunk' });
          await adapter.postMessage(ADDRESS, { markdown: 'Second chunk' });
        },
        'split-outbound',
      ),
    ).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
    expect(service.accepted).toBe(2);
  });

  it('releases receipts only after explicit durable settlement', async () => {
    const { adapter, identity, receipts } = fixture();
    await identity.run(ADDRESS, 'Researcher', () => adapter.postMessage(ADDRESS, { markdown: 'Done' }), 'outbound-1');
    expect(readdirSync(receipts)).toHaveLength(1);
    await identity.finalizeDelivery('outbound-1');
    expect(readdirSync(receipts)).toHaveLength(0);
  });

  it('retries affirmative client rejections without poisoning a receipt', async () => {
    const { adapter, identity, service } = fixture();
    const send = () =>
      identity.run(
        ADDRESS,
        'Researcher',
        () => adapter.postMessage(ADDRESS, { markdown: 'Retry safely' }),
        'outbound-1',
      );
    service.sendFailure = 'rejected';
    await expect(send()).rejects.toThrow('429');
    service.sendFailure = undefined;
    await send();
    expect(service.accepted).toBe(1);
  });

  it('recognizes only its own bot-managed role, and retries failed lookups', async () => {
    const { identity, service } = fixture();
    expect(await identity.recognizesRole('guild', [])).toBe(false);
    service.failRoles = true;
    await expect(identity.recognizesRole('guild', ['own-role'])).rejects.toThrow('403');
    service.failRoles = false;
    expect(await identity.recognizesRole('guild', ['own-role'])).toBe(true);
    expect(await identity.recognizesRole('guild', ['unrelated-role'])).toBe(false);
    expect(service.requests.filter((request) => request.path.endsWith('/roles'))).toHaveLength(2);
  });
});

describe('Discord answer replies', () => {
  const target = { platformId: `discord:423456789012345678:${PARENT}`, messageId: '823456789012345678' };
  it('keeps the actual result inside its thread once across a restart', async () => {
    const { identity, adapter, service, receipts } = fixture();
    const result = { markdown: 'The project is deployed. https://example.com' };
    await identity.run(ADDRESS, 'Researcher', () => adapter.postMessage(ADDRESS, result), 'answer-1', target);
    const restarted = fixture(service, receipts);
    await restarted.identity.run(
      ADDRESS,
      'Researcher',
      () => restarted.adapter.postMessage(ADDRESS, result),
      'answer-1',
      target,
    );
    const posts = service.requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(`/api/v10/channels/${THREAD}/messages`);
    expect(posts[0].body.content).toBe('The project is deployed. [https://example.com](https://example.com)');
    expect(posts[0].body.message_reference).toBeUndefined();
    expect(posts[0].body.allowed_mentions).toEqual({ parse: [], users: [], replied_user: false });
  });
  it('replies silently when the user message is inside the active thread', async () => {
    const { identity, adapter, service } = fixture();
    const source = { ...target, platformId: `discord:423456789012345678:${THREAD}` };
    await identity.run(
      ADDRESS,
      'Researcher',
      () => adapter.postMessage(ADDRESS, { markdown: 'Actual answer' }),
      'thread-answer',
      source,
    );
    const post = service.requests.find((request) => request.method === 'POST')!;
    expect(post.path).toBe(`/api/v10/channels/${THREAD}/messages`);
    expect(post.body.message_reference).toEqual({
      message_id: source.messageId,
      channel_id: THREAD,
      fail_if_not_exists: true,
    });
    expect(post.body.allowed_mentions).toEqual({ parse: [], users: [], replied_user: false });
  });
  it('replies normally in a channel when there is no active thread', async () => {
    const { identity, adapter, service } = fixture();
    const address = `discord:423456789012345678:${PARENT}`;
    await identity.run(
      address,
      'Researcher',
      () => adapter.postMessage(address, { markdown: 'Actual answer' }),
      'channel-answer',
      target,
    );
    const post = service.requests.find((request) => request.method === 'POST')!;
    expect(post.path).toBe(`/api/v10/channels/${PARENT}/messages`);
    expect(post.body.message_reference).toEqual({
      message_id: target.messageId,
      channel_id: PARENT,
      fail_if_not_exists: true,
    });
  });
  it('keeps split results together and keeps every successful chunk silent', async () => {
    const { identity, adapter, service } = fixture();
    await identity.run(
      ADDRESS,
      'Researcher',
      async () => {
        await adapter.postMessage(ADDRESS, { markdown: 'First part' });
        await adapter.postMessage(ADDRESS, { markdown: 'Second part' });
      },
      'split-answer',
      { ...target, platformId: `discord:423456789012345678:${THREAD}` },
    );
    const posts = service.requests.filter((request) => request.method === 'POST');
    expect(posts.map((post) => post.path)).toEqual([
      `/api/v10/channels/${THREAD}/messages`,
      `/api/v10/channels/${THREAD}/messages`,
    ]);
    expect(posts[0].body.allowed_mentions).toEqual({ parse: [], users: [], replied_user: false });
    expect(posts[0].body.message_reference).toEqual({
      message_id: target.messageId,
      channel_id: THREAD,
      fail_if_not_exists: true,
    });
    expect(posts[1].body.message_reference).toBeUndefined();
    expect(posts[1].body.allowed_mentions).toEqual({ parse: [], users: [], replied_user: false });
    expect(
      service.requests.filter((request) => request.method === 'GET' && request.path.includes('/messages/')),
    ).toHaveLength(1);
  });
  it('attaches result files to the actual reply', async () => {
    const { identity, adapter, service } = fixture();
    await identity.run(
      ADDRESS,
      'Researcher',
      () =>
        adapter.postMessage(ADDRESS, {
          markdown: 'Here is the report.',
          files: [{ filename: 'report.txt', data: Buffer.from('Report contents') }],
        }),
      'file-answer',
      target,
    );
    const upload = service.requests.find((request) => request.files)!;
    expect(upload.path).toBe(`/api/v10/channels/${THREAD}/messages`);
    expect(upload.body.message_reference).toBeUndefined();
    expect(await (upload.files!.get('files[0]') as Blob).text()).toBe('Report contents');
  });
  it('does not resend an answer after losing its acknowledgement', async () => {
    const { identity, adapter, service, receipts } = fixture();
    service.sendFailure = 'accepted-timeout';
    await expect(
      identity.run(
        ADDRESS,
        'Researcher',
        () => adapter.postMessage(ADDRESS, { markdown: 'Result' }),
        'lost-answer',
        target,
      ),
    ).rejects.toThrow(DeliveryOutcomeUnknownError);
    const restarted = fixture(service, receipts);
    await expect(
      restarted.identity.run(
        ADDRESS,
        'Researcher',
        () => restarted.adapter.postMessage(ADDRESS, { markdown: 'Result' }),
        'lost-answer',
        target,
      ),
    ).rejects.toThrow(DeliveryOutcomeUnknownError);
    expect(service.accepted).toBe(1);
  });
  it('rejects unrelated channels and bot source messages', async () => {
    const { identity, adapter, service } = fixture();
    await expect(
      identity.run(ADDRESS, 'Researcher', () => adapter.postMessage(ADDRESS, { markdown: 'Result' }), 'foreign', {
        ...target,
        platformId: 'discord:423456789012345678:999',
      }),
    ).rejects.toThrow('outside the current Discord conversation');
    service.authorIsBot = true;
    await expect(
      identity.run(ADDRESS, 'Researcher', () => adapter.postMessage(ADDRESS, { markdown: 'Result' }), 'bot', target),
    ).rejects.toThrow('must be a user message');
    expect(service.accepted).toBe(0);
  });
});

it('suppresses notifications for successful results and only pings the requested owner on the first needs-input chunk', async () => {
  const { identity, adapter, service } = fixture();
  const owner = '723456789012345678';
  await identity.run(
    ADDRESS,
    'Researcher',
    async () => {
      await adapter.postMessage(ADDRESS, { markdown: 'Please finish signing in.' });
      await adapter.postMessage(ADDRESS, { markdown: 'The sign-in instructions are above.' });
    },
    'blocked-result',
    undefined,
    owner,
  );
  const posts = service.requests.filter((request) => request.method === 'POST' && request.path.includes('/webhooks/'));
  expect(posts[0].body.content).toContain(`<@${owner}>`);
  expect(posts[0].body.allowed_mentions).toEqual({ parse: [], users: [owner], replied_user: false });
  expect(Number(posts[0].body.flags) & 4096).toBe(0);
  expect(posts[1].body.allowed_mentions).toEqual({ parse: [], users: [], replied_user: false });
  expect(Number(posts[1].body.flags) & 4096).toBe(4096);
  await identity.run(ADDRESS, 'Researcher', () => adapter.postMessage(ADDRESS, { markdown: 'Done.' }));
  const last = service.requests.at(-1)!;
  expect(Number(last.body.flags) & 4096).toBe(4096);
  expect(last.body.content).not.toContain(`<@${owner}>`);
});

it('notifies the owner for interactive question cards and suppresses routine DM replies', async () => {
  const { identity, adapter, service } = fixture();
  const owner = '723456789012345678';
  await identity.run(
    ADDRESS,
    'Researcher',
    () =>
      adapter.postMessage(ADDRESS, {
        card: Card({
          title: 'Need your choice',
          children: [Actions([Button({ id: 'ncq:fixture:0', label: 'Continue', value: '0' })])],
        }),
        fallbackText: 'Need your choice',
      }),
    'question-card',
    undefined,
    owner,
  );
  const card = service.requests.find((request) => request.body.components)!;
  expect(card.body.allowed_mentions).toEqual({ parse: [], users: [owner], replied_user: false });
  expect(card.body.content).toContain(`<@${owner}>`);
  await identity.run(`discord:@me:${PARENT}`, 'Researcher', () =>
    adapter.postMessage(`discord:@me:${PARENT}`, { markdown: 'Done.' }),
  );
  const dm = service.requests.at(-1)!;
  expect(dm.path).toBe(`/api/v10/channels/${PARENT}/messages`);
  expect(Number(dm.body.flags) & 4096).toBe(4096);
});

it('creates new conversations yellow without spending a title rename', async () => {
  const { adapter, service } = fixture();
  const thread = await (
    adapter as unknown as { createDiscordThread(channel: string, message: string): Promise<{ name: string }> }
  ).createDiscordThread(PARENT, '823456789012345678');
  expect(thread.name).toMatch(/^🟡 Thread /);
  expect(service.requests).toHaveLength(1);
  expect(service.requests[0].method).toBe('POST');
  expect(service.requests[0].path).toBe(`/api/v10/channels/${PARENT}/messages/823456789012345678/threads`);
});
