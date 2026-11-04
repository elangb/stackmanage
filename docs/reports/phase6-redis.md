# Laporan DATABASE-MODULES — Fase 6 (Redis)

## AGEN

DATABASE-MODULES, branch `agent/redis`, worktree
`/tmp/opencode/stackmanage-redis`. Baseline `630e4e5` (integrasi Fase 5).
Tidak ada subagent. Perubahan hanya di `stackmanage/`; perilaku Caddy, Nginx,
runtime Node, hosts/TLS, dan downloader HTTPS proxy-aware bersama tidak diubah.

## FASE

6 — database Redis 7.2.7 (BSD-3-Clause) dengan build dari sumber resmi, siklus
layanan loopback, halaman **Databases**, dan bukti integrasi Linux x64.

## STATUS

**Sebagian, terverifikasi Linux x64.** Redis `7.2.7` diunduh dari
`download.redis.io`, diverifikasi SHA-256, dibangun dari sumber resmi ke prefix
per-pengguna tanpa root, dijalankan pada `127.0.0.1:16379`, diuji
**`redis-cli ping` = `PONG`**, **SET/GET** melalui `redis-cli` terkelola,
dihentikan, dan dicopot. Linux arm64 memakai pin sumber yang sama tetapi
**belum dieksekusi**. Windows **unsupported**: Redis upstream tidak menerbitkan
build native Windows resmi dan tidak ada fork tidak resmi yang dipakai.
Autentikasi/ACL, replikasi, cluster, TLS, dan tuning persistensi **belum ada**.

## YANG SELESAI

- Pin dan provenance resmi:
  - sumber `https://download.redis.io/releases/redis-7.2.7.tar.gz`,
    SHA-256 `72c081e3b8cfae7144273d26d76736f08319000af46c01515cad5d29765cead5`,
    ukuran 3.394.075 byte;
  - digest dihitung dari artefak resmi pada **2026-11-04**; Redis tidak
    menerbitkan sidecar SHA-256 untuk tarball rilis, sehingga provenance dicatat
    eksplisit sebagai hash lokal, bukan kutipan checksum upstream;
  - lisensi **BSD-3-Clause**, bukti
    `https://github.com/redis/redis/blob/7.2.7/COPYING`. Pin 7.2.7 dipilih karena
    Redis 7.4 beralih ke RSALv2/SSPLv1 dan Redis 8 menambahkan opsi AGPLv3.
- Unduhan:
  - HTTPS saja dengan allowlist **hanya `download.redis.io`** pada URL awal dan
    setiap hop redirect;
  - batas jumlah redirect, ukuran total, dan idle; resume `.part`; satu retry
    terbatas untuk kegagalan koneksi sebelum byte diterima;
  - SHA-256 wajib cocok sebelum ekstraksi; symlink di path tujuan ditolak.
- Preflight build Linux:
  - `cc` dan `make` diperiksa sebelum unduhan/build;
  - kekurangan menghasilkan satu error actionable `redis.dependenciesMissing`
    (mis. `build-essential`), bukan build setengah jadi.
- Build sumber:
  - ekstraksi aman mempertahankan direktori top-level `redis-7.2.7`; path
    absolut, traversal, entry di luar top-level, symlink, dan special file
    ditolak; `Makefile` dan `src/Makefile` wajib ada;
  - `make -j… redis-server redis-cli BUILD_TLS=no` dijalankan dari source tree;
    hanya `redis-server` dan `redis-cli` yang disalin ke prefix staging
    (`bin/`), bukan seluruh hasil `make install`;
  - bila build default gagal, satu retry memakai `MALLOC=libc`; build yang
    berhasil dicatat sebagai `malloc=libc` pada versi binary;
  - `redis-server --version` harus mengandung `v=7.2.7` dan
    `redis-cli --version` harus `redis-cli 7.2.7` sebelum promosi;
  - promosi atomik dengan backup/rollback; instalasi valid yang sudah ada
    bersifat idempoten; staging dibersihkan di `finally`; kegagalan build
    menyimpan `build.log` terbatas.
