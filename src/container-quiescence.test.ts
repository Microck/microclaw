import { expect, it } from 'vitest';
import { assertAgentGroupIdle, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';

it('refuses a mutation during an in-flight wake, including before container registration', async () => {
  const session: Session = {
    id: 'quiescence-fixture',
    agent_group_id: 'quiescence-group',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
  expect(() => assertAgentGroupIdle(session.agent_group_id, [session])).not.toThrow();
  // No database is installed in this isolated test. The real async wake
  // remains registered until that failure settles; no runtime is provisioned.
  const waking = wakeContainer(session);
  expect(() => assertAgentGroupIdle(session.agent_group_id, [session])).toThrow('active or starting work');
  await expect(waking).resolves.toBe(false);
  expect(() => assertAgentGroupIdle(session.agent_group_id, [session])).not.toThrow();
  expect(() => assertAgentGroupIdle(session.agent_group_id, [{ ...session, container_status: 'running' }])).toThrow(
    'active or starting work',
  );
});
