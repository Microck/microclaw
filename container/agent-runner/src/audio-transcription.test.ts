import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ChatGptTranscriber, transcribeDiscordAudio } from './audio-transcription.js';
import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getAgentMailbox } from './mailbox/index.js';
import type { MessageInRow } from './db/messages-in.js';

const execute = promisify(execFile);
let directory: string;
let server: ReturnType<typeof Bun.serve>;
let requests: number;
let status: number;
let headers: Headers;
let wav: Buffer;
beforeEach(async () => {
  initTestSessionDb();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nanoclaw-voice-test-'));
  await fs.writeFile(
    path.join(directory, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'fixture-token', account_id: 'fixture-account' } }),
  );
  await execute('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=0.1',
    '-c:a',
    'libopus',
    path.join(directory, 'voice.ogg'),
  ]);
  requests = 0;
  status = 200;
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests++;
      headers = request.headers;
      const form = await request.formData();
      const file = form.get('file') as File;
      expect(file.name).toBe('recording.wav');
      wav = Buffer.from(await file.arrayBuffer());
      return Response.json(
        status === 200 ? { text: '  Remind me tomorrow morning.  ' } : { error: 'private-provider-diagnostic' },
        { status },
      );
    },
  });
});
afterEach(async () => {
  server.stop(true);
  closeSessionDb();
  await fs.rm(directory, { recursive: true, force: true });
});
function client() {
  return new ChatGptTranscriber({
    authFile: path.join(directory, 'auth.json'),
    endpoint: `http://127.0.0.1:${server.port}/transcribe`,
  });
}
function message(channel = 'discord'): MessageInRow {
  return {
    id: 'voice-request',
    seq: 2,
    kind: 'chat-sdk',
    timestamp: new Date().toISOString(),
    status: 'processing',
    channel_type: channel,
    platform_id: 'discord:g:c',
    thread_id: 'thread',
    trigger: 1,
    content: JSON.stringify({
      text: 'Caption',
      attachments: [{ type: 'audio', mimeType: 'audio/ogg', localPath: path.join(directory, 'voice.ogg') }],
    }),
  } as MessageInRow;
}
describe('Discord ChatGPT voice transcription', () => {
  it('decodes real Ogg/Opus and sends the Handy protocol as mono 16 kHz WAV', async () => {
    expect(await client().transcribe(path.join(directory, 'voice.ogg'))).toBe('Remind me tomorrow morning.');
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(headers.get('authorization')).toBe('Bearer fixture-token');
    expect(headers.get('chatgpt-account-id')).toBe('fixture-account');
    expect(headers.get('originator')).toBe('Codex Desktop');
  });
  it('preserves captions, caches transcription on retry and records actual speech for memory', async () => {
    const first = message();
    await transcribeDiscordAudio([first], undefined, client());
    expect(JSON.parse(first.content).text).toBe('Caption\n\n[Voice note transcript]\nRemind me tomorrow morning.');
    await transcribeDiscordAudio([message()], undefined, client());
    expect(requests).toBe(1);
    const transcripts = getUndeliveredMessages().filter((message) => message.id === 'voice-transcript:voice-request');
    expect(transcripts).toHaveLength(1);
    expect(JSON.parse(transcripts[0].content).text).toContain('Remind me tomorrow morning.');
    const state = JSON.parse(getAgentMailbox().operations.getState('voice:voice-request')!.value);
    expect(state.text).toBe('Caption\n\nRemind me tomorrow morning.');
  });
  it('includes cached speech in the user memory transcript', async () => {
    const incoming = message();
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in(id,seq,kind,timestamp,status,trigger,platform_id,channel_type,thread_id,content)
      VALUES(?,2,'chat-sdk',?,'processing',1,'room','discord','thread',?)`,
      )
      .run(incoming.id, incoming.timestamp, incoming.content);
    const mailbox = getAgentMailbox().operations;
    const before = mailbox.getMemoryTranscript('2000-01-01T00:00:00Z');
    await transcribeDiscordAudio([incoming], undefined, client());
    const after = mailbox.getMemoryTranscript('2000-01-01T00:00:00Z', before.revision);
    expect(after.revision).not.toBe(before.revision);
    expect(after.entries?.[0]?.text).toBe('Caption\n\nRemind me tomorrow morning.');
  });
  it('rejects a recording over ten minutes before any upload', async () => {
    const long = path.join(directory, 'long.wav');
    await execute('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=16000:cl=mono',
      '-t',
      '601',
      '-c:a',
      'pcm_s16le',
      long,
    ]);
    await expect(client().transcribe(long)).rejects.toThrow('at most 10 minutes');
    expect(requests).toBe(0);
  });
  it('keeps provider diagnostics out of failed transcripts and allows a later retry', async () => {
    status = 429;
    const first = message();
    await transcribeDiscordAudio([first], undefined, client());
    expect(JSON.parse(first.content).text).toContain('rate limited');
    expect(first.content).not.toContain('private-provider-diagnostic');
    status = 200;
    const retry = message();
    await transcribeDiscordAudio([retry], undefined, client());
    expect(JSON.parse(retry.content).text).toContain('Remind me tomorrow morning.');
    expect(requests).toBe(2);
  });
  it('skips unrelated channels and honours stop before uploading', async () => {
    await transcribeDiscordAudio([message('slack')], undefined, client());
    const abort = new AbortController();
    abort.abort(new Error('stopped'));
    await expect(transcribeDiscordAudio([message()], abort.signal, client())).rejects.toThrow('stopped');
    expect(requests).toBe(0);
  });
});
