/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { DiscordIdentity } from './discord-identity.js';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { loadDiscordAgentManager } from './discord-agent-manager.js';

import { createDiscordFeedback, DiscordThreadStatus } from './discord-feedback.js';
import { readEnvFile } from '../env.js';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { getOwners } from '../modules/permissions/db/user-roles.js';
import { log } from '../log.js';
import type { ChannelDefaults, ChannelSetup } from './adapter.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot app on a threaded platform. group threads:true matches the
 * declared supportsThreads (the skill-installed install-style knob) so
 * mention-sticky engagement stays bounded per-thread. dm.threads:false —
 * DM replies land top-level, one session per DM.
 */
const DISCORD_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

/**
 * Discord message forwards carry their content in `message_snapshots`, not
 * `content` (`message_reference.type === 1` means FORWARD; 0 is a normal
 * reply). The adapter only reads `content`/`attachments`, so without this the
 * agent sees an empty message. Unwrap the snapshot back into the payload so
 * text, attachment download, and formatting all ride the existing path.
 * Note: snapshots contain no author, so the original sender is unavailable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapForwardedSnapshot(data: Record<string, any>): void {
  if (data.message_reference?.type !== 1) return;
  const snaps = (data.message_snapshots ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((s: any) => s?.message)
    .filter(Boolean);
  if (snaps.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = snaps
    .map((m: any) => m.content)
    .filter(Boolean)
    .join('\n');
  const label = '[Forwarded message]';
  data.content = text ? `${label}\n${text}` : data.content || label;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fwdAttachments = snaps.flatMap((m: any) => m.attachments ?? []);
  if (fwdAttachments.length > 0) {
    data.attachments = [...(data.attachments ?? []), ...fwdAttachments];
  }
}

function unwrapForwards(
  adapter: ReturnType<typeof createDiscordAdapter>,
  opensConversation: (guildId: string, channelId: string) => boolean,
  identity: DiscordIdentity,
): void {
  const a = adapter as unknown as {
    handleForwardedMessage: (data: Record<string, unknown>, options?: unknown) => Promise<void>;
    createDiscordThread: (channelId: string, messageId: string) => Promise<{ id: string; name: string }>;
  };
  const pending = new Map<string, Record<string, unknown>>();
  const createThread = a.createDiscordThread.bind(adapter);
  a.createDiscordThread = async (channelId, messageId) => {
    const thread = await createThread(channelId, messageId);
    const source = pending.get(messageId);
    if (source) source.initial_thread_name = thread.name;
    return thread;
  };
  const orig = a.handleForwardedMessage.bind(adapter);
  a.handleForwardedMessage = async (data, options) => {
    unwrapForwardedSnapshot(data);
    if (await identity.recognizesRole(String(data.guild_id ?? ''), (data.mention_roles ?? []) as string[]))
      data.is_mention = true;
    const id = String(data.id);
    pending.set(id, data);
    try {
      // Managed chat channels open conversations without requiring a mention.
      // Supply the real thread metadata rather than inventing a mention flag.
      if (
        !(data.author as { bot?: boolean } | undefined)?.bot &&
        !data.thread &&
        data.channel_type !== 11 &&
        data.channel_type !== 12 &&
        !/^(?:stop|\/stop)$/i.test(String(data.content ?? '').trim()) &&
        opensConversation(String(data.guild_id), String(data.channel_id))
      ) {
        const thread = await a.createDiscordThread(String(data.channel_id), id);
        data.thread = { id: thread.id, parent_id: data.channel_id };
      }
      await orig(data, options);
    } finally {
      pending.delete(id);
    }
  };
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    const manager = loadDiscordAgentManager(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
    const identity = new DiscordIdentity(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID!);
    identity.install(discordAdapter);
    unwrapForwards(
      discordAdapter,
      (guildId, channelId) => manager?.ownsActiveChannel(guildId, channelId) ?? false,
      identity,
    );
    const feedback = createDiscordFeedback(discordAdapter);
    const threadStatus = new DiscordThreadStatus(
      env.DISCORD_BOT_TOKEN,
      fetch,
      path.join(DATA_DIR, 'discord-thread-status.json'),
    );
    const bridge = createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      handleGatewayInteraction: manager ? (interaction) => manager.handle(interaction) : undefined,
      extractReplyContext,
      supportsThreads: true,
      defaults: DISCORD_DEFAULTS,
      // Reserve space for the owner mention on needs-input replies.
      maxTextLength: 1970,
    });
    return {
      ...bridge,
      async setup(setup: ChannelSetup) {
        await manager?.prepareWorkspaces();
        await bridge.setup(setup);
        try {
          await manager?.register();
        } catch (error) {
          log.error(
            'Discord agent commands could not be registered; chat remains available. Retry registration after recovery.',
            { err: error },
          );
        }
      },
      finalizeDelivery: (deliveryId) => identity.finalizeDelivery(deliveryId),
      async deliver(platformId, threadId, message) {
        if (message.kind === 'thread_title')
          return threadStatus.rename(threadId ?? platformId, message.content).then(() => undefined);
        const content = message.content as {
          needsInput?: boolean;
          type?: string;
          phase?: string;
          initialThreadName?: string;
          replyTarget?: import('../mailbox/model.js').FeedbackTarget;
        };
        const needsInput = content.needsInput === true || content.type === 'ask_question';
        const phases: Record<string, 'running' | 'completed' | 'blocked' | 'cancelled' | undefined> = {
          received: 'running',
          completed: 'completed',
          failed: 'blocked',
          cancelled: 'cancelled',
        };
        const status = needsInput
          ? 'blocked'
          : message.kind === 'agent_progress'
            ? phases[content.phase ?? '']
            : undefined;
        const statusUpdate = status
          ? threadStatus.set(threadId ?? platformId, status, content.initialThreadName).catch((error) => {
              log.warn('Discord thread status could not be updated', { err: error });
            })
          : Promise.resolve();
        const notifyUserId = needsInput
          ? (await getOwners()).find((owner) => owner.user_id.startsWith('discord:'))?.user_id.slice('discord:'.length)
          : undefined;
        const replyTarget =
          message.kind === 'chat'
            ? (message.content as { replyTarget?: import('../mailbox/model.js').FeedbackTarget }).replyTarget
            : undefined;
        const delivery = identity.run(
          threadId ?? platformId,
          message.senderName,
          () =>
            message.kind === 'agent_progress'
              ? feedback(threadId ?? platformId, message.content)
              : bridge.deliver(platformId, threadId, message),
          message.deliveryId,
          replyTarget,
          notifyUserId,
        );
        const [result] = await Promise.all([delivery, statusUpdate]);
        return result;
      },
    };
  },
  defaults: DISCORD_DEFAULTS,
});
