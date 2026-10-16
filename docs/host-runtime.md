# Direct host execution

Set `NANOCLAW_RUNTIME_DRIVER=host` to run each agent session as the service's Linux user. The host runtime uses systemd user services for process supervision and restart discovery. It has full user filesystem and network access, with no container sandbox or enforced read-only mounts. Managed model and Supermemory credentials still use the gateway.

Each Discord thread keeps its existing session mailbox and provider continuation. Each agent keeps its own workspace, personality, memory and learned skills. A private CODEX_HOME keeps generated provider configuration and learned skills separate from the user's Codex installation. HOME remains the real user home so authenticated host CLIs retain their normal setup. Ordinary file paths and installed tools are available directly; SSH is unnecessary.

The runtime requires Linux, a working systemd user manager, Bun and the runner's installed dependencies, including its pinned Codex CLI. Selecting it fails explicitly if those prerequisites are unavailable. Stop commands terminate the session's entire systemd control group. Host restarts adopt surviving units by their install, agent and session identity.

Switch only after current turns and their child work finish. Do not kill a running container to perform this switch. Source customizations belong in local commits; private agent files and mailbox data remain outside updates. Switching execution does not delete Hermes or historical session state.

The safe updater stops this install's native session units before replacing runtime files, installs frozen Bun dependencies for native runners, and skips agent image rebuilds. The service's host tool PATH belongs in a systemd drop-in, so service regeneration preserves it. Interactive container attach is unavailable; use a regular host terminal.

Provider startup allows up to two minutes for cold CLI initialization. This does not change per-request deadlines or retry failed user turns. A host that spends most of its time waiting for memory still needs more free RAM to respond reliably.

The controller names its process `nanoclaw-host`, so host policies that prefer killing generic Node workloads do not select it solely by the Node executable name. Memory protection remains enabled.

Native session admission checks the credential proxy listener before starting a runner. While the proxy is starting after a reboot, user messages stay pending for the existing host wake loop instead of reaching a model with an unavailable connection. No gateway lease is registered until that check succeeds.

Native host commands use the existing GitHub, Vercel and other CLI logins in the real user home. Do not override them with gateway placeholders such as `GH_TOKEN=gateway-managed`. The model provider and Supermemory still use gateway-managed credentials; their connection rules do not apply to ordinary host CLI authentication. Verify host CLI access directly before reporting an account problem.

Native Codex runners disable shell snapshots. The pinned CLI can restore proxy variables from a snapshot after shell environment exclusions run, sending ordinary host tools through the credential gateway. Disabling snapshots keeps shell commands on native host networking while model requests retain the gateway.

Codex turns have a ten-minute inactivity deadline, refreshed by provider activity. Active tool calls and streamed reasoning can keep a turn running beyond ten minutes. A silent provider still times out; stopping a turn still terminates its process tree.
