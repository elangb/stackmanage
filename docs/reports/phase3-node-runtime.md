# Laporan RUNTIME-MODULES — Fase 3 (Node.js runtime)

## AGEN

RUNTIME-MODULES, branch `agent/node-runtime`, worktree
`/tmp/opencode/stackmanage-node`. Baseline `0669648` (Fase 2). Tidak ada subagent.

## FASE

3 — runtime Node.js native, terpisah dari layanan web Caddy.

## STATUS

**Sebagian, terverifikasi Linux x64.** Instalasi resmi Node.js `v24.22.2` (LTS
Krypton) berhasil diunduh dari `nodejs.org`, diverifikasi SHA-256, diekstrak,
dijalankan sebagai `<install>/bin/node --version` = `v24.22.2`, lalu dicopot
kembali. Windows x64/arm64 dan Linux arm64 dipatok dan dihash, tetapi **belum
dieksekusi**. Shell hook, pemilihan versi per proyek, dan integrasi npm/npx
belum menjadi bagian fase ini.

## YANG SELESAI

- Modul worker `apps/worker/src/modules/node`:
  - pin resmi `node-v24.22.2-linux-x64.tar.gz`, `linux-arm64`, `win-x64`, dan
    `win-arm64` beserta SHA-256 resmi;
  - unduhan HTTPS dengan allowlist **hanya `nodejs.org`** (setiap hop redirect),
    batas redirect, batas byte, idle timeout, resume `.part`, dan verifikasi
    SHA-256 sebelum promosi;
  - `SHASUMS256.txt` resmi dibaca sebagai bukti tambahan. Bila daftar tidak
    tersedia, instalasi tetap memakai digest terpatok dan menghasilkan warning;
    bila entri daftar berbeda dari digest terpatok, instalasi dihentikan;
  - ekstraksi tar.gz/zip mempertahankan direktori top-level resmi, menolak
    path absolut/traversal/entri di luar top-level/file khusus, dan tidak pernah
    membuat symlink. Symlink npm/npx/corepack resmi dilewati; `bin/node` tetap
    file reguler yang diverifikasi;
  - staging per operasi, validasi versi binary sebelum commit, rename atomik,
    rollback direktori sebelumnya bila commit/persistensi gagal, dan idempotensi
    bila instalasi valid sudah ada;
  - uninstall hanya melalui record instalasi; direktori dan binary wajib resolve
    di dalam root instalasi terkelola, selain itu `FORBIDDEN`.
- Kontrak v1 aditif:
  - worker: `runtime.versions`, `runtime.install`, `runtime.status`,
    `runtime.list`, `runtime.uninstall`;
  - bridge/preload/main: channel tetap `runtimeVersions`, `runtimeInstall`,
    `runtimeStatus`, `runtimeList`, `runtimeUninstall`;
  - skema ketat, tanpa URL/digest/path/command dari pemanggil, tanpa generic
    invoke/exec/shell;
  - `RuntimeInstallationView` mengekspos `binaryPath`, `versionOutput`, dan
    `pathPrepend`, bukan mutasi PATH.
- Renderer:
  - controller singleton modul-local (`runtime/controller.ts`), tanpa Pinia;
    dedupe, progress tervalidasi, terminal cleanup, listener cleanup, notice
    berbasis kunci i18n;
  - halaman **Runtimes** menggantikan tampilan unavailable, kartu Node.js dengan
    versi terpatok, platform/arch, progress, versi terpasang, binary path,
    rencana PATH, tombol install/uninstall, dan tabel empat artefak;
  - label jujur: Linux x64 “Tested”, Windows/arm64 “Unverified”;
  - lima locale (id/en/zh/es/vi) dengan paritas kunci.
- Caddy tidak diubah perilakunya: primitif operasi dipindah ke
  `apps/worker/src/shared/operation.ts` dan tetap diekspor ulang dari manifest
  Caddy; seluruh tes Caddy lulus, termasuk integrasi nyata.

## BUKTI

Mesin: Linux x86_64, Node `v24.21.0`, pnpm `10.32.1`.

