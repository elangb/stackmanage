# Laporan ARCHITECT — Fase 0

## AGEN

ARCHITECT, branch `agent/architect`, worktree `/tmp/opencode/stackmanage-architect`. Baseline legacy `7507ccd`. Seluruh perubahan terlacak berada di `stackmanage/`; tidak ada kode atau aset FlyEnv yang disalin.

## FASE

0 — fondasi desktop, kontrak v1, batas proses, workspace dan dokumentasi serah-terima.

## STATUS

Fondasi siap menjadi baseline agen lanjutan. **Penerimaan produk keseluruhan belum selesai.** Pengujian Windows, fitur layanan/vendor, dan enam artefak rilis belum dilakukan.

## YANG SELESAI

- Workspace pnpm + Turbo: dua aplikasi, tujuh paket, strict TypeScript, lockfile dan versi dipatok.
- Electron/Vue/Vite dapat dijalankan dengan `pnpm dev`; renderer HMR, restart manual untuk perubahan proses.
- `contextIsolation`, sandbox dan validasi sender aktif; preload hanya mengekspos `snapshot()`.
- Worker fork nyata dengan ID korelasi, batas payload/pending, timeout dan shutdown terkonfirmasi.
- Controller singleton bootstrap mengelola pending, deduplikasi, error/retry dan page re-entry; tidak ada Pinia.
- Kontrak/skema v1 untuk semua manager yang diminta; adapter domain tetap skeleton jujur.
- UI awal dengan seluruh label melalui i18n lima bahasa; prinsip unlimited dan telemetry off.
- ADR, operation/failure-boundary plan, inventaris MCP, matriks seluruh fitur, batas operasional dan template CI Windows/Linux.
- Riset fitur resmi dan README GitHub. `LICENSE` lokal menyebut BSD 3-Clause; perbedaan dengan AGENTS dicatat tanpa opini hukum.

## BUKTI

Mesin aktual: Linux x86_64, kernel `7.1.13-070113-generic`, Node `v24.21.0`, pnpm workspace `10.32.1`. Pengujian Electron menggunakan desktop session aktual tanpa `--no-sandbox`.

| Perintah dari `stackmanage/` | Hasil |
|---|---|
| `pnpm install` | Berhasil; lockfile tersimpan; `install-electron` mengunduh runtime melalui postinstall aplikasi |
| `pnpm typecheck` | Berhasil, 9/9 paket |
| `pnpm lint` | Berhasil, nol warning |
| `pnpm test` | Berhasil, 4 berkas / 12 tes |
| `pnpm build` | Berhasil, 9/9 paket; renderer 32 modul; bundle desktop + worker tersedia |
| `pnpm check` | Berhasil setelah perbaikan final; menjalankan typecheck, lint, test, build |
| `pnpm test:desktop` | Berhasil: `DESKTOP_SMOKE_OK: renderer → sandbox preload → main → fork worker; Node globals absent` |
| `STACKMANAGE_SMOKE=1 pnpm dev` | Berhasil; Vite `http://127.0.0.1:5179/`, round-trip Electron sama, exit 0 |

Tes memeriksa payload tak dikenal, versi API salah, metode eksekusi tak diizinkan, payload UTF-8 besar/siklik, sender/frame/origin, dukungan vendor tanpa bukti, HTTPS/hash artefak, partial/unknown outcome, injeksi hosts, timezone/dependency group, wildcard permission/path traversal plugin, deduplikasi/page re-entry/retry controller, fork konkuren nyata, respons malformed/tidak berkorelasi, timeout/close dan kelengkapan locale.

Perbaikan yang ditemukan selama verifikasi:

1. Typecheck awal gagal pada overload `process.send`; callback diberi signature/posisi eksplisit, kemudian lolos.
2. Electron versi ini membutuhkan `install-electron` eksplisit; ditambahkan postinstall aplikasi sebelum smoke test.
3. Turbo awal menampilkan pemberitahuan telemetry default; semua script Turbo kini melewati wrapper opt-out eksplisit. Tidak ada telemetry aplikasi.
4. ESLint 9 memberi deprecation warning; dipindah ke ESLint 10.14.0 dan seluruh lint/check diulang berhasil.
5. Vitest memperingatkan mode konfigurasi CommonJS; root workspace kini `type: module`, warning hilang.
6. Review failure-boundary mengarahkan kegagalan load/bootstrap melalui shutdown worker sebelum keluar.

## RISIKO/BUG

- Windows belum diuji. Linux yang terbukti baru bootstrap; bukan acceptance semua fitur Linux.
- Tidak ada installer/rilis, code signing, update, privilege helper, modul layanan, instalasi runtime, transport MCP atau runtime plugin.
- Daftar enam artefak adalah asumsi perencanaan Windows x64 installer/portable + Linux deb/rpm x64/arm64; konfirmasi dengan pemilik scope sebelum implementasi release.
- Kematian worker membutuhkan restart aplikasi; tidak ada auto-restart/replay mutation.
- Skema cron membatasi struktur lima kolom dan timezone; validasi semantik cron milik scheduler berikutnya.
- Tool MCP `decision` review/gate tidak tersedia dalam katalog sesi (discovery tidak menemukannya); tidak ada klaim review tool tersebut. Review lokal dan tes tercatat di atas.
- Template `ci/checks.yml` belum aktif karena GitHub memerlukan workflow di root `.github/workflows`, di luar scope perubahan fase ini.

## DEPENDENSI

Versi terverifikasi tersedia dari registry npm: pnpm 10.32.1, Turbo 2.11.10, Electron 45.2.2, Vue 3.5.44, vue-i18n 11.4.18, Vite 8.3.5, plugin-vue 6.0.10, TypeScript 5.9.3, vue-tsc 3.3.14, esbuild 0.28.2, Zod 4.6.7, Vitest 5.1.0, ESLint 10.14.0, @eslint/js 10.0.1, typescript-eslint 8.72.1, eslint-plugin-vue 10.12.0, @types/node 24.10.0. Ketersediaan registry bukan audit keamanan atau jaminan dukungan platform.

## LANGKAH BERIKUT

1. Integrator mengambil commit Phase 0 ini dan membuat branch agen berikutnya dari baseline yang sama.
2. Implementasi manager/modules/platform mengikuti kontrak v1 dan operation plan; perubahan breaking perlu versi baru/persetujuan eksplisit.
3. Agen legal meninjau provenance/license terpisah. Agen release mengonfirmasi enam artefak dan mengaktifkan CI root bila diizinkan.
4. QA menjalankan Windows asli serta Linux, lalu menambah bukti per fitur/vendor/arsitektur. Jangan mengubah status U berdasarkan scaffold atau build saja.
