# Laporan SYSTEM-TRUST — Fase 10 (helper)

## AGEN

PLATFORM / SYSTEM-TRUST, branch `integration/phase1`.

## FASE

10 — helper trust store sistem Linux.

## STATUS

**Sebagian.** Helper, plan, status, test, dan status read-only di Caddy selesai. Eksekusi polkit nyata dan tombol UI belum.

## YANG SELESAI

- `LinuxSystemTrust` di `packages/platform`:
  - status read-only terhadap CA bundle;
  - helper `pkexec` dengan argv terpisah;
  - staged helper, target path dan nama file tervalidasi;
  - install/remove dengan status hasil jujur;
  - tidak memakai `sudo` implisit, tidak menerima shell string dari pemanggil.
- `CaddyCertificates.status()` melaporkan `systemTrust` nyata, bukan placeholder.
- Tes in-memory/fake runner untuk trusted/missing/installed/no-elevation.
- Dokumentasi `docs/system-trust.md`.

## BUKTI

| Perintah | Hasil |
|---|---|
| `pnpm exec vitest run packages/platform/test/system-trust.test.ts` | 4 lulus |
| `pnpm --filter @stackmanage/worker typecheck` | lulus |
| `pnpm check` | lihat laporan integrasi; tidak ada akses root nyata |

## RISIKO/BUG

- **Tinggi:** `pkexec` nyata, prompt polkit, dan `update-ca-certificates` belum dieksekusi di VM.
- **Tinggi:** tombol UI untuk system trust belum ada; user-scoped NSS tetap jalur default.
- **Sedang:** bundle path Debian/Ubuntu; RPM/Arch memerlukan adapter trust yang sudah direncanakan platform.
- **Sedang:** remove belum diuji dengan root nyata.

## LANGKAH BERIKUT

1. Tambahkan aksi UI eksplisit + konfirmasi.
2. Uji di VM Linux disposable dengan polkit.
3. Tambahkan adapter Fedora/Arch dan cleanup uninstall.
