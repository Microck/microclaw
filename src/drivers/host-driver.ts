/** Native sessions use systemd's user manager, including adoption and whole-process-tree stop. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { registerSessionDriver } from './driver-registry.js';
import {
  specInvalid,
  validateSpec,
  type DriverCapabilities,
  type MountPolicy,
  type SessionDriver,
  type SessionEvent,
  type SessionHandle,
  type SessionKey,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './types.js';

const exec = promisify(execFile);
async function systemctl(args: string[]): Promise<string> {
  return (await exec('systemctl', ['--user', ...args], { timeout: 30_000, maxBuffer: 2_000_000 })).stdout;
}
function unitName(key: SessionKey): string {
  const name = `nanoclaw-host-${key.installSlug}-${key.sessionId}.service`;
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw specInvalid('Invalid host session identity');
  return name;
}
const PROPERTY_NAMES = '--property=Id,LoadState,ActiveState,SubState,ExecMainStatus,Description';
function parseProperties(text: string): Record<string, string>[] {
  return text
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) =>
      Object.fromEntries(
        block.split('\n').map((line) => {
          const split = line.indexOf('=');
          return [line.slice(0, split), line.slice(split + 1)];
        }),
      ),
    );
}
async function properties(name: string): Promise<Record<string, string>> {
  return parseProperties(await systemctl(['show', name, PROPERTY_NAMES]))[0];
}
function sessionStatus(value: Record<string, string>): SessionStatus {
  if (value.LoadState === 'not-found' || value.ActiveState === 'inactive' || value.SubState === 'exited')
    return { phase: 'stopped' };
  if (value.ActiveState === 'failed')
    return {
      phase: 'failed',
      failure: { kind: 'started-then-died', retryable: false, exitCode: Number(value.ExecMainStatus) },
    };
  return { phase: value.ActiveState === 'activating' ? 'preparing' : 'running' };
}

export class HostSessionDriver implements SessionDriver {
  readonly kind = 'host';
  constructor(private readonly policy: MountPolicy) {}
  capabilities(): DriverCapabilities {
    return {
      isolationTiers: ['host'],
      hostExecution: true,
      admissionEnforced: false,
      networkPolicy: 'none',
      encryptedVolumes: false,
      unrealized: ['memoryMb', 'cpus', 'pidsLimit', 'shmSizeMb'],
      sharedNetworkNamespace: false,
      auxiliaryContainers: false,
      imageBuild: false,
    };
  }
  async ensureReady(): Promise<void> {
    if (process.platform !== 'linux') throw new Error('Host runtime requires Linux and a systemd user manager');
    await systemctl(['show-environment']);
    await exec('bun', ['--version']);
    await exec(path.join(process.cwd(), 'container/agent-runner/node_modules/.bin/codex'), ['--version']);
  }
  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateSpec(spec, this.policy, this.capabilities());
    if (spec.containers.length !== 1 || !spec.hostProcess)
      throw specInvalid('Host execution requires one agent and a resolved native process');
    if (spec.runAs?.uid !== process.getuid?.()) throw specInvalid('Host sessions must run as the service user');
    const name = unitName(spec.key);
    const existing = await properties(name);
    if (existing.LoadState !== 'not-found' && existing.Description !== JSON.stringify(spec.key))
      throw specInvalid('Host unit identity mismatch');
    return this.handle(spec.key, spec);
  }
  private handle(key: SessionKey, spec?: SessionSpec): SessionHandle {
    const name = unitName(key);
    return {
      key,
      name,
      async start() {
        const state = await properties(name);
        if (state.LoadState !== 'not-found') {
          if (sessionStatus(state).phase === 'running') return;
          throw new Error('Existing host unit is terminal; stop it before starting a new incarnation');
        }
        const processSpec = spec?.hostProcess;
        if (!processSpec || !spec) throw new Error('An adopted host unit cannot be started after it exits');
        await exec(
          'systemd-run',
          [
            '--user',
            '--quiet',
            `--unit=${name}`,
            `--description=${JSON.stringify(key)}`,
            '--service-type=exec',
            '--property=RemainAfterExit=yes',
            '--property=KillMode=control-group',
            `--property=TimeoutStopSec=${spec.stopGraceSeconds}s`,
            `--working-directory=${processSpec.cwd}`,
            ...Object.entries(processSpec.env).map(([key, value]) => `--setenv=${key}=${value}`),
            '--',
            processSpec.command,
            ...processSpec.args,
          ],
          { timeout: 30_000 },
        );
      },
      async status() {
        return sessionStatus(await properties(name));
      },
      async stop() {
        if ((await properties(name)).LoadState === 'not-found') return;
        await systemctl(['stop', name]);
        const state = await properties(name);
        if (state.ActiveState === 'failed') await systemctl(['reset-failed', name]);
      },
      execSpec() {
        throw new Error(
          'Native sessions run on the host; interactive container attach is unavailable. Use a regular host terminal.',
        );
      },
    };
  }
  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    if (!/^[a-zA-Z0-9_-]+$/.test(installSlug)) throw specInvalid('Invalid install slug');
    const units = JSON.parse(
      await systemctl(['list-units', '--all', '--output=json', `nanoclaw-host-${installSlug}-*.service`]),
    ) as { unit: string }[];
    if (!units.length) return [];
    const states = parseProperties(await systemctl(['show', ...units.map(({ unit }) => unit), PROPERTY_NAMES]));
    return states
      .filter((state) => state.LoadState !== 'not-found')
      .map((state) => {
        const key = JSON.parse(state.Description) as SessionKey;
        if (key.installSlug !== installSlug || unitName(key) !== state.Id)
          throw specInvalid('Host unit discovery identity mismatch');
        const status = sessionStatus(state);
        return {
          handle: this.handle(key),
          phase: status.phase === 'running' ? 'running' : status.phase === 'preparing' ? 'starting' : 'terminal',
          ...(status.phase === 'failed' ? { failure: status.failure } : {}),
        } as SessionSnapshot;
      });
  }

  watchSessions(installSlug: string, report: (event: SessionEvent) => void): SessionWatch {
    let stopped = false;
    let polling = false;
    let previous = new Map<string, { key: SessionKey; phase: string }>();
    const poll = async () => {
      if (polling || stopped) return;
      polling = true;
      try {
        const current = new Map<string, { key: SessionKey; phase: string }>();
        for (const { handle, phase } of await this.listSessions(installSlug)) {
          current.set(handle.name, { key: handle.key, phase });
          if (!stopped && previous.get(handle.name)?.phase !== phase)
            report({ key: handle.key, kind: phase === 'terminal' ? 'terminal' : 'phase' });
        }
        for (const [name, state] of previous) {
          if (!stopped && !current.has(name)) report({ key: state.key, kind: 'terminal' });
        }
        previous = current;
      } catch (error) {
        console.error('[host-runtime] Session discovery unavailable', error instanceof Error ? error.name : 'unknown');
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), 2000);
    timer.unref();
    return {
      stop() {
        stopped = true;
        clearInterval(timer);
      },
    };
  }
}
registerSessionDriver('host', (policy) => new HostSessionDriver(policy));
