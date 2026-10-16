import { setTimeout as sleep } from 'node:timers/promises';
import {
  DiscordConversations,
  DISCORD_CONVERSATION_COMMANDS,
  type ConversationInteraction,
} from './discord-conversations.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { DATA_DIR } from '../config.js';
import { isOwner } from '../modules/permissions/db/user-roles.js';
import { log } from '../log.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../db/sessions.js';
import { assertAgentGroupIdle, isContainerRunning, killContainer } from '../container-runner.js';
import { getMessagingGroupByPlatform, getMessagingGroupAgents } from '../db/messaging-groups.js';
import {
  knowledgeList,
  knowledgeRead,
  knowledgeFingerprint,
  knowledgeRemove,
  knowledgePage,
  type KnowledgeKind,
} from './discord-agent-knowledge.js';
import {
  archiveAgentWorkspace,
  configureAgentWorkspace,
  deleteAgentWorkspace,
  restartManagedAgent,
  restoreAgentWorkspace,
  validateAgentSetup,
  wireManagedAgent,
  type AgentManagerConfig,
  type ManagedDiscordAgent,
} from './discord-agent-workspaces.js';

type Interaction = ConversationInteraction;

const nameOption = { type: 3, name: 'name', description: 'Agent name', required: true, min_length: 1, max_length: 50 };
const setupOptions = [
  { type: 3, name: 'personality', description: 'Personality and purpose (SOUL.md)', max_length: 4000 },
  { type: 3, name: 'model', description: 'Model id; omit to keep the working default', max_length: 100 },
  {
    type: 3,
    name: 'skills',
    description: 'Source skills to add, comma-separated; existing skills are kept',
    max_length: 1000,
  },
  {
    type: 3,
    name: 'tools',
    description: 'Source MCP tools to allow, comma-separated, or none. SSH tools grant host access.',
    max_length: 1000,
  },
];

export const DISCORD_AGENT_COMMAND = {
  name: 'agent',
  description: 'Manage your personal AI assistants',
  type: 1,
  options: [
    {
      type: 1,
      name: 'create',
      description: 'Create a personality with its own private category and chat',
      options: [nameOption, ...setupOptions],
    },
    { type: 1, name: 'list', description: 'List agents and their chat channels' },
    {
      type: 1,
      name: 'edit',
      description: 'Edit an agent personality, model, tools, or add skills',
      options: [nameOption, ...setupOptions],
    },
    ...['archive', 'restore', 'delete'].map((name) => ({
      type: 1,
      name,
      description: `${name[0].toUpperCase() + name.slice(1)} a managed agent`,
      options: [nameOption],
    })),
  ],
};

const agentOption = { type: 3, name: 'agent', description: 'Agent name, including GLaDOS; omit in its chat channel' };
const pageOption = { type: 4, name: 'page', description: 'Page number', min_value: 1 };
export const DISCORD_KNOWLEDGE_COMMANDS = (['skills', 'memory'] as const).map((kind) => ({
  name: kind,
  description:
    kind === 'skills' ? 'Inspect and remove this agent’s own skills' : 'Inspect and forget saved memory documents',
  type: 1,
  options: [
    { type: 1, name: 'list', description: `List saved ${kind}`, options: [agentOption, pageOption] },
    {
      type: 1,
      name: 'show',
      description: `Read ${kind === 'skills' ? 'a skill' : 'a memory document'}`,
      options: [
        {
          type: 3,
          name: kind === 'skills' ? 'name' : 'file',
          description: 'Name from the list',
          required: true,
          max_length: 180,
        },
        agentOption,
        pageOption,
      ],
    },
    {
      type: 1,
      name: kind === 'skills' ? 'remove' : 'forget',
      description: 'Request removal, with confirmation',
      options: [
        {
          type: 3,
          name: kind === 'skills' ? 'name' : 'file',
          description: 'Name from the list',
          required: true,
          max_length: 180,
        },
        agentOption,
      ],
    },
  ],
}));
type Removal = {
  userId: string;
  groupId: string;
  folder: string;
  kind: KnowledgeKind;
  target: string;
  fingerprint: string;
  expires: number;
};

