import { getMessagingGroupByPlatform, getMessagingGroupAgents } from '../db/messaging-groups.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { findSessionForAgent, getSessionsByAgentGroup } from '../db/sessions.js';
import { resolveSession, withExistingMailboxSession, writeSessionMessage } from '../session-manager.js';
import { requestWake } from '../request-wake.js';
import type { Session } from '../types.js';

export type ConversationInteraction = {
  id: string;
  token: string;
  application_id: string;
  guild_id?: string;
  type: number;
  channel_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: {
    name?: string;
    custom_id?: string;
    values?: string[];
    options?: Array<{
      name: string;
      value?: string | number;
      options?: Array<{ name: string; value?: string | number }>;
    }>;
    components?: Array<{ components: Array<{ custom_id: string; value?: string }> }>;
  };
};
type Reply = { content: string; components?: unknown[] };
type DiscordApi = <T>(route: string, method: string, body?: unknown) => Promise<T>;
const messageOption = {
  type: 3,
  name: 'message',
  description: 'Follow-up to run after the current turn',
  max_length: 4000,
};
export const DISCORD_CONVERSATION_COMMANDS = [
  {
    name: 'model',
    description: 'Show or change the model for this conversation',
    type: 1,
    options: [
      {
        type: 3,
        name: 'model',
        description: 'Model name or family, optionally with reasoning: sol medium',
        max_length: 120,
      },
    ],
  },
  {
    name: 'queue',
    description: 'Queue a follow-up, or inspect/edit pending messages',
    type: 1,
    options: [messageOption, { type: 4, name: 'page', description: 'Page of queued messages', min_value: 1 }],
  },
  { name: 'clear-queue', description: 'Cancel all pending queued inputs in this conversation', type: 1 },
  {
    name: 'btw',
    description: 'Ask a side question in a sibling thread with copied context',
    type: 1,
    options: [{ ...messageOption, name: 'question', description: 'Side question', required: true }],
  },
  {
    name: 'resume',
    description: 'Find and reopen a conversation for this agent and channel',
    type: 1,
    options: [{ type: 4, name: 'page', description: 'Page of conversations', min_value: 1 }],
  },
];

/** Owner-authorized commands only. All conversation writes use the existing mailbox. */
export class DiscordConversations {
  constructor(
    private readonly guild: string,
    private readonly api: DiscordApi,
    private readonly wake: typeof requestWake = requestWake,
  ) {}

  private async context(interaction: ConversationInteraction) {
    if (!interaction.channel_id) throw new Error('Use this command in an agent conversation.');
    const channel = await this.api<{ type: number; parent_id?: string }>(`channels/${interaction.channel_id}`, 'GET');
    const isThread = channel.type === 11 || channel.type === 12;
    const parent = isThread ? channel.parent_id! : interaction.channel_id;
    const platformId = `discord:${this.guild}:${parent}`;
    const messaging = await getMessagingGroupByPlatform('discord', platformId);
    const wirings = messaging ? await getMessagingGroupAgents(messaging.id) : [];
    if (!messaging || wirings.length !== 1 || wirings[0].session_mode !== 'per-thread')
      throw new Error('Use this command in a channel wired to one agent with separate thread sessions.');
    const group = await getAgentGroup(wirings[0].agent_group_id);
    if (!group) throw new Error('This agent no longer exists.');
    return {
      group,
      messaging,
      parent,
      platformId,
      threadId: isThread ? `${platformId}:${interaction.channel_id}` : null,
    };
  }

  private async current(interaction: ConversationInteraction) {
    const context = await this.context(interaction);
    if (!context.threadId) throw new Error('Open a conversation thread first. Use /resume to find one.');
    const session = await findSessionForAgent(context.group.id, context.messaging.id, context.threadId);
    if (!session) throw new Error('This thread has no conversation yet. Send a message first.');
    return { ...context, session };
  }

