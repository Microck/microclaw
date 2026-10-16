import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { HostSessionDriver } from '../../src/drivers/host-driver.js';
import { FIXTURE_POLICY, fixtureSpec } from '../../src/drivers/spec-fixture.js';
import { getInstallSlug } from '../../src/install-slug.js';
import { readEnvFile } from '../../src/env.js';
import { drainContainers, defaultServiceEnvironment, usesHostRuntime } from './service.js';

it('matches canonical runtime environment parsing, including whitespace and quoted settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-update-env-'));
  const previous = process.env.NANOCLAW_RUNTIME_DRIVER;
  try {
    for (const processValue of [undefined, '', '  ', ' host ', 'docker']) {
      if (processValue === undefined) delete process.env.NANOCLAW_RUNTIME_DRIVER;
      else process.env.NANOCLAW_RUNTIME_DRIVER = processValue;
      for (const content of [
        ' NANOCLAW_RUNTIME_DRIVER = host ',
        "NANOCLAW_RUNTIME_DRIVER='host'",
        'NANOCLAW_RUNTIME_DRIVER="HOST"',
        'NANOCLAW_RUNTIME_DRIVER=host\nNANOCLAW_RUNTIME_DRIVER=docker',
        '# NANOCLAW_RUNTIME_DRIVER=host\n',
        'NANOCLAW_RUNTIME_DRIVER=host\nNANOCLAW_RUNTIME_DRIVER=',
      ]) {
        fs.writeFileSync(path.join(root, '.env'), content);
        const canonical =
          processValue?.trim() ||
          readEnvFile(['NANOCLAW_RUNTIME_DRIVER'], root).NANOCLAW_RUNTIME_DRIVER?.trim() ||
          'docker';
        expect(usesHostRuntime(root)).toBe(canonical.toLowerCase() === 'host');
      }
    }
  } finally {
    if (previous === undefined) delete process.env.NANOCLAW_RUNTIME_DRIVER;
    else process.env.NANOCLAW_RUNTIME_DRIVER = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('the updater drains only its native install before replacing runtime files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-update-host-'));
  const driver = new HostSessionDriver(FIXTURE_POLICY);
  const spec = fixtureSpec({
    key: { installSlug: getInstallSlug(root), agentGroupId: 'g1', sessionId: 'update-drain' },
    runtimeTier: 'host',
    runAs: { uid: process.getuid!(), gid: process.getgid!() },
    hostProcess: {
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: root,
      env: { PATH: process.env.PATH!, HOME: root },
    },
  });
  const handle = await driver.prepare(spec);
  try {
    fs.writeFileSync(path.join(root, '.env'), ' NANOCLAW_RUNTIME_DRIVER = host\n');
    await handle.start();
    expect((await handle.status()).phase).toBe('running');
    await drainContainers(root, defaultServiceEnvironment());
    expect((await handle.status()).phase).toBe('stopped');
  } finally {
    await handle.stop('test-cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
