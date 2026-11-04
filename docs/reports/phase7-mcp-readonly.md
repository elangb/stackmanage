# Laporan MCP-AI — Fase 7 (MCP read-only)

## AGEN

MCP-AI, branch `agent/mcp`, worktree `/tmp/opencode/stackmanage-mcp`. Baseline `630e4e5`
(Fase 5). Tidak ada subagent. Perubahan hanya di `stackmanage/`; tidak ada kode atau aset
legacy yang disalin. UI, worker, bridge renderer, dan perilaku layanan yang sudah ada tidak
diubah.

## FASE

7 — server MCP stdio read-only untuk StackManage.

## STATUS

**Sebagian, terverifikasi lokal Linux x64.** `packages/mcp-server` kini menjalankan server
MCP stdio nyata memakai `@modelcontextprotocol/sdk` 1.32.2 dan Zod. Tujuh tool read-only
tersedia; tidak ada listener jaringan, shell/exec, atau tool mutasi. Data hanya dibaca dari
root yang dipercaya, dibatasi ukuran, dan diredaksi. Klien MCP nyata (in-memory dan proses
stdio ter-spawn) berhasil melakukan `listTools` dan `callTool`.

Windows, macOS, dan integrasi klien MCP eksternal **belum dieksekusi**. Mutasi belum
diimplementasikan dan tetap memerlukan bridge lokal terautentikasi dengan persetujuan.

## YANG SELESAI

- Server MCP nyata:
  - `@modelcontextprotocol/sdk` dipatok `1.32.2`, Zod `4.6.7`;
  - hanya `StdioServerTransport`; tidak ada HTTP/SSE, `listen`, atau port;
  - entry CLI `dist/index.js` (esbuild, 71,6 kB) dan `bin` `stackmanage-mcp`;
  - error startup hanya ke stderr; root tidak valid keluar dengan kode 1 tanpa keluaran
    protokol.
- Tujuh tool read-only dengan skema input ketat (properti tak dikenal ditolak):
  - `system.info` — platform/arch, root, `readOnly`, `network.listening=false`, limit;
  - `modules.list` — Caddy, Nginx, Node sebagai **partial** Linux x64; Redis **planned**;
  - `installations.list` — record Caddy/Nginx/Node; `absent`/`empty`/`unknown` eksplisit;
  - `services.status` — record layanan, liveness PID, identitas executable/start-token/
    proc-token di Linux, probe loopback; tidak pernah mengklaim running dari state renderer;
  - `sites.list` — set situs Caddy, flag root di luar direktori terkelola, redaksi kredensial
    `proxyTarget`;
  - `logs.tail` — tail Caddy/Nginx dengan batas 256 B–1 MiB (default 64 KiB);
  - `config.read` — konfigurasi default Caddy/Nginx maksimum 240.000 byte.
- Root data:
  - `STACKMANAGE_DATA_HOME` absolut; kosong, relatif, NUL, dan root filesystem ditolak;
  - default mengikuti Electron `userData/caddy` per OS;
  - Nginx/Node diturunkan dari parent (`<anchor>/nginx`, `<anchor>/node/runtime`) dan
    override opsional wajib tetap di dalam anchor;
  - root Caddy, Nginx, Node, dan state (`<dataRoot>/state`) dilaporkan oleh `system.info`.
- Konfinemen dan batas:
  - `realpath` + pemeriksaan prefix pada setiap read;
  - path absolut/`..`, symlink target, dan symlink state ditolak;
  - record state maksimum 512 KiB, 10 record layanan, 100 situs;
  - tidak ada path, URL, command, digest, atau root dari argumen tool.
- Redaksi sebelum keluaran: header Authorization/Proxy-Authorization, cookie, assignment
  password/token/API key, kredensial URL, bearer token, JWT, dan blok private key PEM.
- Kegagalan eksplisit: record hilang ≠ record rusak; record rusak/oversized/schema mismatch
  menjadi `unknown` dengan alasan, tanpa stack trace atau error OS mentah.
- Dokumentasi:
  - `docs/mcp.md` memuat model keamanan, layout root, referensi tool, dan contoh konfigurasi
    Claude Code, Codex, OpenCode, Kimi Code CLI, GitHub Copilot CLI, Antigravity,
    Hermes Agent, dan OpenClaw;
  - status verifikasi tiap klien ditandai eksplisit (lihat batas di bawah);
  - `contracts-v1.md`, `feature-matrix.md`, `operation-plan.md`, README, notices, dan
    inventaris lisensi produksi diperbarui.
- Legal: `production-dependencies.tsv` diperbarui menjadi 143 paket (semua permisif).
  `sbom.cdx.json` sengaja dicatat **belum diregenerasi**; ini celah inventaris yang
  terdokumentasi, bukan klaim kelengkapan.

## BUKTI

Mesin: Linux x86_64, Node `v24.21.0`, pnpm `10.32.1`, MCP SDK `1.32.2`.

| Perintah | Hasil |
|---|---|
| `pnpm install` | Berhasil; lockfile diperbarui; `tsx` 4.20.3 dan SDK 1.32.2 terpasang |
| `pnpm typecheck` | Lulus **9/9** paket |
| `pnpm lint` | Lulus, **0 warning** |
| `pnpm test` | **32 berkas, 266 lulus, 5 dilewati** |
| `pnpm --filter @stackmanage/mcp-server test` | **3 berkas, 26 lulus** (in-memory + stdio nyata) |
| `pnpm build` | Lulus **9/9**; `packages/mcp-server/dist/index.js` 71,6 kB |
| `pnpm legal:verify` | `LEGAL_VERIFY_OK: 611 checks, 143 production packages, 64 vendor rows, 244 SBOM components` |
| `node dist/index.js </dev/null` | Keluar 0 tanpa keluaran stdout |
| `STACKMANAGE_DATA_HOME=relative/path node dist/index.js` | Keluar 1; stderr `configuration error: STACKMANAGE_DATA_HOME must be an absolute path`; stdout kosong |
| Klien MCP stdio ke `dist/index.js` | 7 tool; `readOnly=true`; `dataRoot` sesuai; `network={transport:"stdio",listening:false,binds:false}` |
| Pemeriksaan `ss -H -ltnp` saat server hidup | Tidak ada listener milik PID server |