| Perintah | Hasil |
|---|---|
| `pnpm install --frozen-lockfile` | Selesai, lockfile tidak berubah |
| `pnpm typecheck` | Lulus 9/9 paket |
| `pnpm lint` | Lulus, 0 warning |
| `pnpm test` | **25 berkas, 218 lulus, 3 dilewati** (integrasi opt-in) |
| `pnpm legal:verify` | `LEGAL_VERIFY_OK` 548 pemeriksaan, 31 paket produksi, 71 baris vendor, 244 komponen SBOM |
| `TURBO_FORCE=1 pnpm build` | Lulus 9/9 paket |
| `pnpm test:desktop` | `DESKTOP_SMOKE_OK: renderer → sandbox preload → main → fork worker; typed narrow bridge; runtime reads; Node globals absent` |
| `STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/node.integration.test.ts` | Lulus: SHASUMS256 resmi, unduhan `nodejs.org`, SHA-256 `361718c4…`, `v24.22.2`, instalasi kedua tanpa unduhan ulang, uninstall menghapus direktori |
| `STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/caddy.integration.test.ts` | Lulus: regresi Caddy (unduh resmi, HTTP 200, rekonsiliasi PID) |
| Electron UI nyata via CDP | Halaman **Runtime Node.js** tampil; klik pasang → `v24.22.2`; binary `/tmp/.../node/runtime/installations/node-v24.22.2-linux-x64/bin/node`; PATH plan terlihat; klik copot → status `installed=false` dan direktori bersih |

Bukti UI CDP (data pengguna sementara, dibersihkan setelah tes):

```json
{
  "title": "Runtime Node.js",
  "bridgeIsolationOk": true,
  "nodeCardVisible": true,
  "installedVersion": "v24.22.2",
  "binaryPath": "/tmp/opencode/stackmanage-ui-data/node/runtime/installations/node-v24.22.2-linux-x64/bin/node",
  "pathPrepend": ["/tmp/opencode/stackmanage-ui-data/node/runtime/installations/node-v24.22.2-linux-x64/bin"],
  "uiShowsInstalledPath": true,
  "removed": true
}
```

## RISIKO/BUG

- **Tinggi:** Windows x64/arm64 dan Linux arm64 belum dieksekusi. Artefak dan
  SHA-256 dipatok; status eksekusinya tetap `unverified`.
- **Tinggi:** Symlink resmi `bin/npm`, `bin/npx`, dan `bin/corepack` sengaja
  dilewati. Runtime `node` berfungsi, tetapi `npm`/`npx` belum tersedia dari
  instalasi ini. Ini konsekuensi kebijakan “tidak membuat symlink”; dibutuhkan
  desain khusus bila npm harus didukung.
- **Sedang:** `SHASUMS256.txt` adalah bukti tambahan, bukan pengganti digest
  terpatok. Kegagalan jaringan daftar menjadi warning, bukan kegagalan instalasi.
- **Sedang:** belum ada shell hook/project environment/version switch. UI hanya
  menampilkan rencana prepend PATH.
- **Sedang:** integrasi UI memakai user-data sementara dan unduhan nyata; tes
  default tetap offline.
- **Rendah:** hanya satu versi terpatok; record mendukung daftar tetapi UI
  menampilkan satu instalasi target saat ini.
- **Rendah:** `runtime.install` berbeda operation ID saat instalasi berjalan
  mengembalikan `CONFLICT`; ID yang sama mengikuti operasi yang ada.

## DEPENDENSI

- PLATFORM: eksekusi Windows/arm64 dan audit path/arsitektur.
- QA: verifikasi UI Windows/arm64; keputusan produk untuk npm/npx.
- WORKFLOW: project environment dan shell hook yang aman.
- PACKAGING: notice Node.js pihak ketiga dan cleanup saat uninstall aplikasi.

## LANGKAH BERIKUT

1. Jalankan tes integrasi Node yang sama di Windows x64 dan Linux arm64.
2. Putuskan dukungan npm/npx: rekonstruksi symlink in-tree dengan validasi
   tujuan, atau dokumentasikan runtime-only secara permanen.
3. Hubungkan `pathPrepend` ke project environment/shell hook dengan consent
   eksplisit dan tanpa mutasi PATH global default.
4. Tambahkan runtime berikutnya (PHP/Python) dengan pola pin/unduh/ekstrak yang
   sudah dipisahkan per modul.
