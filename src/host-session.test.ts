import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { composeHostProcess, renderHostPaths } from './host-session.js';
import { fixtureSpec } from './drivers/spec-fixture.js';

it('composes native paths and private provider state without changing user configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-native-compose-'));
  try {
    const paths = {
      '/workspace/agent': 'agent',
      '/workspace': 'session',
      '/app/src': 'source',
      '/home/node/.codex': 'codex',
      '/home/node/.codex/auth.json': 'stub.json',
      '/app/.nanoclaw-session.json': 'context.json',
    };
    for (const [target, relative] of Object.entries(paths)) {
      const file = path.join(root, relative);
      if (target.endsWith('.json')) fs.writeFileSync(file, '{"placeholder":true}');
      else fs.mkdirSync(file, { recursive: true });
    }
    fs.mkdirSync(path.join(root, 'agent', 'skills'));
    fs.mkdirSync(path.join(root, 'agent', '.agents', 'skills'), { recursive: true });
    fs.symlinkSync('/app/skills/agent-browser', path.join(root, 'agent', '.agents', 'skills', 'agent-browser'));
    const spec = fixtureSpec();
    spec.containers[0].mounts = Object.entries(paths).map(([target, relative]) => ({
      class: 'group-state',
      hostPath: path.join(root, relative),
      containerPath: target,
      mode: 'rw',
      groupScope: 'g1',
    }));
    composeHostProcess(spec);
    expect(spec.runtimeTier).toBe('host');
    expect(spec.hostProcess?.env.HOME).toBe(os.homedir());
    expect(spec.hostProcess?.env.CODEX_HOME).toBe(path.join(root, 'codex'));
    expect(spec.hostProcess?.env.PATH?.split(path.delimiter)[0]).toBe(path.join(root, 'node_modules/.bin'));
    const runner = JSON.parse(fs.readFileSync('container/agent-runner/package.json', 'utf8'));
    const tools = JSON.parse(fs.readFileSync('container/cli-tools.json', 'utf8'));
    expect(runner.dependencies['@openai/codex']).toBe(
      tools.find((tool: { name: string }) => tool.name === '@openai/codex').version,
    );
    expect(spec.hostProcess?.cwd).toBe(path.join(root, 'agent'));
    expect(spec.hostProcess?.env.NANOCLAW_SESSION_DIR).toBe(path.join(root, 'session'));
    expect(fs.readlinkSync(path.join(root, 'codex', 'skills'))).toBe(path.join(root, 'agent', 'skills'));
    expect(fs.readFileSync(path.join(root, 'codex', 'auth.json'), 'utf8')).toBe('{"placeholder":true}');
    expect(fs.realpathSync(path.join(root, 'agent', '.agents', 'skills', 'agent-browser'))).toBe(
      path.join(process.cwd(), 'container/skills/agent-browser'),
    );
    const instructions = renderHostPaths(
      'Host paths such as /home/ubuntu refer to a container.\nSave learning at /workspace/agent/skills; use host-tools.',
      path.join(root, 'agent'),
    );
    expect(instructions).toContain(path.join(root, 'agent', 'skills'));
    expect(instructions).not.toContain('/workspace/agent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
