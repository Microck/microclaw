import { expect, it } from 'vitest';
import { DockerSessionDriver } from './docker-driver.js';
import { FakeCli } from './fake-cli.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';

/** Docker's --rm races with explicit removal after stop. No Docker daemon
 * or mocked modules: the recording CLI exposes the real protocol states. */
it('waits for in-progress automatic removal rather than failing teardown', async () => {
  const cli = new FakeCli('docker');
  cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
  const spec = fixtureSpec();
  spec.containers[0].mounts = [];
  const handle = await new DockerSessionDriver({ ...FIXTURE_POLICY, cli }).prepare(spec);
  cli.responses.unshift({ match: /^rm /, throws: new Error('Removal is already in progress') });
  const removing = { match: /^ps /, output: 'ncl-spike-s1' };
  cli.responses.unshift({ match: /^inspect --format/, output: 'removing' });
  cli.responses.unshift(removing);
  const stopping = handle.stop('user-stop');
  // The first probe has observed removing. Advance the daemon to absent.
  removing.output = '';
  await stopping;
  expect(cli.calls.filter((call) => call.args[0] === 'ps')).toHaveLength(2);
});
it('still refuses teardown when a container remains running', async () => {
  const cli = new FakeCli('docker');
  cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
  const spec = fixtureSpec();
  spec.containers[0].mounts = [];
  const handle = await new DockerSessionDriver({ ...FIXTURE_POLICY, cli }).prepare(spec);
  cli.responses.unshift({ match: /^rm /, throws: new Error('Removal refused') });
  cli.responses.unshift({ match: /^ps /, output: 'ncl-spike-s1' });
  cli.responses.unshift({ match: /^inspect --format/, output: 'running' });
  await expect(handle.stop('user-stop')).rejects.toMatchObject({ kind: 'unknown' });
});
it('accepts removal completing between presence and inspection', async () => {
  const cli = new FakeCli('docker');
  cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
  const spec = fixtureSpec();
  spec.containers[0].mounts = [];
  const handle = await new DockerSessionDriver({ ...FIXTURE_POLICY, cli }).prepare(spec);
  cli.responses.unshift({ match: /^rm /, throws: new Error('Removal is already in progress') });
  let probes = 0;
  cli.responses.unshift({
    match: /^ps /,
    get output() {
      return ++probes === 1 ? 'ncl-spike-s1' : '';
    },
  });
  await handle.stop('user-stop');
  expect(probes).toBe(2);
});
it('does not mistake an inspection failure followed by a daemon outage for absence', async () => {
  const cli = new FakeCli('docker');
  cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
  const spec = fixtureSpec();
  spec.containers[0].mounts = [];
  const handle = await new DockerSessionDriver({ ...FIXTURE_POLICY, cli }).prepare(spec);
  cli.responses.unshift({ match: /^rm /, throws: new Error('Removal refused') });
  let probes = 0;
  cli.responses.unshift({
    match: /^ps /,
    get output() {
      if (++probes === 1) return 'ncl-spike-s1';
      throw new Error('Cannot connect to the Docker daemon');
    },
  });
  await expect(handle.stop('user-stop')).rejects.toMatchObject({ kind: 'runtime-unavailable' });
});
