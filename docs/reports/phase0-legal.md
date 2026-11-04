# Laporan LEGAL-LICENSE — Fase 0

## AGEN

LEGAL-LICENSE, branch `agent/legal-license`. Baseline `d196a79` (menyatukan ARCHITECT `36f69d1`). Semua perubahan di `stackmanage/`.

## FASE

0 — gate lisensi dan provenance.

## STATUS

**Selesai untuk lingkup fondasi, parsial untuk produk penuh.** Fondasi orisinal lolos dengan syarat; modul vendor belum boleh dirilis sampai review per versi/edisi.

## YANG SELESAI

1. Memverifikasi lisensi upstream dari teks `LICENSE` aktual di master dan tag `v4.20.2` (commit `7507ccd…`), keduanya **BSD 3-Clause** dan identik byte-per-byte (SHA-256 `01d77fe9…`). Ringkasan “MIT” di `AGENTS.md` legacy dikoreksi sebagai tidak akurat.
2. Menetapkan kebijakan implementasi bersih: tidak menyalin kode/aset/logo/teks/sistem lisensi FlyEnv; atribusi referensi tetap dicantumkan.
3. Membuat katalog 71 entri vendor dengan status `version-dependent`, `terms-review`, atau `identity-unknown`. Tidak ada persetujuan menyeluruh untuk vendor proprietary/source-available.
4. Menyusun `THIRD_PARTY_NOTICES.md`, analisis lisensi, inventaris 31 dependensi produksi, dan SBOM CycloneDX 1.7 (244 komponen, 254 relasi).
5. Menambahkan pemeriksa otomatis `pnpm legal:verify` (548 assertion): digest lisensi, integritas katalog, lisensi produksi permisif, struktur SBOM tanpa path absolut, tidak ada aset legacy byte-identik, tidak ada merek legacy di kode aplikasi, dan notice wajib.

## BUKTI

| Perintah | Hasil |
|---|---|
| `node scripts/verify-legal.mjs` | `LEGAL_VERIFY_OK: 548 checks, 31 production packages, 71 vendor rows, 244 SBOM components` |
| `sha256sum LICENSE` vs `git show v4.20.2:LICENSE` | identik `01d77fe9ffb39b0a9507ca8d1cae189f56efd625078c3b13b59ce7aae42a4f7d` |
| `pnpm licenses list --json --prod` | 31 paket: MIT 27, BSD-2 1, BSD-3 1, ISC 1, Apache-2.0 1 |

## RISIKO/BUG

- **Sedang:** 76 komponen SBOM tidak memuat field lisensi; bukan bukti bebas lisensi, hanya celah metadata cdxgen. Harus dilengkapi sebelum rilis.
- **Sedang:** notice Electron/Chromium belum dibundel karena installer belum ada.
- **Tinggi:** SQL Server, Dameng, Claude Code, Copilot, Antigravity proprietary; Numa, DNS/FTP, Hermes, OpenClaw, Kimi, CLIProxyAPI belum teridentifikasi vendor. Semua diblokir dari bundling.
- **Tinggi:** Redis 7.4+, MongoDB, Elasticsearch, Consul, MinIO, n8n memerlukan keputusan versi/lisensi eksplisit.
- Dokumen bukan nasihat hukum final; redistribusi komersial memerlukan review penasihat hukum.

## DEPENDENSI

- PACKAGING: sertakan notice dependensi produksi + Electron/Chromium dan SBOM final.
- Modul vendor: pin versi/edisi, URL resmi, digest; perbarui katalog/notice/SBOM.
- Pemilik produk: konfirmasi model lisensi (default unlimited) dan apakah binary vendor boleh dibundel atau hanya diunduh pengguna.

## LANGKAH BERIKUT

1. Tambahkan generator notice otomatis dari lockfile ke pipeline rilis.
2. Review hukum per vendor saat modul diaktifkan.
3. Regenerasi SBOM dari artefak final, bukan hanya lockfile.
