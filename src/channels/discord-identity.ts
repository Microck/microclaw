import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';
import type { FeedbackTarget } from '../mailbox/model.js';
import { DeliveryOutcomeUnknownError } from './adapter.js';
import type { createDiscordAdapter } from '@chat-adapter/discord';

type Identity = {
  name: string;
  parent: string;
  thread?: string;
  deliveryId?: string;
  nextPost: number;
  replyTarget?: FeedbackTarget;
  notifyUserId?: string;
  isDm?: boolean;
  replySource?: Promise<{ channelId: string; messageId?: string }>;
};
class DiscordRequestError extends Error {
  constructor(readonly status: number) {
    super(`Discord identity request failed: HTTP ${status}`);
  }
}
type Webhook = { id: string; token?: string; name: string; user?: { id: string } };
type DiscordInternals = {
  discordFetch(route: string, method: string, body?: Record<string, unknown>): Promise<Response>;
  postMessageWithFiles(
    channel: string,
    thread: string,
    payload: Record<string, unknown>,
    files: Array<{
      data: Buffer | ArrayBuffer | Uint8Array | Blob | string;
      filename: string;
      mimeType?: string;
    }>,
  ): Promise<{ id: string; threadId: string; raw: unknown }>;
};
const USER_AGENT = 'OpenAI File Downloader, XaiImageApiFetch/1.0';

/** Keep identity local to one delivery, including concurrent split replies and previews.
 * The SDK still renders cards/text and splits replies; only its transport changes.
 */
export class DiscordIdentity {
  private readonly context = new AsyncLocalStorage<Identity>();
  private readonly webhooks = new Map<string, Promise<Webhook>>();
  private readonly roles = new Map<string, Promise<string[]>>();
  constructor(
    private readonly token: string,
    private readonly botId: string,
    private readonly request: typeof fetch = fetch,
    private readonly receipts = join(DATA_DIR, 'discord-delivery'),
  ) {}

  run<T>(
    address: string,
    name: string | undefined,
    action: () => T,
    deliveryId?: string,
    replyTarget?: FeedbackTarget,
    notifyUserId?: string,
  ): T {
    const [, guild, parent, thread] = address.split(':');
    // Webhooks cannot send DMs. Host controls have no agent sender identity.
    if ((!name && !notifyUserId) || !guild || !parent) return action();
    return this.context.run(
      {
        name: name ?? 'NanoClaw',
        parent,
        thread,
        deliveryId,
        nextPost: 0,
        replyTarget,
        notifyUserId,
        isDm: guild === '@me',
      },
      action,
    );
  }

  private receiptDirectory(deliveryId: string): string {
    return join(this.receipts, createHash('sha256').update(deliveryId).digest('hex'));
  }

  /** Only after durable mailbox settlement: this ID can no longer be retried. */
  async finalizeDelivery(deliveryId: string): Promise<void> {
    await rm(this.receiptDirectory(deliveryId), { recursive: true, force: true });
  }

  async recognizesRole(guild: string, mentioned: string[]): Promise<boolean> {
    if (!mentioned.length || !guild || guild === '@me') return false;
    let roles = this.roles.get(guild);
    if (!roles) {
      roles = this.api(`/guilds/${guild}/roles`, 'GET').then(async (response) => {
        const found = (await response.json()) as Array<{ id: string; tags?: { bot_id?: string } }>;
        return found.filter((role) => role.tags?.bot_id === this.botId).map((role) => role.id);
      });
      this.roles.set(guild, roles);
      void roles.catch(() => this.roles.delete(guild));
    }
    return (await roles).some((role) => mentioned.includes(role));
  }

