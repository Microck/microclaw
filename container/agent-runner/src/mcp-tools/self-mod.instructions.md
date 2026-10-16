## Installing packages & tools

To install packages that persist, use the self-modification tools:

**`install_packages`** — request system (apt) or global npm packages. Requires admin approval.

Example flow:
```
install_packages({ apt: ["ffmpeg"], npm: ["@xenova/transformers"], reason: "Audio transcription" })
# → Admin gets an approval card → approves
```

**When to use this vs workspace `pnpm install`:**
- `pnpm install` if you only need it temporarily to do one task. Will not be available in subsequent truns.
- `install_packages` persists for all future turns. Use especially if the user specifically asks you to add a capability

### MCP servers (`add_mcp_server`)

Use **`add_mcp_server`** to add an MCP server to your configuration. Browse available servers at https://mcp.so — it's a curated directory of high-quality MCP servers. Most Node.js servers run via `pnpm dlx`, e.g.:

```
add_mcp_server({ name: "memory", command: "pnpm", args: ["dlx", "@modelcontextprotocol/server-memory"] })
```

Remote Streamable HTTP servers use a URL instead of a command:

```
add_mcp_server({ name: "remote", url: "https://example.com/mcp" })
```

Use HTTPS; plain HTTP is allowed only for `localhost` and
`host.docker.internal` (an MCP server running on the host machine). URLs with
credentials, fragments, or credential-looking query parameters are rejected;
authentication belongs in the configured credential gateway.

Do not ask the user to paste credentials into chat or fabricate credential setup instructions. Gateway-managed model/API credentials use the configured gateway and its documented placeholders and connection flow. Native host CLI commands use their existing local logins: do not override `gh`, `git`, `vercel` or other host tools with dummy credentials or require a gateway connection for an already authenticated CLI. Never print stored tokens or authentication files.
