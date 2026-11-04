# Third-Party Notices

This file records third-party components that StackManage uses or may download. It is a living inventory, not a transfer of rights. Full analysis and per-vendor status: [`docs/legal/license-analysis.md`](docs/legal/license-analysis.md) and [`docs/legal/vendor-catalog.tsv`](docs/legal/vendor-catalog.tsv).

## A. Reference project (not distributed)

**Legacy upstream project** — BSD 3-Clause, Copyright (c) 2023, 徐鹏飞 (Pengfei Xu).

The upstream project was used only as a behavioural/feature reference during requirements research. No upstream source code, assets, icons, marketing text, screenshots, or licensing system are included in StackManage. The BSD notice is reproduced here for transparency:

> BSD 3-Clause License
>
> Copyright (c) 2023, 徐鹏飞 (Pengfei Xu)
>
> Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
> 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
> 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS “AS IS” AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## B. npm production dependencies (Phase 7)

Generated from `pnpm-lock.yaml` with `pnpm licenses list --json --prod` after adding the
read-only MCP server. All 143 production packages use permissive licences: MIT (123),
ISC (9), BlueOak-1.0.0 (4), BSD-2-Clause (3), BSD-3-Clause (3), Apache-2.0 (1). Proxy
downloads use `https-proxy-agent` 9.1.0 (MIT) with its MIT transitive dependencies.
`@modelcontextprotocol/sdk` 1.32.2 is MIT and is not currently included in the Electron
packaging file set; it is a dependency of the standalone MCP server. The complete licence
texts must be included in installer artifacts once packaging exists. Development-only
tooling is listed in the SBOM and is not shipped.

Notable runtime distributions that require their own bundled notices at packaging time:

- **Electron** (MIT) — bundles Chromium, Node.js, ffmpeg and other components; `LICENSES.chromium.html` and Electron's third-party notices must ship with the app.
- **Vue / vue-i18n / Zod / PostCSS** — MIT; preserve licence comments in bundled output where required.
- **@modelcontextprotocol/sdk and its transitive HTTP/validation packages** — MIT; the MCP server bundle keeps them external, so package or bundle their notices if it is shipped standalone.

## C. Vendor runtimes and services (download-on-demand, not bundled in Phase 0)

Each entry below is **planned**; none is downloaded or redistributed in Phase 0. The exact version, edition, source URL and digest must be pinned per module before enabling installation. Status values match `vendor-catalog.tsv`.

| Component | Candidate licence | Redistribution posture |
|---|---|---|
| PHP | PHP-3.01; extensions vary | Download from php.net/official mirrors; ship licence + extension notices |
| Node.js | MIT + bundled notices | Download official binary; include Node third-party notices |
| Python | PSF-2.0 | Download python.org build; include licence |
| OpenJDK | GPL-2.0 + Classpath Exception | Choose a specific distributor; Oracle builds have separate terms |
| Go, Rust, Zig, .NET, Bun, Deno, Flutter, Gradle | Permissive mixes | Per-artifact notices; bundled LLVM/V8/engine components apply |
| Erlang/OTP, Ruby | Apache-2.0 / Ruby or BSD-2 | Version-specific notices |
| Nginx, Apache HTTP Server, Caddy, FrankenPHP, Tomcat | BSD-2 / Apache-2.0 / MIT mixes | Exclude proprietary Nginx Plus; include NOTICE files |
| mkcert | BSD-3-Clause | Trust-store integration is separate from binary licence |
| MySQL / MariaDB | GPL-2.0 (+commercial alternatives) | Redistribution triggers source/notice obligations; prefer user-initiated download |
| PostgreSQL, Qdrant, ClickHouse, etcd | PostgreSQL / Apache-2.0 | Include notices; extensions separately reviewed |
| MongoDB | SSPL-1.0 (modern Community) | Network-service obligations; legal review before bundling |
| Neo4j Community | GPL-3.0 | Source obligations on redistribution |
| phpMyAdmin | GPL-2.0-or-later | Web app redistribution requires corresponding source |
| pgAdmin 4, DBGate, Redis Commander | PostgreSQL / MIT mixes | Bundled Python/Node dependencies reviewed separately |
| Redis | BSD-3 ≤7.2; RSALv2/SSPLv1 ≥7.4; AGPLv3 option ≥8 | Pin version and licence path explicitly |
| Memcached, Mailpit | BSD-3 / MIT | Include notices || RabbitMQ | MPL-2.0 | File-level source obligations; Erlang runtime separate |
| Elasticsearch | ELv2/SSPL/AGPLv3 depending on version | Not OSI for current default distribution; review before bundling |
| Meilisearch, Typesense, ZincSearch | MIT / GPL-3.0 / Apache-2.0 candidate | Pin project identity and release |
| Static HTTP server | UNKNOWN | Blocked until vendor identity confirmed |
| MinIO, RustFS | AGPL-3.0 / Apache-2.0 candidate | Pin release; AGPL network obligations |
| Podman | Apache-2.0 | Windows machine/VM images separately licensed |
| Cloudflared | Apache-2.0 client | Cloudflare service terms separate |
| R-Nacos, Consul, Temporal | Apache-2.0 candidate / MPL or BUSL / MIT | Consul must be pinned to a version with clear licence |
| Kafka, OpenSearch, llama.cpp | Apache-2.0 / MIT | Confluent and model weights have separate terms |
| SQL Server, Dameng DM8 | Proprietary EULA | Do not bundle; user installs under vendor terms |
| Claude Code, GitHub Copilot, Antigravity | Proprietary service/client terms | Integration only; no binary redistribution |