- Siklus layanan:
  - `start`, `stop`, `status`;
  - konfigurasi privat dirender ulang setiap start:
    `bind 127.0.0.1`, `protected-mode yes`, `port 16379`, `daemonize no`,
    `save ""`, `appendonly no`, `maxmemory 67108864`,
    `maxmemory-policy noeviction`, serta path privat untuk data, log, dan PID;
  - worker memiliki child process (tidak daemonize); readiness hanya jika
    `redis-cli -h 127.0.0.1 -p 16379 ping` mengembalikan **PONG**;
  - deteksi port bentrok, readiness timeout, cleanup child saat gagal start,
    log tail terbatas, dan status PID/port;
  - identitas proses memakai executable + start token OS; PID daur ulang
    ditolak. Rekonsiliasi saat worker mulai menghentikan hanya proses yang
    terverifikasi;
  - stop melaporkan `unknown` bila penghentian tidak dapat dikonfirmasi, bukan
    sukses palsu.
- Uninstall:
  - hanya record instalasi terkelola; direktori, `redis-server`, dan
    `redis-cli` wajib resolve di dalam root instalasi;
  - layanan yang berjalan atau `unknown` dengan PID ditolak
    (`redis.serviceRunning`);
  - kegagalan pembersihan record menjadi warning.
- Bridge/UI:
  - metode worker/bridge/preload/main aditif:
    `redis.versions`, `redis.install`, `redis.status`, `redis.list`,
    `redis.uninstall`, `redis.start`, `redis.stop`, `redis.logs`;
  - skema Zod ketat; tidak ada URL/digest/build flag/port/path/command dari
    pemanggil; tidak ada generic invoke/exec/shell;
  - controller singleton module-local tanpa Pinia: dedupe, progress tervalidasi,
    terminal cleanup, listener cleanup;
  - halaman **Databases** dengan kartu Redis: install/start/stop/uninstall,
    status/PID/endpoint/versi, bukti eksekusi, dan log;
  - lima locale (id/en/zh/es/vi) dengan paritas kunci, termasuk label bukti dan
    pesan error.
- Legal/dokumentasi:
  - `THIRD_PARTY_NOTICES.md` menambahkan bagian Redis 7.2.7 BSD-3-Clause,
    sumber, SHA-256, dan bukti lisensi;
  - `docs/legal/vendor-catalog.tsv` mencatat pin 7.2.7 dan peringatan 7.4+;
  - `docs/legal/license-analysis.md` menambahkan catatan Redis dan SBOM;
  - `docs/contracts-v1.md`, `docs/operation-plan.md`, `docs/feature-matrix.md`,
    dan `README.md` diperbarui untuk permukaan `redis.*` dan batas kemampuannya.

## BUKTI

Mesin: Linux x86_64, Node `v24.21.0`, pnpm `10.32.1`, gcc 15.2.0,
GNU Make 4.4.1.

| Perintah | Hasil |
|---|---|
| `pnpm check` | Lulus: typecheck 9/9, lint 0 warning, **32 berkas tes, 261 lulus, 6 dilewati**, legal 523 checks, build 9/9 |
| `pnpm legal:verify` | `LEGAL_VERIFY_OK: 523 checks, 55 production packages, 64 vendor rows, 244 SBOM components` |
| `xvfb-run -a pnpm test:desktop` | `DESKTOP_SMOKE_OK: renderer → sandbox preload → main → fork worker; typed narrow bridge; runtime, Nginx and Redis reads; Node globals absent` |
| `STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/redis.integration.test.ts --reporter=verbose` | **Lulus**: unduh sumber resmi melalui jalur proxy-aware, SHA-256, build sumber, PING/PONG, SET/GET, stop, uninstall; 70,18 detik |

Detail integrasi nyata:

- Artefak resmi diunduh dari `download.redis.io`, diverifikasi
  `72c081e3…cead5` sebelum ekstraksi.
- Build memakai `make`, menghasilkan
  `Redis server v=7.2.7 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=6a7acd940db1ee6f`
  dan `redis-cli 7.2.7`. Karena build default (jemalloc) berhasil, fallback
  `MALLOC=libc` tidak diperlukan pada run ini.
- Prefix instalasi per-operasi dipromosikan ke
  `<data>/redis/installations/redis-7.2.7-linux-x64`.
- Layanan default melayani `redis-cli -h 127.0.0.1 -p 16379 ping` → **PONG**.
- `SET stackmanage:phase6 ok` → **OK**; `GET stackmanage:phase6` → **ok**.
- `redis.log` berisi output server; `redis.logs` mengembalikan tail terbatas.
- Stop menutup proses; `redis.status` menjadi `stopped`; uninstall menghapus
  direktori instalasi dan `redis.status.installed` menjadi `false`.

