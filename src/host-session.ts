import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { specInvalid, type SessionSpec } from './drivers/types.js';

/** Compose real paths before the driver runs. Native processes never create /workspace or /app aliases. */
export function composeHostProcess(spec: SessionSpec): void {
  const agent = spec.containers.find((container) => container.role === 'agent')!;
  const source = (target: string): string => {
    const mount = agent.mounts.find((entry) => entry.containerPath === target);
    if (!mount) throw specInvalid(`Host execution requires ${target}`);
    return mount.hostPath;
  };
  const agentDir = source('/workspace/agent');
  const sessionDir = source('/workspace');
  const sourceDir = source('/app/src');
  const codexDir = source('/home/node/.codex');
  const home = os.homedir();
  fs.closeSync(fs.openSync(path.join(agentDir, '.nanoclaw-agent-root'), 'a'));
  // Only NanoClaw's private provider store is changed. Real HOME preserves authenticated host CLIs.
  const link = (target: string, destination: string) => {
    try {
      if (fs.readlinkSync(destination) === target) return;
      fs.unlinkSync(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    fs.symlinkSync(target, destination);
  };
  link(path.join(agentDir, 'skills'), path.join(codexDir, 'skills'));
  const stub = source('/home/node/.codex/auth.json');
  fs.copyFileSync(stub, path.join(codexDir, 'auth.json'));
  const skillDirs = [path.join(agentDir, '.agents', 'skills')];
  for (const directory of skillDirs) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      if (!fs.lstatSync(file).isSymbolicLink()) continue;
      const target = fs.readlinkSync(file);
      if (target.startsWith('/app/skills/'))
        link(path.join(process.cwd(), 'container/skills', target.slice('/app/skills/'.length)), file);
      else if (target.startsWith('/workspace/agent/'))
        link(path.join(agentDir, target.slice('/workspace/agent/'.length)), file);
    }
  }
  const environment = { ...agent.env, ...agent.contributedEnv };
  // The source environment contributes tool locations and locale, never provider credentials.
  for (const name of ['PATH', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR']) {
    if (process.env[name]) environment[name] = process.env[name]!;
  }
  // Use the runner's pinned provider CLI, independent of updates to the user's Codex.
  environment.PATH = `${path.join(sourceDir, '../node_modules/.bin')}:${environment.PATH || ''}`;
  Object.assign(environment, {
    HOME: home,
    CODEX_HOME: codexDir,
    NANOCLAW_AGENT_DIR: agentDir,
    NANOCLAW_SESSION_DIR: sessionDir,
    NANOCLAW_CONTEXT_PATH: source('/app/.nanoclaw-session.json'),
    NANOCLAW_HEARTBEAT_PATH: path.join(sessionDir, '.heartbeat'),
  });
  spec.runtimeTier = 'host';
  spec.hostProcess = {
    command: execFileSync('which', ['bun'], { encoding: 'utf8' }).trim(),
    args: ['run', path.join(sourceDir, 'index.ts')],
    cwd: agentDir,
    env: environment,
  };
}

/** Resolve only core-owned resource paths, never user persona or plugin instruction text. */
export function renderHostPaths(content: string, agentDir: string): string {
  return content
    .replaceAll('/workspace/agent', agentDir)
    .replaceAll('/app/skills', path.join(process.cwd(), 'container/skills'));
}
