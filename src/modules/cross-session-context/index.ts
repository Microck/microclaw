/**
 * Conversation-scoped delivery context and explicit history retrieval.
 * Automatic context stays within agent group × messaging group × exact thread.
 * Other conversations are available only through explicit session-history reads.
 */
export {
  ECHO_BACKLOG_CAP,
  ECHO_CHANNEL_TYPE,
  ECHO_CONCURRENCY,
  ECHO_MAX_AGE_DAYS,
  ECHO_MAX_AGE_MS,
  ECHO_SIBLING_SURFACE,
  ECHO_TASK_SURFACE,
  ECHO_TEXT_MAX_CHARS,
  HOT_SESSION_LIMIT,
} from './config.js';
export {
  buildDeliveredEchoLabel,
  buildEchoLabel,
  buildSiblingEchoLabel,
  echoRowId,
  fanInboundMessage,
  fanOutboundMessage,
  loadHotCandidates,
  selectEchoTargets,
  selectHotSessions,
  settleEchoFans,
  truncateEchoText,
  type EchoTargetCandidate,
  type EchoWireSurface,
} from './fan.js';
export { mapConcurrent } from './parallel.js';
export { pruneEchoBacklog } from './prune.js';
export {
  formatHistoryLines,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_TEXT_MAX_CHARS,
  sessionHistory,
  type HistoryRow,
} from './history.js';
export { backfillSession, BACKFILL_LIMIT, type BackfillOptions } from './backfill.js';
