# Analisis lisensi dan batas penggunaan ulang

Status: gate Fase 0 untuk fondasi orisinal. Tanggal riset: 2026-11-04. Dokumen ini bukan nasihat hukum; keputusan komersial/redistribusi final memerlukan peninjauan penasihat hukum.

## 1. Referensi FlyEnv

Sumber yang diperiksa:

| Sumber | Identitas | Temuan |
|---|---|---|
| `https://github.com/xpf0000/FlyEnv` | README dan metadata repositori | Menyatakan **BSD 3-Clause**; versi rilis terbaru yang disebut README adalah v4.20.2 |
| `https://raw.githubusercontent.com/xpf0000/FlyEnv/master/LICENSE` | Teks lisensi master | BSD 3-Clause, copyright 2023 Pengfei Xu |
| Tag `v4.20.2` pada checkout lokal | Commit `7507ccd77ee986dbec7a76b6ab26800eb5ac3569` | `LICENSE` identik byte-per-byte dengan master; SHA-256 `01d77fe9ffb39b0a9507ca8d1cae189f56efd625078c3b13b59ce7aae42a4f7d` |
| `AGENTS.md` legacy | Panduan proyek lama | Menulis “License: MIT”. **Bertentangan** dengan `LICENSE` dan metadata GitHub; `LICENSE` adalah otoritas hukum, bukan ringkasan AGENTS |

### Yang BSD 3-Clause izinkan bila kode disalin

Redistribution source/binary diperbolehkan dengan syarat: mempertahankan copyright notice, daftar kondisi dan disclaimer; mereproduksi notice pada distribusi binary; dan **tidak** memakai nama copyright holder/contributor untuk endorsement tanpa izin tertulis. BSD tidak mewajibkan membuka source turunan.

### Keputusan proyek

Meskipun penyalinan kode dimungkinkan secara lisensi, proyek ini memilih **implementasi bersih tanpa menyalin kode FlyEnv**. Alasan: paritas perilaku lintas 18 domain lebih mudah diaudit dengan kontrak sendiri; menghindari membawa utang arsitektur; dan memisahkan identitas merek. Tidak ada kode, aset, ikon, logo, teks marketing, screenshot, atau sistem lisensi FlyEnv yang disalin ke `stackmanage/`.

Atribusi FlyEnv tetap dicantumkan sebagai **referensi riset fitur**, bukan sebagai komponen runtime. Jika kelak ada potongan kode FlyEnv yang ingin dipakai ulang, wajib: (a) persetujuan pemilik, (b) catat file/commit asal, (c) bawa copyright notice BSD, (d) perbarui `THIRD_PARTY_NOTICES`, dan (e) review ulang dokumen ini.

### Merek dan aset

Nama “FlyEnv”, logo, ikon aplikasi, screenshot, dan teks pemasaran **tidak boleh** dipakai untuk produk ini. Nama kerja produk adalah **StackManage**. Logo/ikon StackManage harus dibuat orisinal. Logo vendor pihak ketiga (PHP, MySQL, Nginx, dsb.) hanya untuk identifikasi nominal dan tunduk pada pedoman merek masing-masing; jangan mengunduh aset logo dari CDN FlyEnv.

### Sistem lisensi Pro

Prompt melarang meniru atau menembus validasi lisensi FlyEnv. Implementasi StackManage memakai kebijakan **unlimited** pada Fase 0 dan tidak memiliki aktivasi, kunci, atau pembatasan buatan. Jika monetisasi ditambahkan kelak, skema harus orisinal, diumumkan, dan tidak mengambil kode/endpoint lisensi FlyEnv.

## 2. Dependensi npm yang benar-benar dikirim

Dihasilkan dari lockfile yang dipasang dengan `pnpm install --frozen-lockfile`. Cakupan produksi dihitung dengan `pnpm licenses list --json --prod`.

| Lisensi | Jumlah paket | Paket |
|---|---:|---|
| MIT | 43 | Babel helper/parser/types, Vue compiler/runtime, `@intlify/*`, `csstype`, `estree-walker`, `magic-string`, `nanoid`, `postcss`, `vue`, `vue-i18n`, `zod`, dll. |
| BSD-2-Clause | 2 | `entities` |
| BSD-3-Clause | 1 | `source-map-js` |
| ISC | 4 | `picocolors` |
| Apache-2.0 | 1 | `typescript` |
| BlueOak-1.0.0 | 4 | transitive permissive packages |

Total 55 paket produksi setelah penambahan klien proxy: MIT 43, ISC 4, BlueOak-1.0.0 4, BSD-2 2, BSD-3 1, Apache-2.0 1. Tidak ada dependensi produksi dengan lisensi copyleft kuat, SSPL, atau lisensi proprietary. Ini hanya observasi inventaris, bukan jaminan kepatuhan; notice setiap paket harus ikut dalam paket distribusi saat `electron-builder` diimplementasikan. Dependensi pengembangan (`eslint`, `vitest`, `turbo`, `electron`, `vite`, dsb.) tidak dikirim ke pengguna, tetapi tetap dicatat di SBOM.

