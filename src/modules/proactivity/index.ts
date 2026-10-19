import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { DATA_DIR, GROUPS_DIR, INSTALL_SLUG } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession, isTaskThread } from '../../db/sessions.js';
import { collectActivity, dispatchContinuations } from './activity.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getSessionDriver } from '../../drivers/index.js';
import { getGatewayProvider, gatewayRuntimeIdentity, type GatewaySessionLease } from '../../gateway-providers/index.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { ensureUserDm } from '../permissions/user-dm.js';
import { isOwner } from '../permissions/db/user-roles.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { resolveTaskSession } from '../../session-manager.js';
import { resolveProviderName } from '../../providers/provider-name.js';
import { ReviewLedger, type MailEnvelope } from './ledger.js';
import { reviewEvent, reviewPrompt, ReviewError, reviewerUnavailable } from './reviewer.js';

const exec = promisify(execFile);
interface ReviewConfig {
  mode: 'silent' | 'active';
  agentGroupIds: string[];
  agentGroupId: string;
  emailAccount?: string;
  notificationUserId?: string;
  pollSeconds: number;
  maxDailyReviews: number;
}

export function parseReviewConfig(value: unknown): ReviewConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid proactivity configuration');
  const config = value as Record<string, unknown>;
  if (
    !['silent', 'active'].includes(String(config.mode)) ||
    !Array.isArray(config.agentGroupIds) ||
    !config.agentGroupIds.length ||
    config.agentGroupIds.some((id) => typeof id !== 'string' || !/^(?:[a-zA-Z0-9_-]+|\*)$/.test(id)) ||
    typeof config.agentGroupId !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(config.agentGroupId) ||
    (config.emailAccount !== undefined &&
      (typeof config.emailAccount !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(config.emailAccount))) ||
    (config.notificationUserId !== undefined &&
      (typeof config.notificationUserId !== 'string' || !/^discord:[0-9]{17,20}$/.test(config.notificationUserId))) ||
    !Number.isInteger(config.pollSeconds) ||
    Number(config.pollSeconds) < 15 ||
    Number(config.pollSeconds) > 86400 ||
    !Number.isInteger(config.maxDailyReviews) ||
    Number(config.maxDailyReviews) < 1 ||
    Number(config.maxDailyReviews) > 500
  )
    throw new Error('Invalid proactivity configuration');
  return config as unknown as ReviewConfig;
}

/** Validate the external mail boundary once, before it enters the durable ledger. */
export function parseEnvelopes(value: unknown): MailEnvelope[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.id !== 'string' ||
        !/^\d+$/.test(entry.id) ||
        typeof entry.date !== 'string' ||
        !Number.isFinite(Date.parse(entry.date)) ||
        typeof entry.subject !== 'string' ||
        !entry.from ||
        typeof entry.from.addr !== 'string',
    )
  )
    throw new ReviewError('invalid_mail_response');
  return value.map((entry) => ({
    id: entry.id,
    date: entry.date,
    subject: entry.subject.slice(0, 1000),
    from: { addr: entry.from.addr, name: typeof entry.from.name === 'string' ? entry.from.name : undefined },
  }));
}

export function mailArgs(account: string, operation: 'list' | 'read', idOrPage: string): string[] {
  return operation === 'list'
    ? ['envelope', 'list', '--account', account, '--folder', 'INBOX', '--output', 'json', '--page-size', '0']
    : ['message', 'read', '--account', account, '--folder', 'INBOX', '--preview', '--output', 'json', idOrPage];
}

async function mailCommand(args: string[], signal: AbortSignal): Promise<unknown> {
  try {
    const { stdout } = await exec('himalaya', args, { timeout: 45_000, maxBuffer: 2 * 1024 * 1024, signal });
    return JSON.parse(stdout);
  } catch (error) {
    // Child-process errors contain stdout/stderr. Never copy them into host logs.
    throw new ReviewError(signal.aborted ? 'cancelled' : 'mail_unavailable', { cause: error });
  }
}

async function collectMail(config: ReviewConfig, ledger: ReviewLedger, signal: AbortSignal): Promise<number> {
  const envelopes = parseEnvelopes(await mailCommand(mailArgs(config.emailAccount!, 'list', ''), signal));
  return ledger.ingest(config.emailAccount!, envelopes, new Date().toISOString());
}

