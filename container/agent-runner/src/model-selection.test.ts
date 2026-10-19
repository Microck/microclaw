import './modules/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resolveModelSelection, openingModelRequest, type AvailableModel } from './model-selection.js';
import type { MessageInRow } from './db/messages-in.js';
import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getAgentMailbox } from './mailbox/index.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, ModelSelection, QueryInput } from './providers/types.js';

const models: AvailableModel[] = [
  'gpt-6-sol',
  'gpt-6.1-sol',
  'gpt-6.10-sol',
  'gpt-6-luna',
  'gpt-6-astra',
  'gpt-reserve',
].map((model) => ({
  id: model,
  model,
  isDefault: model === 'gpt-6-luna',
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({ reasoningEffort })),
}));
const message = (text: string, fields: Partial<MessageInRow> = {}) =>
  ({
    id: 'input',
    kind: 'chat',
    trigger: 1,
    channel_type: 'discord',
    content: JSON.stringify({ text }),
    ...fields,
  }) as MessageInRow;

describe('model selection', () => {
  it('chooses the newest numeric version and defaults explicit names to low', () => {
    expect(resolveModelSelection('sol', models)).toEqual({ model: 'gpt-6.10-sol', effort: 'low' });
    expect(resolveModelSelection('SOL MEDIUM', models)).toEqual({ model: 'gpt-6.10-sol', effort: 'medium' });
    expect(resolveModelSelection('gpt-6-sol high', models)).toEqual({ model: 'gpt-6-sol', effort: 'high' });
    expect(resolveModelSelection('luna', models).model).toBe('gpt-6-luna');
  });
  it('rejects unavailable models and unsupported reasoning', () => {
    expect(() => resolveModelSelection('gpt-99-sol', models)).toThrow('unavailable');
    expect(() => resolveModelSelection('sol ultra', models)).toThrow('does not support');
    expect(() => resolveModelSelection('sol low extra', models)).toThrow('Use /model');
  });
  for (const [text, request] of [
    ['I want you to do X with sol', 'sol low'],
    ['Use sol medium to review this', 'sol medium'],
    ['Use gpt-reserve for this', 'gpt-reserve low'],
    ['Use gpt-reserve medium for this', 'gpt-reserve medium'],
    ['Please check this using gpt-6-sol xhigh.', 'gpt-6-sol xhigh'],
    ['What is Sol?', undefined],
    ['How does using sol work?', undefined],
    ['Compare sol with luna', undefined],
    ['Compare using sol and luna', undefined],
    ['I am using sol in my app', undefined],
    ['Do this with the latest sol medium', 'sol medium'],
    ['Read this: "use sol medium"', undefined],
    ['Explain `use sol medium`', undefined],
    ['Summarize this:\n```\nuse sol high\n```', undefined],
    ['Review this:\n> use sol high', undefined],
    ["Don't use sol for this", undefined],
    ['Don’t use sol for this', undefined],
    ['Do not use sol for this', undefined],
    ['Look at https://example.org/use/sol', undefined],
    ['Do this with solar energy', undefined],
  ] as const)
    it(`interprets direct instructions: ${text}`, () => {
      expect(openingModelRequest([message(text)])).toBe(request);
    });
  it('ignores tasks and copied history', () => {
    expect(openingModelRequest([message('Use sol', { kind: 'task' })])).toBeUndefined();
    expect(openingModelRequest([message('Use sol', { channel_type: 'session-echo' })])).toBeUndefined();
  });
});

