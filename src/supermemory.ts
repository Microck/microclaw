import fs from 'node:fs';
import path from 'node:path';
import { GROUPS_DIR, INSTALL_SLUG } from './config.js';
import { readEnvFile } from './env.js';
import type { GatewayApprovalRequest } from './gateway-providers/gateway-provider-registry.js';
import type { AgentGroup } from './types.js';

export const SUPERMEMORY_CONFIG_FILE = '.supermemory.json';

/** Public namespace identity, independent of conversation and model provider. */
export function supermemoryNamespace(groupId: string): string {
  return `nanoclaw_${INSTALL_SLUG}_${groupId}`;
}

/** New groups inherit the operator's memory setting; existing choices survive updates. */
export function initializeSupermemory(group: AgentGroup): void {
  const env = readEnvFile(['NANOCLAW_SUPERMEMORY_ENABLED', 'NANOCLAW_SUPERMEMORY_CAPTURE_SINCE']);
  if (env.NANOCLAW_SUPERMEMORY_ENABLED !== 'true') return;
  const since = env.NANOCLAW_SUPERMEMORY_CAPTURE_SINCE;
  if (!since || !Number.isFinite(Date.parse(since))) throw new Error('Supermemory requires an ISO capture start');
  const file = path.join(GROUPS_DIR, group.folder, SUPERMEMORY_CONFIG_FILE);
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ enabled: true, namespace: supermemoryNamespace(group.id), since }, null, 2),
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** The operator authorized memory access, not unrestricted administration of the service. */
export function permitsSupermemoryRequest(
  group: AgentGroup,
  destination: NonNullable<GatewayApprovalRequest['destination']>,
): boolean {
  if (
    destination.host.toLowerCase().replace(/:443$/, '') !== 'api.supermemory.ai' ||
    !['POST', 'GET'].includes(destination.method ?? '')
  )
    return false;
  const namespace = supermemoryNamespace(group.id);
  const memoryWrite =
    destination.method === 'POST' &&
    ['document', 'profile', 'search'].some((endpoint) => destination.path === `/ns/${namespace}/${endpoint}`);
  const balanceRead = destination.method === 'GET' && destination.path === '/v3/auth/billing';
  if (!memoryWrite && !balanceRead) return false;
  const file = path.join(GROUPS_DIR, group.folder, SUPERMEMORY_CONFIG_FILE);
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { enabled?: boolean; namespace?: string };
    return config.enabled === true && config.namespace === namespace;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