  private async pending(session: Session) {
    return (
      (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
        const claimed = new Set(mailbox.getProcessingClaims().map((claim) => claim.messageId));
        return mailbox.getQueuedInputs().filter((input) => !claimed.has(input.id));
      })) ?? []
    );
  }

  private async change(session: Session, id: string, text: string | null) {
    const changed = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
      if (mailbox.getProcessingClaims().some((claim) => claim.messageId === id)) return false;
      return mailbox.updateQueuedInput(id, text);
    });
    if (!changed) throw new Error('This input has already started, was removed, or no longer exists.');
  }

  async editModal(interaction: ConversationInteraction): Promise<unknown> {
    const { session } = await this.current(interaction);
    const id = interaction.data!.custom_id!.slice('ncc:edit:'.length);
    const input = (await this.pending(session)).find((item) => item.id === id);
    if (!input) throw new Error('This queued input has already started or was removed.');
    return {
      type: 9,
      data: {
        custom_id: `ncc:save:${id}`,
        title: 'Edit queued message',
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: 'text',
                label: 'Message',
                style: 2,
                required: true,
                max_length: 4000,
                value: input.text,
              },
            ],
          },
        ],
      },
    };
  }

  async command(interaction: ConversationInteraction, userId: string): Promise<Reply> {
    const custom = interaction.data?.custom_id ?? '';
    const name = interaction.data?.name;
    if (name === 'resume' || custom === 'ncc:resume') return this.resume(interaction);
    const context = await this.current(interaction);
    const { session, group, platformId, threadId } = context;
    const options = Object.fromEntries((interaction.data?.options ?? []).map((option) => [option.name, option.value]));
    if (name === 'model') {
      const specification = String(options.model ?? '').trim();
      await writeSessionMessage(group.id, session.id, {
        id: interaction.id,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId,
        channelType: 'discord',
        threadId,
        content: JSON.stringify({
          text: `/model${specification ? ' ' + specification : ''}`,
          sender: 'Owner',
          senderId: `discord:${userId}`,
          delivery: 'queue',
        }),
      });
      await this.wake(session, 'interactive');
      return { content: 'Model request queued for this conversation. A running turn finishes first.' };
    }
    if (name === 'btw') {
      const question = String(options.question ?? '').trim();
      if (!question) throw new Error('Provide a side question.');
      const forkFrom = await withExistingMailboxSession(group.id, session.id, (mailbox) =>
        mailbox.getProviderContinuation('codex'),
      );
      if (session.agent_provider !== 'codex' || !forkFrom)
        throw new Error('Wait for this Codex conversation to start before forking its history.');
      const thread = await this.api<{ id: string }>(`channels/${context.parent}/threads`, 'POST', {
        name: `🟡 ${question.replace(/[@\r\n]/g, '').slice(0, 90)}`,
        type: 11,
        auto_archive_duration: 1440,
      });
      const forkThread = `${platformId}:${thread.id}`;
      const { session: fork } = await resolveSession(group.id, context.messaging.id, forkThread, 'per-thread');
      await this.api(`channels/${thread.id}/thread-members/${userId}`, 'PUT');
      await this.api(`channels/${thread.id}/messages`, 'POST', {
        content: `Side question from <#${interaction.channel_id}>:\n${question}`.slice(0, 2000),
        allowed_mentions: { parse: [] },
        flags: 4096,
      });
      await writeSessionMessage(group.id, fork.id, {
        id: interaction.id,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId,
        channelType: 'discord',
        threadId: forkThread,
        content: JSON.stringify({
          text: `This is a side conversation fork. Answer only the side question below. Do not continue or repeat the original task. The source conversation is running independently.\n\n${question}`,
          sender: 'Owner',
          senderId: `discord:${userId}`,
          forkFrom,
        }),
      });
      await this.wake(fork, 'interactive');
      await this.api(`channels/${interaction.channel_id}/messages`, 'POST', {
        content: `Side question: <#${thread.id}>`,
        allowed_mentions: { parse: [] },
        flags: 4096,
      });
      return { content: `Opened <#${thread.id}>. This conversation continues independently.` };
    }
    if (name === 'queue' && typeof options.message === 'string') {
      const text = options.message.trim();
      if (!text) throw new Error('Provide a non-empty message.');
      await writeSessionMessage(group.id, session.id, {
        id: interaction.id,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId,
        channelType: 'discord',
        threadId,
        content: JSON.stringify({ text, sender: 'Owner', senderId: `discord:${userId}`, delivery: 'queue' }),
      });
      await this.wake(session, 'interactive');
    } else if (name === 'clear-queue') {
      await withExistingMailboxSession(group.id, session.id, (mailbox) => {
        const claimed = new Set(mailbox.getProcessingClaims().map((claim) => claim.messageId));
        for (const item of mailbox.getQueuedInputs())
          if (!claimed.has(item.id)) mailbox.updateQueuedInput(item.id, null);
      });
      return { content: 'Pending queue cleared. The current turn continues.' };
    } else if (custom.startsWith('ncc:remove:')) {
      await this.change(session, custom.slice('ncc:remove:'.length), null);
    } else if (custom.startsWith('ncc:save:')) {
      const text = interaction.data?.components
        ?.flatMap((row) => row.components)
        .find((field) => field.custom_id === 'text')
        ?.value?.trim();
      if (!text || text.length > 4000) throw new Error('Provide a message of 1–4000 characters.');
      await this.change(session, custom.slice('ncc:save:'.length), text);
    }
    const pending = await this.pending(session);
    const page = Math.max(1, Number(options.page ?? 1));
    const visible = pending.slice((page - 1) * 5, page * 5);
    return {
      content: pending.length
        ? `Pending queue (${pending.length}), page ${page}:\n${visible
            .map((item, i) => `${i + 1}. ${item.text.slice(0, 220)}`)
            .join('\n')}\nUse /queue again to refresh.`
        : 'No pending queued messages. An idle conversation runs queued inputs immediately.',
      components: visible.map((item, i) => ({
        type: 1,
        components: [
          { type: 2, style: 2, label: `Edit ${i + 1}`, custom_id: `ncc:edit:${item.id}` },
          { type: 2, style: 4, label: `Remove ${i + 1}`, custom_id: `ncc:remove:${item.id}` },
        ],
      })),
    };
  }

  private async resume(interaction: ConversationInteraction): Promise<Reply> {
    const { group, messaging, platformId } = await this.context(interaction);
    const sessions = (await getSessionsByAgentGroup(group.id))
      .filter(
        (session) =>
          session.messaging_group_id === messaging.id &&
          session.status === 'active' &&
          session.thread_id?.startsWith(`${platformId}:`),
      )
      .sort((a, b) => (b.last_active ?? b.created_at).localeCompare(a.last_active ?? a.created_at));
    const selected = interaction.data?.values?.[0];
    if (selected) {
      const session = sessions.find((item) => item.id === selected);
      if (!session) throw new Error('Choose a conversation from this agent and channel.');
      const thread = session.thread_id!.split(':')[3];
      await this.api(`channels/${thread}`, 'PATCH', { archived: false });
      return { content: `Continue in <#${thread}>. Its existing session and context are preserved.`, components: [] };
    }
    const page = Math.max(1, Number(interaction.data?.options?.find((option) => option.name === 'page')?.value ?? 1));
    const rows = sessions.slice((page - 1) * 25, page * 25);
    if (!rows.length) return { content: 'No conversations on this page.' };
    const entries = await Promise.all(
      rows.map(async (session) => {
        const thread = session.thread_id!.split(':')[3];
        let metadata: { name: string };
        try {
          metadata = await this.api<{ name: string }>(`channels/${thread}`, 'GET');
        } catch (error) {
          if ((error as { status?: number }).status === 404) return null;
          throw error;
        }
        return {
          label: metadata.name.slice(0, 100),
          value: session.id,
          description: `Last active ${(session.last_active ?? session.created_at).slice(0, 16)}`,
        };
      }),
    );
    const choices = entries.filter((entry) => entry !== null);
    if (!choices.length) return { content: 'No available Discord threads on this page. Try the next page.' };
    return {
      content: `Choose a conversation. Page ${page} of ${Math.ceil(sessions.length / 25)}.`,
      components: [
        {
          type: 1,
          components: [{ type: 3, custom_id: 'ncc:resume', placeholder: 'Resume a conversation', options: choices }],
        },
      ],
    };
  }
}
