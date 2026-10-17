import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';
import type { RoutingContext } from './formatter.js';

beforeEach(() => {
  initTestSessionDb();
});
afterEach(() => {
  closeSessionDb();
});
const routing: RoutingContext = {
  channelType: 'discord',
  platformId: 'discord:123:456',
  threadId: 'discord:123:456:789',
  inReplyTo: 'source',
  taskRun: false,
  feedbackTargets: [{ platformId: 'discord:123:456', messageId: '123456789012345678' }],
};
function progress() {
  return getUndeliveredMessages()
    .filter((row) => row.kind === 'agent_progress')
    .map((row) => JSON.parse(row.content));
}
async function run(events: AsyncIterable<ProviderEvent>, push: (message: string) => void = () => {}) {
  const query: AgentQuery = { events, push, abort() {}, end() {} };
  return processQuery(query, routing, [], 'codex', undefined, 'prompt', undefined);
}

describe('durable turn feedback', () => {
  it('completes both message reactions when a follow-up steers the current answer', async () => {
    let steered!: () => void;
    const inputConsumed = new Promise<void>((resolve) => {
      steered = resolve;
    });
    let acknowledge!: () => void;
    const steerResponse = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const secondTarget = { platformId: 'discord:123:456', messageId: '223456789012345678' };
    const query: AgentQuery = {
      async push() {
        steered();
        await steerResponse;
        return 'steered';
      },
      abort() {},
      end() {},
      events: (async function* (): AsyncGenerator<ProviderEvent> {
        getInboundDb()
          .prepare(
            `INSERT INTO messages_in (id,kind,timestamp,status,platform_id,channel_type,content)
          VALUES ('steer','chat',datetime('now'),'pending','discord:123:456','discord',?)`,
          )
          .run(JSON.stringify({ text: 'use the updated goal', feedbackTarget: secondTarget }));
        await inputConsumed;
        // Exercise turn completion arriving BEFORE the steer RPC response.
        yield { type: 'result', text: null };
      })(),
    };
    const processing = processQuery(query, { ...routing }, [], 'codex', undefined, 'first request', undefined);
    await inputConsumed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(progress()).toEqual([]);
    expect(getOutboundDb().prepare("SELECT status FROM processing_ack WHERE message_id='steer'").get()).toEqual({
      status: 'processing',
    });
    acknowledge();
    await processing;
    expect(progress()).toEqual([{ phase: 'completed', targets: [...routing.feedbackTargets!, secondTarget] }]);
    expect(getOutboundDb().prepare("SELECT status FROM processing_ack WHERE message_id='steer'").get()).toEqual({
      status: 'completed',
    });
  });
  it('publishes tool activity but waits for the result before completing', async () => {
    await run(
      (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'tool', name: 'terminal', preview: 'printf hello' };
        expect(progress().map((value) => value.phase)).toEqual(['tool']);
        yield { type: 'text', text: 'interim text' };
        expect(progress().map((value) => value.phase)).toEqual(['tool']);
        yield { type: 'result', text: null };
      })(),
    );
    expect(progress().map((value) => value.phase)).toEqual(['tool', 'completed']);
    expect(progress()[1].targets).toEqual(routing.feedbackTargets);
  });

  it('keeps processing through a formatting retry and completes only once', async () => {
    const pushed: string[] = [];
    await run(
      (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'result', text: 'unwrapped final text' };
        expect(pushed).toHaveLength(1);
        expect(progress()).toEqual([]);
        yield { type: 'result', text: null };
      })(),
      (message) => pushed.push(message),
    );
    expect(progress().map((value) => value.phase)).toEqual(['completed']);
  });

  it('publishes failure for an explicit provider failure', async () => {
    await run(
      (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'result', text: null, isError: true, error: 'Safe failure notice' };
      })(),
    );
    expect(progress().map((value) => value.phase)).toEqual(['failed']);
  });

  it('does not leave processing stuck on a disconnected stream', async () => {
    await expect(
      run(
        (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: 'activity' };
          throw new Error('Fixture disconnect');
        })(),
      ),
    ).rejects.toThrow('Fixture disconnect');
    expect(progress().map((value) => value.phase)).toEqual(['failed']);
  });

  it('keeps progress out of script and scheduled task conversations', async () => {
    const query: AgentQuery = {
      push() {},
      abort() {},
      end() {},
      events: (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'tool', name: 'terminal', preview: 'monitor' };
        yield { type: 'result', text: null };
      })(),
    };
    await processQuery(query, { ...routing, taskRun: true }, [], 'codex', undefined, 'task', undefined);
    expect(progress()).toEqual([]);
  });
  it('does not reuse a previous message target for a later turn without feedback metadata', async () => {
    let pushed!: () => void;
    const followUp = new Promise<void>((resolve) => {
      pushed = resolve;
    });
    const query: AgentQuery = {
      push() {
        pushed();
      },
      abort() {},
      end() {},
      events: (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'result', text: null };
        getInboundDb()
          .prepare(
            `INSERT INTO messages_in (id,kind,timestamp,status,platform_id,channel_type,content)
          VALUES ('follow-up','chat',datetime('now'),'pending','discord:123:456','discord','{"text":"next"}')`,
          )
          .run();
        await followUp;
        yield { type: 'tool', name: 'terminal', preview: 'second turn' };
        yield { type: 'result', text: null };
      })(),
    };
    await processQuery(query, routing, [], 'codex', undefined, 'first', undefined);
    expect(progress().map((value) => value.phase)).toEqual(['completed']);
  });
  it('reports failure when formatting recovery still produces no deliverable reply', async () => {
    await run(
      (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'result', text: 'unwrapped response' };
        yield { type: 'result', text: 'still unwrapped' };
      })(),
    );
    expect(progress().map((value) => value.phase)).toEqual(['failed']);
  });
});

it('starts post-reply work before a reusable query stream closes', async () => {
  getInboundDb()
    .query(
      "INSERT INTO destinations (name, display_name, type, channel_type, platform_id) VALUES ('test', 'Test', 'channel', 'discord', 'discord:123:456')",
    )
    .run();
  let release!: () => void;
  const heldOpen = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const query: AgentQuery = {
    events: (async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: 'result', text: '<message to="test">Done</message>', isError: false };
      await heldOpen;
    })(),
    push() {},
    abort() {
      release();
    },
    end() {},
  };
  await processQuery(query, routing, [], 'codex', undefined, 'prompt', undefined, false, undefined, () => {
    started = true;
    release();
  });
  expect(started).toBe(true);
});

it('publishes pending first-title metadata with completion without waiting for the title process', async () => {
  const query: AgentQuery = {
    push() {}, abort() {}, end() {},
    events: (async function* (): AsyncGenerator<ProviderEvent> { yield { type: 'result', text: null }; })(),
  };
  let started = false;
  await processQuery(query, routing, [], 'codex', undefined, 'prompt', undefined, false, undefined, () => {
    started = true;
    return 'Thread today';
  });
  expect(started).toBe(true);
  expect(progress()).toEqual([{ phase: 'completed', targets: routing.feedbackTargets, initialThreadName: 'Thread today' }]);
});
