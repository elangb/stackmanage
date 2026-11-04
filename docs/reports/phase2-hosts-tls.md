# Laporan WEB-SITES-HTTPS — Fase 2 (hosts + TLS)

## AGEN

WEB-SITES-HTTPS, branch `integration/phase1`. Baseline mencakup Caddy Linux x64 dan adapter PLATFORM.

## FASE

2 — situs lokal, hosts terkelola, HTTPS internal, trust CA.

## STATUS

**Sebagian, terverifikasi Linux x64.** Domain `.test` dapat dipetakan lewat hosts, disajikan dengan TLS internal, dan CA-nya dapat dipercaya di NSS pengguna. Chrome/Firefox/Edge belum diuji melalui UI browser; Windows belum diuji.

## YANG SELESAI

- Caddyfile mendukung `https://…` dengan `tls internal`; bind tetap `127.0.0.1`.
- `auto_https disable_redirects` mencegah Caddy membuka port 80 privileged.
- Hosts terkelola:
  - hanya blok bertanda StackManage yang diubah;
  - baris hosts lain dipertahankan;
  - penulisan atomik, backup, verifikasi read-back;
  - `clear()` menghapus blok tanpa menyentuh baris lain;
  - custom domain yang ditambahkan/dihapus disinkronkan;
  - kegagalan hosts menjadi hasil `partial` + warning, bukan sukses palsu.
- Trust CA:
  - status CA (`exists`, `browserTrust`, `systemTrust`) tanpa membocorkan private key;
  - trust ke `~/.pki/nssdb` dan profil Firefox yang ada via `certutil`;
  - operasi terpisah dan eksplisit dari UI;
  - platform non-Linux melaporkan `unsupported`, bukan sukses.
- UI: checkbox HTTPS, status CA, tombol trust, dan perbaikan payload controller (Vue proxy dinormalisasi ke JSON sebelum melewati `contextBridge`).
- Tes: render TLS, clear hosts, certutil pada NSS terisolasi, integrasi HTTPS nyata + hosts + trust.

## BUKTI

| Perintah | Hasil |
|---|---|
| `pnpm check` | 22 berkas, **196 lulus**, 2 dilewati; build 9/9; legal 548 checks |
| `STACKMANAGE_INTEGRATION=1 vitest run apps/worker/test/caddy-tls.integration.test.ts` | Lulus: custom `.test` + alias, hosts berisi entri, HTTPS 200 dengan CA, trust NSS `trusted`, hosts dibersihkan saat situs dihapus |
| `pnpm exec vitest run apps/worker/test/certificates.test.ts` | 3 lulus: untrusted → trusted, platform lain unsupported, CA hilang gagal jujur |
| Electron UI nyata | Tambah situs TLS `localhost:18443`; Caddy HTTPS melayani 200 dengan CA; UI menampilkan status CA; tidak ada console error |
| `STACKMANAGE_BROWSER_E2E=1 pnpm exec vitest run apps/worker/test/caddy-browser.integration.test.ts` | **Chrome 157 nyata** membuka `https://shop.test` dengan CA internal, profil/NSS/HOME terisolasi, tanpa `--ignore-certificate-errors`; DOM berisi `browser-tls-ok` |

## RISIKO/BUG

- **Tinggi:** trust system store tidak diubah; `curl` tanpa CA masih menolak. Hanya NSS pengguna yang ditangani.
- **Sedang:** Chrome sudah lulus acceptance nyata. Firefox dan Edge belum dijalankan; Edge target final tetap Windows.
- **Tinggi:** Windows trust/hosts hanya rencana; belum dieksekusi.
- **Sedang:** hosts pada `/etc/hosts` memerlukan pkexec; tanpa prompt, domain tetap tidak resolve (hasil partial).
- **Sedang:** Firefox profile yang dibuat setelah trust belum otomatis mendapat CA.
- **Rendah:** sertifikat belum memiliki operasi renew/rotate eksplisit.

## DEPENDENSI

- PLATFORM: helper Windows trust/hosts teruji.
- QA: jalankan Chrome, Firefox, Edge terhadap `https://x.test` di Linux dan Windows.
- PACKAGING: sertakan CA lifecycle/cleanup saat uninstall.

## LANGKAH BERIKUT

1. Uji browser nyata di Linux dan Windows; tambahkan bukti screenshot/HTTP.
2. Implementasikan trust system store dengan helper terpisah dan consent.
3. Lanjut ke Nginx dengan strategi paket resmi Linux/Windows, lalu runtime Node/PHP.
