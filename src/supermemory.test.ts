import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { GROUPS_DIR } from './config.js';
import { permitsSupermemoryRequest, supermemoryNamespace } from './supermemory.js';
import type { AgentGroup } from './types.js';

const group: AgentGroup = {
  id: 'memory-' + randomUUID(),
  name: 'Fixture',
  folder: 'memory-fixture-' + randomUUID(),
  agent_provider: null,
  created_at: new Date().toISOString(),
};
const folder = path.join(GROUPS_DIR, group.folder);
afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));
describe('Supermemory gateway authorization', () => {
  it('permits only an enabled agent namespace and the three authorized operations', () => {
    fs.mkdirSync(folder, { recursive: true });
    const namespace = supermemoryNamespace(group.id);
    fs.writeFileSync(path.join(folder, '.supermemory.json'), JSON.stringify({ enabled: true, namespace }));
    const request = { host: 'api.supermemory.ai', method: 'POST', path: `/ns/${namespace}/search` };
    expect(permitsSupermemoryRequest(group, request)).toBe(true);
    expect(
      permitsSupermemoryRequest(group, { host: 'api.supermemory.ai', method: 'GET', path: '/v3/auth/billing' }),
    ).toBe(true);
    expect(
      permitsSupermemoryRequest(group, { host: 'api.supermemory.ai', method: 'POST', path: '/v3/auth/billing' }),
    ).toBe(false);
    for (const changed of [
      { path: '/ns/another-agent/search' },
      { path: `/ns/${namespace}` },
      { path: '/v3/auth/billing/auto-topups' },
      { path: `/ns/${namespace}/search/anything` },
      { host: 'evil.supermemory.ai' },
      { host: 'api.supermemory.ai:8443' },
      { method: 'DELETE' },
      { path: undefined },
    ])
      expect(permitsSupermemoryRequest(group, { ...request, ...changed })).toBe(false);
    fs.writeFileSync(path.join(folder, '.supermemory.json'), JSON.stringify({ enabled: false, namespace }));
    expect(permitsSupermemoryRequest(group, request)).toBe(false);
  });
  it('does not grant access merely because a workspace requests another namespace', () => {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, '.supermemory.json'),
      JSON.stringify({ enabled: true, namespace: 'another-agent' }),
    );
    expect(
      permitsSupermemoryRequest(group, {
        host: 'api.supermemory.ai',
        method: 'POST',
        path: '/ns/another-agent/profile',
      }),
    ).toBe(false);
  });
});
