import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { Adapter } from 'chat';
import { createDiscordFeedback } from './discord-feedback.js';

function transport(failFirstEdit = false) {
  const calls: Array<{ operation: string; thread: string; message?: string; body: unknown }> = [];
  const adapter: Pick<Adapter, 'addReaction' | 'removeReaction' | 'postMessage' | 'editMessage'> = {
    async addReaction(thread, message, emoji) {
      calls.push({ operation: 'add', thread, message, body: emoji });
    },
    async removeReaction(thread, message, emoji) {
      calls.push({ operation: 'remove', thread, message, body: emoji });
    },
    async postMessage(thread, body) {
      calls.push({ operation: 'post', thread, body });
      return { id: `posted-${calls.length}`, threadId: thread, raw: {} };
    },
    async editMessage(thread, message, body) {
      if (failFirstEdit) {
        failFirstEdit = false;
        throw new Error('Fixture edit failure');
      }
      calls.push({ operation: 'edit', thread, message, body });
      return { id: message, threadId: thread, raw: {} };
    },
  };
  return {
    calls,
    feedback: createDiscordFeedback(adapter),
  };
}
const targets = [{ platformId: 'discord:123:456', messageId: '123456789012345678' }];

describe('Discord processing feedback', () => {
  it('keeps URL previews inside inline code without allowing mentions or fence escapes', async () => {
    const { feedback, calls } = transport();
    await feedback('discord:123:456', {
      phase: 'tool',
      targets,
      tool: { name: 'terminal', preview: 'curl https://example.test/`name` @everyone' },
    });
    expect(calls.at(-1)?.body).toEqual({
      markdown: "-# 🖥️ terminal · `curl https://example.test/'name' @\u200beveryone`",
    });
  });

  it('does not notify for tool activity, receipt, cancellation, or unattended runs', async () => {
    const { feedback, calls } = transport();
    await feedback('discord:123:456', { phase: 'received', targets });
    await feedback('discord:123:456', { phase: 'tool', targets, tool: { name: 'terminal', preview: 'ls' } });
    await feedback('discord:123:456', { phase: 'cancelled', targets });
    await feedback('discord:123:456', { phase: 'completed', targets: [] });
    expect(calls.filter((call) => call.operation === 'post')).toHaveLength(1);
  });

  it('reacts on the source channel while posting actual tool previews in the reply thread', async () => {
    const { calls, feedback } = transport();
    await feedback('discord:123:456:789', { phase: 'received', targets });
    await feedback('discord:123:456:789', {
      phase: 'tool',
      targets,
      tool: { name: 'terminal', preview: 'printf hello' },
    });
    await feedback('discord:123:456:789', { phase: 'completed', targets });
    expect(calls.map((call) => [call.operation, call.thread, call.body])).toEqual([
      ['add', 'discord:123:456', '👀'],
      ['post', 'discord:123:456:789', { markdown: '-# 🖥️ terminal · `printf hello`' }],
      ['remove', 'discord:123:456', '👀'],
      ['add', 'discord:123:456', '✅'],
    ]);
    expect(calls.filter((call) => call.operation === 'post')).toHaveLength(1);
  });
  it('shows failure and removes processing on cancellation without reporting success', async () => {
    const { calls, feedback } = transport();
    await feedback('discord:123:456', { phase: 'failed', targets });
    await feedback('discord:123:456', { phase: 'cancelled', targets });
    expect(calls.map((call) => [call.operation, call.body])).toEqual([
      ['remove', '👀'],
      ['add', '❌'],
      ['remove', '👀'],
    ]);
    expect(calls.filter((call) => call.operation === 'post')).toHaveLength(0);
  });
  it('coalesces consecutive identical tool previews and rejects foreign reaction targets', async () => {
    const { calls, feedback } = transport();
    const progress = { phase: 'tool', targets, tool: { name: 'kagi.search', preview: 'query' } };
    await feedback('discord:123:456', progress);
    await feedback('discord:123:456', progress);
    expect(calls[1].operation).toBe('edit');
    expect(calls[1].body).toEqual({ markdown: '-# 🔧 kagi.search · `query` (×2)' });
    await expect(
      feedback('discord:123:456', {
        phase: 'received',
        targets: [{ platformId: 'slack:C1', messageId: '123456789012345678' }],
      }),
    ).rejects.toThrow('Invalid agent progress');
  });
  it('does not double-count a preview after a failed edit is retried', async () => {
    const { calls, feedback } = transport(true);
    const progress = { phase: 'tool', targets, tool: { name: 'terminal', preview: 'same command' } };
    await feedback('discord:123:456', progress);
    await expect(feedback('discord:123:456', progress)).rejects.toThrow('Fixture edit failure');
    await feedback('discord:123:456', progress);
    expect(calls.at(-1)?.body).toEqual({ markdown: '-# 🖥️ terminal · `same command` (×2)' });
  });

  it('bounds abandoned preview retention while preserving new tool activity', async () => {
    const { calls, feedback } = transport();
    for (let index = 0; index < 129; index++) {
      await feedback('discord:123:456', {
        phase: 'tool',
        targets: [{ ...targets[0], messageId: String(123456789012345678n + BigInt(index)) }],
        tool: { name: 'terminal', preview: 'command' },
      });
    }
    await feedback('discord:123:456', { phase: 'tool', targets, tool: { name: 'terminal', preview: 'command' } });
    expect(calls.at(-1)?.operation).toBe('post');
  });
});

