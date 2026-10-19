import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CodexProvider, type CodexRuntimeDeps } from './codex.js';
import type { AppServer, JsonRpcNotification, TurnParams } from './codex-app-server.js';
import type { ProviderEvent } from './types.js';

const MEMORY_SESSION_HOOK = {
  command: 'bun /app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: ['startup', 'clear', 'compact'],
} as const;

function createCodexProvider(...args: ConstructorParameters<typeof CodexProvider>): CodexProvider {
  const provider = new CodexProvider(...args);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider;
}

describe('CodexProvider active turns', () => {
  it('keeps child notifications from completing, steering or overwriting the parent', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'delegate work', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);
    fake.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
    fake.notify('item/agentMessage/delta', { threadId: 'child', delta: 'private child answer' });
    fake.notify('item/completed', { threadId: 'child', item: { type: 'agentMessage', text: 'private child answer' } });
    fake.notify('turn/completed', {
      threadId: 'child',
      turn: { items: [{ type: 'agentMessage', text: 'private child answer' }] },
    });
    await sleep(20);
    expect(events.filter((event) => event.type === 'result')).toHaveLength(0);
    expect(await query.push('follow up')).toBe('steered');
    expect(fake.steerCalls.at(-1)?.turnId).toBe('turn-1');
    query.end();
    fake.completeTurn('parent answer');
    await collect;
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'parent answer' }]);
  });

  it('keeps an active turn alive beyond the inactivity deadline', async () => {
    const fake = createFakeCodexRuntime({ quietNoticeAfterMs: 500 });
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'long task', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);
    for (let i = 0; i < 8; i++) {
      await sleep(100);
      fake.notify('item/reasoning/textDelta', { delta: 'working' });
    }
    query.end();
    fake.completeTurn('done');
    await collect;
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'done' }]);
  });

  it('keeps a silent turn alive beyond the notice interval and still stops immediately', async () => {
    const fake = createFakeCodexRuntime({ quietNoticeAfterMs: 50 });
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'wait for a long quiet tool', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);
    await sleep(180);
    expect(fake.killed).toBe(false);
    expect(events.some((event) => event.type === 'progress' && event.message.includes('continuing to wait'))).toBe(
      true,
    );
    expect(events.filter((event) => event.type === 'activity').length).toBeGreaterThanOrEqual(2);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
    query.abort();
    await collect;
    expect(fake.interruptCalls).toHaveLength(1);
    expect(fake.killed).toBe(true);
  });

  it('accepts a completed long quiet turn without asking the user to continue', async () => {
    const fake = createFakeCodexRuntime({ quietNoticeAfterMs: 30 });
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'wait then finish', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);
    await sleep(120);
    query.end();
    fake.completeTurn('finished after waiting');
    await collect;
    expect(events.filter((event) => event.type === 'result')).toEqual([
      { type: 'result', text: 'finished after waiting' },
    ]);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
  });

  it('delivers late search details once and labels reported skill loads', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'search and read a skill', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);
    fake.notify('item/started', { item: { id: 'search-1', type: 'webSearch', query: '' } });
    const search = {
      id: 'search-1',
      type: 'webSearch',
      query: '',
      action: { type: 'search', queries: ['site status'] },
    };
    fake.notify('item/completed', { item: search });
    fake.notify('item/completed', { item: search });
    fake.notify('item/started', { item: { ...search, id: 'search-2' } });
    fake.notify('item/completed', { item: { ...search, id: 'search-2' } });
    const command = 'cat skills/raft-cli/SKILL.md';
    const read = {
      id: 'read-1',
      type: 'commandExecution',
      command,
      commandActions: [{ type: 'read', command, name: 'SKILL.md', path: 'skills/raft-cli/SKILL.md' }],
    };
    fake.notify('item/started', { item: read });
    fake.notify('item/completed', { item: read });
    query.end();
    fake.completeTurn('done');
    await collect;
    expect(events.filter((event) => event.type === 'tool')).toEqual([
      { type: 'tool', name: 'web search', preview: 'site status' },
      { type: 'tool', name: 'web search', preview: 'site status' },
      { type: 'tool', name: 'loading skill: raft-cli', preview: command },
    ]);
  });
  it('steers follow-ups into the active turn and yields liveness activity', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    expect(await query.push('follow-up prompt')).toBe('steered');
    await waitFor(() => fake.steerCalls.length === 1);
    query.end();
    fake.completeTurn('final answer');

    await collect;

    expect(fake.startCalls).toHaveLength(1);
    expect(fake.startCalls[0].inputText).toBe('first prompt');
    expect(fake.steerCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1', inputText: 'follow-up prompt' }]);
    expect(events.filter((event) => event.type === 'activity').length).toBeGreaterThanOrEqual(2);
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'final answer' }]);
    expect(fake.killed).toBe(true);
  });

  it('queues follow-ups for the next turn when steering is rejected', async () => {
    const fake = createFakeCodexRuntime({ rejectSteer: true });
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    expect(await query.push('queued follow-up')).toBe('queued');
    await waitFor(() => fake.steerCalls.length === 1);
    await sleep(0);

    fake.completeTurn('first answer');
    await waitFor(() => fake.startCalls.length === 2);
    query.end();
    fake.completeTurn('second answer');

    await collect;

    expect(fake.startCalls.map((call) => call.inputText)).toEqual(['first prompt', 'queued follow-up']);
    expect(fake.steerCalls).toHaveLength(1);
    expect(events.filter((event) => event.type === 'result')).toEqual([
      { type: 'result', text: 'first answer' },
      { type: 'result', text: 'second answer' },
    ]);
  });

  it('queues a follow-up that races turn completion into a new turn, never steering the finished turn', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);

    // The turn completes, then a follow-up lands in the same tick — before the
    // generator has drained and torn the turn down. codex's turn/steer no-ops
    // on a finished turn (resolves without error), so steering here would drop
    // the message silently. It must start a fresh turn instead.
    fake.completeTurn('first answer');
    query.push('racing follow-up');

    await waitFor(() => fake.startCalls.length === 2);
    query.end();
    fake.completeTurn('second answer');

    await collect;

    expect(fake.steerCalls).toHaveLength(0);
    expect(fake.startCalls.map((call) => call.inputText)).toEqual(['first prompt', 'racing follow-up']);
    expect(events.filter((event) => event.type === 'result')).toEqual([
      { type: 'result', text: 'first answer' },
      { type: 'result', text: 'second answer' },
    ]);
  });

  it('interrupts the active turn and closes the stream on abort', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    query.abort();

    await collect;

    expect(fake.interruptCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
    expect(events.some((event) => event.type === 'result')).toBe(false);
    expect(fake.killed).toBe(true);
  });

  it('threads the configured model and effort into the turn', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({ model: 'gpt-5.5', effort: 'high' }, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    query.end();
    fake.completeTurn('final answer');

    await collect;

    expect(fake.startCalls[0].model).toBe('gpt-5.5');
    expect(fake.startCalls[0].effort).toBe('high');
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'final answer' }]);
  });

  it('delivers harness-generated images as file events — the model never sends them itself', async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    const prevHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const fake = createFakeCodexRuntime();
      const provider = createCodexProvider({}, fake.runtime);
      const query = provider.query({ prompt: 'make an image', cwd: '/workspace/agent' });
      const events: ProviderEvent[] = [];
      const collect = collectEvents(query.events, events);

      await waitFor(() => fake.startCalls.length === 1);
      // Codex's built-in image_gen writes into CODEX_HOME mid-turn.
      const imagesDir = path.join(codexHome, 'generated_images', 'thread-1');
      fs.mkdirSync(imagesDir, { recursive: true });
      fs.writeFileSync(path.join(imagesDir, 'ig_abc.png'), 'png-bytes');

      query.end();
      fake.completeTurn('Here you go — created the image.');
      await collect;

      const files = events.filter((event) => event.type === 'file') as Array<{ type: 'file'; path: string }>;
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe(path.join(imagesDir, 'ig_abc.png'));
      // file events arrive before the result so delivery shares the turn.
      expect(events.findIndex((e) => e.type === 'file')).toBeLessThan(events.findIndex((e) => e.type === 'result'));
    } finally {
      if (prevHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('ends the turn immediately with the real cause when the app-server dies mid-turn', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);

    // No pending request exists mid-turn (turn/start already resolved), so
    // only the exitHandlers seam can end the turn — without it this parks
    // on the waker without an event to finish the turn.
    fake.crashServer(new Error('Codex app-server exited: code=1 signal=null'));

    // The generator yields the error event, then rethrows to its consumer.
    await collect.catch(() => {});

    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toContain('app-server exited');
  });
});