/** One Discord command, host-owned registry, and native agent lifecycle. No model turn is needed. */
export class DiscordAgentManager {
  private readonly conversations: DiscordConversations;
  private readonly agents: ManagedDiscordAgent[];
  private queue: Promise<void> = Promise.resolve();
  private readonly seen = new Map<string, number>();
  private readonly removals = new Map<string, Removal>();

  constructor(
    private readonly config: AgentManagerConfig,
    private readonly token: string,
    private readonly applicationId: string,
    private readonly stateFile = path.join(DATA_DIR, 'discord-agents', 'agents.json'),
    private readonly request: typeof fetch = fetch,
  ) {
    this.conversations = new DiscordConversations(config.guildId, this.api.bind(this));
    this.agents = fs.existsSync(stateFile)
      ? (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as ManagedDiscordAgent[])
      : [];
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = this.stateFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.agents, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
  }

  private async api<T>(route: string, method: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.request(`https://discord.com/api/v10/${route}`, {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'OpenAI File Downloader, XaiImageApiFetch/1.0',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error('Discord request failed. Retry the command to continue.', { cause: error });
    }
    if (response.status === 429) {
      const body = (await response.json()) as { retry_after: number };
      throw Object.assign(new Error('Discord rate-limited this command. Try again after its cooldown.'), {
        status: 429,
        retryAfterMs: body.retry_after * 1000,
      });
    }
    if (response.status === 404 && method === 'DELETE') return undefined as T;
    if (!response.ok)
      throw Object.assign(new Error(`Discord returned HTTP ${response.status}. Check bot permissions, then retry.`), {
        status: response.status,
      });
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  ownsActiveChannel(guildId: string, channelId: string): boolean {
    return (
      guildId === this.config.guildId &&
      this.agents.some((agent) => agent.status === 'active' && agent.channelId === channelId)
    );
  }

  async prepareWorkspaces(): Promise<void> {
    for (const agent of this.agents)
      if (agent.status === 'active' || agent.status === 'archived') await configureAgentWorkspace(this.config, agent);
  }

  async register(): Promise<void> {
    const commands = [
      DISCORD_AGENT_COMMAND,
      ...DISCORD_KNOWLEDGE_COMMANDS,
      ...DISCORD_CONVERSATION_COMMANDS,
      { name: 'stop', description: 'Stop this conversation and its active tools', type: 1 },
    ];
    // Command POSTs upsert by name and are safe to repeat after a known 429.
    // Never bulk-replace unrelated commands or retry non-idempotent channel creation.
    for (const command of commands) {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.api(`applications/${this.applicationId}/guilds/${this.config.guildId}/commands`, 'POST', command);
          break;
        } catch (error) {
          const failure = error as { status?: number; retryAfterMs?: number };
          const delay = failure.retryAfterMs;
          if (
            failure.status !== 429 ||
            delay === undefined ||
            !Number.isFinite(delay) ||
            delay < 0 ||
            delay > 60_000 ||
            attempt >= 2
          )
            throw error;
          await sleep(Math.ceil(delay) + 100);
        }
      }
    }
  }