### C.1 Redis 7.2.7 (BSD-3-Clause, download-on-demand)

Phase 6 pins **Redis 7.2.7**, the last release line distributed under the
**BSD-3-Clause** licence. Redis 7.4 changed the default licence to
RSALv2/SSPLv1 and Redis 8 added an AGPLv3 option, so this pin must not be
silently advanced.

- Official source: `https://download.redis.io/releases/redis-7.2.7.tar.gz`
- SHA-256: `72c081e3b8cfae7144273d26d76736f08319000af46c01515cad5d29765cead5`
  (computed from the official artifact on 2026-11-04; the vendor publishes no
  SHA-256 sidecar)
- Licence evidence: <https://github.com/redis/redis/blob/7.2.7/COPYING>
- Redistribution posture: the user downloads and builds the source into their
  own profile. StackManage does not bundle or redistribute the Redis binaries in
  this phase. A release that bundles them must carry the upstream `COPYING` text.

No native Windows build exists upstream, so StackManage does not substitute an
unofficial Windows fork.

### C.2 PHP 8.5.12 (PHP-3.01, download-on-demand)

Phase 8 pins **PHP 8.5.12** from the official php.net distribution and builds a
Linux x64 CLI/FPM runtime. The source archive is verified by SHA-256 before it
enters the build context, and the Dockerfile verifies it again before extraction.

- Official source: `https://www.php.net/distributions/php-8.5.12.tar.gz`
- SHA-256: `81a0f450349e84b08eb43faa85f8a4c835684f3cc1c50471775d1317a046c525`
  (matches the php.net releases JSON, 2026-10-21)
- Licence evidence: <https://www.php.net/license/> and the upstream `LICENSE`
- Redistribution posture: the generated artifact includes the upstream
  `LICENSE`, `README.REDIST.BINS`, and the bundled notices copied by the build
  (libmagic, libmbfl, libbcmath, libavifinfo, lexbor, uriparser). Other embedded
  portions listed in `README.REDIST.BINS` still need release review. Runtime
  shared libraries come from pinned Ubuntu packages and are not copied into the
  tar; an installer or image distribution must carry the corresponding
  Ubuntu/Debian notices.
- Do not add `zend_extension=opcache.so`: PHP 8.5 always builds OPcache into the
  binary.

## D. Assets and identity

No upstream-brand logo, icon, screenshot or marketing text is used. The StackManage name and mark are project-original. Vendor product names and logos remain trademarks of their owners and are used only for identification.

## E. Updates

When a module, plugin, model, font, icon set, or installer dependency is added, update this file, `docs/legal/vendor-catalog.tsv`, and regenerate `docs/legal/sbom.cdx.json`. A release is blocked while any shipped component has `identity-unknown`, `terms-review`, or unresolved copyleft/source obligations.