  private async api(route: string, method: string, body?: Record<string, unknown> | FormData): Promise<Response> {
    const multipart = body instanceof FormData;
    const response = await this.request(`https://discord.com/api/v10${route}`, {
      method,
      headers: {
        'User-Agent': USER_AGENT,
        // Webhook URLs authenticate themselves. Never include their URLs in errors.
        ...(route.startsWith('/webhooks/') ? {} : { Authorization: `Bot ${this.token}` }),
        ...(multipart || body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new DiscordRequestError(response.status);
    return response;
  }

  private webhook(parent: string): Promise<Webhook> {
    let pending = this.webhooks.get(parent);
    if (!pending) {
      pending = (async () => {
        const response = await this.api(`/channels/${parent}/webhooks`, 'GET');
        const hooks = (await response.json()) as Webhook[];
        // Discover the same bot-owned hook after updates/restarts. Never adopt
        // another application's hook or store its token in an agent workspace.
        const existing = hooks.find(
          (hook) => hook.name === 'NanoClaw agents' && hook.user?.id === this.botId && hook.token,
        );
        if (existing) return existing;
        return (await (
          await this.api(`/channels/${parent}/webhooks`, 'POST', { name: 'NanoClaw agents' })
        ).json()) as Webhook;
      })();
      this.webhooks.set(parent, pending);
      void pending.catch(() => this.webhooks.delete(parent));
    }
    return pending;
  }

  private async send(identity: Identity, payload: Record<string, unknown>, files?: FormData): Promise<Response> {
    // Discord replies use the bot message endpoint; webhooks supply agent names
    // for ordinary output. Both transports share the same durable receipts.
    let route: string;
    let body: Record<string, unknown>;
    if (identity.replyTarget) {
      const target = identity.replyTarget;
      identity.replySource ??= (async () => {
        const replyTo = {
          channelId: target.platformId.split(':')[2],
          messageId: target.messageId,
        };
        if (replyTo.channelId !== identity.parent && replyTo.channelId !== identity.thread)
          throw new Error('Reply target is outside the current Discord conversation');
        const source = (await (
          await this.api(`/channels/${replyTo.channelId}/messages/${replyTo.messageId}`, 'GET')
        ).json()) as { author?: { bot?: boolean; id?: string } };
        if (!source.author?.id || source.author.bot) throw new Error('Reply target must be a user message');
        // Delivery belongs to the active conversation. Discord rejects reply
        // references across channels, even from a parent into its thread.
        const destination = identity.thread ?? identity.parent;
        return {
          channelId: destination,
          ...(replyTo.channelId === destination ? { messageId: replyTo.messageId } : {}),
        };
      })();
      const replyTo = await identity.replySource;
      const firstChunk = identity.nextPost === 0;
      route = `/channels/${replyTo.channelId}/messages`;
      body = {
        ...payload,
        ...(firstChunk && replyTo.messageId
          ? {
              message_reference: {
                message_id: replyTo.messageId,
                channel_id: replyTo.channelId,
                fail_if_not_exists: true,
              },
            }
          : {}),
      };
    } else if (identity.isDm) {
      route = `/channels/${identity.parent}/messages`;
      body = { ...payload };
    } else {
      const hook = await this.webhook(identity.parent);
      const query = new URLSearchParams({ wait: 'true', with_components: 'true' });
      if (identity.thread) query.set('thread_id', identity.thread);
      route = `/webhooks/${hook.id}/${hook.token}?${query}`;
      body = { ...payload, username: identity.name };
    }
    body = this.notificationPayload(identity, body);
    if (files) files.set('payload_json', JSON.stringify(body));
    // Claim the exact outbound chunk before sending, so a lost acknowledgement
    // or restart cannot POST it again. Receipts also cover successful sends
    // whose mailbox write fails.
    const postIndex = identity.nextPost++;
    const receipt = identity.deliveryId
      ? join(this.receiptDirectory(identity.deliveryId), `${postIndex}.json`)
      : undefined;
    if (receipt) {
      await mkdir(this.receiptDirectory(identity.deliveryId!), { recursive: true, mode: 0o700 });
      try {
        await writeFile(receipt, JSON.stringify({ state: 'pending' }), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const saved = JSON.parse(await readFile(receipt, 'utf8')) as { state: string; id?: string };
        if (saved.state === 'sent' && saved.id) return Response.json({ id: saved.id });
        throw new DeliveryOutcomeUnknownError();
      }
    }
    try {
      const response = await this.api(route, 'POST', files ?? body);
      // Consume the body inside this boundary: the server can accept a POST
      // before its response body times out, which the SDK would otherwise retry.
      const sent = (await response.json()) as { id: string };
      if (!sent.id) throw new DeliveryOutcomeUnknownError();
      if (receipt) await writeFile(receipt, JSON.stringify({ state: 'sent', id: sent.id }), { mode: 0o600 });
      return Response.json(sent);
    } catch (error) {
      // A client rejection is affirmative evidence that Discord did not send.
      // Server failures and transport/body failures have an unknown outcome.
      if (error instanceof DiscordRequestError && error.status >= 400 && error.status < 500) {
        if (receipt) await unlink(receipt);
        throw error;
      }
      throw new DeliveryOutcomeUnknownError();
    }
  }

  private notificationPayload(identity: Identity, payload: Record<string, unknown>): Record<string, unknown> {
    const notify = identity.nextPost === 0 && identity.notifyUserId;
    return {
      ...payload,
      flags: notify ? Number(payload.flags ?? 0) & ~4096 : Number(payload.flags ?? 0) | 4096,
      ...(notify ? { content: `<@${notify}>${payload.content ? ` ${payload.content}` : ''}` } : {}),
      allowed_mentions: { parse: [], users: notify ? [notify] : [], replied_user: false },
    };
  }

  install(adapter: ReturnType<typeof createDiscordAdapter>): void {
    const transport = adapter as unknown as DiscordInternals;
    const nativeFetch = transport.discordFetch.bind(adapter);
    transport.discordFetch = async (route, method, body) => {
      // Set the initial state at creation, preserving the scarce rename budget
      // for the generated title and completion status.
      if (
        method === 'POST' &&
        /^\/channels\/[0-9]+\/messages\/[0-9]+\/threads$/.test(route) &&
        typeof body?.name === 'string'
      )
        return nativeFetch(route, method, { ...body, name: `🟡 ${body.name}`.slice(0, 100) });
      const identity = this.context.getStore();
      const match = /^\/channels\/([0-9]+)\/messages(?:\/([0-9]+))?$/.exec(route);
      if (!identity || !match || match[1] !== (identity.thread ?? identity.parent))
        return nativeFetch(route, method, body);
      // Interactive approval cards belong to the bot application, whose
      // existing callback/authentication path must remain unchanged.
      if (method === 'POST' && !match[2]) {
        if (body?.components) return nativeFetch(route, method, this.notificationPayload(identity, body));
        return this.send(identity, body ?? {});
      }
      if (method === 'PATCH' && match[2]) {
        const message = (await (await this.api(route, 'GET')).json()) as { webhook_id?: string };
        if (!message.webhook_id) return nativeFetch(route, method, body);
        const hook = await this.webhook(identity.parent);
        if (message.webhook_id !== hook.id) throw new Error("Cannot edit another webhook's message");
        const query = new URLSearchParams();
        if (identity.thread) query.set('thread_id', identity.thread);
        return this.api(`/webhooks/${hook.id}/${hook.token}/messages/${match[2]}?${query}`, 'PATCH', {
          ...body,
          allowed_mentions: { parse: [] },
        });
      }
      return nativeFetch(route, method, body);
    };
    const nativeFiles = transport.postMessageWithFiles.bind(adapter);
    transport.postMessageWithFiles = async (channel, thread, payload, files) => {
      const identity = this.context.getStore();
      if (!identity || payload.components) return nativeFiles(channel, thread, payload, files);
      const form = new FormData();
      for (const [index, file] of files.entries()) {
        // NanoClaw outbox attachments are buffers. Reject unsupported sources
        // instead of performing a second, unauthenticated URL fetch here.
        if (typeof file.data === 'string') throw new Error('Discord identity attachments require file bytes');
        const blob =
          file.data instanceof Blob
            ? file.data
            : new Blob([file.data instanceof ArrayBuffer ? new Uint8Array(file.data) : Uint8Array.from(file.data)], {
                type: file.mimeType ?? 'application/octet-stream',
              });
        form.append(`files[${index}]`, blob, file.filename);
      }
      const raw = (await (await this.send(identity, payload, form)).json()) as { id: string };
      return { id: raw.id, threadId: thread, raw };
    };
  }
}
