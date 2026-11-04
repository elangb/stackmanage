# Laporan WEB-SERVERS — Fase 4 (Nginx)

## AGEN

WEB-SERVERS, branch `agent/nginx`, worktree
`/tmp/opencode/stackmanage-nginx`. Baseline `3632737` (Fase 3). Tidak ada
subagent. Perubahan hanya di `stackmanage/`; perilaku Caddy, hosts/TLS, dan
runtime Node yang sudah ada tidak diubah.

## FASE

4 — server web Nginx stable 1.30.6 dengan build dari sumber resmi, siklus
layanan, dan UI.

## STATUS

**Sebagian, terverifikasi Linux x64.** Nginx `1.30.6` berhasil diunduh dari
`nginx.org`, diverifikasi SHA-256 dan tanda tangan `.asc`, dibangun dari sumber
ke prefix per-pengguna tanpa root, dijalankan pada `127.0.0.1:18081`, diuji
**HTTP 200**, di-reload, dihentikan, dan dicopot. Linux arm64 memakai pin sumber
yang sama tetapi **belum dieksekusi**. Windows memakai zip resmi yang dipatok
tetapi eksekusinya **UNVERIFIED/unsupported** pada build ini. Integrasi PHP-FPM
belum ada.

## YANG SELESAI

- Pin dan provenance resmi:
  - sumber `https://nginx.org/download/nginx-1.30.6.tar.gz`,
    SHA-256 `3cf46f5ed7504d460125866b7bea99fb357f31d887e2e63b35503310e9b8b6c8`,
    ukuran 1.331.698 byte, `Last-Modified` 2026-10-02;
  - Windows `https://nginx.org/download/nginx-1.30.6.zip`,
    SHA-256 `c6ee35edb0a861063323f709192ae50d1eefaf2ea7d00678bd2b22d8542dc61e`,
    ukuran 2.773.293 byte, `Last-Modified` 2026-10-05;
  - `nginx.org` tidak menerbitkan sidecar SHA-256. Digest dihitung dari artefak
    resmi pada **2026-11-04**, dicatat sebagai provenance lokal, bukan kutipan
    checksum upstream;
  - tanda tangan terlepas `nginx-1.30.6.tar.gz.asc` dan
    `nginx-1.30.6.zip.asc` diverifikasi dengan kunci penulis Nginx
    (Sergey Kandaurov, fingerprint
    `D6786CE303D9A9022998DC6CC8464D549AF75C0A`, sumber
    `https://nginx.org/keys/pluknet.key`). Kunci publik dipatok dan ditanam di
    modul; `gpg --status-fd` harus melaporkan `VALIDSIG` dengan fingerprint itu.
- Unduhan:
  - HTTPS saja, allowlist **hanya `nginx.org`** pada URL awal dan setiap hop
    redirect, batas redirect/byte/idle, resume `.part`, satu retry terbatas untuk
    kegagalan koneksi sebelum byte diterima, verifikasi SHA-256 sebelum promosi.
- Preflight build Linux:
  - compiler C dan `make` diperiksa;
  - header `pcre2.h` (dengan `PCRE2_CODE_UNIT_WIDTH`), `zlib.h`, dan
    `openssl/ssl.h` diperiksa dengan probe compiler;
  - kekurangan menghasilkan satu error actionable `nginx.dependenciesMissing`
    (mis. `build-essential libpcre2-dev zlib1g-dev libssl-dev`), bukan build
    setengah jadi.
- Build sumber:
  - `configure` memakai prefix final per-pengguna, `--with-http_ssl_module`,
    `--with-http_v2_module`, serta path privat untuk conf/pid/log/temp;
  - `make install DESTDIR=<staging>` sehingga path absolut yang dikompilasi
    tetap valid setelah rename atomik;
  - `nginx -v` harus melaporkan `nginx/1.30.6`, `nginx -t` harus menerima
    konfigurasi staged dan final;
  - staging dibersihkan di `finally`; prefix sebelumnya dipulihkan bila
    promosi/validasi/persistensi gagal; instalasi valid yang sudah ada bersifat
    idempoten.
