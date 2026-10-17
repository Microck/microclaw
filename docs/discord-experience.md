# Discord experience carried over from Hermes

## Feedback contract

For an authorized message that engages GLaDOS:

- Add 👀 when accepted, including container startup time.
- Show actual tool names and short command/query previews in the reply thread.
- Search previews include the query or queries, opened URL, or in-page search pattern. If Codex supplies details only at completion, show them then; do not post an empty search label.
- Label reported reads of a skill's `SKILL.md` as `loading skill: <name>`, with the command preview. This records a load attempt, not successful execution of the skill's instructions.
- Keep 👀 through tool execution, interim replies and delivery-format retries.
- Remove 👀 and add ✅ when the turn finishes, or ❌ when it fails.
- Cancellation removes 👀 without reporting success.
- React to the original message, including a parent-channel message that opened a new thread.
- Do not react to ignored/unauthorized messages or expose reasoning, tool results or credentials in previews.

Progress travels through the existing session mailbox. Discord rendering remains in the Discord adapter; model-provider events supply tool activity without asking the model to narrate its actions.

## Audit

| Behavior | Migration status |
| --- | --- |
| Same bot, owner, home channel and DM | Retained |
| Mention to start, follow-ups in existing threads | Retained |
| Automatic new threads | Native Discord adapter |
| Typing indicator | Native, heartbeat-driven refresh |
| Processing/completion reactions | Restored and verified live |
| Tool names and command previews | Restored and verified live |
| Text formatting, long-message splitting | Native bridge |
| Screenshot/image input | Verified; forwarded attachment download fixed |
| File delivery | Verified live through native send_file, including a real Discord attachment |
| User preferences, durable memories, personality and global instructions | Imported and verified |
| Previous conversations | Searchable archives; not native resumed Hermes sessions |
| Last 50 Discord messages automatically injected into old threads | Not equivalent to Hermes history_backfill; archives remain searchable |
| Schedules and notification destinations | 20 active jobs migrated, 18 inactive definitions retained |
| Hermes slash commands/model picker/voice controls | Not reproduced wholesale; NanoClaw has its own command surface |

This audit records differences explicitly. It does not claim parity for every optional Hermes feature.

## Verification and limits

The live DM check observed 👀 followed by ✅, an actual terminal command preview, the native send_file tool name, the resulting attachment with verified contents and the final reply. A separate home-channel check observed reactions on the original parent message while tool previews and the answer appeared in its new thread. Input for these checks used authenticated local Gateway fixtures on clearly labelled real bot-posted messages; they did not impersonate the owner through Discord's API.

Provider failures, cancellation, retries and interrupted queries have focused mailbox tests. Failure and cancellation rendering also have direct native-adapter checks against Discord. No real model failure was deliberately induced.

No owner messages were found in the home channel, DM or recently active home threads during the deployment pause. This was a one-time check, not a background polling service. Cold gateway restarts do not provide the same history recovery as Hermes backfill.

A live check exposed an unhealthy Iron credential service and a gateway availability interruption. The credential service was restarted and recovered. This host has limited RAM and exhausted swap; the successful checks establish the feedback behavior, not a long-term reliability guarantee.

## Automatic thread titles

New home-channel threads receive a concise title generated from the first user message by gpt-6-luna with low reasoning. The request uses T3 Code's pattern: an ephemeral, read-only Codex invocation with a JSON output schema. It runs after the assistant's first reply and does not share conversation history or MCP servers. A short bounded retry handles transient generation failures. Failure leaves Discord's original thread name and does not fail the conversation. Existing and manually renamed threads are not overwritten. On the first successful turn, completion and the generated title are applied in one rename. The answer and completion reaction do not wait for title generation. If generation fails, the original title receives the final status. A persisted two-minute deadline also releases completion if the title worker is lost, so a restart cannot leave the thread yellow indefinitely.

## Delivery receipts

Discord webhook sends are not idempotent. Each outbound message and split chunk gets a durable host-only receipt in `data/discord-delivery/` before the POST. A confirmed send reuses its Discord message ID if mailbox bookkeeping retries. A timeout, connection loss, or host crash during a send leaves an unknown outcome; automatic resending stops and the host records a terminal delivery failure with the outbound ID for inspection. The original outbound content and attachment outbox remain available. Known HTTP client rejections can retry. Receipts are removed only after the mailbox durably records delivery or terminal failure. This prevents duplicate messages without hiding legitimate repeated text.

## Turn notifications

