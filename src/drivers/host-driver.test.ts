import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HostSessionDriver } from './host-driver.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';
import type { SessionHandle } from './types.js';

const handles: SessionHandle[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop('test-cleanup');
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  do {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('Host runtime test timed out');
}
function nativeSpec(script: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-host-test-'));
  directories.push(directory);
  return fixtureSpec({
    key: { installSlug: `test-${process.pid}`, agentGroupId: 'g1', sessionId: `s-${path.basename(directory)}` },
    runtimeTier: 'host',
    runAs: { uid: process.getuid!(), gid: process.getgid!() },
    hostProcess: {
      command: process.execPath,
      args: ['-e', script],
      cwd: directory,
      env: { PATH: process.env.PATH!, HOME: directory },
    },
  });
}
describe('native host runtime with real systemd services', () => {
  it('adopts the same session from a fresh driver and stops its entire child process tree', async () => {
    const driver = new HostSessionDriver(FIXTURE_POLICY);
    const spec = nativeSpec(
      "const fs=require('fs');const child=require('child_process').spawn('sleep',['120']);fs.writeFileSync('child.pid',String(child.pid));setInterval(()=>{},1000)",
    );
    const handle = await driver.prepare(spec);
    handles.push(handle);
    await handle.start();
    await waitFor(async () => fs.existsSync(path.join(spec.hostProcess!.cwd, 'child.pid')), Boolean);
    expect((await handle.status()).phase).toBe('running');
    const adopted = await new HostSessionDriver(FIXTURE_POLICY).listSessions(spec.key.installSlug);
    expect(adopted.find((row) => row.handle.name === handle.name)?.handle.key).toEqual(spec.key);
    const child = Number(fs.readFileSync(path.join(spec.hostProcess!.cwd, 'child.pid'), 'utf8'));
    await handle.stop('user-stop');
    expect((await handle.status()).phase).toBe('stopped');
    expect(() => process.kill(child, 0)).toThrow();
  }, 20_000);
  it('reports a real process failure rather than a live session', async () => {
    const driver = new HostSessionDriver(FIXTURE_POLICY);
    const spec = nativeSpec('setTimeout(()=>process.exit(7),100)');
    const handle = await driver.prepare(spec);
    handles.push(handle);
    await handle.start();
    expect(
      await waitFor(
        () => handle.status(),
        (state) => state.phase === 'failed',
      ),
    ).toEqual({ phase: 'failed', failure: { kind: 'started-then-died', retryable: false, exitCode: 7 } });
    const rows = await driver.listSessions(spec.key.installSlug);
    expect(rows.find((row) => row.handle.name === handle.name)?.phase).toBe('terminal');
  }, 20_000);
});
