import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import type { Adapter } from 'chat';
import { parseAgentProgress } from '../mailbox/model.js';

/** Hermes-style feedback uses the bot's own reactions, never clears user reactions. */
export function createDiscordFeedback(
  adapter: Pick<Adapter, 'addReaction' | 'removeReaction' | 'postMessage' | 'editMessage'>,
) {
  const previews = new Map<string, { id: string; text: string; count: number }>();
  return async (replyThread: string, content: unknown): Promise<string | undefined> => {
    const progress = parseAgentProgress(content);
    const key = `${replyThread}|${progress.targets.map((target) => `${target.platformId}/${target.messageId}`).join(',')}`;
    if (progress.phase === 'tool') {
      const tool = progress.tool!;
      const icon = tool.name === 'terminal' ? '🖥️' : '🔧';
      // Fences suppress command URL unfurls and prevent mentions in previews.
      const label = `${icon} ${tool.name.replace(/[`@\n]/g, '')}`;
      const text = tool.preview ? `${label}\n\`\`\`\n${tool.preview.replace(/`/g, "'")}\n\`\`\`` : label;
      const previous = previews.get(key);
      if (previous?.text === text) {
        const nextCount = previous.count + 1;
        await adapter.editMessage(replyThread, previous.id, { markdown: `${text}\n(×${nextCount})` });
        previous.count = nextCount;
        return previous.id;
      }
      const posted = await adapter.postMessage(replyThread, { markdown: text });
      previews.set(key, { id: posted.id, text, count: 1 });
      // Hard-killed turns may never emit terminal progress. Retain at most
      // 128 previews; an evicted turn starts a new preview instead of editing.
      if (previews.size > 128) previews.delete(previews.keys().next().value!);
      return posted.id;
    }
    if (progress.phase === 'received') {
      for (const target of progress.targets) await adapter.addReaction(target.platformId, target.messageId, '👀');
      return;
    }
    previews.delete(key);
    for (const target of progress.targets) {
      await adapter.removeReaction(target.platformId, target.messageId, '👀');
      if (progress.phase !== 'cancelled') {
        await adapter.addReaction(target.platformId, target.messageId, progress.phase === 'completed' ? '✅' : '❌');
      }
    }
  };
}

/** Preserve manual names; Discord's adapter initially uses "Thread <date>". */
export async function renameGeneratedDiscordThread(
  thread: string,
  content: unknown,
  token: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const match = /^discord:[0-9]+:[0-9]+:([0-9]{17,20})$/.exec(thread);
  const payload = content as { title?: unknown; initialName?: unknown } | null;
  const title = payload?.title;
  if (
    !match ||
    typeof title !== 'string' ||
    !title.trim() ||
    title.length > 100 ||
    typeof payload?.initialName !== 'string'
  ) {
    throw new Error('Invalid Discord thread-title request');
  }
  const url = `https://discord.com/api/v10/channels/${match[1]}`;
  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'OpenAI File Downloader, XaiImageApiFetch/1.0',
  };
  const current = await request(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!current.ok) throw new Error(`Discord thread lookup failed: ${current.status}`);
  const metadata = (await current.json()) as { name: string };
  if (metadata.name.replace(STATUS_PREFIX, '') !== payload.initialName.replace(STATUS_PREFIX, '')) return;
  const renamed = await request(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ name: `${metadata.name.match(STATUS_PREFIX)?.[0] ?? ''}${title.trim()}`.slice(0, 100) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!renamed.ok) throw new Error(`Discord thread rename failed: ${renamed.status}`);
}

const STATUS_PREFIX = /^(?:🟡|🟢|🔴)\s*/u;

type ThreadState = 'running' | 'completed' | 'blocked' | 'cancelled';
type PendingTitle = {
  state?: ThreadState;
  title?: string;
  initialName?: string;
  retryAt?: number;
  titleDeadline?: number;
  dirty: boolean;
  resetBlocker?: boolean;
};

/** Keep only the latest title/state while Discord's rename bucket is cooling down. */
export class DiscordThreadStatus {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly states: Record<string, PendingTitle>;
  constructor(
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
    private readonly stateFile?: string,
  ) {
    this.states = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    for (const [thread, entry] of Object.entries(this.states)) if (entry.dirty) this.schedule(thread);
  }

