# Plugin SDK and local PluginHost (Phase 9)

This document describes the additive `@stackmanage/plugin-sdk` manifest/API and the
`@stackmanage/plugin-host` local backend. It is **not** a marketplace UI, it is not wired
to the renderer/MCP bridge yet, and it does not claim OS-level sandboxing.

## Scope

- Verify a strict manifest, a SHA-256 package pin, and an Ed25519 detached signature.
- Install a local `tar.gz` package into a managed per-user plugin root without restarting
  the host process.
- Enable/disable/remove plugins without restarting the host process.
- Run one Node child process per enabled plugin with a bounded JSON-RPC probe surface.
- Keep Caddy, Node, Nginx, Redis, MCP and the frozen v1 bridge unchanged. No worker,
  preload, renderer or MCP channel is added in this phase.

## Manifest

`plugin.json` is parsed with strict Zod (`unknown` keys rejected). The SDK schema is
additive; the frozen core `PluginManifestSchema` remains unchanged.

```json
{
  "apiVersion": 1,
  "id": "example-plugin",
  "name": "Example",
  "version": "1.0.0",
  "entry": "index.mjs",
  "permissions": ["host.ping", "host.status"],
  "compatibility": { "host": { "min": "0.1.0", "max": "1.0.0" } },
  "signature": { "algorithm": "ed25519", "keyId": "example-key", "file": "plugin.sig" }
}
```

| Field | Rule |
|---|---|
| `apiVersion` | Exactly `1`; any other value is `UNSUPPORTED_API` |
| `id` | `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`, at most 128 characters; unique in the registry and installed store |
| `version` | Strict semantic version |
| `entry` | Relative slash-separated `.mjs` path inside the package. Absolute paths, drive letters, backslashes, `.`/`..` segments, empty segments and non-`.mjs` filenames are rejected |
| `permissions` | Explicit capability list, unique, no wildcard |
| `compatibility.host` | Inclusive host-version window; `min <= max` |
| `signature` | Optional metadata. When present, the package must contain `plugin.sig` and the key must be pinned |
| `modules` | Optional bounded `ModuleDefinition` declarations; a declaration is not execution evidence |

### Requested capabilities

Phase 1 supports only `host.ping` and `host.status`. A manifest requesting `fs.read`,
`fs.write`, `network.connect` or `process.spawn` is valid schema but is rejected by the
host (`UNSUPPORTED_PERMISSION`) because the host cannot grant it. Nothing is granted by
default.

`SUPPORTED_PLUGIN_PERMISSIONS` is exported by the SDK so callers do not have to duplicate
the policy. A future capability requires an explicit host implementation, not a manifest
claim.

## Package format

A package is a gzip-compressed tar archive:

```text
plugin.json          exact manifest bytes, pinned by the registry
plugin.sig           optional base64 Ed25519 signature over the exact plugin.json bytes
index.mjs            entry; may be nested (for example dist/index.mjs)
assets/...           optional regular files
```

Extraction is confined to a fresh staging directory:

- `plugin.json` must exist at the package root and be a regular file.
- Entries with absolute paths, drive letters, backslashes, `.`/`..` segments, symlinks,
  hardlinks or special file types are rejected.
- File/entry/total-size limits are enforced before promotion.
- The exact `plugin.json` bytes are hashed and compared with the registry pin.
- The entry must remain inside the staging directory and be a regular file.

The package digest is the SHA-256 of the complete `tar.gz`; the manifest digest is the
SHA-256 of the exact `plugin.json` bytes. Both are registry-pinned and verified before
promotion. Promotion is a same-filesystem rename from `staging/` to
`installed/<id>/<version>/`; a failed state write removes the promoted directory.

The entry runs from the installed package directory and must be self-contained (relative
imports/assets or Node built-ins). The host does not run a package manager or install
dependencies inside the plugin root.

`plugin.sig` is standard base64 (64 decoded bytes). It signs the exact `plugin.json` bytes
with Ed25519. The manifest's `signature.keyId` selects a pinned public key.

## Registry and key pinning