User-facing answers reply directly to the original user message, including results delivered through `send_message` and file responses. There is no separate turn-finished message. Successful answers suppress Discord notifications. Only an explicit needs-input message or question/approval card notifies the owner. The first answer to a parent-channel message stays inside its newly created thread; Discord rejects reply references across those channels. Tool previews remain silent and completion reactions remain enabled.

The runner carries the original Discord message target with the answer. The host verifies that target belongs to the current conversation and has a human author. Needs-input messages notify on their first chunk only, and all chunks stay in the active conversation thread or channel. Bot replies and ordinary webhook output share the same durable delivery receipts.

Discord voice notes and uploaded audio are transcribed with the ChatGPT file-transcription protocol used by handy-codex. The existing credential gateway supplies the ChatGPT login; no extra API key is required. The runner converts Ogg/Opus and other audio to mono 16 kHz PCM WAV with the host's ffmpeg. Recordings longer than ten minutes are rejected explicitly.

Transcription runs only for accepted, triggering Discord messages in that conversation's runner. New voice notes can steer an active turn, and `/stop` still terminates its entire process tree. Captions are preserved, transcripts become prompt text and thread-title input, and cached transcripts are included in Supermemory's user text. Raw recordings stay in the existing session inbox; decoded temporary WAVs are removed. A failed or silent recording produces a clear notice in context instead of invented speech. ChatGPT's transcription endpoint is not a documented public API and can change.

### Public X links

The built-in `read_x` tool reads public X/Twitter post, thread and profile URLs using x.md at `x.pcstyle.dev`. It includes available article text and media links, preserves completeness warnings, caps author threads at twenty posts, and marks text truncation explicitly. It sends no X cookies or account credentials and does not use the official X API. Native curl performs the public request; no new service or package is required. Private, deleted or unavailable content cannot be read. Rate limits fail visibly without retry loops.

The runtime instructions direct agents to this tool for X links and require treating fetched content as untrusted data. The tool and instructions are committed customizations, so new agents receive the same reader and the safe updater retains it. Existing bookmark workflows remain unchanged.

The approach follows public-reader workflows used by [x-tweet-fetcher](https://github.com/ythx-101/x-tweet-fetcher) and Hermes's FxTwitter reading guidance, while using the reader selected in this installation's host instructions. x.md's [post documentation](https://x.pcstyle.dev/docs/posts) defines the current post/thread contract and [reliability documentation](https://x.pcstyle.dev/docs/reliability) describes its best-effort coverage and limits.

## Conversation controls

`/queue message:<text>` saves a follow-up in the current thread's durable inbox. It waits until the current turn ends, then runs in order. Ordinary messages still steer active work. `/queue` without a message lists pending items with edit/remove buttons, and `/clear-queue` cancels pending items. Stop cancels queued inputs too. Claimed work cannot be edited or removed as pending work.

`/btw question:<text>` forks the current Codex history into a sibling thread under the same parent channel, using the same agent, model and instructions. The source continues independently. The fork answers only the side question. It does not continue the original task or automatically merge answers back. The copied history is the stored history available when the new runner forks it.

`/resume` shows a paginated picker of this agent's conversations in the current channel. Choosing one unarchives and links its original thread; the next message resumes that thread's session rather than copying context elsewhere.

Accepted voice messages display their recognized text in the conversation before the assistant acts. Cached transcripts are not reposted on retry. Normal results, transcripts and tool output suppress notifications. `send_message` with `needs_input: true` and question/approval cards notify the owner when an answer, approval, credentials or another concrete user action is needed. A failed user turn also notifies because it has stopped and needs retry or inspection. Optional follow-up offers do not qualify. There is no completion ping.

Thread titles use 🟡 while running, 🟢 after successful completion and 🔴 when blocked or awaiting input. The status prefix preserves the title, including manual names. Needs-input messages and cards set red; a completion event cannot clear a pending red status. A new accepted user message returns it to yellow. Stop removes the state prefix so a cancelled turn does not remain marked as running. Renames are serialized and identical statuses do not issue redundant patches.

Discord rate-limits thread renames. Status/title updates coalesce to the latest requested value and retry after Discord's reported delay, independently of answer and notification delivery. Pending titles and blocker states persist across controller restarts. New conversations start yellow at creation to save the rename budget for their generated title and completion. During rapid turns the title may lag behind the actual run state.

A live API probe on 2026-10-17 in a separate temporary thread accepted two name changes and rejected the third with HTTP 429 and `retry_after: 597.267` seconds. The ordinary route headers still reported seven requests remaining, so those headers alone do not describe the rename restriction. This is an observation for this bot and thread, not a guaranteed Discord quota. The updater follows Discord's returned retry delay and retains the latest desired name and state.
