# Laporan CORE-SERVICES + UI-SHELL — Fase 1 (irisan vertikal)

## AGEN

CORE-SERVICES dan UI-SHELL, branch `agent/core-services`. Baseline `0eb7274` (Fase 0 + legal). Worktree `/tmp/opencode/stackmanage-core`. Branch UI semula terpisah tidak sempat menghasilkan commit karena kuota model agen; implementasi UI diselesaikan langsung pada branch integrasi ini.

## FASE

1 — fondasi layanan nyata dan shell UI.

## STATUS

**Sebagian.** Caddy berhasil dipasang, dijalankan, diuji HTTP 200, dihentikan, dan direkonsiliasi pada **Linux x64**. Nginx, HTTPS/browser acceptance, modul lain, MCP, plugin, dan installer belum selesai. Windows belum diuji.

## YANG SELESAI

- Pemasang Caddy 2.11.8 dari rilis resmi GitHub:
  - pin URL dan checksum SHA-512 resmi;
  - SHA-256 nyata untuk linux x64/arm64 dan windows x64 dihitung dari artefak resmi (bukan hash semu);
  - unduhan streaming dengan batas ukuran/redirect/timeout, resume Range + fallback, verifikasi digest, ekstraksi aman tar.gz/zip, staging + atomic rename, validasi `caddy version`, rollback.
- Siklus proses Caddy: start, stop, restart, status, deteksi port, log tail terbatas, PID/state atomik, verifikasi identitas proses, rekonsiliasi PID yatim saat worker mulai.
- Situs lokal: generate Caddyfile, validasi dengan `caddy validate`, penerapan situs dikelola di dalam direktori situs (bukan path sembarang), peringatan restart jika layanan berjalan.
- Bridge IPC aditif v1: channel eksplisit per operasi, skema Zod ketat, progres tervalidasi, tanpa generic invoke. `contextIsolation`/sandbox tetap aktif.
- Controller singleton renderer (tanpa Pinia) untuk dedupe, progres, terminal cleanup, dan notice berbasis kunci i18n.
- UI orisinal: sidebar kategori, overview, halaman Caddy dengan status/aksi/situs/log, tema terang/gelap, aksesibilitas keyboard, lima bahasa (id/en/zh/es/vi).
- Label jujur untuk area yang belum diimplementasikan; tidak ada status layanan palsu.
- Tes unit/worker/controller/UI helper dan tes integrasi opt-in dengan unduhan nyata.

## BUKTI

Mesin: Linux x86_64, Node `v24.21.0`, pnpm `10.32.1`.

| Perintah | Hasil |
|---|---|
| `pnpm typecheck` | Lulus 9/9 paket |
| `pnpm lint` | Lulus, 0 warning |
| `pnpm test` | **20 berkas, 190 lulus, 1 dilewati** (integrasi opt-in; termasuk PLATFORM yang diintegrasikan) |
| `TURBO_FORCE=1 pnpm build` | Lulus 9/9 paket |
| `pnpm test:desktop` | `DESKTOP_SMOKE_OK: renderer → sandbox preload → main → fork worker; typed narrow bridge; Node globals absent` |
| `STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/caddy.integration.test.ts` | Lulus: unduh resmi, checksum, `caddy version` v2.11.8, HTTP 200 (`body=stackmanage`), simulasi kematian worker, PID yatim direkonsiliasi |
| `pnpm legal:verify` | `LEGAL_VERIFY_OK` 545 pemeriksaan |
| Electron UI nyata melalui CDP | Klik **Pasang Caddy** → unduhan resmi + verifikasi checksum + instalasi selesai; klik **Mulai** → status Berjalan, PID 117240; `curl http://localhost:18080/` → **HTTP 200** dengan body situs default; klik **Hentikan** → status Berhenti dan port 18080 tertutup |

Catatan integrasi: tes mengunduh sekitar 18 MB dari GitHub dan berjalan dalam ~5 detik; tes default tidak membutuhkan jaringan.

## RISIKO/BUG

- **Tinggi:** Windows dan Linux arm64 belum dieksekusi. Artefak dipatok, tetapi status eksekusi tetap `unverified`.
- **Tinggi:** Nginx belum diimplementasikan; Caddy bukan pengganti klaim paritas Nginx.
- **Tinggi:** HTTPS lokal, hosts file, dan trust store belum diintegrasikan ke UI/worker. Situs saat ini HTTP loopback.
- **Sedang:** document root dibatasi ke direktori terkelola; root proyek arbitrer belum diizinkan.
- **Sedang:** tidak ada uninstall/rollback UI; pemasangan ulang memakai idempotensi dan validasi binary.
- **Sedang:** auto-refresh status/log berupa polling 4 detik, bukan streaming log real-time.
- **Rendah:** `sitesApply` mengganti seluruh set situs; UI mengirim set lengkap.
- **Rendah:** progress event hanya membawa stage terbatas; teks stage ditampilkan sebagai identifier teknis.

## DEPENDENSI

- PLATFORM: integrasi hosts/trust store untuk HTTPS `.test` setelah privilege flow diuji.
- RUNTIME/DATABASE: pola installer/worker yang sama, masing-masing dengan pin vendor dan bukti platform.
- PACKAGING: notice Electron/Chromium, SBOM final, installer Windows/Linux.
- MCP: perlu transport dan otorisasi; bridge saat ini hanya untuk renderer.

## LANGKAH BERIKUT

1. Integrasikan PLATFORM (`6c8ae1c`) dan jalankan seluruh suite.
2. Tambahkan hosts manager ke alur situs dengan persetujuan elevasi eksplisit, lalu trust CA lokal untuk HTTPS.
3. Tambahkan modul Nginx dengan strategi vendor Linux yang sah (paket distro/kompilasi) dan bukti uji.
4. Tambahkan runtime Node/PHP/Python dan database prioritas.
5. Bungkus installer Linux/Windows beserta notice dan checksum.
