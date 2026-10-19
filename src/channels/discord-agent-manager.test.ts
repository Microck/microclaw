import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createAgentGroup, getAgentGroup } from '../db/agent-groups.js';
import {
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from '../db/container-configs.js';
import { composeGroupProjectDoc } from '../project-doc-compose.js';
import { getProviderHostContract } from '../provider-contracts/registry.js';
import { providerProjectDocSpec } from '../provider-contracts/realize.js';
import { readGroupPersona } from '../group-persona.js';
import { DISCORD_AGENT_COMMAND, DiscordAgentManager } from './discord-agent-manager.js';
import { agentHostCommand, type AgentManagerConfig, type ManagedDiscordAgent } from './discord-agent-workspaces.js';
import '../cli/resources/index.js';
import '../provider-contracts/index.js';

const APP = '123456789012345678';
const GUILD = '223456789012345678';
const OWNER = '323456789012345678';

/** In-memory Discord service; native agent lifecycle and database handlers stay real. */
class DiscordFixture {
  channels: Array<{ id: string; parent_id?: string }> = [];
  replies: Array<{ content: string; components?: Array<{ components: Array<{ custom_id: string }> }> }> = [];
  failChannelCreation = false;
  registrations = 0;
  rateLimitCommand = false;
  mutations = 0;
  fetch: typeof fetch = async (input, init) => {
    const route = new URL(String(input)).pathname.replace('/api/v10/', '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (route.endsWith('/commands')) {
      this.registrations++;
      if (this.rateLimitCommand) {
        this.rateLimitCommand = false;
        return response({ retry_after: 0.001 }, 429);
      }
      return response({ id: 'command' });
    }
    if (route.endsWith('/callback')) return new Response(null, { status: 204 });
    if (route.startsWith('webhooks/')) {
      this.replies.push(body as (typeof this.replies)[number]);
      return response({ id: 'reply' });
    }
    if (route === `guilds/${GUILD}/channels` && init?.method === 'GET') return response(this.channels);
    if (route === `guilds/${GUILD}/channels` && init?.method === 'POST') {
      if (body.type === 0 && this.failChannelCreation) {
        this.failChannelCreation = false;
        return response({}, 500);
      }
      const channel = {
        id: `${423456789012345678n + BigInt(this.mutations++)}`,
        parent_id: body.parent_id as string | undefined,
      };
      this.channels.push(channel);
      return response(channel);
    }
    if (route.startsWith('channels/') && init?.method === 'DELETE') {
      this.channels = this.channels.filter((channel) => channel.id !== route.slice(9));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fixture request: ${init?.method} ${route}`);
  };
}

let temp: string;
let sourceId: string;
let sourceFolder: string;
let state: string;
let config: AgentManagerConfig;
let discord: DiscordFixture;
let manager: DiscordAgentManager;
function records(): ManagedDiscordAgent[] {
  return fs.existsSync(state) ? (JSON.parse(fs.readFileSync(state, 'utf8')) as ManagedDiscordAgent[]) : [];
}
function command(verb: string, options: Record<string, string> = {}, user = OWNER, id = randomUUID()) {
  return {
    id,
    token: 'fixture-token',
    type: 2,
    application_id: APP,
    guild_id: GUILD,
    member: { user: { id: user } },
    data: {
      name: 'agent',
      options: [{ name: verb, options: Object.entries(options).map(([name, value]) => ({ name, value })) }],
    },
  };
}

beforeEach(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-agent-manager-'));
  sourceId = randomUUID();
  sourceFolder = `fixture-${randomUUID()}`;
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: sourceId,
    name: 'source',
    folder: sourceFolder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig(sourceId, 'codex');
  await updateContainerConfigScalars(sourceId, { model: 'gpt-6-luna', image_tag: 'fixture-image' });
  const db = getDb();
  await db.run(
    "INSERT INTO users (id,kind,display_name,created_at) VALUES (?, 'discord', 'Owner', ?)",
    `discord:${OWNER}`,
    new Date().toISOString(),
  );
  await db.run(
    "INSERT INTO user_roles (user_id,role,agent_group_id,granted_at) VALUES (?, 'owner', NULL, ?)",
    `discord:${OWNER}`,
    new Date().toISOString(),
  );
  const instructionsFile = path.join(temp, 'AGENTS.md');
  fs.writeFileSync(instructionsFile, 'Custom standing instructions.');
  const skill = path.join(GROUPS_DIR, sourceFolder, 'skills', 'my-skill');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(
    path.join(skill, 'SKILL.md'),
    '---\nname: my-skill\nauthor: Hermes Agent\n---\nA verified custom workflow.',
  );
  const sourceRoot = path.join(GROUPS_DIR, sourceFolder);
  fs.mkdirSync(path.join(sourceRoot, 'host-access'));
  fs.writeFileSync(path.join(sourceRoot, 'host-access', 'ssh-config'), 'Host fixture-host');
  fs.writeFileSync(path.join(sourceRoot, 'host-access', 'known-hosts'), 'fixture-host-key');
  fs.mkdirSync(path.join(sourceRoot, 'skills', 'host-tools'));
  fs.writeFileSync(path.join(sourceRoot, 'skills', 'host-tools', 'SKILL.md'), 'Use the fixture host connection.');
  await updateContainerConfigJson(sourceId, 'additional_mounts', [
    { hostPath: '/fixture/socket', containerPath: 'host-agent', readonly: true },
  ]);
  config = { guildId: GUILD, sourceGroupId: sourceId, instructionsFile };
  state = path.join(temp, 'agents.json');
  discord = new DiscordFixture();
  manager = new DiscordAgentManager(config, 'fixture-token', APP, state, discord.fetch);
});

afterEach(async () => {
  const agents = records();
  await closeDb();
  for (const agent of agents) {
    fs.rmSync(path.join(GROUPS_DIR, agent.folder), { recursive: true, force: true });
    if (agent.groupId) fs.rmSync(path.join(DATA_DIR, 'v2-sessions', agent.groupId), { recursive: true, force: true });
  }
  fs.rmSync(path.join(GROUPS_DIR, sourceFolder), { recursive: true, force: true });
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('Discord personal agent management', () => {
  it('keeps host access independent of optional MCPs, with an owned skill copy', async () => {
    await manager.handle(command('create', { name: 'Host Reader' }));
    const [agent] = records();
    const root = path.join(GROUPS_DIR, agent.folder);
    expect(fs.readFileSync(path.join(root, 'host-access', 'ssh-config'), 'utf8')).toBe('Host fixture-host');
    expect(fs.readFileSync(path.join(root, 'skills', 'host-tools', 'SKILL.md'), 'utf8')).toBe(
      'Use the fixture host connection.',
    );
    fs.writeFileSync(path.join(root, 'skills', 'host-tools', 'SKILL.md'), 'My learned host workflow');
    await manager.handle(command('edit', { name: agent.name, tools: 'none' }));
    await updateContainerConfigJson(agent.groupId!, 'additional_mounts', [
      { hostPath: '/fixture/socket', containerPath: 'host-agent', readonly: true },
      { hostPath: '/fixture/custom', containerPath: 'my-files', readonly: true },
    ]);
    fs.writeFileSync(path.join(root, 'host-access', 'ssh-config'), 'My owned host settings');
    await manager.prepareWorkspaces();
    const runtime = (await getContainerConfig(agent.groupId!))!;
    expect(JSON.parse(runtime.mcp_servers)).toEqual({});
    expect(JSON.parse(runtime.additional_mounts)).toEqual([
      { hostPath: '/fixture/socket', containerPath: 'host-agent', readonly: true },
      { hostPath: '/fixture/custom', containerPath: 'my-files', readonly: true },
    ]);
    expect(fs.readFileSync(path.join(root, 'host-access', 'ssh-config'), 'utf8')).toBe('My owned host settings');
    expect(fs.readFileSync(path.join(root, 'skills', 'host-tools', 'SKILL.md'), 'utf8')).toBe(
      'My learned host workflow',
    );
  });

  it('creates a real isolated workspace and routing; composes soul and completion instructions', async () => {
    await manager.register();
    await manager.handle(command('create', { name: 'Researcher', skills: 'my-skill' }));
    expect(records()[0].personality).toBe('You are Researcher, a personal AI assistant.');
    const createSchema = DISCORD_AGENT_COMMAND.options[0] as { options: Array<{ name: string; required?: boolean }> };
    expect(createSchema.options.find((option) => option.name === 'personality')?.required).not.toBe(true);
    await manager.handle(command('edit', { name: 'Researcher', personality: 'Be a curious research assistant.' }));
    expect(discord.registrations).toBe(9);
    expect(discord.channels).toHaveLength(2);
    const [agent] = records();
    expect(agent.status).toBe('active');
    expect(manager.ownsActiveChannel(GUILD, agent.channelId!)).toBe(true);
    expect(manager.ownsActiveChannel('another-guild', agent.channelId!)).toBe(false);
    expect(manager.ownsActiveChannel(GUILD, 'unmanaged-channel')).toBe(false);
    const group = (await getAgentGroup(agent.groupId!))!;
    const dir = path.join(GROUPS_DIR, group.folder);
    expect(fs.readFileSync(path.join(dir, 'skills/my-skill/SKILL.md'), 'utf8')).toContain('verified custom workflow');
    expect(fs.readlinkSync(path.join(DATA_DIR, 'v2-sessions', group.id, '.codex-shared/skills'))).toBe(
      '/workspace/agent/skills',
    );
    await composeGroupProjectDoc(group, dir, providerProjectDocSpec(getProviderHostContract('codex')!)!);
    const instructions = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(instructions).toContain('Custom standing instructions.');
    expect(instructions).toContain('Be a curious research assistant.');
    expect(instructions).toContain('carry the authorized work through execution and verification in the same turn');
    const runtime = (await getContainerConfig(group.id))!;
    expect(runtime.provider).toBe('codex');
    expect(runtime.cli_scope).toBe('group');
    expect(JSON.parse(runtime.mcp_servers)).toEqual({});
    expect(
      await getDb().get('SELECT engage_mode,engage_pattern FROM messaging_group_agents WHERE id=?', agent.wiringId),
    ).toEqual({ engage_mode: 'pattern', engage_pattern: '.' });
  });

  it('denies non-owners and other guilds, and never exposes unmanaged agents', async () => {
    await manager.handle(command('create', { name: 'Nope', personality: 'Nope' }, '999999999999999999'));
    const elsewhere = command('create', { name: 'Nope', personality: 'Nope' });
    elsewhere.guild_id = '999999999999999998';
    await manager.handle(elsewhere);
    await manager.handle(command('delete', { name: 'source' }));
    expect(records()).toEqual([]);
    expect(discord.channels).toEqual([]);
    expect(await getAgentGroup(sourceId)).toBeDefined();
    expect(discord.replies.at(-1)?.content).toContain('No managed agent');
  });

  it('deduplicates redelivered interactions and resumes partial provisioning after restart', async () => {
    discord.failChannelCreation = true;
    const interaction = command('create', { name: 'Writer', personality: 'Write clearly.' });
    await manager.handle(interaction);
    expect(records()[0].status).toBe('creating');
    expect(discord.channels).toHaveLength(1);
    await manager.handle(interaction);
    expect(discord.channels).toHaveLength(1);
    manager = new DiscordAgentManager(config, 'fixture-token', APP, state, discord.fetch);
    await manager.handle(command('create', { name: 'Writer', personality: 'Write clearly.' }));
    expect(records()[0].status).toBe('active');
    expect(discord.channels).toHaveLength(2);
  });

  it('edits only the requested setup and preserves learned skill contents', async () => {
    await manager.handle(command('create', { name: 'Writer', personality: 'Write clearly.', skills: 'my-skill' }));
    const agent = records()[0];
    const dir = path.join(GROUPS_DIR, agent.folder);
    fs.writeFileSync(path.join(dir, 'skills/my-skill/SKILL.md'), 'Improved by this assistant.');
    await updateContainerConfigScalars(agent.groupId!, { effort: 'high' });
    await manager.handle(command('edit', { name: 'Writer', personality: 'Write briefly.', skills: 'my-skill' }));
    expect(readGroupPersona(dir, 'SOUL.md')).toBe('Write briefly.');
    expect(fs.readFileSync(path.join(dir, 'skills/my-skill/SKILL.md'), 'utf8')).toBe('Improved by this assistant.');
    expect((await getContainerConfig(agent.groupId!))!.effort).toBe('high');
  });

  it('archives schedules and routing, then restores only previously pending tasks', async () => {
    await manager.handle(command('create', { name: 'Planner', personality: 'Plan things.' }));
    const agent = records()[0];
    const first = await agentHostCommand<{ series_id: string }>('tasks-create', {
      group: agent.groupId,
      prompt: 'First',
      process_after: '2099-01-01T00:00:00Z',
    });
    const second = await agentHostCommand<{ series_id: string }>('tasks-create', {
      group: agent.groupId,
      prompt: 'Second',
      process_after: '2099-01-02T00:00:00Z',
    });
    await agentHostCommand('tasks-pause', { group: agent.groupId, id: second.series_id });
    await manager.handle(command('archive', { name: 'Planner' }));
    expect(records()[0].status).toBe('archived');
    expect(records()[0].pausedTasks).toEqual([first.series_id]);
    expect(
      await getDb().get('SELECT id FROM messaging_group_agents WHERE agent_group_id=?', agent.groupId),
    ).toBeUndefined();
    expect(
      (await getDb().get<{ denied_at: string }>(
        'SELECT denied_at FROM messaging_groups WHERE id=?',
        agent.messagingGroupId,
      ))!.denied_at,
    ).toBeTruthy();
    await manager.handle(command('restore', { name: 'Planner' }));
    expect(records()[0].status).toBe('active');
    const pending = await agentHostCommand<Array<{ series_id: string }>>('tasks-list', {
      group: agent.groupId,
      status: 'pending',
    });
    expect(pending.map((task) => task.series_id)).toEqual([first.series_id]);
    expect(
      (await getDb().get<{ denied_at: string | null }>(
        'SELECT denied_at FROM messaging_groups WHERE id=?',
        agent.messagingGroupId,
      ))!.denied_at,
    ).toBeNull();
  });

  it('requires an owner-bound single-use confirmation and keeps files after deletion', async () => {
    await manager.handle(command('create', { name: 'Temp', personality: 'Temporary test agent.' }));
    const agent = records()[0];
    await manager.handle(command('delete', { name: 'Temp' }));
    expect(await getAgentGroup(agent.groupId!)).toBeDefined();
    const custom_id = discord.replies.at(-1)!.components![0].components[0].custom_id;
    const confirm = { ...command('delete'), type: 3, data: { custom_id } };
    await manager.handle(confirm);
    expect(records()[0].status).toBe('deleted');
    expect(discord.channels).toEqual([]);
    expect(await getAgentGroup(agent.groupId!)).toBeUndefined();
    expect(fs.existsSync(path.join(GROUPS_DIR, agent.folder, 'SOUL.md'))).toBe(true);
    await manager.handle({ ...confirm, id: randomUUID() });
    expect(discord.replies.at(-1)!.content).toContain('expired or already used');
  });

  it('refuses unsafe skill paths and does not follow personality symlinks', async () => {
    await manager.handle(command('create', { name: 'Unsafe', personality: 'Test.', skills: '../outside' }));
    expect(records()).toEqual([]);
    await manager.handle(command('create', { name: 'Safe', personality: 'Test.' }));
    const agent = records()[0];
    const outside = path.join(temp, 'outside.md');
    fs.writeFileSync(outside, 'Untouched.');
    const soul = path.join(GROUPS_DIR, agent.folder, 'SOUL.md');
    fs.unlinkSync(soul);
    fs.symlinkSync(outside, soul);
    await manager.handle(command('edit', { name: 'Safe', personality: 'Updated safely.' }));
    expect(fs.readFileSync(outside, 'utf8')).toBe('Untouched.');
    expect(fs.lstatSync(soul).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(soul, 'utf8')).toContain('Updated safely.');
  });
});

function inspection(kind: 'skills' | 'memory', verb: string, options: Record<string, string>) {
  const interaction = command(verb, options);
  interaction.data.name = kind;
  return interaction;
}
function removalButton() {
  return discord.replies.at(-1)!.components![0].components[0].custom_id;
}
function confirmRemoval(custom_id: string, user = OWNER) {
  return { ...command('unused', {}, user), type: 3, data: { custom_id } };
}
it('privately lists and reads source skills and paginated memory without exposing borrowed links', async () => {
  const memory = path.join(GROUPS_DIR, sourceFolder, 'memory');
  fs.mkdirSync(path.join(memory, 'system'), { recursive: true });
  fs.writeFileSync(path.join(memory, 'index.md'), 'Index is protected.');
  fs.writeFileSync(path.join(memory, 'system', 'definition.md'), 'System is protected.');
  fs.writeFileSync(path.join(memory, 'fact.md'), 'Saved fact. '.repeat(400));
  fs.symlinkSync(temp, path.join(GROUPS_DIR, sourceFolder, 'skills', 'borrowed'));
  await manager.handle(inspection('skills', 'list', { agent: 'source' }));
  expect(discord.replies.at(-1)!.content).toContain('my-skill');
  expect(discord.replies.at(-1)!.content).not.toContain('borrowed');
  await manager.handle(inspection('skills', 'show', { agent: 'source', name: 'my-skill' }));
  expect(discord.replies.at(-1)!.content).toContain('verified custom workflow');
  await manager.handle(inspection('memory', 'list', { agent: 'source' }));
  expect(discord.replies.at(-1)!.content).toContain('fact.md');
  expect(discord.replies.at(-1)!.content).not.toContain('definition.md');
  await manager.handle(inspection('memory', 'show', { agent: 'source', file: 'fact.md', page: '2' }));
  expect(discord.replies.at(-1)!.content).toContain('page 2/4');
  expect(discord.replies.at(-1)!.content.length).toBeLessThan(2000);
  await manager.handle(inspection('memory', 'show', { agent: 'source', file: 'fact.md', page: '99' }));
  expect(discord.replies.at(-1)!.content).toContain('Choose a page');
});
it('binds skill removal to owner and content, and does not restore it during later edits', async () => {
  await manager.handle(command('create', { name: 'Reader', personality: 'Read.', skills: 'my-skill' }));
  const agent = records()[0];
  const skill = path.join(GROUPS_DIR, agent.folder, 'skills', 'my-skill');
  await manager.handle(inspection('skills', 'remove', { agent: 'Reader', name: 'my-skill' }));
  const button = removalButton();
  await manager.handle(confirmRemoval(button, '999999999999999999'));
  expect(fs.existsSync(skill)).toBe(true);
  fs.writeFileSync(path.join(skill, 'new.txt'), 'New supporting file.');
  await manager.handle(confirmRemoval(button));
  expect(discord.replies.at(-1)!.content).toContain('Content changed');
  expect(fs.existsSync(skill)).toBe(true);
  await manager.handle(inspection('skills', 'remove', { agent: 'Reader', name: 'my-skill' }));
  const fresh = removalButton();
  await manager.handle(confirmRemoval(fresh));
  expect(fs.existsSync(skill)).toBe(false);
  expect(records()[0].skills).toEqual([]);
  expect(fs.existsSync(path.join(GROUPS_DIR, sourceFolder, 'skills/my-skill'))).toBe(true);
  await manager.handle(confirmRemoval(fresh));
  expect(discord.replies.at(-1)!.content).toContain('already used');
  await manager.handle(command('edit', { name: 'Reader', personality: 'Updated.' }));
  expect(fs.existsSync(skill)).toBe(false);
});
it('forgets only the selected memory document and protects indexes, rules, and host links', async () => {
  const memory = path.join(GROUPS_DIR, sourceFolder, 'memory');
  fs.mkdirSync(path.join(memory, 'system'), { recursive: true });
  fs.writeFileSync(path.join(memory, 'fact.md'), 'One fact.');
  fs.writeFileSync(path.join(memory, 'other.md'), 'Other fact.');
  fs.writeFileSync(path.join(memory, 'index.md'), '- [Fact](fact.md) and [Other](other.md)');
  fs.writeFileSync(path.join(memory, 'system', 'definition.md'), 'Keep rules.');
  fs.writeFileSync(path.join(temp, 'outside.md'), 'Keep outside.');
  fs.symlinkSync(path.join(temp, 'outside.md'), path.join(memory, 'linked.md'));
  for (const file of ['index.md', 'system/definition.md', '../outside.md', 'linked.md']) {
    await manager.handle(inspection('memory', 'forget', { agent: 'source', file }));
    expect(discord.replies.at(-1)!.components).toEqual([]);
  }
  await manager.handle(inspection('memory', 'forget', { agent: 'source', file: 'fact.md' }));
  await manager.handle(confirmRemoval(removalButton()));
  expect(fs.existsSync(path.join(memory, 'fact.md'))).toBe(false);
  expect(fs.readFileSync(path.join(memory, 'index.md'), 'utf8')).toBe('- Fact (forgotten) and [Other](other.md)');
  expect(fs.readFileSync(path.join(memory, 'other.md'), 'utf8')).toBe('Other fact.');
  expect(fs.readFileSync(path.join(temp, 'outside.md'), 'utf8')).toBe('Keep outside.');
});
it('bounds traversal even when entries have no content or are not Markdown', async () => {
  const memory = path.join(GROUPS_DIR, sourceFolder, 'memory');
  fs.mkdirSync(memory, { recursive: true });
  const skill = path.join(GROUPS_DIR, sourceFolder, 'skills/my-skill');
  for (let index = 0; index < 2001; index++) {
    fs.writeFileSync(path.join(memory, `empty-${index}.txt`), '');
    fs.writeFileSync(path.join(skill, `empty-${index}`), '');
  }
  await manager.handle(inspection('memory', 'list', { agent: 'source' }));
  expect(discord.replies.at(-1)!.content).toContain('Too many memory entries');
  await manager.handle(inspection('skills', 'remove', { agent: 'source', name: 'my-skill' }));
  expect(discord.replies.at(-1)!.content).toContain('Too many skill entries');
});

it('honors Discord command-registration cooldowns without abandoning later commands', async () => {
  discord.rateLimitCommand = true;
  await manager.register();
  expect(discord.registrations).toBe(10);
});