Tes unit mencakup: pin/checksum/lisensi, allowlist unduhan, penolakan symlink,
ekstraksi top-level/traversal, konfigurasi loopback/protected-mode/maxmemory dan
penolakan path tidak aman, preflight, guard uninstall, promosi/idempotensi
installer, siklus proses nyata dengan child palsu (start → PING → status → stop),
deteksi port bentrok, serta penolakan uninstall saat berjalan. No network in
default tests.

## RISIKO/BUG

- **Tinggi:** build Linux memerlukan compiler C dan `make`. Tanpa itu instalasi
  ditolak dengan pesan actionable; tidak ada dependency yang dipasang diam-diam.
- **Tinggi:** Windows **tidak didukung**. Redis upstream tidak menyediakan build
  native Windows resmi; UI/worker melaporkan `unsupported`, bukan sukses, dan
  tidak memakai fork tidak resmi.
- **Tinggi:** Linux arm64 memakai sumber yang sama tetapi belum dieksekusi pada
  mesin arm64.
- **Tinggi:** belum ada autentikasi/ACL atau TLS. Instans hanya aman untuk
  loopback lokal pada mesin pengguna; jangan mengubah bind menjadi non-loopback
  tanpa menambahkan kontrol akses.
- **Sedang:** persistensi dinonaktifkan (`save ""`, `appendonly no`); data
  hilang saat proses berhenti. Ini disengaja untuk menghindari tulisan disk tak
  terbatas pada fase awal, bukan jaminan durabilitas.
- **Sedang:** batas memori tetap 64 MiB dan kebijakan `noeviction`; belum ada
  pengaturan dari UI.
- **Sedang:** port tetap `16379`; belum ada pemilihan port/instance ganda.
- **Sedang:** replikasi, sentinel, cluster, dan database panel (Redis Commander)
  belum ada.
- **Sedang:** uninstall menghapus direktori instalasi, tetapi konfigurasi, data,
  dan log layanan tersisa untuk diagnostik; belum ada pembersihan penuh.
- **Rendah:** bila record proses masih hidup tetapi tidak menjawab PING, `start`
  menolak dengan konflik (bukan mengklaim siap); hentikan instance terlebih
  dahulu. Ini mencegah dua proses memperebutkan port yang sama.
- **Rendah:** `redis.logs` membaca `redis.log`; stdout/stderr terpisah
  (`stdout.log`, `stderr.log`) belum digabung ke view.
- **Rendah:** identitas proses tidak memakai token environment; keamanan
  bergantung pada executable + start token OS.
- **Rendah:** fallback `MALLOC=libc` hanya diuji secara logika; run integrasi
  memakai jemalloc bawaan.

## DEPENDENSI

- PLATFORM: verifikasi Linux arm64 dan putuskan dukungan Windows secara eksplisit
  (tanpa fork tidak resmi).
- PACKAGING: notice Redis `COPYING`/BSD-3-Clause, sumber, SHA-256, dan cleanup
  data aplikasi saat uninstall.
- QA: uji UI nyata pada mesin target dan skenario tanpa compiler/make.
- SECURITY: review auth/ACL, TLS, dan bind sebelum ada permintaan akses non-local.
- WORKFLOW: integrasi database panel, koneksi klien, dan pemilihan port.
- RELEASE: jalankan ulang integrasi Redis pada mesin target sebelum rilis.

## LANGKAH BERIKUT

1. Jalankan tes integrasi pada Linux arm64; jangan klaim dukungan sebelum ada
   eksekusi nyata.
2. Tambahkan kontrol auth/ACL dan TLS bila Redis akan dipakai di luar loopback,
   dengan secret redaction dan tanpa mengekspos path/kunci ke renderer.
3. Tambahkan pilihan port/instance dan batas memori yang tetap tervalidasi,
   tanpa membuka command/path arbitrer.
4. Tambahkan panel database (mis. Redis Commander) melalui lifecycle companion
   yang memiliki parent shutdown dan penanganan kredensial.
5. Putuskan kebijakan persistensi (RDB/AOF) dan dokumentasikan trade-off
   durabilitas versus pertumbuhan disk.
6. Bawa provenance Redis 7.2.7 ke SBOM rilis final saat binary vendor mulai
   didistribusikan; sampai saat itu modul tetap download-on-demand.