Cakupan tes:

- daftar tool persis tujuh dan seluruh anotasi `readOnlyHint`;
- `installations.list`: absen, record valid Caddy/Nginx/Node, JSON rusak, schema mismatch,
  path record di luar root;
- `services.status`: record absen, PID mati → `stopped`, executable salah → `unknown`,
  record `unverified`, record rusak, proses anak nyata dengan token benar → `running`,
  token salah → `unknown`/`proc-token`;
- `sites.list`: redaksi kredensial proxy, root di luar direktori terkelola, state rusak;
- `logs.tail`/`config.read`: file hilang, argumen path absolut/ekstra ditolak, batas byte,
  truncation, redaksi header/password/private key, konfigurasi 300 kB terpotong ke 240.000;
- konfinemen: traversal relatif, path absolut, symlink keluar root;
- root data: default Linux, override relatif/kosong/root filesystem ditolak;
- transport: `InMemoryTransport` dan proses stdio nyata via `tsx`, plus entry `dist`;
- startup invalid: exit 1, stdout bersih, pesan tidak memuat nilai path.

## RISIKO/BUG

- **Tinggi:** integrasi klien MCP eksternal belum dieksekusi. Format Claude Code, Codex,
  OpenCode, Kimi, GitHub Copilot CLI, Antigravity, Hermes, dan OpenClaw dicek dari
  dokumentasi publik pada 2026-11-04, tetapi tidak ada klien yang dijalankan pada mesin ini.
  OpenClaw dan path Antigravity CLI sangat mungkin berubah antar rilis.
- **Tinggi:** belum ada autentikasi/otorisasi MCP. Klien lokal dengan user OS yang sama
  memiliki akses filesystem yang sama; server ini adalah pengurang permukaan data dan
  pencegah mutasi tak sengaja, bukan sandbox klien jahat. Mutasi tetap memerlukan bridge
  lokal terautentikasi dan approval.
- **Tinggi:** `sbom.cdx.json` masih 244 komponen Phase 0 dan belum memuat SDK/dependensi
  transitif baru. Regenerasi wajib sebelum artefak rilis yang memuat server MCP dikirim.
- **Sedang:** identitas proses hanya dapat diverifikasi di Linux (`/proc`). macOS/Windows
  hanya memeriksa liveness, sehingga status maksimal `unknown`; belum dieksekusi di OS itu.
- **Sedang:** hanya lokasi default yang dibaca (`default` instance, `logs/default.log`,
  `caddyfiles/default.Caddyfile`, `service/logs/error.log`, `service/conf/nginx.conf`).
  Multi-instance dan access log Nginx belum didukung.
- **Sedang:** redaksi berbasis pola bersifat best-effort; format rahasia baru atau log
  terpotong di tengah nilai dapat lolos. Direktori data tetap harus berpermission ketat.
- **Sedang:** `services.status` melakukan koneksi loopback outbound untuk readiness. Ini
  bukan listener, tetapi tetap aktivitas jaringan lokal; firewall lokal dapat membuat status
  menjadi `unknown`.
- **Rendah:** nama tool fase ini (`services.status`, `logs.tail`, `config.read`) berbeda dari
  inventaris `McpToolSchema` (`services.inspect`, `logs.read`, `configs.read`). Tidak ada
  kontrak core yang diubah; rekonsiliasi aditif diperlukan sebelum mengklaim paritas.
- **Rendah:** tidak ada timeout request global pada tool; pembacaan dibatasi ukuran dan
  probe loopback dibatasi 350 ms, tetapi filesystem lambat tetap dapat menahan satu request.
- **Rendah:** `pnpm licenses list` memperbarui daftar produksi, tetapi SBOM dan notice paket
  SDK belum final untuk distribusi standalone.

## DEPENDENSI

- SECURITY/PLATFORM: desain bridge lokal terautentikasi (principal, grant per tool, expiry,
  approval) sebelum mutasi MCP dibuka.
- PACKAGING: masukkan `dist` MCP, dependency SDK/Zod, notice, dan SBOM yang diregenerasi bila
  server didistribusikan bersama aplikasi.
- QA: jalankan klien nyata Claude Code/Codex/OpenCode/Kimi/Copilot/Antigravity/Hermes/
  OpenClaw pada Windows, macOS, dan Linux; perbaiki contoh konfigurasi yang menyimpang.
- CORE: putuskan apakah nama tool read-only akan diselaraskan secara aditif dengan
  `McpToolSchema` atau didokumentasikan sebagai permukaan MCP terpisah.
- WORKER: sediakan pembacaan multi-instance/access log bila fitur itu dibutuhkan.

## LANGKAH BERIKUT

1. Tambahkan bridge lokal terautentikasi + approval sebelum membuka satu pun tool mutasi.
2. Jalankan smoke test klien nyata untuk setiap klien yang didokumentasikan; turunkan status
   “unverified” hanya setelah ada bukti.
3. Regenerasi SBOM dari lockfile akhir dan masukkan notice SDK/dependensi transitif.
4. Tambahkan dukungan multi-instance dan access log Nginx bila site manager Nginx diperluas.
5. Evaluasi timeout per request dan mekanisme audit read (tanpa merekam isi rahasia).