beforeEach(() => {
  initTestSessionDb();
});
afterEach(() => {
  closeSessionDb();
});
function insert(text: string) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id,kind,timestamp,status,platform_id,channel_type,thread_id,content)
    VALUES ('input','chat',datetime('now'),'pending','discord:123:456','discord','discord:123:456:789',?)`,
    )
    .run(JSON.stringify({ text }));
}
function selectionProvider(abort: AbortController) {
  const configurations: Array<string | undefined> = [];
  const queries: QueryInput[] = [];
  let chosen = { model: 'gpt-6-luna', effort: 'xhigh' };
  const provider: AgentProvider = {
    registerMemorySessionHook() {},
    isSessionInvalid() {
      return false;
    },
    async configureModel(request): Promise<ModelSelection> {
      configurations.push(request);
      if (request) chosen = resolveModelSelection(request, models);
      return {
        ...chosen,
        available: models.map((entry) => ({ model: entry.model, efforts: ['low', 'medium', 'high', 'xhigh'] })),
      };
    },
    query(input) {
      queries.push(input);
      abort.abort();
      return { push() {}, end() {}, abort() {}, events: (async function* () {})() };
    },
  };
  return { provider, configurations, queries, current: () => chosen };
}
it('selects before the first query and persists the resolved ID in this session', async () => {
  insert('I want you to do X with sol medium');
  const abort = new AbortController();
  const fake = selectionProvider(abort);
  await runPollLoop({ provider: fake.provider, providerName: 'codex', cwd: '/tmp', signal: abort.signal });
  expect(fake.configurations).toEqual(['sol medium']);
  expect(fake.current()).toEqual({ model: 'gpt-6.10-sol', effort: 'medium' });
  expect(fake.queries).toHaveLength(1);
  expect(getAgentMailbox().operations.getState('inference:codex')?.value).toBe('gpt-6.10-sol medium');
});
it('restores the saved model without replacing the continuation', async () => {
  insert('Continue the existing task');
  getAgentMailbox().operations.setState('inference:codex', 'gpt-6-sol high');
  getAgentMailbox().operations.setState('continuation:codex', 'existing-thread');
  const abort = new AbortController();
  const fake = selectionProvider(abort);
  await runPollLoop({ provider: fake.provider, providerName: 'codex', cwd: '/tmp', signal: abort.signal });
  expect(fake.configurations).toEqual(['gpt-6-sol high']);
  expect(fake.queries[0].continuation).toBe('existing-thread');
});
it('handles /model as a control command without an inference turn', async () => {
  insert('/model sol medium');
  const abort = new AbortController();
  const fake = selectionProvider(abort);
  const configure = fake.provider.configureModel!;
  fake.provider.configureModel = async (request) => {
    const selected = await configure(request);
    abort.abort();
    return selected;
  };
  await runPollLoop({ provider: fake.provider, providerName: 'codex', cwd: '/tmp', signal: abort.signal });
  expect(fake.queries).toEqual([]);
  expect(getUndeliveredMessages().find((entry) => entry.kind === 'chat')?.content).toContain('gpt-6.10-sol');
});

it('finishes a running turn before applying a plain-text model command', async () => {
  insert('Original task');
  const stop = new AbortController();
  const configured: string[] = [];
  let aborted = 0;
  let release!: () => void;
  let close!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ended = new Promise<void>((resolve) => {
    close = resolve;
  });
  const provider: AgentProvider = {
    registerMemorySessionHook() {},
    isSessionInvalid() {
      return false;
    },
    async configureModel(request) {
      configured.push(request!);
      stop.abort();
      return { model: 'gpt-6-sol', effort: 'medium', available: [] };
    },
    query() {
      started();
      return {
        push() {
          throw new Error('Model command must not steer');
        },
        end() {},
        abort() {
          aborted++;
          close();
        },
        events: (async function* () {
          await finish;
          yield { type: 'result' as const, text: null };
          await ended;
        })(),
      };
    },
  };
  const running = runPollLoop({ provider, providerName: 'codex', cwd: '/tmp', signal: stop.signal });
  await ready;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id,kind,timestamp,status,platform_id,channel_type,thread_id,content)
    VALUES ('switch','chat',datetime('now'),'pending','discord:123:456','discord','discord:123:456:789',?)`,
    )
    .run(JSON.stringify({ text: '/model sol medium' }));
  await new Promise((resolve) => setTimeout(resolve, 650));
  expect(configured).toEqual([]);
  expect(aborted).toBe(0);
  release();
  await running;
  expect(configured).toEqual(['sol medium']);
});

it('refuses an inherited provider home before any test can write to it', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-boundary-'));
  try {
    const fixture = path.join(root, 'sentinel.test.ts');
    const config = path.join(root, 'config.toml');
    fs.writeFileSync(config, 'operator settings');
    fs.writeFileSync(
      fixture,
      `import {it} from 'bun:test'; import fs from 'node:fs'; it('fixture',()=>fs.writeFileSync(process.env.CODEX_HOME+'/config.toml','overwritten'));`,
    );
    const child = Bun.spawn(
      [process.execPath, 'test', '--preload', path.join(import.meta.dir, 'test-preload.ts'), fixture],
      {
        cwd: root,
        env: { ...process.env, CODEX_HOME: root },
        stdout: 'ignore',
        stderr: 'pipe',
      },
    );
    const diagnostic = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(diagnostic).toContain('Refusing to run tests with inherited CODEX_HOME');
    expect(fs.readFileSync(config, 'utf8')).toBe('operator settings');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