- Siklus layanan:
  - `start`, `stop`, `reload`, `status`;
  - situs statis default `127.0.0.1:18081`, `daemon off` agar master dimiliki
    worker, `try_files` dan index default;
  - `nginx -t` wajib sebelum start dan sebelum reload; kandidat yang ditolak
    tidak pernah menggantikan konfigurasi live;
  - deteksi port bentrok, readiness probe TCP, log tail terbatas, konfigurasi
    read-only;
  - identitas proses memakai executable + start token OS. Token environment
    Caddy tidak dipakai untuk Nginx karena master Nginx menulis ulang
    environment proses; PID daur ulang tetap ditolak.
  - rekonsiliasi saat worker mulai menghentikan hanya proses yang identitasnya
    terverifikasi; PID yang tidak cocok disimpan sebagai `unknown`.
- Uninstall:
  - hanya record instalasi terkelola; direktori dan binary wajib resolve di
    dalam root instalasi;
  - layanan yang berjalan ditolak (`nginx.serviceRunning`);
  - kegagalan pembersihan record menjadi warning, bukan klaim sukses palsu.
- Bridge/UI:
  - metode worker/bridge/preload/main aditif: `nginx.versions`, `nginx.install`,
    `nginx.status`, `nginx.list`, `nginx.uninstall`, `nginx.start`,
    `nginx.stop`, `nginx.reload`, `nginx.logs`, `nginx.config`;
  - skema Zod ketat; tidak ada URL/digest/flag configure/path/command dari
    pemanggil; tidak ada generic invoke/exec/shell;
  - controller singleton module-local tanpa Pinia, dedupe, progress tervalidasi,
    terminal cleanup, dan listener cleanup;
  - kartu Nginx ringkas di halaman **Web Servers & Sites** tanpa mengubah
    halaman Caddy/Node;
  - lima locale (id/en/zh/es/vi) dengan paritas kunci.
- Shared primitives:
  - proses/identitas/log/port dipindah ke `apps/worker/src/shared/process.ts`;
    modul Caddy melakukan re-export sehingga perilaku Caddy tidak berubah.
  - `checkIdentity` menerima opsi `requireProcToken`; default tetap `true` untuk
    Caddy.

## BUKTI

Mesin: Linux x86_64, Node `v24.21.0`, pnpm `10.32.1`, gcc 15.2.0,
GNU Make 4.4.1, OpenSSL 3.5.5, gpg 2.4.8.

| Perintah | Hasil |
|---|---|
| `pnpm check` | Lulus: typecheck 9/9, lint 0 warning, **29 berkas tes, 240 lulus, 5 dilewati**, legal 548 checks, build 9/9 |
| `pnpm legal:verify` | `LEGAL_VERIFY_OK: 548 checks, 31 production packages, 71 vendor rows, 244 SBOM components` |
| `xvfb-run -a pnpm test:desktop` | `DESKTOP_SMOKE_OK: renderer → sandbox preload → main → fork worker; typed narrow bridge; runtime and Nginx reads; Node globals absent` |
| `STACKMANAGE_INTEGRATION=1 pnpm exec vitest run apps/worker/test/nginx.integration.test.ts` | **Lulus di branch integrasi:** unduh sumber resmi melalui proxy, SHA-256, signature GPG `D6786CE3…C0A` verified, build source, `nginx -v`, `nginx -t`, HTTP 200, reload, stop, uninstall |

Unduhan memakai klien HTTPS native + `https-proxy-agent` karena `fetch` bawaan Node mengabaikan `HTTP(S)_PROXY` di lingkungan ini. Allowlist host, redirect, resume, batas ukuran, dan checksum tetap berlaku.
| `gpg --verify nginx-1.30.6.tar.gz.asc nginx-1.30.6.tar.gz` | `Good signature`, fingerprint `D6786CE303D9A9022998DC6CC8464D549AF75C0A` |
| `gpg --verify nginx-1.30.6.zip.asc nginx-1.30.6.zip` | `Good signature`, fingerprint yang sama |

Detail integrasi nyata:

- Sumber resmi diunduh dari `nginx.org` dan diverifikasi sebelum ekstraksi.
- Build memakai prefix sementara per-operasi, `DESTDIR`, lalu promosi atomik ke
  `<data>/nginx/installations/nginx-1.30.6-linux-x64`.
- Binary melaporkan `nginx version: nginx/1.30.6`.
- Layanan default melayani `GET http://127.0.0.1:18081/` → **HTTP 200** dengan
  isi `StackManage default site`.
- Reload memvalidasi kandidat dengan `nginx -t` lalu mengirim SIGHUP; HTTP 200
  tetap setelah reload.
- Stop menutup listener; uninstall menghapus direktori instalasi dan
  `nginx.status` menjadi `installed=false`.

Tes unit mencakup: pin/checksum, allowlist unduhan, penolakan symlink, ekstraksi
top-level/traversal, konfigurasi loopback dan path tidak aman, preflight,
guard uninstall, serta siklus proses nyata dengan child palsu (start → HTTP 200
→ reload → stop) dan deteksi port bentrok.

## RISIKO/BUG

- **Tinggi:** build Linux memerlukan compiler C, `make`, dan header PCRE2/zlib/
  OpenSSL. Tanpa itu instalasi ditolak dengan pesan actionable; tidak ada
  dependency yang dipasang diam-diam.
- **Tinggi:** Windows x64 zip sudah dipatok dan di-hash, tetapi ekstraksi,
  service lifecycle, dan eksekusi Windows **belum dijalankan**. UI/worker
  melaporkan `unsupported`, bukan sukses.
- **Tinggi:** Linux arm64 memakai sumber yang sama tetapi belum dieksekusi pada
  mesin arm64.
- **Sedang:** verifikasi `.asc` bergantung pada `gpg` dan ketersediaan file
  `.asc`. Bila tidak tersedia, SHA-256 terpatok tetap wajib dan hasil instalasi
  membawa warning `nginx.signatureUnavailable`; tanda tangan yang salah tetap
  menghentikan instalasi.
- **Sedang:** port default tetap `18081`; belum ada pemilihan port/situs dari
  UI atau site manager Nginx.
- **Sedang:** belum ada integrasi PHP-FPM, reverse proxy, TLS lokal, atau hosts
  untuk Nginx. Kartu Nginx hanya mengelola situs statis default.
- **Sedang:** uninstall menghapus direktori instalasi, tetapi konfigurasi/log
  layanan tersisa untuk diagnostik; belum ada pembersihan penuh.
- **Rendah:** build sumber memerlukan waktu dan ruang disk lebih besar daripada
  unduhan binary Caddy/Node.
- **Rendah:** `nginx.logs` hanya membaca error log; access log belum digabung.
- **Rendah:** identitas proses Nginx tidak memakai token environment; keamanan
  bergantung pada executable + start token OS.

## DEPENDENSI

- PLATFORM: verifikasi Windows x64 dan Linux arm64 sebelum mengklaim dukungan.
- PACKAGING: notice Nginx/PCRE2/zlib/OpenSSL dan cleanup saat uninstall aplikasi.
- QA: uji UI nyata pada Windows/arm64 dan skenario tanpa header build.
- WORKFLOW: integrasi PHP-FPM/situs dinamis dan pemilihan port.
- RELEASE: jalankan ulang integrasi Nginx pada mesin target sebelum rilis.

## LANGKAH BERIKUT

1. Jalankan tes integrasi Nginx pada Windows x64 dan Linux arm64; bila Windows
   diimplementasikan, tambahkan ekstraksi zip, service lifecycle, dan bukti
   eksekusi sebelum mengubah status.
2. Tambahkan site manager Nginx (port, root terkelola, reverse proxy/PHP-FPM)
   dengan validasi `nginx -t` yang sama.
3. Tambahkan pilihan port dan konfigurasi lanjutan tanpa membuka path/command
   arbitrer ke renderer.
4. Petakan dependency build ke UI (deteksi header, tautan panduan paket) dan
   dokumentasikan paket per distro.
5. Tambahkan notice/sbom vendor Nginx ke proses packaging.
