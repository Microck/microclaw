import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SESSION_DIR } from './runtime-paths.js';
import { writeMessageOut } from './db/messages-out.js';
import { getAgentMailbox } from './mailbox/index.js';
import type { MessageInRow } from './db/messages-in.js';

const execute = promisify(execFile);
const ENDPOINT = 'https://chatgpt.com/backend-api/transcribe';
const MAX_WAV_BYTES = 600 * 16000 * 2 + 44;
const USER_AGENT = 'OpenAI File Downloader, XaiImageApiFetch/1.0';

/** Handy-Codex's file transcription protocol, using NanoClaw's brokered login. */
export class ChatGptTranscriber {
  constructor(private readonly options: { authFile?: string; endpoint?: string } = {}) {}

  async transcribe(file: string, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(120_000);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nanoclaw-voice-'));
    try {
      const wav = path.join(directory, 'recording.wav');
      // Discord records Ogg/Opus. Decode a bounded amount, then reject long
      // recordings rather than silently truncating the user's message.
      await execute(
        'ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-i',
          file,
          '-map',
          '0:a:0',
          '-t',
          '601',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          '-fflags',
          '+bitexact',
          wav,
        ],
        { signal: abort, timeout: 30_000, maxBuffer: 64 * 1024 },
      );
      const audio = await fs.readFile(wav);
      if (audio.length > MAX_WAV_BYTES) throw new Error('Voice notes must be at most 10 minutes long.');
      if (audio.length <= 78) return '';
      const authFile = this.options.authFile ?? path.join(process.env.CODEX_HOME ?? '', 'auth.json');
      const auth = JSON.parse(await fs.readFile(authFile, 'utf8')) as {
        tokens?: { access_token?: string; account_id?: string };
      };
      if (!auth.tokens?.access_token || !auth.tokens.account_id)
        throw new Error('ChatGPT transcription login is unavailable.');
      const proxy = this.options.endpoint ? undefined : process.env.HTTPS_PROXY;
      if (!this.options.endpoint && !proxy) throw new Error('ChatGPT transcription requires the credential gateway.');
      const form = new FormData();
      form.set('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav');
      const response = await fetch(this.options.endpoint ?? ENDPOINT, {
        proxy,
        method: 'POST',
        redirect: 'error',
        signal: abort,
        headers: {
          Authorization: `Bearer ${auth.tokens.access_token}`,
          'ChatGPT-Account-Id': auth.tokens.account_id,
          originator: 'Codex Desktop',
          'User-Agent': USER_AGENT,
        },
        body: form,
      });
      if (!response.ok) {
        if (response.status === 429) throw new Error('ChatGPT transcription is rate limited. Please try again later.');
        throw new Error(`ChatGPT transcription failed (HTTP ${response.status}).`);
      }
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string')
        throw new Error('ChatGPT returned an invalid transcription.');
      return result.text.trim();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}

interface VoiceState {
  text: string;
  transcripts: Record<string, string>;
  displayed?: boolean;
}

/** Enrich accepted Discord messages before prompts, steering, titles and memory recall. */
export async function transcribeDiscordAudio(
  messages: MessageInRow[],
  signal?: AbortSignal,
  transcriber = new ChatGptTranscriber(),
): Promise<void> {
  for (const message of messages) {
    if (message.channel_type !== 'discord' || message.trigger !== 1) continue;
    const content = JSON.parse(message.content) as {
      text?: string;
      feedbackTarget?: { platformId: string; messageId: string };
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        localPath?: string;
      }>;
    };
    const audio = content.attachments?.filter((att) => att.type === 'audio' || att.mimeType?.startsWith('audio/'));
    if (!audio?.length) continue;
    const mailbox = getAgentMailbox().operations;
    const key = `voice:${message.id}`;
    const saved = mailbox.getState(key)?.value;
    const state: VoiceState = saved ? JSON.parse(saved) : { text: '', transcripts: {} };
    const parts: string[] = [];
    const spoken: string[] = [];
    for (const attachment of audio) {
      if (signal?.aborted) throw signal.reason;
      try {
        if (!attachment.localPath) throw new Error('The audio attachment could not be downloaded. Please resend it.');
        const file = path.resolve(SESSION_DIR, attachment.localPath);
        const text = state.transcripts[file] ?? (await transcriber.transcribe(file, signal));
        state.transcripts[file] = text;
        if (text) {
          parts.push(`[Voice note transcript]\n${text}`);
          spoken.push(text);
        } else parts.push('[Voice note contained no detectable speech. Ask the user to resend it.]');
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        // Never feed raw HTTP bodies, credentials or decoder diagnostics into
        // the conversation. Failure must not become an invented transcript.
        const explanation =
          error instanceof Error && /^(Voice notes|ChatGPT|The audio attachment)/.test(error.message)
            ? error.message
            : 'The audio could not be transcribed. Please resend it or type the message.';
        parts.push(`[Voice transcription unavailable: ${explanation}]`);
      }
    }
    if (spoken.length && !state.displayed && !mailbox.hasMessageOut(`voice-transcript:${message.id}`)) {
      await writeMessageOut({
        id: `voice-transcript:${message.id}`,
        kind: 'chat',
        platform_id: message.platform_id,
        channel_type: message.channel_type,
        thread_id: message.thread_id,
        content: JSON.stringify({
          text: parts.join('\n\n'),
          ...(content.feedbackTarget ? { replyTarget: content.feedbackTarget } : {}),
        }),
      });
      state.displayed = true;
    }
    state.text = [content.text ?? '', ...spoken].filter(Boolean).join('\n\n');
    const serialized = JSON.stringify(state);
    if (serialized !== saved) mailbox.setState(key, serialized);
    content.text = [content.text ?? '', ...parts].filter(Boolean).join('\n\n');
    message.content = JSON.stringify(content);
  }
}