  async handle(raw: Record<string, unknown>): Promise<boolean> {
    const interaction = raw as unknown as Interaction;
    const ours =
      (interaction.type === 2 &&
        ['agent', 'stop', 'skills', 'memory', ...DISCORD_CONVERSATION_COMMANDS.map((command) => command.name)].includes(
          interaction.data?.name ?? '',
        )) ||
      ([3, 5].includes(interaction.type) &&
        (interaction.data?.custom_id?.startsWith('nca:delete:') ||
          interaction.data?.custom_id?.startsWith('nck:') ||
          interaction.data?.custom_id?.startsWith('ncc:')));
    if (!ours) return false;
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    const callback = `interactions/${interaction.id}/${interaction.token}/callback`;
    if (
      interaction.application_id !== this.applicationId ||
      interaction.guild_id !== this.config.guildId ||
      !userId ||
      !(await isOwner(`discord:${userId}`))
    ) {
      await this.api(callback, 'POST', {
        type: 4,
        data: { content: 'Only the NanoClaw owner can manage agents in the configured server.', flags: 64 },
      });
      return true;
    }
    // Gateway events may be redelivered. Bound the cache to interaction-token lifetime.
    const now = Date.now();
    for (const [id, expires] of this.seen) if (expires < now) this.seen.delete(id);
    if (this.seen.has(interaction.id)) return true;
    this.seen.set(interaction.id, now + 15 * 60_000);
    if (interaction.data?.custom_id?.startsWith('ncc:edit:')) {
      try {
        await this.api(callback, 'POST', await this.conversations.editModal(interaction));
      } catch (error) {
        await this.api(callback, 'POST', {
          type: 4,
          data: { content: error instanceof Error ? error.message : 'Cannot edit this queued input.', flags: 64 },
        });
      }
      return true;
    }
    await this.api(callback, 'POST', { type: interaction.type === 3 ? 6 : 5, data: { flags: 64 } });
    const execute = async () => {
      const reply = `webhooks/${this.applicationId}/${interaction.token}/messages/@original`;
      try {
        const message =
          interaction.data?.custom_id?.startsWith('ncc:') ||
          DISCORD_CONVERSATION_COMMANDS.some((command) => command.name === interaction.data?.name)
            ? await this.conversations.command(interaction, userId)
            : interaction.type === 3
              ? interaction.data?.custom_id?.startsWith('nck:')
                ? await this.confirmKnowledgeRemoval(interaction, userId)
                : await this.confirmDelete(interaction, userId)
              : await this.command(interaction, userId);
        await this.api(reply, 'PATCH', { ...message, allowed_mentions: { parse: [] } });
      } catch (error) {
        log.error('Discord agent command failed', {
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        await this.api(reply, 'PATCH', {
          content: error instanceof Error ? error.message : 'Agent command failed.',
          components: [],
          allowed_mentions: { parse: [] },
        });
      }
    };
    if (interaction.data?.name === 'stop') {
      await execute();
      return true;
    }
    // A failed reply must not poison subsequent management commands.
    this.queue = this.queue.then(execute).catch((error: unknown) => {
      log.error('Discord agent reply failed', { message: error instanceof Error ? error.message : 'Unknown error' });
    });
    await this.queue;
    return true;
  }

  private find(name: string): ManagedDiscordAgent {
    const agent = this.agents.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase() && candidate.status !== 'deleted',
    );
    if (!agent) throw new Error(`No managed agent named ${name}. Use /agent list.`);
    return agent;
  }

  private async command(
    interaction: Interaction,
    userId: string,
  ): Promise<{ content: string; components?: unknown[] }> {
    if (interaction.data?.name === 'skills' || interaction.data?.name === 'memory')
      return this.knowledgeCommand(interaction, userId);
    if (interaction.data?.name === 'stop') {
      if (!interaction.channel_id) throw new Error('Stop requires a conversation channel.');
      const channel = await this.api<{ type: number; parent_id?: string }>(`channels/${interaction.channel_id}`, 'GET');
      const thread = channel.type === 11 || channel.type === 12;
      const platformId = `discord:${this.config.guildId}:${thread ? channel.parent_id : interaction.channel_id}`;
      const { routeInbound } = await import('../router.js');
      await routeInbound({
        channelType: 'discord',
        instance: 'discord',
        platformId,
        threadId: thread ? `${platformId}:${interaction.channel_id}` : null,
        message: {
          id: interaction.id,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          isMention: true,
          isGroup: true,
          content: JSON.stringify({ text: 'stop', sender: 'Owner', senderId: `discord:${userId}` }),
        },
      });
      return { content: 'Stop requested for this conversation.' };
    }
    const subcommand = interaction.data?.options?.[0];
    const options = Object.fromEntries(
      (subcommand?.options ?? []).map((option) => [option.name, String(option.value ?? '')]),
    );
    if (subcommand?.name === 'list') {
      const lines = this.agents
        .filter((agent) => agent.status !== 'deleted')
        .map((agent) => `${agent.name}: ${agent.status}${agent.channelId ? ` · <#${agent.channelId}>` : ''}`);
      return { content: lines.join('\n').slice(0, 1900) || 'No managed agents yet. Use /agent create.' };
    }
    const name = options.name?.trim();
    if (!name || name.length > 50 || /[@`\r\n]/.test(name))
      throw new Error('Use a name of 1–50 characters without mentions or line breaks.');
    if (subcommand?.name === 'create') return this.create(name, options, userId);
    const agent = this.find(name);
    switch (subcommand?.name) {
      case 'edit': {
        if (agent.status !== 'active' && agent.status !== 'archived')
          throw new Error('Finish the pending lifecycle operation before editing.');
        const updated = this.applySetup({ ...agent }, options);
        await validateAgentSetup(this.config, updated);
        if (Object.keys(options).every((key) => key === 'name'))
          throw new Error('Choose a personality, model, skills, or tools change.');
        await configureAgentWorkspace(this.config, updated, options);
        Object.assign(agent, updated);
        this.persist();
        await restartManagedAgent(agent);
        return { content: `Updated ${agent.name}. Its next turn uses the new setup.` };
      }
      case 'archive':
        await this.archive(agent);
        return { content: `Archived ${agent.name}. Replies and schedules are stopped; files and history are kept.` };
      case 'restore':
        if (agent.status !== 'archived') throw new Error('Only an archived agent can be restored.');
        await restoreAgentWorkspace(this.config, agent);
        agent.status = 'active';
        this.persist();
        return { content: `Restored ${agent.name}: <#${agent.channelId}>` };
      case 'delete': {
        agent.confirmation = { token: randomUUID(), userId, expires: Date.now() + 5 * 60_000 };
        this.persist();
        return {
          content: `Delete ${agent.name}? This removes its Discord chat/category and stops its tasks. Workspace files remain on disk. Confirmation expires in five minutes.`,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 4,
                  label: `Delete ${agent.name}`.slice(0, 80),
                  custom_id: `nca:delete:${agent.id}:${agent.confirmation.token}`,
                },
              ],
            },
          ],
        };
      }
      default:
        throw new Error('Unknown agent command.');
    }
  }

  private async knowledgeGroup(interaction: Interaction, name?: string) {
    const source = await getAgentGroup(this.config.sourceGroupId);
    let id: string | undefined;
    if (name) {
      id =
        source && [source.name, source.id].some((value) => value.toLowerCase() === name.toLowerCase())
          ? source.id
          : this.find(name).groupId;
    } else if (interaction.channel_id) {
      const channel = await this.api<{ type: number; parent_id?: string }>(`channels/${interaction.channel_id}`, 'GET');
      const channelId = channel.type === 11 || channel.type === 12 ? channel.parent_id : interaction.channel_id;
      const messaging = await getMessagingGroupByPlatform('discord', `discord:${this.config.guildId}:${channelId}`);
      if (messaging) {
        const agents = await getMessagingGroupAgents(messaging.id);
        if (agents.length === 1) id = agents[0].agent_group_id;
      }
    }
    if (
      !id ||
      (id !== source?.id &&
        !this.agents.some((agent) => agent.groupId === id && ['active', 'archived'].includes(agent.status)))
    )
      throw new Error('Choose an agent name, or use this command in its chat channel.');
    const group = await getAgentGroup(id);
    if (!group) throw new Error('This agent no longer exists.');
    return group;
  }

  private async knowledgeCommand(
    interaction: Interaction,
    userId: string,
  ): Promise<{ content: string; components?: unknown[] }> {
    const kind = interaction.data!.name as KnowledgeKind;
    const subcommand = interaction.data?.options?.[0];
    const options = Object.fromEntries(
      (subcommand?.options ?? []).map((option) => [option.name, String(option.value ?? '')]),
    );
    const group = await this.knowledgeGroup(interaction, options.agent);
    const page = options.page === undefined ? 1 : Number(options.page);
    if (subcommand?.name === 'list')
      return { content: knowledgePage(`${group.name} · ${kind}`, knowledgeList(group.folder, kind).join('\n'), page) };
    const target = kind === 'skills' ? options.name : options.file;
    if (!target) throw new Error('Choose a name from the list.');
    if (subcommand?.name === 'show')
      return { content: knowledgePage(`${group.name} · ${target}`, knowledgeRead(group.folder, kind, target), page) };
    if (subcommand?.name !== (kind === 'skills' ? 'remove' : 'forget')) throw new Error('Unknown inspection command.');
    const fingerprint = knowledgeFingerprint(group.folder, kind, target);
    for (const [key, removal] of this.removals) if (removal.expires < Date.now()) this.removals.delete(key);
    const nonce = randomUUID();
    this.removals.set(nonce, {
      userId,
      groupId: group.id,
      folder: group.folder,
      kind,
      target,
      fingerprint,
      expires: Date.now() + 5 * 60_000,
    });
    return {
      content: `Remove ${kind === 'skills' ? 'skill and its supporting files' : 'saved memory document'} \`${target}\` from ${group.name}? This stops that agent's active turns. Historical conversations and other copies remain. Confirmation expires in five minutes.`,
      components: [
        { type: 1, components: [{ type: 2, style: 4, label: 'Confirm removal', custom_id: `nck:${nonce}` }] },
      ],
    };
  }

  private async confirmKnowledgeRemoval(
    interaction: Interaction,
    userId: string,
  ): Promise<{ content: string; components: unknown[] }> {
    const nonce = interaction.data!.custom_id!.slice(4);
    const removal = this.removals.get(nonce);
    if (!removal || removal.userId !== userId || removal.expires < Date.now())
      throw new Error('This confirmation expired or was already used. Request removal again.');
    this.removals.delete(nonce);
    const group = await getAgentGroup(removal.groupId);
    if (!group || group.folder !== removal.folder) throw new Error('The agent changed. Request removal again.');
    const sessions = await getSessionsByAgentGroup(group.id);
    await Promise.all(
      sessions
        .filter((session) => isContainerRunning(session.id))
        .map(
          (session) =>
            new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error('Agent shutdown did not finish. No content was removed; retry after recovery.')),
                15_000,
              );
              killContainer(session.id, 'knowledge-removal', () => {
                clearTimeout(timeout);
                resolve();
              });
            }),
        ),
    );
    const settledSessions = await getSessionsByAgentGroup(group.id);
    // Keep the quiescence check and file mutation in the same synchronous
    // turn. Incoming work that raced shutdown causes refusal, not data loss.
    assertAgentGroupIdle(group.id, settledSessions);
    knowledgeRemove(group.folder, removal.kind, removal.target, removal.fingerprint);
    if (removal.kind === 'skills') {
      const managed = this.agents.find((agent) => agent.groupId === group.id);
      if (managed) {
        managed.skills = managed.skills.filter((name) => name !== removal.target);
        this.persist();
      }
    }
    return {
      content: `Removed ${removal.target} from ${group.name}. Historical conversations and other copies remain.`,
      components: [],
    };
  }

  private applySetup(agent: ManagedDiscordAgent, options: Record<string, string>): ManagedDiscordAgent {
    const list = (value: string) => [
      ...new Set(
        value
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    ];
    if (options.personality !== undefined) {
      if (!options.personality.trim() || options.personality.length > 4000)
        throw new Error('Personality must contain 1–4000 characters.');
      agent.personality = options.personality;
    }
    if (options.model !== undefined) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/.test(options.model)) throw new Error('Invalid model id.');
      agent.model = options.model;
    }
    if (options.skills !== undefined) agent.skills = [...new Set([...agent.skills, ...list(options.skills)])];
    if (options.tools !== undefined) agent.tools = options.tools.trim() === 'none' ? [] : list(options.tools);
    return agent;
  }

  private async create(name: string, options: Record<string, string>, userId: string): Promise<{ content: string }> {
    let agent = this.agents.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase() && candidate.status !== 'deleted',
    );
    if (agent && agent.status !== 'creating') throw new Error(`Agent ${name} already exists. Use /agent edit.`);
    if (!agent) {
      agent = this.applySetup(
        {
          id: randomUUID(),
          name,
          folder: `discord-agent-${randomUUID()}`,
          status: 'creating',
          personality: `You are ${name}, a personal AI assistant.`,
          skills: [],
          tools: [],
          pausedTasks: [],
          closedSessions: [],
        },
        options,
      );
      await validateAgentSetup(this.config, agent);
      this.agents.push(agent);
      this.persist();
    }
    await configureAgentWorkspace(this.config, agent);
    this.persist();
    if (!agent.categoryId) {
      // Private to creator and bot; threads inherit the channel permissions.
      const chat = (
        (1n << 10n) |
        (1n << 11n) |
        (1n << 14n) |
        (1n << 15n) |
        (1n << 16n) |
        (1n << 31n) |
        (1n << 35n) |
        (1n << 38n)
      ).toString();
      const category = await this.api<{ id: string }>(`guilds/${this.config.guildId}/channels`, 'POST', {
        name: agent.name,
        type: 4,
        permission_overwrites: [
          { id: this.config.guildId, type: 0, deny: '1024', allow: '0' },
          { id: userId, type: 1, allow: chat, deny: '0' },
          {
            id: this.applicationId,
            type: 1,
            allow: (BigInt(chat) | (1n << 4n) | (1n << 6n) | (1n << 34n)).toString(),
            deny: '0',
          },
        ],
      });
      agent.categoryId = category.id;
      this.persist();
    }
    if (!agent.channelId) {
      const channel = await this.api<{ id: string }>(`guilds/${this.config.guildId}/channels`, 'POST', {
        name: 'chat',
        type: 0,
        parent_id: agent.categoryId,
        topic: `NanoClaw agent: ${agent.name} (${agent.id})`,
      });
      agent.channelId = channel.id;
      this.persist();
    }
    await wireManagedAgent(this.config, agent);
    agent.status = 'active';
    this.persist();
    return { content: `Created ${agent.name}: <#${agent.channelId}>. Send a message there; no mention needed.` };
  }

  private async archive(agent: ManagedDiscordAgent): Promise<void> {
    if (agent.status === 'archived') return;
    if (agent.status !== 'deleting') agent.status = 'archiving';
    this.persist();
    await archiveAgentWorkspace(agent, () => this.persist());
    if (agent.status !== 'deleting') agent.status = 'archived';
    this.persist();
  }

  private async confirmDelete(
    interaction: Interaction,
    userId: string,
  ): Promise<{ content: string; components: unknown[] }> {
    const [, , id, token] = interaction.data!.custom_id!.split(':');
    const agent = this.agents.find((candidate) => candidate.id === id && candidate.status !== 'deleted');
    const grant = agent?.confirmation;
    if (!agent || !grant || grant.token !== token || grant.userId !== userId || grant.expires < Date.now()) {
      throw new Error('This confirmation is expired or already used. Run /agent delete again.');
    }
    delete agent.confirmation;
    agent.status = 'deleting';
    this.persist();
    await this.archive(agent);
    if (agent.channelId) await this.api(`channels/${agent.channelId}`, 'DELETE');
    if (agent.categoryId) {
      // Never delete a category containing channels added outside this manager.
      const channels = await this.api<Array<{ id: string; parent_id?: string }>>(
        `guilds/${this.config.guildId}/channels`,
        'GET',
      );
      if (channels.some((channel) => channel.parent_id === agent.categoryId))
        throw new Error('Category contains other channels. Move them out, then retry deletion.');
      await this.api(`channels/${agent.categoryId}`, 'DELETE');
    }
    await deleteAgentWorkspace(agent);
    agent.status = 'deleted';
    this.persist();
    return { content: `Deleted ${agent.name}. Its workspace files remain on disk.`, components: [] };
  }
}

export function loadDiscordAgentManager(
  token: string,
  applicationId: string | undefined,
): DiscordAgentManager | undefined {
  const configFile = path.join(DATA_DIR, 'discord-agents', 'config.json');
  if (!fs.existsSync(configFile)) return;
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as AgentManagerConfig;
  if (
    !applicationId ||
    !/^[0-9]{17,20}$/.test(config.guildId) ||
    !config.sourceGroupId ||
    !path.isAbsolute(config.instructionsFile)
  ) {
    throw new Error('Discord agent manager configuration is incomplete.');
  }
  return new DiscordAgentManager(config, token, applicationId);
}
