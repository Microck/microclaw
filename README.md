# MicroClaw

A personal Discord assistant built on [NanoClaw](https://github.com/nanocoai/nanoclaw), customized for everyday use with Codex.

## What changed

- Separate conversation sessions for Discord threads, with steering, stop, queues, history resume and side conversations.
- Named agents with their own workspace, editable personality, memory and learned skills. Creating one only needs a name.
- Visible tool activity, processing reactions, voice-note transcription and public X post reading.
- Quiet result replies inside the conversation. Questions, blockers and approvals notify the owner.
- Thread titles show running, completed or blocked state, subject to Discord rename limits.
- Optional Supermemory capture and recall, plus local Markdown memory.
- A Linux native runtime for direct access to the user's files and authenticated command-line tools.
- Checked updates that preserve local code customizations and private runtime state.

The native runtime runs as your user with full file and network access. Use it only with trusted users and agents. Containers remain available. Managed model and memory credentials use the configured credential gateway.

## Get started

```sh
git clone https://github.com/Microck/microclaw.git
cd microclaw
bash nanoclaw.sh
```

This is a customized source distribution, not a copy of a running personal assistant. Configure your own Discord application, provider, credential gateway and agent instructions. Credentials, conversations, memories, private skills and agent workspaces are not included. Some internal commands, package names and services retain the NanoClaw name.

See [Discord agents](docs/discord-agents.md), [Discord conversations](docs/discord-experience.md), [native runtime](docs/host-runtime.md), [memory](docs/supermemory.md) and [publication automation](docs/publication.md). NanoClaw's [setup documentation](docs/setup-wiring.md) covers the underlying setup flow.

## Development

The host uses Node 22 or later and pnpm. The separate agent runner uses Bun.

```sh
pnpm install --frozen-lockfile
(cd container/agent-runner && bun install --frozen-lockfile)
pnpm run typecheck
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm test
(cd container/agent-runner && bun run test)
```

## Attribution

MicroClaw is a fork of NanoClaw by Gavriel Cohen and contributors. The original MIT [license](LICENSE) is retained. Upstream code and documentation retain their original attribution.
