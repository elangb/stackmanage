# Laporan PLUGIN-MARKET — Fase 9 (Plugin SDK dan runtime lokal)

## AGEN

PLUGIN-MARKET, branch `agent/plugin`, worktree `/tmp/opencode/stackmanage-plugin`.
Baseline `55737f9`. Tidak ada subagent. Perubahan hanya di `stackmanage/`; tidak ada kode
atau aset legacy yang disalin. Perilaku Caddy, Node, Nginx, Redis, MCP read-only, worker,
bridge renderer, preload dan UI tidak diubah.

## FASE

9 — `packages/plugin-sdk` dan backend minimal `PluginHost` lokal yang jujur soal isolasi.

## STATUS

**Sebagian, terverifikasi Linux x64 melalui unit/integration test.** Manifest ketat,
registry lokal bertanda tangan, paket `tar.gz` ber-SHA-256 dan tanda tangan Ed25519,
install/enable/disable/remove tanpa restart host, serta satu proses anak per plugin yang
aktif sudah berjalan. **Belum ada UI/market, bridge worker/renderer/MCP, update plugin,
multi-versi, rotasi kunci, atau OS sandbox.** Proses anak Node memiliki hak OS yang sama
dengan host; ini bukan sandbox keamanan.

## YANG SELESAI

- `packages/plugin-sdk`:
  - skema manifest Zod ketat: `apiVersion`, `id`, semver, `entry` relatif `.mjs`,
    permission eksplisit, compatibility window host, metadata signature, module opsional;
  - penolakan path traversal, path absolut, drive letter, backslash, segmen `.`/`..`,
    entry non-`.mjs`, permission wildcard/duplikat, API selain 1, host tidak kompatibel,
    dan signature yang diwajibkan tetapi tidak ada;
  - permission yang dikenal: `host.ping`, `host.status`, `fs.read`, `fs.write`,
    `network.connect`, `process.spawn`; hanya dua yang pertama didukung host, sisanya
    ditolak (`UNSUPPORTED_PERMISSION`, deny by default);
  - skema JSON-RPC 2.0 untuk `plugin.ping`, `plugin.status`, `plugin.shutdown`,
    notifikasi `plugin.ready`/`plugin.fatal`, serta context aktivasi immutable tanpa fungsi.
- `packages/plugin-host`:
  - registry index JSON ketat, ID unik, entri bertanda tangan Ed25519 atas canonical JSON
    (key diurutkan, `signature` dikeluarkan), path paket relatif dan dikurung di direktori
    registry;
  - verifikasi SHA-256 paket dan SHA-256 byte `plugin.json`, verifikasi `plugin.sig`
    (base64, Ed25519) dengan public key SPKI yang dipin (`TrustedKeyring`);
  - ekstraksi `tar.gz` ke staging: `plugin.json` wajib di root, entry harus file reguler
    di dalam package, symlink/hardlink/special file/absolute/traversal ditolak, batas
    ukuran arsip/entry/file/total diterapkan;
  - promosi atomik `rename` ke `installed/<id>/<version>`, rollback bila penulisan state
    gagal, penolakan ID duplikat, state JSON `state/plugins.json` di bawah plugin root
    (bukan `config.setup`), path guard pada remove;
  - install/enable/disable/remove/shutdown tanpa restart host; record `enabled` baru
    ditulis setelah handshake anak berhasil; disable yang gagal menulis state melaporkan
    `partial` dengan warning karena proses sudah berhenti;
  - satu `child_process.fork` per plugin aktif: argument array, `execArgv: []`, `cwd` di
    direktori plugin, environment allowlist kecil, JSON-RPC dibatasi 65.536 byte,
    handshake/request/heartbeat timeout, stdout/stderr dibatasi dan dilog, crash isolation,
    graceful stop (shutdown RPC → SIGTERM → SIGKILL);
  - host API hanya `plugin.ping`/`plugin.status`; context anak hanya `{pluginId,
    apiVersion}`; tidak ada bridge fs/network/shell/exec dan tidak ada generic invoke.
- Dev key generator:
  - `packages/plugin-host/scripts/generate-dev-key.mjs` membuat Ed25519 key pair,
    private key mode `0600`, public key, dan `trusted-keys.json`; menolak overwrite tanpa
    `--force`; tidak ada key yang di-commit;
  - `packages/plugin-host/config/trusted-keys.example.json` sengaja kosong.
- Dokumentasi:
  - `docs/plugin-sdk.md` memuat format manifest/paket, registry, pinning key, lifecycle,
    batas runtime dan peringatan eksplisit bahwa Node child bukan OS sandbox;
  - `docs/contracts-v1.md`, `docs/operation-plan.md`, `docs/feature-matrix.md`, README
    dan `.gitignore` diperbarui secara aditif.
- Tidak ada perubahan UI, i18n, bridge, worker, MCP, atau konfigurasi layanan.

## BUKTI

Mesin: Linux x86_64, Node `v24.21.0`, pnpm `10.32.1`.

