# StackManage MCP server — read-only Phase 1

Status: **implemented and tested locally**. The server is a real stdio MCP server built on
`@modelcontextprotocol/sdk` 1.32.2. It exposes seven read-only tools and **no mutation
tool**. It binds no TCP port, starts no shell, and never writes application state.

This is not a claim that every client configuration below was executed. Client formats
were checked against public documentation on 2026-11-04 and are labelled accordingly.

## Build and run

```sh
cd stackmanage
pnpm install --frozen-lockfile
pnpm --filter @stackmanage/mcp-server build
node packages/mcp-server/dist/index.js
```

The process speaks MCP over stdin/stdout. It is meant to be spawned by an MCP client.
Running it directly with an interactive terminal is only useful for protocol debugging.

## Scope

| Exposed | Not exposed |
|---|---|
| `system.info` | install, uninstall, start, stop, restart |
| `modules.list` | file writes, config writes, hosts writes, certificate trust |
| `installations.list` | shell, `exec`, PTY, arbitrary command |
| `services.status` | arbitrary paths, URLs, module IDs beyond the fixed catalog |
| `sites.list` | HTTP/SSE listener, plugin host, scheduler |
| `logs.tail` | telemetry, analytics, screenshots, terminal |
| `config.read` | mutations of any kind |

The tool names in this phase are the requested read-only surface. The frozen core
inventory in `contracts-v1.md` currently lists planned names such as `services.inspect`,
`logs.read` and `configs.read`. That divergence is recorded in
`docs/reports/phase7-mcp-readonly.md`; no core contract was changed.

### Mutations require a future bridge

There is no install/start/stop/write path in this server. A later phase needs:

1. a locally authenticated bridge with an explicit principal and per-tool authorization;
2. a user-visible approval step for each mutation class;
3. operation IDs, terminal results and audit records;
4. authenticated caller identity that the server does not take from tool arguments.

Until that exists, clients should treat all StackManage MCP output as observation only.

## Data root and layout

The only trusted input is the process environment, never a tool argument.

| Platform | Default data root |
|---|---|
| Linux | `$XDG_CONFIG_HOME/StackManage/caddy`, fallback `~/.config/StackManage/caddy` |
| Windows | `%APPDATA%\StackManage\caddy` |
| macOS | `~/Library/Application Support/StackManage/caddy` |

The default equals Electron `app.getPath('userData') + /caddy`, matching what the desktop
main process passes to the worker as `STACKMANAGE_DATA_HOME`.

`STACKMANAGE_DATA_HOME` overrides the root. It must be an absolute path; empty,
whitespace-only, relative, NUL-containing and filesystem-root values are rejected before
the server starts. The parent directory anchors the sibling module roots:

| Purpose | Location |
|---|---|
| Caddy root | `STACKMANAGE_DATA_HOME` |
| Nginx root | `STACKMANAGE_NGINX_HOME` if set, otherwise `<anchor>/nginx` |
| Node root | `STACKMANAGE_NODE_HOME` if set, otherwise `<anchor>/node/runtime` |
| Worker state | `<dataRoot>/state/<module>/` |

`STACKMANAGE_NGINX_HOME` and `STACKMANAGE_NODE_HOME` are optional and must remain inside
the anchor. If `STACKMANAGE_DATA_HOME` does not end in `caddy`, the anchor is the data
root itself.

Read locations:

| Tool | Location |
|---|---|
| Caddy installation | `<dataRoot>/state/caddy/installation.json` |
| Caddy services | `<dataRoot>/state/caddy/service-<instance>.json` |
| Caddy sites | `<dataRoot>/state/caddy/sites.json` |
| Caddy log | `<dataRoot>/logs/default.log` |
| Caddy config | `<dataRoot>/caddyfiles/default.Caddyfile` |
| Nginx installations | `<dataRoot>/state/nginx/installations.json` |
| Nginx services | `<dataRoot>/state/nginx/service-<instance>.json` |
| Nginx log | `<nginxRoot>/service/logs/error.log` |
| Nginx config | `<nginxRoot>/service/conf/nginx.conf` |
| Node installations | `<dataRoot>/state/node/installations.json` |

Missing state is reported as `absent`/`empty`. Corrupt, oversized, schema-mismatched,
symlinked or unreadable state is reported as `unknown` with a reason code. No installation,
site or running service is invented from a corrupt record. `services.status` does not
reconcile or rewrite stale records.

## Security model

- **Stdio only, no listener.** The server imports only the stdio transport and never calls
  `listen`. `services.status` may make an outbound loopback TCP probe to verify readiness;
  that does not bind a port.
- **Deny by default.** Exactly seven tools are registered. There is no generic invoke,
  shell, exec, terminal, filesystem or network tool. Unknown tools fail at the protocol.