import { renameGeneratedDiscordThread } from './discord-feedback.js';

describe('automatic Discord titles', () => {
  it('renames a newly generated default title through the real HTTP contract', async () => {
    const requests: { method: string; body?: unknown }[] = [];
    const request: typeof fetch = async (_url, init) => {
      requests.push({ method: init?.method ?? 'GET', body: init?.body });
      return new Response(JSON.stringify({ name: 'Thread 10/15/2026' }), { status: 200 });
    };
    await renameGeneratedDiscordThread(
      'discord:123:456:123456789012345678',
      { title: 'Track recent tweets', initialName: 'Thread 10/15/2026' },
      'fixture',
      request,
    );
    expect(requests).toEqual([
      { method: 'GET', body: undefined },
      { method: 'PATCH', body: JSON.stringify({ name: 'Track recent tweets' }) },
    ]);
  });
  it('preserves manual names even when a delayed generated title arrives', async () => {
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ name: 'Thread debugging' }));
    };
    await renameGeneratedDiscordThread(
      'discord:123:456:123456789012345678',
      { title: 'Generated title', initialName: 'Thread 10/15/2026' },
      'fixture',
      request,
    );
    expect(calls).toBe(1);
  });
  it('rejects DMs and oversized titles before contacting Discord', async () => {
    await expect(renameGeneratedDiscordThread('discord:@me:123', { title: 'hello' }, 'fixture')).rejects.toThrow(
      'Invalid Discord',
    );
    await expect(
      renameGeneratedDiscordThread('discord:123:456:123456789012345678', { title: 'x'.repeat(101) }, 'fixture'),
    ).rejects.toThrow('Invalid Discord');
  });
});

import { DiscordThreadStatus } from './discord-feedback.js';
describe('dynamic Discord thread status', () => {
  it('preserves manual names, avoids duplicate patches, and keeps blockers red across completion and restart', async () => {
    let name = 'My manual title';
    const patches: string[] = [];
    const request: typeof fetch = async (_url, init) => {
      if (init?.method === 'PATCH') {
        name = JSON.parse(String(init.body)).name;
        patches.push(name);
      }
      return Response.json({ name });
    };
    const thread = 'discord:123:456:123456789012345678';
    const status = new DiscordThreadStatus('fixture', request);
    await status.set(thread, 'running');
    await status.set(thread, 'running');
    await status.set(thread, 'blocked');
    await new DiscordThreadStatus('fixture', request).set(thread, 'completed');
    expect(name).toBe('🔴 My manual title');
    await status.set(thread, 'running');
    await status.set(thread, 'completed');
    expect(patches).toEqual(['🟡 My manual title', '🔴 My manual title', '🟡 My manual title', '🟢 My manual title']);
  });
  it('serializes generated titles and status changes without losing either', async () => {
    let name = 'Thread today';
    const request: typeof fetch = async (_url, init) => {
      if (init?.method === 'PATCH') name = JSON.parse(String(init.body)).name;
      return Response.json({ name });
    };
    const thread = 'discord:123:456:123456789012345678';
    const status = new DiscordThreadStatus('fixture', request);
    await Promise.all([
      status.set(thread, 'running'),
      status.rename(thread, { title: 'Research', initialName: 'Thread today' }),
    ]);
    expect(name).toBe('Thread today');
    await status.set(thread, 'completed', 'Thread today');
    expect(name).toBe('🟢 Research');
  });
});

