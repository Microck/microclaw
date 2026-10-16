# Supermemory

NanoClaw captures the full text of new Discord user messages and assistant replies. Each agent has its own namespace. Each conversation is one document with a stable ID, so updates process only new text. Tool output, system prompts, scheduled-task sessions, progress messages, and copied context are excluded. Capture starts at activation; it does not upload the old Hermes chat archive.

Automatic recall searches extracted memories, rather than injecting raw chat from other threads. Retrieved facts are historical data, not instructions or a change of task. Short follow-ups such as `continue` use the current conversation without a new cross-thread memory lookup.

Local Markdown memory files remain authoritative and are preserved. Saved memories and new conversation snapshots use immediate processing so facts do not wait for a batch. This costs one extra operation per upload, currently $0.0001. Processing remains asynchronous; capture never blocks a reply.

## Configuration and credentials

The operator enables the integration for new agents with `NANOCLAW_SUPERMEMORY_ENABLED=true` and an ISO UTC `NANOCLAW_SUPERMEMORY_CAPTURE_SINCE` in the host `.env`. Group initialization creates `.supermemory.json` in that agent's workspace with its namespace and capture start. Existing group configuration is preserved. To disable an agent, set its configuration's `enabled` to false and restart its sessions.

The API key stays in the credential gateway. Agent containers receive only a placeholder. Gateway automatic approval covers POST requests to the configured agent's exact namespace document, profile, and search endpoints. An exact GET billing-summary request is also permitted for credit monitoring. Other namespaces, organization writes, deletion, and explicit policy holds retain normal approval behavior. The destination's path must be attested by the gateway.

No paid billing, top-up, or plan change is enabled. Request counts and captured character counts are recorded in the session's `session_state` under `supermemory:status`; character counts are not a measured provider bill. The provider credit balance is refreshed hourly in `.supermemory-pending/billing.json` in the agent workspace; a balance below $0.50 produces an operator warning. The provider console is authoritative for credits and usage.

## Failure behavior

Capture runs in the background and saves the newest full transcript in a per-agent upload queue. Any running session of that agent can retry the queue, even after the original conversation stops. Original mailbox history remains preserved. Stable document IDs make retries safe. Recall allows up to six seconds for parallel profile and search requests; if the service is unavailable, the agent answers with its normal local memory and conversation. Capture errors never fail a turn. Authentication errors and credit exhaustion pause requests for an hour; temporary failures back off for a minute. Failed uploads do not remove queued snapshots or discard source text. A shared SQLite lease prevents concurrent drains and permits recovery after a worker has been gone for a minute.

Implementation uses the namespace-scoped HTTP API and adds no SDK dependency. Local customizations are committed for the safe updater; agent configuration, local memories, and mailbox state remain outside source updates.

Sources: [ingestion](https://supermemory.ai/docs/ingestion/add-memories), [authentication](https://supermemory.ai/docs/authentication), [billing](https://supermemory.ai/docs/overview/billing).
