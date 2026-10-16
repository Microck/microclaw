# Credentials and egress

Native host commands use their existing CLI authentication and normal host networking. Run `gh`, `git`, `vercel` and other installed CLIs normally. Do not override host logins with dummy credential environment variables or require Iron Control for an already authenticated host CLI. A connected MCP app has separate permissions; check the host CLI directly before reporting its credentials invalid. Never print tokens or authentication files.

The model provider, Supermemory and container API clients use gateway-managed credentials. For a requested connection for those clients, run `ncl groups connect --host <API hostname>` and show the exact `connect_url` and action. A handoff or request approval does not mean the account is connected. Only documented non-secret placeholders belong in gateway-managed clients; real gateway credentials stay in the gateway.

Verify a credentialed request before reporting success. A bare 401/403 does not identify which policy or credential check failed. Report the observed error without guessing; do not weaken TLS or bypass the proxy for gateway-managed traffic.