| Perintah | Hasil |
|---|---|
| `pnpm install` | Berhasil; workspace menjadi 11 proyek; lockfile diperbarui; tidak ada dependensi eksternal baru |
| `pnpm typecheck` | Lulus **10/10** paket |
| `pnpm lint` | Lulus, **0 warning** |
| `pnpm test` | **39 berkas, 311 lulus, 6 dilewati** (integrasi opt-in) |
| `pnpm exec vitest run packages/plugin-sdk packages/plugin-host` | **4 berkas, 24 lulus** |
| `pnpm build` | Lulus **10/10**; `packages/plugin-host/dist/runtime/runner.mjs` tersalin |
| `pnpm legal:verify` | `LEGAL_VERIFY_OK: 611 checks, 143 production packages, 64 vendor rows, 244 SBOM components` |
| `generate-dev-key.mjs --out … --key-id dev-test` | Menghasilkan private/public key dan `trusted-keys.json`; private key mode `600`; file uji dihapus |

Cakupan tes plugin:

- manifest: valid, entry bersarang, traversal/absolut/drive/backslash/non-`.mjs`, semver,
  compatibility, signature wajib, permission wildcard/duplikat/tidak didukung, field asing;
- registry/paket: SHA-256 paket dan manifest, signature valid/salah/unknown key/unsigned,
  registry tamper, ID duplikat, path paket `../`, ekstraksi arsip dengan entry `../escape.mjs`
  (tidak ada file yang ditulis di luar staging);
- lifecycle: install/enable/ping/disable/enable ulang/remove tanpa restart, penolakan
  remove saat aktif, penolakan install duplikat, dua plugin aktif bersamaan, state file;
- runtime: `cwd` terkelola, environment allowlist (secret parent tidak bocor), context
  tanpa fungsi/`host`, crash satu plugin tidak mematikan plugin lain, handshake timeout,
  request timeout, kegagalan heartbeat, hasil RPC kebesaran, stdout/stderr cap dan log
  truncation.

## RISIKO/BUG

- **Tinggi:** proses anak Node bukan OS sandbox. Plugin dapat membuka file, socket, atau
  menjalankan proses sendiri dengan hak user yang sama. Allowlist environment, path guard
  dan batas pesan bukan containment OS; tidak ada seccomp/namespace/container/AppContainer.
- **Tinggi:** belum ada UI market, discovery, transport registry remote, approval, atau
  bridge aman ke renderer/MCP. Backend hanya dapat dipakai langsung dari kode lokal.
- **Tinggi:** belum ada update/rollback versi, multi-versi per ID, rotasi/revocation key,
  atau transparency log. Registry dan key harus dikelola manual.
- **Sedang:** hanya `plugin.ping`/`plugin.status` yang tersedia. Permission fs/network/
  process ditolak; ini keputusan kontrak, bukan kemampuan runtime untuk menegakkannya.
- **Sedang:** `plugin.json` dan `plugin.sig` diverifikasi setelah ekstraksi; paket sudah
  di-pin SHA-256 lebih dulu, tetapi parser tar tetap permukaan serangan. Batas ukuran dan
  penolakan link/special file sudah diuji, belum ada fuzzing.
- **Sedang:** state rusak dilaporkan sebagai `IO_ERROR`; tidak ada automatic repair. Stale
  directory tanpa record dapat menyebabkan konflik install dan harus dibersihkan manual.
- **Rendah:** `shutdown` menghentikan child tanpa mengubah record `enabled`; host berikutnya
  perlu memanggil `enable` lagi. Tidak ada auto-start saat ini.
- **Rendah:** Windows/macOS belum dieksekusi. Fork, path separator, mode file, dan sinyal
  belum diverifikasi di OS tersebut.
- **Rendah:** SBOM belum diregenerasi untuk paket workspace baru; tidak ada dependensi
  eksternal baru (`tar` dan `zod` sudah ada di inventaris).
- **Rendah:** test key generator hanya dijalankan manual; tidak ada test otomatis untuk
  script.

## DEPENDENSI

- SECURITY/PLATFORM: desain containment OS nyata (seccomp/namespace/AppContainer/user
  terpisah) dan bukti per platform sebelum mengklaim sandbox.
- BRIDGE/UI: kanal worker/preload/renderer bertipe, operasi progress/terminal, persetujuan
  instalasi, dan UI market; jangan memakai generic invoke.
- KEY MANAGEMENT: rotasi, revocation, key expiry, dan registry distribution bertanda tangan.
- PACKAGING/LEGAL: regenerasi SBOM/notice bila paket workspace baru ikut didistribusikan.
- QA: jalankan lifecycle dan crash test di Windows/macOS; uji path/case/sinyal setempat.

## LANGKAH BERIKUT

1. Tambahkan bridge worker/preload/renderer yang sempit untuk list/install/enable/disable/
   remove/ping dengan progress dan terminal result; jangan mengekspos path, digest, atau key.
2. Implementasikan containment OS nyata sebelum menyebut plugin “sandboxed”.
3. Tambahkan update/rollback, multi-versi, key rotation/revocation, dan registry remote
   bertanda tangan.
4. Regenerasi SBOM dan notice untuk distribusi paket plugin-host/plugin-sdk.
5. Jalankan acceptance Windows/macOS dan fuzzing parser tar.