function createFakeCodexRuntime(opts: { rejectSteer?: boolean; quietNoticeAfterMs?: number } = {}) {
  const server = fakeServer();
  const startCalls: TurnParams[] = [];
  const steerCalls: Array<{ threadId: string; turnId: string; inputText: string }> = [];
  const interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  let killed = false;

  const notify = (method: string, params?: Record<string, unknown>): void => {
    const notification: JsonRpcNotification = { method, params };
    for (const handler of [...server.notificationHandlers]) handler(notification);
  };

  const runtime: CodexRuntimeDeps = {
    quietNoticeAfterMs: opts.quietNoticeAfterMs ?? 600_000,
    writeCodexConfigToml: () => {},
    spawnCodexAppServer: () => server,
    attachCodexAutoApproval: () => {},
    initializeCodexAppServer: async () => {},
    startOrResumeCodexThread: async (_server, threadId) => threadId ?? 'thread-1',
    startCodexTurn: async (_server, params) => {
      startCalls.push(params);
      const turnId = `turn-${startCalls.length}`;
      notify('turn/started', { turn: { id: turnId } });
      return turnId;
    },
    steerCodexTurn: async (_server, threadId, turnId, inputText) => {
      steerCalls.push({ threadId, turnId, inputText });
      if (opts.rejectSteer) throw new Error('steer rejected');
    },
    interruptCodexTurn: async (_server, threadId, turnId) => {
      interruptCalls.push({ threadId, turnId });
    },
    killCodexAppServer: () => {
      killed = true;
    },
  };

  return {
    runtime,
    notify,
    startCalls,
    steerCalls,
    interruptCalls,
    get killed() {
      return killed;
    },
    completeTurn(text: string) {
      notify('turn/completed', { turn: { items: [{ type: 'agentMessage', text }] } });
    },
    crashServer(err: Error) {
      for (const h of [...server.exitHandlers]) h(err);
    },
  };
}

function fakeServer(): AppServer {
  return {
    process: { stdin: { write: () => true }, kill: () => true },
    readline: { close: () => {} },
    pending: new Map(),
    notificationHandlers: [],
    exitHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;
}

async function collectEvents(events: AsyncIterable<ProviderEvent>, sink: ProviderEvent[]): Promise<void> {
  for await (const event of events) {
    sink.push(event);
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