it('coalesces title updates during a Discord rename cooldown and persists the latest desired state', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-title-'));
  const file = path.join(directory, 'status.json');
  let name = 'Rate limited thread';
  let limited = true;
  const patches: string[] = [];
  const request: typeof fetch = async (_url, init) => {
    if (init?.method === 'PATCH') {
      if (limited) {
        limited = false;
        return Response.json({ retry_after: 0.01 }, { status: 429 });
      }
      name = JSON.parse(String(init.body)).name;
      patches.push(name);
    }
    return Response.json({ name });
  };
  try {
    const status = new DiscordThreadStatus('fixture', request, file);
    const thread = 'discord:123:456:123456789012345678';
    await status.set(thread, 'running');
    await status.set(thread, 'blocked');
    await status.set(thread, 'completed');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[thread].state).toBe('blocked');
    await status.set(thread, 'running');
    await status.set(thread, 'completed');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(patches).toEqual(['🟢 Rate limited thread']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[thread].dirty).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('replays a pending persisted title after controller restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-title-recovery-'));
  const file = path.join(directory, 'status.json');
  const thread = 'discord:123:456:123456789012345678';
  fs.writeFileSync(file, JSON.stringify({ [thread]: { state: 'blocked', dirty: true, retryAt: Date.now() + 10 } }));
  let name = 'A pending question';
  const request: typeof fetch = async (_url, init) => {
    if (init?.method === 'PATCH') name = JSON.parse(String(init.body)).name;
    return Response.json({ name });
  };
  try {
    new DiscordThreadStatus('fixture', request, file);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(name).toBe('🔴 A pending question');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('first-turn title and completion coalescing', () => {
  for (const titleFirst of [true, false]) {
    it(`uses one rename when ${titleFirst ? 'the title' : 'completion'} arrives first, including after restart`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-title-complete-'));
      const file = path.join(directory, 'status.json');
      const thread = 'discord:123:456:123456789012345678';
      let name = '🟡 Thread today';
      const patches: string[] = [];
      const request: typeof fetch = async (_url, init) => {
        if (init?.method === 'PATCH') {
          name = JSON.parse(String(init.body)).name;
          patches.push(name);
        }
        return Response.json({ name });
      };
      try {
        let status = new DiscordThreadStatus('fixture', request, file);
        await status.set(thread, 'running');
        if (titleFirst) await status.rename(thread, { title: 'Ask what day it is', initialName: 'Thread today' });
        else await status.set(thread, 'completed', 'Thread today');
        expect(patches).toEqual([]);
        status = new DiscordThreadStatus('fixture', request, file);
        if (titleFirst) await status.set(thread, 'completed', 'Thread today');
        else await status.rename(thread, { title: 'Ask what day it is', initialName: 'Thread today' });
        expect(patches).toEqual(['🟢 Ask what day it is']);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
  it('preserves manual edits and releases completion when generation keeps the original name', async () => {
    let name = '🟡 My manual name';
    const patches: string[] = [];
    const request: typeof fetch = async (_url, init) => {
      if (init?.method === 'PATCH') {
        name = JSON.parse(String(init.body)).name;
        patches.push(name);
      }
      return Response.json({ name });
    };
    const status = new DiscordThreadStatus('fixture', request);
    const thread = 'discord:123:456:123456789012345678';
    await status.set(thread, 'completed', 'Thread today');
    expect(patches).toEqual([]);
    await status.rename(thread, { title: 'Thread today', initialName: 'Thread today' });
    expect(patches).toEqual(['🟢 My manual name']);
  });
  for (const state of ['blocked', 'cancelled'] as const) {
    it(`does not hold ${state} while waiting for a title`, async () => {
      let name = '🟡 Thread today';
      const request: typeof fetch = async (_url, init) => {
        if (init?.method === 'PATCH') name = JSON.parse(String(init.body)).name;
        return Response.json({ name });
      };
      const status = new DiscordThreadStatus('fixture', request);
      const thread = 'discord:123:456:123456789012345678';
      await status.set(thread, 'completed', 'Thread today');
      await status.set(thread, state);
      expect(name).toBe(state === 'blocked' ? '🔴 Thread today' : 'Thread today');
    });
  }
});

it('releases completed status after a lost title worker reaches its persisted deadline', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-title-worker-loss-'));
  const file = path.join(directory, 'status.json');
  const thread = 'discord:123:456:123456789012345678';
  fs.writeFileSync(
    file,
    JSON.stringify({
      [thread]: { state: 'completed', initialName: 'Thread today', titleDeadline: Date.now() - 1, dirty: true },
    }),
  );
  let name = '🟡 Thread today';
  const patches: string[] = [];
  const request: typeof fetch = async (_url, init) => {
    if (init?.method === 'PATCH') {
      name = JSON.parse(String(init.body)).name;
      patches.push(name);
    }
    return Response.json({ name });
  };
  try {
    const status = new DiscordThreadStatus('fixture', request, file);
    await status.set(thread, 'completed');
    expect(patches).toEqual(['🟢 Thread today']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[thread].dirty).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("retries a blocker on Discord's cooldown without waiting for the title deadline", async () => {
  let name = '🟡 Thread today';
  let limited = true;
  const patches: string[] = [];
  const request: typeof fetch = async (_url, init) => {
    if (init?.method === 'PATCH') {
      if (limited) {
        limited = false;
        return Response.json({ retry_after: 0.01 }, { status: 429 });
      }
      name = JSON.parse(String(init.body)).name;
      patches.push(name);
    }
    return Response.json({ name });
  };
  const status = new DiscordThreadStatus('fixture', request);
  const thread = 'discord:123:456:123456789012345678';
  await status.set(thread, 'completed', 'Thread today');
  await status.set(thread, 'blocked');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(patches).toEqual(['🔴 Thread today']);
});