The local registry is a JSON file. Every entry is strict and the list rejects duplicate
plugin IDs.

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "id": "example-plugin",
      "version": "1.0.0",
      "manifestSha256": "<64 lowercase hex characters>",
      "package": { "file": "packages/example-plugin-1.0.0.tgz", "sha256": "<64 lowercase hex characters>" },
      "signature": { "algorithm": "ed25519", "keyId": "example-key", "value": "<base64 signature>" }
    }
  ]
}
```

The registry-entry signature covers the canonical JSON of the entry with `signature`
removed (object keys recursively sorted, arrays preserved). The package path is relative
to the registry index directory; `..`, absolute paths and backslashes are rejected.

Public keys are pinned in a separate file. Only keys listed there can verify packages or
registry entries; unknown key IDs are rejected.

```json
{
  "schemaVersion": 1,
  "keys": [{ "keyId": "example-key", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n..." }]
}
```

`packages/plugin-host/config/trusted-keys.example.json` is intentionally empty. No
production or development key is committed.

Generate a throwaway development key pair in an ignored directory:

```bash
node packages/plugin-host/scripts/generate-dev-key.mjs --out .plugin-keys --key-id dev
```

The script refuses existing files unless `--force` is passed, writes the private key with
mode `0600`, and emits a matching `trusted-keys.json`. Do not use development keys for a
production registry.

## Host backend

```ts
import { PluginHost, TrustedKeyring } from '@stackmanage/plugin-host';

const trustedKeys = await TrustedKeyring.fromFile('/path/to/trusted-keys.json');
const host = new PluginHost({
  root: '/path/to/managed-plugins',
  registryIndex: '/path/to/registry/index.json',
  trustedKeys,
  hostVersion: '1.0.0',
  requireSignature: true,
  requireSignedRegistry: true
});

await host.install('example-plugin', '1.0.0', operationContext);
await host.enable('example-plugin', operationContext);
await host.ping('example-plugin');        // read-only plugin.ping
await host.probeStatus('example-plugin'); // read-only plugin.status
await host.disable('example-plugin', operationContext);
await host.remove('example-plugin', operationContext);
await host.shutdown();
```

### Managed root

```text
<root>/
  registry/index.json
  registry/packages/*.tgz
  installed/<id>/<version>/
  staging/
  trash/
  state/plugins.json
```

`plugins.json` is module-owned JSON under the plugin root. It is never stored in a shared
application `config.setup` object. `STACKMANAGE_PLUGIN_HOME` overrides the root;
`STACKMANAGE_DATA_HOME/plugins` is used when set; otherwise the per-user
`<data home>/StackManage/plugins` path is used.

### Lifecycle guarantees

- `install` rejects an existing ID, duplicate registry IDs, unsigned entries when
  signatures are required, bad digests, bad signatures and unsafe paths. Staging is
  removed in `finally`; a successful promotion is removed if the state write fails.
- `enable` is idempotent while running. The manifest is re-validated against the current
  host version and capability policy. The state record is marked enabled only after the
  child handshake succeeds.
- `disable` stops the child, then writes the disabled record. If only the state write
  fails, the result is `partial` with a warning because the process is already stopped.
- `remove` refuses a running plugin, moves the installed directory to `trash/`, removes
  the state record, and only then deletes the trash directory. A state-write failure
  restores the directory. A final cleanup failure is a warning, not a false "still
  installed" result.
- `shutdown` stops children without rewriting enabled records.

## Child runtime

Each enabled plugin runs in its own `child_process.fork` child:

- argument array, `execArgv: []`, no shell;
- `cwd` is the installed plugin directory;
- environment is a small allowlist (`PATH`, `HOME`, `TMPDIR`/`TMP`/`TEMP`,
  `SystemRoot` on Windows, `LANG`/`LC_ALL`/`LC_CTYPE`) plus
  `STACKMANAGE_PLUGIN_ID`, `STACKMANAGE_PLUGIN_ENTRY` and
  `STACKMANAGE_PLUGIN_API_VERSION`;
- stdout/stderr are capped and logged by the host, never forwarded as protocol;
- JSON-RPC only over the Node IPC channel;
- inbound/outbound messages are capped at 65,536 bytes;
- handshake timeout, request timeout, heartbeat timeout and bounded pending requests;
- crash isolation: a plugin exit rejects only its own pending requests and leaves other
  plugins running; no automatic restart.

The child runner loads exactly one entry with a dynamic `import()`. It passes an immutable
`{ pluginId, apiVersion }` context to an optional `activate(context)`. The context contains
no functions, no host object, no filesystem, network, shell or exec bridge. Optional entry
exports are `activate`, `deactivate`, `ping` and `status`.

Host → plugin RPC methods are exactly:

| Method | Purpose |
|---|---|
| `plugin.ping` | Liveness/read-only probe |
| `plugin.status` | Bounded read-only status |
| `plugin.shutdown` | Host-initiated graceful stop |

There is no generic invoke/exec channel.

## Isolation limits (read this before trusting the runtime)

**A Node child process is not an OS sandbox.** The plugin executes with the same OS user
privileges as the host process. It can import Node built-ins, open files, open sockets and
spawn processes if it chooses. Phase 1 prevents the *host* from handing it filesystem,
network, shell or exec functions; it does not use seccomp, namespaces, containers,
AppContainer, a separate OS user or a VM. Do not describe this runtime as a security
sandbox.

The environment allowlist, path confinement, signature checks and message caps reduce
accidental and protocol-level exposure. They are not a substitute for OS containment.
A future phase that claims real containment must add platform-specific evidence.

## Limits

| Limit | Default |
|---|---:|
| Archive size | 10 MiB |
| Extracted entries | 512 |
| Extracted single file | 5 MiB |
| Extracted total | 20 MiB |
| Manifest size | 256 KiB |
| Signature file | 4 KiB |
| JSON-RPC message | 65,536 bytes |
| Pending requests | 16 |
| Handshake | 10 s |
| Request | 5 s |
| Heartbeat interval / timeout | 5 s / 2 s |
| stdout/stderr per stream | 65,536 bytes |

## Not implemented in Phase 9

- Plugin market UI, discovery, ratings or remote registry transport.
- Renderer/preload/worker/MCP bridge channels or approvals.
- Plugin updates, rollback to an older version, version ranges for a package, or
  multiple installed versions of one ID.
- Key rotation, revocation, certificate chains or transparency logs.
- Filesystem/network mediation, resource quotas, process-tree containment or an OS
  sandbox.
- Windows/macOS execution evidence. Unit/integration tests run on Linux x64.
