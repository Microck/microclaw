---
name: iron-proxy-gateway
description: Use Iron Proxy for gateway-managed model and API credentials. Native host CLIs use their existing local authentication. Connect gateway accounts through the operator console and diagnose blocked requests without exposing tokens.
compatibility: Gateway-managed clients require the injected proxy and CA. Native host commands retain normal host authentication and networking.
metadata:
  author: nanoclaw
  version: "1.1.0"
---

# Iron Proxy gateway

## Native host commands

When NanoClaw runs directly on the host (`NANOCLAW_AGENT_DIR` is set), ordinary shell commands use the user's existing CLI logins and normal host networking. Run `gh`, `git`, `vercel` and other CLIs normally. Never override their authentication with dummy `GH_TOKEN`, `GITHUB_TOKEN`, `VERCEL_TOKEN` or `gateway-managed` values. Do not read or print stored tokens.

Check native CLI authentication directly before declaring it invalid, for example `gh api user` or `vercel whoami`, without credential overrides. A GitHub MCP connection has separate permissions; its write denial does not mean the native GitHub CLI is unauthenticated. Existing native CLI logins do not need an Iron Control connection.

The model provider and Supermemory still use the injected gateway. The following rules govern clients whose requests actually pass through that proxy, including container clients.

## Gateway-managed connections

A policy-selected credential request waits for approval before the proxy inserts a credential. These clients receive only a documented non-secret placeholder. Real gateway credentials stay in the gateway; never paste them into a client or store them through a container login.

For a requested gateway account connection, run:

```bash
ncl groups connect --host <API hostname>
```

Return the exact `connect_url` and describe its `action`. An `operator_console` handoff requires operator configuration of the gateway credential, grant and destination. It is not an OAuth link. The command does not grant access or change policy. Do not invent a connection flow when the result is `unsupported`, or add an MCP server merely to connect an account.

A bare 401 or 403 does not identify the failing layer. It may be a destination rule, credential grant, approval or upstream API. Report the hostname and observed error and request a host-side check. Request approval and account connection are separate; verify a credentialed request before claiming success.

## Rules

- Never ask for, print or store a raw API key or OAuth token in chat or an agent workspace.
- Never bypass the configured proxy for gateway-managed traffic or weaken TLS validation.
- Never treat a pending approval as granted or claim that a blocked destination is connected.
- Ordinary native host CLI authentication remains available; gateway placeholders are not a replacement for it.
