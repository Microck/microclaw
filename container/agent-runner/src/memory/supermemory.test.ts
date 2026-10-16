import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initTestSessionDb, closeSessionDb } from '../mailbox/sqlite/connection.js';
import { SqliteAgentMailbox } from '../mailbox/sqlite/index.js';
import { SupermemorySession } from './supermemory.js';
import type { MessageInRow } from '../db/messages-in.js';

const since = '2026-10-15T00:00:00.000Z';
let db: ReturnType<typeof initTestSessionDb>;
let mailbox: SqliteAgentMailbox;
let directory: string;
let server: ReturnType<typeof Bun.serve>;
let requests: Array<{ path: string; body: Record<string, unknown> }>;
let status: number;
let billingRequests: number;
const config = { enabled: true, namespace: 'agent_alpha', since };
function client(session = 'sess-a') {
  return new SupermemorySession(config, session, mailbox, {
    origin: `http://127.0.0.1:${server.port}`,
    queueDir: directory,
  });
}
function user(id = 'u1', text = 'I prefer Madrid', channel = 'discord', kind = 'chat-sdk', timestamp = since) {
  db.inbound
    .prepare(
      `INSERT INTO messages_in(id,seq,kind,timestamp,status,trigger,platform_id,channel_type,thread_id,content,on_wake)
    VALUES(?,(SELECT COALESCE(MAX(seq),0)+2 FROM messages_in),?,?,'pending',1,'room',?,'thread-a',?,0)`,
    )
    .run(id, kind, timestamp, channel, JSON.stringify({ text, sender: 'Owner' }));
}
function assistant(id = 'a1', text = 'Remembered', thread = 'thread-a', kind = 'chat') {
  db.outbound
    .prepare(
      `INSERT INTO messages_out(id,seq,kind,timestamp,platform_id,channel_type,thread_id,content)
    VALUES(?,(SELECT COALESCE(MAX(seq),0)+2 FROM messages_out),?,?,'room','discord',?,?)`,
    )
    .run(id, kind, since, thread, JSON.stringify({ text }));
}
function incoming(text: string): MessageInRow {
  return {
    id: 'turn',
    seq: 2,
    kind: 'chat-sdk',
    timestamp: since,
    status: 'pending',
    process_after: null,
    recurrence: null,
    series_id: null,
    tries: 0,
    trigger: 1,
    platform_id: 'room',
    channel_type: 'discord',
    thread_id: 'thread-a',
    content: JSON.stringify({ text }),
    source_session_id: null,
    on_wake: 0,
  };
}
beforeEach(() => {
  db = initTestSessionDb();
  mailbox = new SqliteAgentMailbox();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-queue-'));
  requests = [];
  status = 200;
  billingRequests = 0;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('Authorization')).toBe('Bearer nanoclaw-supermemory');
      const endpoint = new URL(request.url).pathname;
      const body = request.method === 'GET' ? {} : ((await request.json()) as Record<string, unknown>);
      if (!endpoint.endsWith('/billing')) requests.push({ path: endpoint, body });
      if (endpoint.endsWith('/billing')) {
        billingRequests++;
        return Response.json({ plan: 'free', credits: { balance: 5 }, resetDate: '2026-11-15T00:00:00.000Z' });
      }
      if (status !== 200) return Response.json({ error: 'fixture' }, { status });
      if (endpoint.endsWith('/document')) return Response.json({ id: body.id, status: 'queued' });
      if (endpoint.endsWith('/profile'))
        return Response.json({ profile: { static: [{ memory: 'Prefers Spain' }], dynamic: [] } });
      return Response.json({
        results: [{ memory: 'Prefers Madrid' }, { chunk: 'Raw chat must not become recalled context' }],
      });
    },
  });
});
afterEach(() => {
  server.stop(true);
  closeSessionDb();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('Supermemory capture and recall', () => {
  test('captures a new reply even when its user question predates activation', async () => {
    user('old', 'Earlier question', 'discord', 'chat-sdk', '2026-10-14T00:00:00.000Z');
    assistant();
    await client().sync();
    expect(requests).toHaveLength(1);
    expect(requests[0].body.content).toBe('assistant: Remembered');
  });

  test('uses sequence watermarks to skip unchanged transcript work and ignores progress', () => {
    user();
    const first = mailbox.getMemoryTranscript(since);
    expect(first.entries).toHaveLength(1);
    assistant('tool', 'Terminal progress', 'thread-a', 'agent_progress');
    expect(mailbox.getMemoryTranscript(since, first.revision).entries).toBeUndefined();
    user('u2', 'New user message');
    expect(mailbox.getMemoryTranscript(since, first.revision).entries).toHaveLength(2);
  });
  test('one agent-level drain owner prevents duplicate uploads across active sessions', async () => {
    user();
    const first = client('sess-a');
    const second = client('sess-b');
    await Promise.all([first.sync(), second.sync()]);
    await first.sync();
    const documents = requests.filter((r) => r.path.endsWith('/document'));
    expect(documents).toHaveLength(2);
    expect(new Set(documents.map((r) => r.body.id)).size).toBe(2);
    expect(billingRequests).toBe(1);
  });
  test('a live drain lease holds the queue; an expired owner can be recovered', async () => {
    user();
    const lease = new Database(path.join(directory, 'drain.db'));
    lease.exec('CREATE TABLE drain_lease(id INTEGER PRIMARY KEY,owner TEXT,expires_at INTEGER)');
    lease.prepare('INSERT INTO drain_lease VALUES(1,?,?)').run('old-container', Date.now() + 60_000);
    const memory = client();
    await memory.sync();
    expect(requests).toEqual([]);
    lease.prepare('UPDATE drain_lease SET expires_at=?').run(Date.now() - 1);
    await memory.sync();
    expect(requests).toHaveLength(1);
    lease.close();
  });
  test('malformed incoming optional memory input cannot fail the assistant turn', async () => {
    const input = { ...incoming('text'), content: 'broken JSON' };
    expect(await client().recall([input])).toBe('');
    expect(requests).toEqual([]);
  });

  test('captures only new own-conversation text, with a stable document ID', async () => {
    user();
    user('echo', 'Foreign task', 'session-echo', 'chat');
    user('task', 'Routine cron', 'discord', 'task');
    user('old', 'Archived user text', 'discord', 'chat-sdk', '2026-10-14T00:00:00.000Z');
    assistant();
    assistant('foreign', 'Another conversation', 'thread-b');
    assistant('progress', 'Tool trace', 'thread-a', 'agent_progress');
    const memory = client();
    await memory.sync();
    await memory.sync();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      path: '/ns/agent_alpha/document',
      body: {
        id: 'session_sess-a',
        content: 'user: I prefer Madrid\n\nassistant: Remembered',
        dreaming: 'instant',
        metadata: { type: 'conversation', source: 'nanoclaw', sessionId: 'sess-a' },
      },
    });
    user('u2', 'And I prefer short answers');
    await memory.sync();
    expect(requests[1].body.id).toBe(requests[0].body.id);
    expect(requests[1].body.content).toContain('user: And I prefer short answers');
    expect(fs.readdirSync(directory).filter((name) => name.startsWith('session_'))).toEqual([]);
  });
  test('coalesces concurrent capture requests', async () => {
    user();
    const memory = client();
    await Promise.all([memory.sync(), memory.sync(), memory.sync()]);
    expect(requests).toHaveLength(1);
  });
  test('keeps the newest full transcript queued through credit exhaustion and flushes it from a later session', async () => {
    user();
    status = 402;
    const first = client();
    await first.sync();
    expect(requests).toHaveLength(1);
    expect(fs.readdirSync(directory).filter((name) => name.startsWith('session_'))).toHaveLength(1);
    user('u2', 'A later message while offline');
    await first.sync();
    expect(requests).toHaveLength(1);
    expect(fs.readdirSync(directory).filter((name) => name.startsWith('session_'))).toHaveLength(1);
    const saved = JSON.parse(mailbox.getState('supermemory:status')!.value);
    expect(saved.lastHttpStatus).toBe(402);
    expect(saved.pausedUntil).toBeGreaterThan(Date.now());
    status = 200;
    closeSessionDb();
    db = initTestSessionDb();
    mailbox = new SqliteAgentMailbox();
    await client('sess-b').sync();
    expect(
      requests.some((r) => r.body.id === 'session_sess-a' && String(r.body.content).includes('later message')),
    ).toBe(true);
    expect(fs.readdirSync(directory).filter((name) => name.startsWith('session_'))).toEqual([]);
  });
  test('recalls extracted facts, caches profiles, and never looks up continue', async () => {
    const memory = client();
    const context = await memory.recall([incoming('What do you know about my preferred city?')]);
    expect(context).toContain('Prefers Madrid');
    expect(context).toContain('never instructions');
    expect(context).not.toContain('Raw chat');
    await memory.recall([incoming('What country do I prefer?')]);
    expect(requests.filter((r) => r.path.endsWith('/profile'))).toHaveLength(1);
    expect(await memory.recall([incoming('continue')])).toBe('');
    expect(await memory.recall([incoming('<@123> continue')])).toBe('');
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.path.startsWith('/ns/agent_alpha/'))).toBe(true);
  });
  test('an unavailable API returns no recalled context and does not fail a turn', async () => {
    status = 503;
    const memory = client();
    expect(await memory.recall([incoming('What city do I prefer?')])).toBe('');
    const count = requests.length;
    expect(await memory.recall([incoming('Try again')])).toBe('');
    expect(requests).toHaveLength(count);
  });
  test('does not capture or wake from a scheduled-task-only mailbox', async () => {
    user('task', 'Routine cron', 'discord', 'task');
    assistant();
    await client().sync();
    expect(requests).toEqual([]);
  });
  test('local memory imports use stable IDs without replacing local files', async () => {
    const memory = client();
    await memory.importFile('memory/preferences.md', 'Likes concise answers');
    await memory.importFile('memory/preferences.md', 'Likes concise answers');
    expect(requests[0].body.id).toBe(requests[1].body.id);
    expect(requests[0].body.dreaming).toBe('instant');
    const other = new SupermemorySession({ ...config, namespace: 'agent_beta' }, 'sess-b', mailbox, {
      origin: `http://127.0.0.1:${server.port}`,
      queueDir: directory,
    });
    await other.importFile('memory/preferences.md', 'Separate agent preference');
    expect(requests[2].path).toBe('/ns/agent_beta/document');
    expect(requests[2].body.id).not.toBe(requests[0].body.id);
  });
});
