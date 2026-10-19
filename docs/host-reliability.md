# Host reliability

The native runner shares its Linux user with editors and code indexers. Watch exhaustion produces `No space left on device` even with free disk space. This install uses `/etc/sysctl.d/90-nanoclaw-inotify.conf`:

```ini
fs.inotify.max_user_watches = 262144
fs.inotify.max_user_instances = 1024
```

Apply that file with `sudo sysctl -p /etc/sysctl.d/90-nanoclaw-inotify.conf`. The settings persist across reboot and NanoClaw source updates. Raising the ceiling does not allocate unused watches. Check actual consumers before increasing it again.

Codex transport retries remain inside the same turn. NanoClaw does not replay failed turns automatically because tools may already have performed actions. A quiet live provider is no longer stopped after ten minutes. App-server exits and actual provider errors still stop the turn; native keepalives preserve worker liveness during deliberate waits. See [proactive review](proactive-review.md#long-turns-and-deliberate-waits).

The native service's persistent `90-host-runtime.conf` drop-in includes the installed Homebrew `bin` and `sbin` directories, plus `/snap/bin`. In this installation `certutil` is a Homebrew tool. Omitting that path prevents the runner from trusting the gateway CA for Chromium. Run `systemctl --user daemon-reload` after editing the drop-in, then reload only when all turns are idle.

`patches/discordjs-ws-1.2.3.patch` fixes teardown of pending Discord handshakes and prevents cancelled waits from starting recursive recovery. pnpm applies it to the pinned transport during frozen installs. Revalidate the real socket test when updating that dependency. Remove the patch only when the unpatched replacement passes both cancellation and genuine timeout recovery.

Runner and MCP processes share the outbound mailbox. A new connection sets its existing five-second lock timeout before running journal/schema setup, and enters the cache only after setup succeeds. This prevents brief runner writes from making the first tool call fail immediately or leave a partially initialized connection cached. DELETE journal mode remains unchanged for cross-mount readers.

The host memory guard sent SIGTERM to Iron Control at 21:29 on 2026-10-18. Its Ruby web process then hung during graceful shutdown while PostgreSQL remained healthy. The generated web service now has `oom_score_adj: -500`, inherited by its job processes. This lowers its memory-kill priority without disabling the host guard or making the service unkillable. A dry run of the installed guard confirmed its score fell from 978 to 645, below ordinary workloads. The host still needs enough free memory for all services.

Native Codex delegation is capped at two concurrent children per conversation. Run heavy builds, whole-project test suites and large indexing jobs in the configured Raft workspace. The assistant still has normal host file access. This reduces assistant-driven load; it does not reserve RAM against unrelated host workloads or replace additional host capacity.