  private save(): void {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.states), { mode: 0o600 });
    fs.renameSync(this.stateFile + '.tmp', this.stateFile);
  }

  private schedule(thread: string): void {
    if (this.timers.has(thread)) return;
    const entry = this.states[thread];
    const titleDeadline = entry?.state === 'completed' && !entry.title ? entry.titleDeadline : undefined;
    const timer = setTimeout(
      () => {
        this.timers.delete(thread);
        void this.enqueue(thread).catch((error) => log.warn('Discord title retry failed', { err: error }));
      },
      Math.max(1, Math.max(entry?.retryAt ?? 0, titleDeadline ?? 0) - Date.now()),
    );
    timer.unref();
    this.timers.set(thread, timer);
  }

  private enqueue(thread: string): Promise<void> {
    const previous = this.pending.get(thread) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.apply(thread));
    this.pending.set(thread, next);
    void next
      .finally(() => {
        if (this.pending.get(thread) === next) this.pending.delete(thread);
      })
      .catch(() => {});
    return next;
  }

  async rename(thread: string, content: unknown): Promise<void> {
    const payload = content as { title?: unknown; initialName?: unknown };
    if (
      typeof payload?.title !== 'string' ||
      !payload.title.trim() ||
      payload.title.length > 100 ||
      typeof payload.initialName !== 'string'
    )
      return Promise.reject(new Error('Invalid Discord thread-title request'));
    this.states[thread] = {
      ...this.states[thread],
      title: payload.title.trim(),
      titleDeadline: undefined,
      initialName: payload.initialName,
      dirty: true,
    };
    this.save();
    return this.enqueue(thread);
  }

  async set(thread: string, state: ThreadState, initialName?: string): Promise<void> {
    if (!/^discord:[0-9]+:[0-9]+:[0-9]{17,20}$/.test(thread)) return Promise.resolve();
    const previous = this.states[thread];
    if (state === 'completed' && previous?.state === 'blocked') return Promise.resolve();
    if (!initialName && state === previous?.state && !previous.dirty) return Promise.resolve();
    this.states[thread] = {
      ...previous,
      ...(initialName ? { initialName, titleDeadline: previous?.title ? undefined : Date.now() + 120_000 } : {}),
      state,
      dirty: true,
      resetBlocker: state === 'running' || previous?.resetBlocker,
    };
    this.save();
    return this.enqueue(thread);
  }

  private async apply(thread: string): Promise<void> {
    const timer = this.timers.get(thread);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(thread);
    }
    let entry = this.states[thread];
    if (!entry?.dirty) return;
    // A new thread already starts yellow. Wait for both the first result and
    // its title, rather than spending two renames on the same completion.
    if (entry.initialName && entry.state === 'running') return;
    if (entry.initialName && entry.state === 'completed' && !entry.title) {
      if ((entry.titleDeadline ?? 0) > Date.now()) {
        this.schedule(thread);
        return;
      }
      // The generator may have died after the answer was delivered. Settle
      // with the existing name rather than retaining yellow indefinitely.
      delete entry.initialName;
      delete entry.titleDeadline;
    }
    if ((entry.retryAt ?? 0) > Date.now()) {
      this.schedule(thread);
      return;
    }
    const id = /^discord:[0-9]+:[0-9]+:([0-9]{17,20})$/.exec(thread)?.[1];
    if (!id) throw new Error('Invalid Discord thread-title request');
    const url = `https://discord.com/api/v10/channels/${id}`;
    const headers = {
      Authorization: `Bot ${this.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'OpenAI File Downloader, XaiImageApiFetch/1.0',
    };
    const limited = async (response: Response): Promise<boolean> => {
      if (response.status !== 429) return false;
      const body = (await response.json()) as { retry_after: number };
      if (!Number.isFinite(body.retry_after) || body.retry_after < 0)
        throw new Error('Discord returned an invalid retry delay');
      this.states[thread].retryAt = Date.now() + Math.max(1000, body.retry_after * 1000);
      this.save();
      this.schedule(thread);
      return true;
    };
    const response = await this.request(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (await limited(response)) return;
    if (response.status === 404) {
      delete this.states[thread];
      this.save();
      return;
    }
    if (!response.ok) throw new Error(`Discord status lookup failed: ${response.status}`);
    const { name } = (await response.json()) as { name: string };
    // Inputs can arrive during the lookup. Apply the newest state, not a stale frame.
    entry = this.states[thread];
    if (entry.initialName && (entry.state === 'running' || (entry.state === 'completed' && !entry.title))) return;
    if (entry.state === 'completed' && name.startsWith('🔴') && !entry.resetBlocker) entry.state = 'blocked';
    const base =
      entry.title && name.replace(STATUS_PREFIX, '') === entry.initialName?.replace(STATUS_PREFIX, '')
        ? entry.title
        : name.replace(STATUS_PREFIX, '');
    const prefix = entry.state
      ? { running: '🟡', completed: '🟢', blocked: '🔴', cancelled: '' }[entry.state]
      : name.match(STATUS_PREFIX)?.[0]?.trim();
    const updated = `${prefix ? prefix + ' ' : ''}${base}`.slice(0, 100);
    if (name !== updated) {
      const renamed = await this.request(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name: updated }),
        signal: AbortSignal.timeout(15_000),
      });
      if (await limited(renamed)) return;
      if (!renamed.ok) throw new Error(`Discord status update failed: ${renamed.status}`);
    }
    // If state changed during PATCH, the next serialized operation must apply it.
    if (entry !== this.states[thread]) return;
    entry.dirty = false;
    delete entry.retryAt;
    delete entry.title;
    delete entry.initialName;
    delete entry.titleDeadline;
    this.save();
  }
}