function userFacts(groupFolder: string): string {
  const directory = path.join(GROUPS_DIR, groupFolder, 'memory');
  const preferred = ['proactive-review.md', 'index.md', 'hermes-user.md', 'hermes-memory.md', 'hermes-facts.md'];
  let notes: string[];
  try {
    notes = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  const files = [...new Set([...preferred, ...notes])];
  let facts = '';
  for (const name of files) {
    if (facts.length >= 10000) break;
    try {
      const fd = fs.openSync(path.join(directory, name), 'r');
      try {
        const buffer = Buffer.alloc(24000);
        const bytes = fs.readSync(fd, buffer);
        facts = (facts + (facts ? '\n\n' : '') + buffer.toString('utf8', 0, bytes).slice(0, 6000)).slice(0, 10000);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return facts;
}

export async function runReviews(config: ReviewConfig, signal: AbortSignal): Promise<void> {
  const directory = path.join(DATA_DIR, 'proactivity');
  const group = await getAgentGroup(config.agentGroupId);
  const containerConfig = await getContainerConfig(config.agentGroupId);
  if (config.notificationUserId && !(await isOwner(config.notificationUserId)))
    throw new ReviewError('notification_owner_required');
  if (
    !group ||
    resolveProviderName(group.agent_provider, containerConfig?.provider) !== 'codex' ||
    !getSessionDriver().capabilities().hostExecution
  ) {
    throw new ReviewError('native_codex_group_required');
  }
  const ledger = new ReviewLedger(directory);
  const leases = new Map<string, { lease: GatewaySessionLease; abort: AbortController }>();
  let activityError: string | null = null;
  let lastPollAt: string | null = null;
  let lastMailAttempt = 0;
  let reviewBackoffUntil = 0;
  let sourceError: string | null = null;
  let reviewError: string | null = null;
  const publishStatus = (): void => {
    const now = new Date().toISOString();
    const status = {
      mode: config.mode,
      activity: { groups: config.agentGroupIds, error: activityError },
      model: 'gpt-reserve',
      effort: 'low',
      updatedAt: now,
      email: { account: config.emailAccount, lastPollAt, error: sourceError },
      calendar: 'not_configured',
      maxDailyReviews: config.maxDailyReviews,
      reviewError,
      reviewBackoffUntil: reviewBackoffUntil ? new Date(reviewBackoffUntil).toISOString() : null,
      ...ledger.summary(now),
    };
    const temporary = path.join(directory, 'status.json.tmp');
    fs.writeFileSync(temporary, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, 'status.json'));
  };
  try {
    publishStatus();
    while (!signal.aborted) {
      try {
        const collected = await collectActivity(ledger, config.agentGroupIds, new Date().toISOString());
        activityError = collected.errors ? 'activity_collection_failed' : null;
      } catch {
        activityError = 'activity_collection_failed';
      }
      if (config.emailAccount && Date.now() - lastMailAttempt >= 120_000)
        try {
          lastMailAttempt = Date.now();
          const queued = await collectMail(config, ledger, signal);
          lastPollAt = new Date().toISOString();
          sourceError = null;
          log.info('Proactive email poll', { queued, mode: config.mode });
        } catch (error) {
          sourceError =
            error instanceof ReviewError
              ? error.category
              : error instanceof Error && error.message === 'mail_source_changed'
                ? 'mail_source_changed'
                : 'collection_failed';
        }
      // One bounded batch per poll. Inference never overlaps another review.
      for (let count = 0; count < 5 && !signal.aborted && Date.now() >= reviewBackoffUntil; count++) {
        const event = ledger.next(new Date().toISOString());
        if (!event) break;
        const now = new Date().toISOString();
        let reviewGroup = group;
        if (event.source === 'session') {
          const session = await getSession(event.session_id!);
          const currentGroup = session && (await getAgentGroup(session.agent_group_id));
          if (!session || !currentGroup || (session.status !== 'active' && !isTaskThread(session.thread_id))) {
            ledger.discard(event.id, 'closed');
            continue;
          }
          const snapshot = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
            mailbox.getActivitySnapshot(),
          );
          if (!snapshot) {
            ledger.discard(event.id, 'closed');
            continue;
          }
          if (snapshot.stopped || snapshot.origin?.id !== event.origin_id) {
            ledger.discard(event.id, snapshot.stopped ? 'stopped' : 'superseded');
            continue;
          }
          if (snapshot.busy) {
            ledger.defer(event.id, now);
            continue;
          }
          reviewGroup = currentGroup;
        }
        const attempt = ledger.begin(event.id, now, config.maxDailyReviews);
        if (attempt === undefined) break;
        try {
          let credentials = leases.get(reviewGroup.id);
          if (!credentials || credentials.abort.signal.aborted) {
            const { session } = await resolveTaskSession(reviewGroup.id, 'proactive-review');
            const key = { installSlug: INSTALL_SLUG, agentGroupId: reviewGroup.id, sessionId: session.id };
            const abort = new AbortController();
            const lease = await getGatewayProvider().sessions.ensure(
              {
                key,
                runtimeIdentity: gatewayRuntimeIdentity(key),
                groupName: reviewGroup.name,
                containerName: `nanoclaw-proactivity-${INSTALL_SLUG}-${session.id}`,
                capabilities: getSessionDriver().capabilities(),
              },
              AbortSignal.any([signal, abort.signal]),
            );
            lease.onUnavailable?.(() => abort.abort());
            credentials = { lease, abort };
            leases.set(reviewGroup.id, credentials);
          }
          const currentLease = credentials.lease;
          const reviewSignal = AbortSignal.any([signal, credentials.abort.signal]);
          const auth = currentLease.contribution.mounts?.find((mount) =>
            mount.containerPath.endsWith('/.codex/auth.json'),
          );
          if (!auth || !currentLease.contribution.env?.HTTPS_PROXY) throw new ReviewError('gateway_auth_unavailable');
          let eventText = event.payload;
          let related = '';
          if (event.source === 'mail') {
            const envelope = JSON.parse(event.payload) as MailEnvelope;
            const body = await mailCommand(mailArgs(config.emailAccount!, 'read', envelope.id), reviewSignal);
            if (typeof body !== 'string') throw new ReviewError('invalid_mail_body');
            eventText = JSON.stringify({ envelope, body });
            related = ledger.related(envelope);
          }
          const result = await reviewEvent({
            binary: path.resolve('container/agent-runner/node_modules/.bin/codex'),
            authFile: auth.hostPath,
            gatewayEnv: currentLease.contribution.env,
            prompt: reviewPrompt({
              event: eventText,
              facts: userFacts(reviewGroup.folder),
              related,
            }),
            signal: reviewSignal,
          });
          ledger.finish(event.id, attempt, result.decision, result, new Date().toISOString());
          reviewError = null;
          log.info('Proactive event reviewed', {
            action: result.decision.action,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            mode: config.mode,
          });
        } catch (error) {
          reviewError = error instanceof ReviewError ? error.category : 'review_failed';
          ledger.fail(event.id, attempt, reviewError, new Date().toISOString());
          // A mail-source failure does not stall activity. Model/gateway outages
          // back off globally instead of spending one attempt per queued event.
          if (reviewerUnavailable(reviewError)) {
            reviewBackoffUntil = Date.now() + 15 * 60_000;
            break;
          }
        }
      }
      if (config.mode === 'active') {
        try {
          const dm = config.notificationUserId
            ? await ensureUserDm(config.notificationUserId, { privacySafeLogs: true })
            : null;
          if (config.notificationUserId && !dm) throw new ReviewError('notification_dm_unavailable');
          await dispatchContinuations(
            ledger,
            new Date().toISOString(),
            dm
              ? {
                  agentGroupId: config.agentGroupId,
                  messagingGroupId: dm.id,
                  channelType: dm.channel_type,
                  platformId: dm.platform_id,
                  threadId: null,
                  emailAccount: config.emailAccount,
                }
              : undefined,
          );
        } catch (error) {
          activityError = error instanceof ReviewError ? error.category : 'continuation_admission_failed';
        }
      }
      publishStatus();
      await delay(config.pollSeconds * 1000, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) {
      reviewError = error instanceof ReviewError ? error.category : 'worker_stopped';
      publishStatus();
      throw error;
    }
  } finally {
    for (const { lease, abort } of leases.values()) {
      abort.abort();
      await lease.release?.({ kind: 'session-ended', reason: 'proactive review stopped' });
    }
    ledger.close();
  }
}

let worker: Promise<void> | undefined;
onHostStart(({ signal }) => {
  const file = path.join(DATA_DIR, 'proactivity.json');
  if (!fs.existsSync(file)) return;
  try {
    const config = parseReviewConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    worker = runReviews(config, signal).catch(() => {
      // Optional background work must not take down Discord or leak private input.
      log.error('Proactive review stopped; inspect its private status file');
    });
  } catch (error) {
    log.error('Proactive review configuration is invalid', {
      category: error instanceof SyntaxError ? 'json' : 'schema',
    });
  }
});
onHostShutdown(async () => {
  await worker;
  worker = undefined;
});
