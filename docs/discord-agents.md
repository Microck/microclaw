# Discord agent manager

The owner can manage personal assistants with the guild-scoped `/agent` command. Commands run on the host after checking NanoClaw's owner role; the language model does not provision agents or authorize management requests.

| Command | Behavior |
| --- | --- |
| `/agent create name [personality] [model] [skills] [tools]` | Create a private category and chat channel, native agent group, separate memory and learned-skill storage. |
| `/agent list` | List managed agents and channel links. |
| `/agent edit name [personality] [model] [skills] [tools]` | Edit personality/model/tool selection. Skills adds selected copies without overwriting learned skills. Restart this agent's running containers so changes apply. |
| `/agent archive name` | Disconnect replies, pause pending schedules, close active sessions and stop this agent's containers. Keep files and Discord history. |
| `/agent restore name` | Restore routing, reopen previously active sessions, and resume only schedules paused by archive. |
| `/agent delete name` | Show an owner-bound, five-minute confirmation button. Confirmation archives first, then removes this manager's category/channel and the native group. Workspace and session files remain on disk. |

Only the name is required when creating an agent. Without a personality, it starts as a standard personal assistant named after the agent. Set a personality later with `/agent edit`.

Each conversation thread has its own session and active history. Parent-channel messages and other threads are not automatically injected into it. An explicit request may retrieve another conversation through session history; durable memories remain shared within this agent. Agents respond without mentions in their own chat channel. Each opening message creates a conversation thread with the normal progress previews, processing reactions, and automatic title. Guild replies and tool previews display the sending agent's own name through a bot-owned webhook. Direct messages and host approval controls use the bot account. Both direct bot mentions and mentions of its managed Discord role start conversations.

New messages steer the active Codex turn through its app-server steer operation. Send `stop` or `/stop` in the conversation to stop its container and tools, cancel queued inputs through that point, and suppress unsent output. The owner can also use the registered Discord `/stop` command. Queued inputs become cancelled before runtime teardown, preventing a sweep from restarting that work. Cancellation retains history and does not disable future messages or unrelated schedules.

`SOUL.md` is the editable personality source, inlined into generated AGENTS.md on spawn. `instructions.prepend.md` contains a snapshot of Codex standing instructions plus NanoClaw scope. Memory, tasks, provider state and authored skills belong to this group only. Creating an agent does not copy GLaDOS memory, history, or schedules. Custom skills are copied when named explicitly from the configured source group's own skills folder; host-tools is supplied automatically. Borrowed Codex/OMP folders are read-only references by default. An explicit user request to install or edit a skill there uses the requested host path through host-tools; automatic learning remains in NanoClaw's own skill tree.

Tools is a comma-separated selection of the source group's MCP servers; `none` removes those MCP connections. Every managed agent inherits the source's host connection and its host-tools skill, independently of optional MCP selection. Host files are accessed through SSH, while each agent retains its own working folder, memory, personality and authored skills. The default is no extra MCP servers. Shared host access is trusted access to the Ubuntu account, not a filesystem security boundary between personalities. The provider, model, image and timezone inherit the working source configuration, with group-scoped CLI access.

Manager configuration lives in `data/discord-agents/config.json` (`guildId`, `sourceGroupId`, `instructionsFile`). Its durable host-only registry is `data/discord-agents/agents.json`. The instructions file is a private copy of the user's Codex AGENTS.md. These paths are covered by the native updater's data snapshot. Source changes use the committed customization branch; the Discord payload edit is registered for protected provider/channel refreshes.

Provisioning and deletion record their progress. A failed operation reports an error; repeating create with the same name resumes provisioning rather than creating a second agent. Delete can be retried after a fresh confirmation. Commands are serialized, interaction ids are deduplicated for the Discord token lifetime, and confirmation tokens are single-use. Only manager-owned records in the configured guild can be edited or removed; GLaDOS and pre-existing channels are not managed records.

## Inspecting learned content

Owner-only `/skills list`, `/skills show name`, and `/skills remove name` inspect NanoClaw-owned skills. `/memory list`, `/memory show file`, and `/memory forget file` inspect saved Markdown memory documents. Each accepts an optional `agent` name, including GLaDOS; otherwise it uses the current agent channel. Lists and documents accept `page` and reply privately.

Removal requires an owner-bound confirmation that expires after five minutes. It stops the selected agent's active turns and refuses deletion if content changed since confirmation. Skill removal deletes that skill's whole directory, including supporting files. Forget deletes one saved memory document, not individual facts or historical conversation copies. Memory indexes and system rules are protected. Borrowed Codex/OMP resources and original Hermes files are outside these commands' scope. Nothing is shared between agents automatically.
