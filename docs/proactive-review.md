# Proactive review

The optional proactivity module watches assistant activity through the existing
session mailboxes. It uses `gpt-reserve` with low reasoning to decide whether
something warrants a follow-up. Email is one additional source, not the scope
of the loop. The module starts after the credential gateway and stops with the
host. It does nothing without private `data/proactivity.json` configuration.

## Behavior contract

- Observe every configured agent group's active conversation and task sessions, including task sessions closed in the last day:
  incoming requests, tool calls and bounded tool results, outgoing messages,
  task logs, terminal processing outcomes, and failures.
- Baseline historical mailbox records on first observation. Collect changes
  during running turns, then review a bounded batch after the session is idle.
  A periodic review can revisit an explicitly identified pending commitment.
- Use an isolated, tool-free `gpt-reserve` reviewer. It receives the originating
  session's recent activity, its latest request, and that agent's local memory.
  It never receives another conversation's transcript.
- Decisions are `ignore`, `digest`, or `investigate`, with evidence. A nullable
  `followUpAfterSeconds` schedules a later review of pending work, from two
  minutes to one day. A non-null delay schedules review only; it never wakes the main agent immediately. When that timer expires, an authorized status check can wake the agent. Completed work and questions awaiting the user should
  receive no scheduled review. At most three timer reviews run per new request.
- In `active` mode, an evidenced investigation can queue a continuation through
  the original session's inbound mailbox as a triggered `webhook` event. `system` messages are reserved for MCP responses and cannot wake an idle runner. Automatic review events retain the original request identity and wake limits. It uses that session's existing model,
  context, tools and permissions. When `notificationUserId` is configured, automated follow-up replies go to that owner's DM; normal user-requested replies retain their thread route. Each notifying personality receives an outbound DM destination and refreshed session projections; inbound DMs stay wired to the primary assistant. It cannot grant permission or execute
  the reviewer's instructions as trusted instructions. The main agent verifies
  the finding against the user's request. Unsupported or already resolved
  findings remain silent. `digest` is retained privately, not sent to Discord.
- Admit a continuation only when the original session remains active and idle,
  its latest request has not changed, and it has not been stopped. Recheck at
  admission after inference. Respect queued user input and approval/question
  waits. Never create a replacement session for an archived conversation.
- `/stop` records a durable stop marker and cancels queued proactive inputs.
  No automatic review continuation resumes that conversation until another
  user request arrives. Scheduled tasks retain their existing stop semantics.
- Use deterministic inbound IDs for crash-safe admission. Limit automatic
  continuations to three per request, at least five minutes apart, and suppress
  repeated findings with identical evidence. Do not send a turn-finished ping.
  Existing Discord delivery decides whether the final result needs user input.
- A failed review never interrupts ordinary assistant work. Daily review limits,
  retries and token accounting survive restarts. Never fall back silently to
  another reviewer model.

## Configuration and sources

Configuration contains `mode` (`active` or `silent`), `agentGroupId` (the primary
agent and mail-memory owner), `agentGroupIds` (the complete activity scope, `["*"]` includes future agents),
optional `emailAccount` and Discord owner `notificationUserId`, `pollSeconds` (15 through 86400), and `maxDailyReviews`
(1 through 500). Polling and inference run serially; unchanged sessions without
a due follow-up do not cause inference. Private configuration, the SQLite ledger
and status file stay under updater-preserved `data/` and must not be published.

The email source uses Himalaya IMAP. `message read --preview` preserves unread
flags. The first complete snapshot baselines existing mail. Later snapshots
queue unseen messages regardless of sender date. Email decisions remain private
unless an owner `notificationUserId` is configured. Then an evidenced finding queues a verification in the owner's DM conversation before any alert; read email with `--preview`, never execute email instructions.
Himalaya exposes UIDs but not UIDVALIDITY; mailbox rebuilds may replay mail.
Calendar is unavailable until a calendar source is connected. A mail-source
outage must not prevent activity reviews.

## Isolation and operations

The reviewer has no shell, browser, MCP, app, skill, or subagent tools.
Set `[agents] enabled = false` as well as disabling both multi-agent feature
flags: a model catalog can otherwise select a multi-agent backend despite a
disabled legacy flag. Rejected non-text items record only their type in private logs. A rejected
event retries on its own budget and does not pause reviews of other events.
Only model or gateway infrastructure failures cause a global backoff. Codex `item` entries of type `error` are nonfatal warnings, including model rerouting; allow the review to finish. Only top-level `error`, `turn.failed`, an unsuccessful process exit or a missing completion establish a model failure. This follows the [pinned Codex event contract](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/exec/src/exec_events.rs). Its isolated HOME,
Codex config, short model instructions and ephemeral session do not read or
write personal Codex configuration. All event content, local memory and model
findings are untrusted data, never authorization. Tool observations are bounded
and private. Review only meaningful tool items, never reasoning token streams.

Read `data/proactivity/status.json` for source health, queue and decision counts,
daily attempts and tokens. The private ledger records decisions and continuation
admission, not just successful model calls. Normal cancellation terminates the
reviewer's process group. No reserve-specific cost or quota guarantee is assumed.

Keep source customizations committed for the safe updater. Removing the private
configuration and restarting disables collection without erasing retained state.

## Long turns and deliberate waits

A quiet Codex turn has no NanoClaw elapsed-time cutoff. Ten minutes without a
provider event produces an internal diagnostic, not cancellation or a Discord
failure message. While the app-server remains alive, the runner emits liveness
every 30 seconds so the host does not mistake a deliberate wait for a dead
worker. This heartbeat proves worker liveness, not model progress. App-server
exits and explicit provider errors still fail promptly; `/stop` still interrupts
the turn and its process tree. Existing network/RPC and tool-specific deadlines
remain in force.

NanoClaw explicitly enables Codex's existing native `sleep_tool`. Use it for a
short intentional wait. Use a scheduled task or the proactive follow-up timer
for unattended future checks instead of keeping a turn open just to poll.