**Electron** memiliki lisensi MIT untuk framework, namun distribusi binary Electron membawa komponen pihak ketiga (Chromium, Node.js, ffmpeg, dsb.) dengan notice sendiri. Saat packaging, seluruh `LICENSES.chromium.html`/notice Electron wajib disertakan. Ini belum dilakukan pada Fase 0 karena belum ada installer.

## 3. Binary vendor yang direncanakan

Tabel lengkap ada di [`vendor-catalog.tsv`](vendor-catalog.tsv). Ringkasan keputusan:

| Kategori | Contoh | Status |
|---|---|---|
| Permisif/Apache/BSD | PostgreSQL, Qdrant, ClickHouse, etcd, Caddy, Apache HTTP Server, Gradle, RabbitMQ (MPL), Kafka | **Conditional** — boleh diunduh dari sumber resmi, notice disertakan, versi dipatok dan checksum diverifikasi |
| Copyleft dengan kewajiban source | MySQL/MariaDB (GPL-2.0), Neo4j Community (GPL-3.0), Typesense (GPL-3.0), MinIO (AGPL-3.0), phpMyAdmin (GPL-2.0+) | **Conditional** — redistribusi binary pihak ketiga menimbulkan kewajiban source/notice; keputusan bundling vs unduh-langsung pengguna harus eksplisit per modul |
| Source-available/terbatas | Redis ≥7.4 (RSALv2/SSPLv1), MongoDB (SSPL), Elasticsearch (ELv2/SSPL/AGPL), Consul (BUSL-1.1), n8n (Sustainable Use) | **Review wajib per versi** — jangan menyimpulkan “open source” dari nama proyek |
| Proprietary/EULA | SQL Server, Dameng DM8, Claude Code client, GitHub Copilot, Antigravity | **Tidak boleh dibundel** tanpa izin tertulis; hanya alur unduh/instal oleh pengguna dengan persetujuan EULA mereka |
| Identitas belum pasti | Numa, DNS server, FTP server, Hermes Agent, OpenClaw, Kimi CLI, static HTTP server, CLIProxyAPI | **Diblokir sampai vendor/edisi dipastikan** — jangan mengganti dengan proyek bernama mirip |

Aturan unduhan: hanya dari domain resmi vendor, HTTPS, checksum SHA-256 resmi bila tersedia, verifikasi signature bila vendor menyediakannya. Mirror hanya boleh dikonfigurasi pengguna dan tetap diverifikasi checksum. Setiap penambahan versi vendor memperbarui `vendor-catalog.tsv`, `THIRD_PARTY_NOTICES`, dan SBOM.

## 4. SBOM

`sbom.cdx.json` adalah CycloneDX 1.7 yang dihasilkan `@cyclonedx/cdxgen` 12.9.0 dari `pnpm-lock.yaml`, berisi 244 komponen dan 254 relasi dependensi. Karakteristik yang perlu diketahui:

- `metadata.timestamp`: 2026-11-04T08:57:58Z.
- Komponen `development: true` menandai dependensi build/dev.
- 76 komponen tidak memiliki field `licenses` (mayoritas binary opsional per-platform seperti `esbuild`/`lightningcss`/`turbo` dan paket yang metadata lisensinya tidak terbaca cdxgen). **Tidak adanya field bukan berarti tanpa lisensi**; itu celah inventaris.
- Beberapa properti `LocalNodeModulesPath` memuat path absolut mesin pembuat. Sebelum publikasi, path absolut harus dihapus/dinormalisasi. Untuk Fase 0 artefak disimpan sebagai bukti internal dengan path dinormalisasi menjadi `<workspace>`.

SBOM ini mencakup dependensi build, **bukan** binary vendor runtime yang belum diunduh. SBOM rilis final harus dibuat dari artefak terpasang dan memuat komponen vendor.

## 5. Checklist kepatuhan Fase 0

- [x] Lisensi upstream diverifikasi dari teks resmi dan tag rilis, bukan dari ringkasan AGENTS.
- [x] Tidak ada source/aset/merek FlyEnv di `stackmanage/` (dicek dengan pencarian teks dan daftar file aset).
- [x] Tidak ada impor kode legacy; workspace terpisah.
- [x] Kebijakan produk unlimited, tanpa aktivasi lisensi tiruan.
- [x] Inventaris lisensi dependensi produksi dan SBOM tersedia.
- [x] Katalog vendor menandai versi/edisi yang belum pasti sebagai `identity-unknown`/`terms-review`.
- [ ] Notice dependensi produksi dimasukkan ke paket installer — menunggu agen packaging.
- [ ] EULA SQL Server/Dameng/Claude/Copilot diuji alurnya — menunggu modul terkait.
- [ ] SBOM rilis dari artefak final plus komponen vendor — menunggu rilis.

## 6. Kesimpulan gate

Fondasi Fase 0 **lolos** gate legal bersyarat: kode orisinal, tidak ada aset FlyEnv, lisensi upstream terdokumentasi, dependensi produksi permisif, dan tidak ada binary vendor yang didistribusikan. Gate produk penuh **belum lolos**: setiap modul vendor memerlukan keputusan redistribusi per versi, dan installer wajib membawa notice. Modul berstatus `terms-review`, `identity-unknown`, atau proprietary tetap diblokir dari bundling sampai review spesifik selesai.
