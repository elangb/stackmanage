# Laporan PACKAGING-CI/CD — Fase 5 (awal)

## AGEN

PACKAGING, branch `agent/packaging`, baseline `3632737`.

## FASE

5 — artefak Linux pertama dan smoke test paket.

## STATUS

**Sebagian.** Dua artefak `.deb` berhasil dibangun. RPM dan Windows belum dapat dibangun karena toolchain tidak tersedia. Ini belum memenuhi target enam artefak.

## YANG SELESAI

- Konfigurasi electron-builder orisinal:
  - Electron dipatok 45.2.2;
  - appId, productName, kategori, dependency Debian;
  - memuat `dist` main/preload/worker/renderer;
  - menyertakan `THIRD_PARTY_NOTICES.md`.
- Ikon aplikasi 512×512 orisinal (bukan aset legacy).
- Script `dist:linux:deb:x64`, `dist:linux:deb:arm64`, `dist:linux:rpm`.
- Paket x64 diekstrak dan binary terpaket menjalankan smoke test penuh.
- `release/` diabaikan dari git agar artefak besar tidak masuk repositori.

## BUKTI

| Perintah | Hasil |
|---|---|
| `pnpm dist:linux:deb:x64` | `release/StackManage-0.1.0-amd64.deb` (~101 MB) |
| `pnpm dist:linux:deb:arm64` | `release/StackManage-0.1.0-arm64.deb` (~96 MB) |
| `dpkg-deb -x … && STACKMANAGE_SMOKE=1 ./@stackmanagedesktop` | `DESKTOP_SMOKE_OK … typed narrow bridge; runtime reads; Node globals absent`, exit 0 |
| `dpkg-deb -I` | metadata Debian valid, dependency GTK/NSS/secret terdaftar |

SHA-256 artefak dibangun pada mesin ini tercatat di laporan kerja (bukan jaminan reproducible karena build belum hermetik).

## RISIKO/BUG

- **Tinggi:** RPM belum dibuat; `rpmbuild` hilang.
- **Tinggi:** Windows NSIS/portable belum dibuat; tidak ada Windows/Wine.
- **Sedang:** `asar` dimatikan; perlu desain `asarUnpack` untuk worker.
- **Sedang:** notice Electron/Chromium belum lengkap di paket.
- **Sedang:** lisensi proyek/homepage masih placeholder.
- **Rendah:** arm64 dibangun tetapi belum dijalankan di perangkat arm64.

## DEPENDENSI

- CI runner Windows dan Linux arm64.
- Toolchain `rpmbuild` atau container build.
- Sertifikat code signing dan keputusan lisensi/homepage.

## LANGKAH BERIKUT

1. Build RPM di container/CI dengan `rpmbuild`.
2. Build Windows NSIS/portable di runner Windows (bukan Wine klaim).
3. Aktifkan asar dengan worker unpack yang terverifikasi.
4. Tambahkan smoke test pasang/copot `.deb` nyata di VM bersih.
