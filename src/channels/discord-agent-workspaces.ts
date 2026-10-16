import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { AnchoredDir, copyRegularFile } from '../anchored-dir.js';
import { dispatch } from '../cli/dispatch.js';
import { getAgentGroup } from '../db/agent-groups.js';
import {
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../db/container-configs.js';
import { getSessionsByAgentGroup, updateSession } from '../db/sessions.js';
import { getDb } from '../db/connection.js';
import { withExistingMailboxSession } from '../session-manager.js';
import { setMessagingGroupDeniedAt } from '../db/messaging-groups.js';
import { initGroupFilesystem } from '../group-init.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { restartAgentGroupContainers } from '../container-restart.js';
import { isContainerRunning, killContainer } from '../container-runner.js';
import { walkPluginDir } from '../templates/plugin-dir.js';
import type { AgentGroup } from '../types.js';

export interface AgentManagerConfig {
  guildId: string;
  sourceGroupId: string;
  instructionsFile: string;
}

export interface ManagedDiscordAgent {
  id: string;
  name: string;
  folder: string;
  groupId?: string;
  categoryId?: string;
  channelId?: string;
  wiringId?: string;
  messagingGroupId?: string;
  status: 'creating' | 'active' | 'archiving' | 'archived' | 'deleting' | 'deleted';
  personality: string;
  model?: string;
  skills: string[];
  tools: string[];
  pausedTasks: string[];
  closedSessions: string[];
  confirmation?: { token: string; userId: string; expires: number };
}

/** Reuse the native host command handlers, including their cascade and wiring invariants. */
export async function agentHostCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const response = await dispatch({ id: randomUUID(), command, args }, { caller: 'host' });
  if (!response.ok) throw new Error(response.error.message);
  return response.data as T;
}