- **Strict inputs.** Every tool uses a strict Zod object; unknown properties are rejected.
  No tool accepts a path, command, URL, digest or caller-supplied root.
- **Confinement.** Every read resolves the managed root with `realpath`, rejects absolute
  and `..` paths, rejects symlink targets, and verifies the canonical target stays inside
  the root. Symlinked state files are treated as `unknown`, not followed.
- **Bounded output.** Logs are tailed to at most 1 MiB (default 64 KiB), configs to
  240,000 bytes, state records to 512 KiB, services to 10 records, installations to the
  owning schema limits, and sites to 100 entries.
- **Redaction.** Authorization/proxy-authorization headers, cookies, common
  password/token/api-key assignments, URL credentials, bearer tokens, JWTs and PEM private
  keys are replaced before text leaves the process. Redaction is best-effort; it does not
  replace the need for least-privilege data directories.
- **No internal leakage.** Tool failures return a stable `{ok:false,error:{code,message}}`
  JSON body. Stack traces, raw OS errors and secret values are not returned.
- **No shell and no exec.** PID liveness uses `process.kill(pid, 0)`. Linux identity reads
  `/proc/<pid>/{stat,exe,environ}` read-only. Other platforms cannot verify identity and
  therefore never report `running`.
- **No telemetry.** The server does not log tool arguments, environment values or secrets.
  Fatal startup errors go to stderr and use a generic message.

Local MCP is not an authentication boundary. Any client running as the same OS user has
the same filesystem access; the server reduces exposure and prevents accidental mutation,
but it cannot sandbox a hostile local client.

## Tool reference

All results are JSON text. Success has `ok: true`; tool failures set `isError` and return
`ok: false` with a stable error code.

### `system.info`

No arguments. Returns platform, architecture, Node version, data root and source, module
roots, `readOnly: true`, `network: {transport:"stdio", listening:false, binds:false}`,
the tool list, limits and security flags.

### `modules.list`

No arguments. Returns Caddy 2.11.8, Nginx 1.30.6 and Node.js 24.22.2 as **partial**
(Linux x64 execution evidence only), and Redis as **planned**. Status is evidence, not an
availability promise.

### `installations.list`

Optional `{moduleId?: "caddy"|"nginx"|"node"|"redis"}`. Returns per-module
`state: present|empty|absent|unknown`, bounded installation views and warnings. A record
only proves that state was persisted; it does not prove the binary still exists. Paths
outside the module root are omitted.

### `services.status`

Optional `{moduleId?: "caddy"|"nginx"}`. Reads persisted service records, checks PID
liveness and, on Linux, executable + OS start token + persisted environment token. It
reports `running` only when identity is verified **and** the recorded loopback port
accepts a connection. Otherwise it reports `stopped` or `unknown` with a warning. Stale,
corrupt and unverified records are never treated as running.

### `sites.list`

Optional `{moduleId?: "caddy"}`. Returns the persisted Caddy site set, flags roots outside
the managed sites directory, and redacts credentials in `proxyTarget` URLs.

### `logs.tail`

`{moduleId: "caddy"|"nginx", maxBytes?: integer 256..1048576}`. Reads only the known
default log location. Returns `exists`, relative `path`, `bytes`, `truncated`, `redacted`,
`redactions`, `maxBytes` and redacted `text`.

### `config.read`

`{moduleId: "caddy"|"nginx"}`. Reads only the known default configuration location.
Returns `exists`, relative `path`, `bytes`, `truncated`, `redacted`, `redactions`,
`maxBytes` and redacted `content`.

## Client configuration

Replace `/ABS/PATH/stackmanage` with the absolute checkout path. `STACKMANAGE_DATA_HOME`
may be omitted when the OS default is correct; setting it explicitly is recommended.

Generic stdio entry:

```json
{
  "mcpServers": {
    "stackmanage": {
      "command": "node",
      "args": ["/ABS/PATH/stackmanage/packages/mcp-server/dist/index.js"],
      "env": {
        "STACKMANAGE_DATA_HOME": "/home/you/.config/StackManage/caddy"
      }
    }
  }
}
```

### Claude Code

Documented format, **not executed in this environment**.

```sh
claude mcp add \
  --env STACKMANAGE_DATA_HOME=/home/you/.config/StackManage/caddy \
  --transport stdio stackmanage \
  -- node /ABS/PATH/stackmanage/packages/mcp-server/dist/index.js
```

The server name must not directly follow `--env`; keep another option such as
`--transport stdio` between them, as shown in the vendor documentation.

Project `.mcp.json` equivalent:

```json
{
  "mcpServers": {
    "stackmanage": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABS/PATH/stackmanage/packages/mcp-server/dist/index.js"],
      "env": { "STACKMANAGE_DATA_HOME": "/home/you/.config/StackManage/caddy" }
    }
  }
}
```

### Codex

Documented TOML shape, **not executed in this environment**. Add to
`~/.codex/config.toml`:

```toml
[mcp_servers.stackmanage]
command = "node"
args = ["/ABS/PATH/stackmanage/packages/mcp-server/dist/index.js"]
env = { STACKMANAGE_DATA_HOME = "/home/you/.config/StackManage/caddy" }
```

### OpenCode

Documented local MCP shape, **not executed in this environment**. Add to `opencode.json`
or the global OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "stackmanage": {
      "type": "local",
      "command": ["node", "/ABS/PATH/stackmanage/packages/mcp-server/dist/index.js"],
      "enabled": true,
      "environment": {
        "STACKMANAGE_DATA_HOME": "/home/you/.config/StackManage/caddy"
      }
    }
  }
}
```

### Kimi Code CLI

Vendor documentation checked 2026-11-04 (`~/.kimi-code/mcp.json` or
`$KIMI_CODE_HOME/mcp.json`), **not executed in this environment**:

```json
{
  "mcpServers": {
    "stackmanage": {
      "command": "node",
      "args": ["/ABS/PATH/stackmanage/packages/mcp-server/dist/index.js"],
      "env": { "STACKMANAGE_DATA_HOME": "/home/you/.config/StackManage/caddy" }
    }
  }
}
```

The older Kimi CLI (`.kimi` / TOML) has a different configuration format; use its
`kimi mcp` management command or vendor docs.

### GitHub Copilot CLI

Vendor documentation checked 2026-11-04, **not executed in this environment**:

```sh
copilot mcp add stackmanage \
  --env STACKMANAGE_DATA_HOME=/home/you/.config/StackManage/caddy \
  -- node /ABS/PATH/stackmanage/packages/mcp-server/dist/index.js
```

Or add to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "stackmanage": {
      "type": "local",
      "command": "node",
      "args": ["/ABS/PATH/stackmanage/packages/mcp-server/dist/index.js"],
      "env": { "STACKMANAGE_DATA_HOME": "/home/you/.config/StackManage/caddy" },
      "tools": ["*"]
    }
  }
}
```

### Google Antigravity

Vendor documentation checked 2026-11-04 for the global file
`~/.gemini/config/mcp_config.json`, **not executed in this environment**:

```json
{
  "mcpServers": {
    "stackmanage": {
      "command": "node",
      "args": ["/ABS/PATH/stackmanage/packages/mcp-server/dist/index.js"],
      "env": { "STACKMANAGE_DATA_HOME": "/home/you/.config/StackManage/caddy" }
    }
  }
}
```

Community reports mention a separate CLI path (`~/.gemini/antigravity-cli/mcp_config.json`);
that path is **unverified**.

### Hermes Agent

Community and vendor documentation describe `~/.hermes/config.yaml` with an
`mcp_servers` map, **not executed in this environment**:

```yaml
mcp_servers:
  stackmanage:
    command: "node"
    args: ["/ABS/PATH/stackmanage/packages/mcp-server/dist/index.js"]
    env:
      STACKMANAGE_DATA_HOME: "/home/you/.config/StackManage/caddy"
```

Exact YAML keys vary by Hermes release; verify against the installed version.

### OpenClaw

Vendor documentation states that configuration lives in `~/.openclaw/openclaw.json` under
`mcp.servers`. The exact stdio entry shape has changed between releases, so this example is
**UNVERIFIED** and must be checked against the installed version:

```json
{
  "mcp": {
    "servers": {
      "stackmanage": {
        "command": "node",
        "args": ["/ABS/PATH/stackmanage/packages/mcp-server/dist/index.js"],
        "env": { "STACKMANAGE_DATA_HOME": "/home/you/.config/StackManage/caddy" }
      }
    }
  }
}
```

Some community posts show a top-level `mcpServers` key; do not assume it is current.

## Verification

```sh
cd stackmanage
pnpm --filter @stackmanage/mcp-server typecheck
pnpm --filter @stackmanage/mcp-server test
pnpm --filter @stackmanage/mcp-server build
pnpm lint
pnpm legal:verify
```

The test suite connects a real MCP `Client` over both `InMemoryTransport` and a spawned
stdio process. It covers exact tool exposure, absent/corrupt/oversized state, path
traversal and symlink escape, bounded log/config output, secret redaction, PID identity
mismatch, token mismatch, verified running state, invalid data-root overrides, and the
built `dist/index.js` CLI entry. See `docs/reports/phase7-mcp-readonly.md` for recorded
results and remaining limits.