export async function validateAgentSetup(config: AgentManagerConfig, agent: ManagedDiscordAgent): Promise<void> {
  const source = await getAgentGroup(config.sourceGroupId);
  const runtime = await getContainerConfig(config.sourceGroupId);
  if (!source || !runtime) throw new Error('The source agent is not configured.');
  const tools = JSON.parse(runtime.mcp_servers) as Record<string, unknown>;
  fs.accessSync(config.instructionsFile, fs.constants.R_OK);
  for (const name of agent.tools) if (!Object.hasOwn(tools, name)) throw new Error(`Unknown source tool: ${name}`);
  for (const name of agent.skills) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid skill name: ${name}`);
    const skill = path.join(resolveGroupFolderPath(source.folder), 'skills', name);
    walkPluginDir(skill);
    if (!fs.existsSync(path.join(skill, 'SKILL.md'))) throw new Error(`Not a source skill: ${name}`);
  }
}

export async function configureAgentWorkspace(
  config: AgentManagerConfig,
  agent: ManagedDiscordAgent,
  changes?: Record<string, string>,
): Promise<void> {
  const source = (await getAgentGroup(config.sourceGroupId))!;
  const runtime = (await getContainerConfig(config.sourceGroupId))!;
  const creating = agent.status === 'creating';
  const group = creating
    ? await agentHostCommand<AgentGroup>('groups-create', { name: agent.name, folder: agent.folder })
    : await getAgentGroup(agent.groupId!);
  if (!group) throw new Error('The managed workspace no longer exists.');
  agent.groupId = group.id;
  if (creating)
    await updateContainerConfigScalars(group.id, {
      provider: runtime.provider,
      model: agent.model ?? runtime.model,
      effort: runtime.effort,
      image_tag: runtime.image_tag,
      timezone: runtime.timezone,
      assistant_name: agent.name,
      cli_scope: 'group',
    });
  if (creating) await initGroupFilesystem(group, { provider: runtime.provider });
  const root = AnchoredDir.open(GROUPS_DIR, [group.folder], true)!;
  try {
    if (creating) {
      const instructions = fs.readFileSync(config.instructionsFile, 'utf8');
      const ownScope =
        "\n\n# NanoClaw personal assistant scope\n\nYour identity comes from SOUL.md. Save self-directed learning and memories only in this agent's own folders. User-requested host file operations, including explicit skill installation or editing in Codex or OMP directories, use host-tools and the requested host path. The ownership rule does not block those explicit requests. Preserve all Hermes files. Follow the native completion contract below.\n";
      root.replaceFile('instructions.prepend.md', instructions + ownScope);
    }
    if (creating || changes?.personality !== undefined) root.replaceFile('SOUL.md', agent.personality + '\n');
    // Each personality has its own connection files and skill copy. Only the
    // SSH agent socket is shared; optional MCP selection does not gate files.
    const sourceRoot = AnchoredDir.open(GROUPS_DIR, [source.folder])!;
    try {
      const hostAccess = sourceRoot.openDir('host-access');
      if (hostAccess) {
        try {
          const destination = root.openDir('host-access', true)!;
          try {
            for (const file of ['ssh-config', 'known-hosts']) {
              try {
                destination.writeNewFile(file, hostAccess.readFile(file));
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                destination.readFile(file); // Existing connection files must still be regular files.
              }
            }
          } finally {
            destination.close();
          }
        } finally {
          hostAccess.close();
        }
      }
      const sourceSkills = sourceRoot.openDir('skills');
      let hostSkill: AnchoredDir | null;
      try {
        hostSkill = sourceSkills?.openDir('host-tools') ?? null;
      } finally {
        sourceSkills?.close();
      }
      if (hostSkill) {
        try {
          const ownedSkills = root.openDir('skills', true)!;
          try {
            const existing = ownedSkills.openDir('host-tools');
            if (existing) existing.close();
            else {
              const destination = ownedSkills.openDir('host-tools', true)!;
              try {
                copySkillFiles(hostSkill, destination);
              } finally {
                destination.close();
              }
            }
          } finally {
            ownedSkills.close();
          }
        } finally {
          hostSkill.close();
        }
      }
    } finally {
      sourceRoot.close();
    }
    const skills = root.openDir('skills', true)!;
    try {
      if (creating || changes?.skills !== undefined) {
        for (const name of agent.skills) {
          const existing = skills.openDir(name);
          if (existing) {
            existing.close();
            continue;
          }
          const from = AnchoredDir.open(GROUPS_DIR, [source.folder, 'skills', name])!;
          const to = skills.openDir(name, true)!;
          try {
            copySkillFiles(from, to);
          } finally {
            from.close();
            to.close();
          }
        }
      }
    } finally {
      skills.close();
    }
  } finally {
    root.close();
  }
  if (creating && runtime.provider === 'codex') {
    const home = AnchoredDir.open(DATA_DIR, ['v2-sessions', group.id, '.codex-shared'], true)!;
    try {
      try {
        home.symlink('/workspace/agent/skills', 'skills');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || home.readlink('skills') !== '/workspace/agent/skills')
          throw error;
      }
    } finally {
      home.close();
    }
  }
  if (!creating && changes?.model !== undefined) await updateContainerConfigScalars(group.id, { model: agent.model });
  if (creating || changes?.tools !== undefined) {
    const sourceTools = JSON.parse(runtime.mcp_servers) as Record<string, unknown>;
    await updateContainerConfigJson(
      group.id,
      'mcp_servers',
      Object.fromEntries(agent.tools.map((name) => [name, sourceTools[name]])),
    );
  }
  const mounts = JSON.parse(runtime.additional_mounts) as Array<{ containerPath: string }>;
  const current = (await getContainerConfig(group.id))!;
  const selected =
    creating || changes?.tools !== undefined
      ? agent.tools.length
        ? mounts
        : mounts.filter((mount) => mount.containerPath === 'host-agent')
      : (JSON.parse(current.additional_mounts) as Array<{ containerPath: string }>);
  const hostMount = mounts.find((mount) => mount.containerPath === 'host-agent');
  if (hostMount && !selected.some((mount) => mount.containerPath === 'host-agent')) selected.push(hostMount);
  if (JSON.stringify(selected) !== current.additional_mounts)
    await updateContainerConfigJson(group.id, 'additional_mounts', selected);
}

/** Descriptor-pinned copies cannot follow symlinks planted by a running assistant. */
function copySkillFiles(from: AnchoredDir, to: AnchoredDir): void {
  for (const name of from.entries()) {
    if (from.lstat(name).isDirectory()) {
      const childFrom = from.openDir(name)!;
      const childTo = to.openDir(name, true)!;
      try {
        copySkillFiles(childFrom, childTo);
      } finally {
        childFrom.close();
        childTo.close();
      }
    } else {
      copyRegularFile(from, name, to, name);
    }
  }
}

export async function wireManagedAgent(config: AgentManagerConfig, agent: ManagedDiscordAgent): Promise<void> {
  const platformId = `discord:${config.guildId}:${agent.channelId}`;
  const messagingGroup = await agentHostCommand<{ id: string }>('messaging-groups-create', {
    channel_type: 'discord',
    platform_id: platformId,
    instance: 'discord',
    name: agent.name,
    is_group: 1,
    unknown_sender_policy: 'strict',
  });
  agent.messagingGroupId = messagingGroup.id;
  const wiring = await agentHostCommand<{ id: string }>('wirings-create', {
    channel_type: 'discord',
    platform_id: platformId,
    agent_group_id: agent.groupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'known',
    threads: true,
  });
  agent.wiringId = wiring.id;
  await setMessagingGroupDeniedAt(messagingGroup.id, null);
}

/** Close admission before stopping containers, so pending work cannot respawn them. */
export async function archiveAgentWorkspace(agent: ManagedDiscordAgent, persist: () => void): Promise<void> {
  if (!agent.groupId) return;
  if (agent.messagingGroupId) await setMessagingGroupDeniedAt(agent.messagingGroupId, new Date().toISOString());
  if (agent.wiringId) {
    await getDb().run('DELETE FROM messaging_group_agents WHERE id = ?', agent.wiringId);
    delete agent.wiringId;
    persist();
  }
  const sessions = await getSessionsByAgentGroup(agent.groupId);
  for (const session of sessions) {
    if (session.status === 'active') {
      if (!agent.closedSessions.includes(session.id)) {
        agent.closedSessions.push(session.id);
        persist();
      }
      await updateSession(session.id, { status: 'closed' });
    }
    if (isContainerRunning(session.id)) killContainer(session.id, 'discord-agent-archive');
  }
  const deadline = Date.now() + 15_000;
  while ((await getSessionsByAgentGroup(agent.groupId)).some((session) => isContainerRunning(session.id))) {
    if (Date.now() > deadline) throw new Error('Agent containers are still stopping. Retry archive before deleting.');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Snapshot only after execution and recurrence can no longer race the pause.
  // Closed sessions remain accessible through the mailbox lifecycle API.
  for (const session of sessions) {
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
      for (const task of mailbox.listLiveTasks('pending')) {
        const id = task.seriesId ?? task.id;
        if (!agent.pausedTasks.includes(id)) {
          agent.pausedTasks.push(id);
          persist();
        }
        mailbox.pauseTask(id);
      }
    });
  }
}

export async function restoreAgentWorkspace(config: AgentManagerConfig, agent: ManagedDiscordAgent): Promise<void> {
  for (const id of agent.closedSessions) await updateSession(id, { status: 'active' });
  for (const id of agent.pausedTasks) await agentHostCommand('tasks-resume', { group: agent.groupId, id });
  await wireManagedAgent(config, agent);
  agent.closedSessions = [];
  agent.pausedTasks = [];
}

export async function restartManagedAgent(agent: ManagedDiscordAgent): Promise<void> {
  if (agent.groupId) await restartAgentGroupContainers(agent.groupId, 'discord-agent-edit');
}

export async function deleteAgentWorkspace(agent: ManagedDiscordAgent): Promise<void> {
  if (agent.groupId && (await getAgentGroup(agent.groupId)))
    await agentHostCommand('groups-delete', { id: agent.groupId });
}
