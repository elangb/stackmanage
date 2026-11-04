# Laporan PLATFORM — Fase 1

## AGEN

PLATFORM (adapter platform Linux + Windows). Branch `agent/platform`, worktree `/tmp/opencode/stackmanage-platform`. Baseline bersama `0eb7274` (`integration/phase1`). Semua perubahan terlacak berada di `stackmanage/packages/platform/**`, `stackmanage/docs/platform-adapters.md`, `stackmanage/docs/platform-release.md`, dan `stackmanage/ci/platform.yml`. Nested app `stackmanage/` tidak diubah strukturnya; `apps/desktop`, `packages/i18n`, kontrak `packages/core` (frozen) dan `docs/reports/phase1-core.md` tidak disentuh. Tidak ada subagent.

## FASE

1 — adapter platform: deteksi OS/arch, root data, hosts (managed block), trust store, port bind, autostart, shell hook, process-tree kill, health/port probe, matriks kapabilitas. Privilese tetap **terencana, tidak dieksekusi** di luar stub berjalan sebagai user biasa.

## STATUS

Implementasi Linux berjalan dan teruji **unprivileged**. Windows **hanya perencanaan dan UNVERIFIED**. **Penerimaan produk keseluruhan dan penerimaan platform belum selesai**; laporan ini bukan klaim acceptance.

## YANG SELESAI

- `detect.ts`: klasifikasi `linux`/`win32` + `x64`/`arm64`; `darwin` dilaporkan unsupported (bukan ditebak), arch di luar kontrak ditolak.
- `paths.ts`: root data independen workspace. Prioritas: `STACKMANAGE_HOME` (portable) → `STACKMANAGE_DATA_HOME`/`STACKMANAGE_CACHE_HOME` (override) → OS default (`LOCALAPPDATA`/`APPDATA` dengan fallback `USERPROFILE`; `XDG_DATA_HOME`/`XDG_CONFIG_HOME` dengan fallback `HOME`). Faktor hilang dilaporkan eksplisit, tidak dikarang.
- `hosts-block.ts`: parser blok marker eksak; marker ganda/tidak berpasangan/terbalik = malformed (ditolak, bukan diperbaiki). Validasi entri per item (IPv4 + IPv6 struktural, hostname lewat skema frozen), `localhost` ditolak. Render/merge deterministik dan idempoten (tidak menulis jika tidak berubah). Dukungan CRLF.
- `scripts.ts`: helper POSIX `sh` dan PowerShell dihasilkan deterministik (SHA-256, nama file turunan digest). Encoding PowerShell `-EncodedCommand` (UTF-16LE→base64) dengan literal single-quote; `'` digandakan. Path Windows wajib absolut (drive/UNC), tanpa NUL/CR/LF.
- `hosts-linux.ts`: `LinuxHostsManager`. Jalur tulis langsung: backup bertimestamp, temp+fsync+rename via `writeFileAtomic`, verifikasi baca-ulang. Tanpa izin tulis: pakai `pkexec` hanya bila ada; helper di-stage, argv terpisah (`/bin/sh <script> <hosts> <block> <backup>`), exit code helper dipetakan ke alasan, timeout → `failed` dengan status file **unknown**. Verifikasi pasca-tulis: exit 0 tanpa perubahan nyata = gagal.
- `hosts-windows.ts`: `WindowsHostsManager`. Hanya **plan**: `-EncodedCommand`, blok + backup di-stage sebagai konten rencana, `privilege: 'unverified'`, `execution: 'unverified'`. `apply` mengembalikan status terminal `unknown` + warning `hosts.windowsExecutionUnverified`. Tidak memanggil runner, tidak menulis file.
- `trust.ts`: deteksi distro dari `/etc/os-release` (debian/rhel/arch/unknown). Debian → `update-ca-certificates`, RHEL → `update-ca-trust extract`, Arch → `trust extract-compat` atau hanya direktori anchor. Command yang tidak ada = **unsupported** dengan alasan. Windows → rencana `certutil -addstore -f Root`, unverified.
- `ports-capability.ts`: risiko port terhadap `ip_unprivileged_port_start`; strategi fallback high-port default; rencana `setcap cap_net_bind_service=+ep` hanya dengan binary absolut + `setcap`; parsing `getcap` ketat. `sudo` tidak pernah dipanggil otomatis.
- `autostart.ts`: XDG desktop entry deterministik + pembuatan/penghapusan di `XDG_CONFIG_HOME`; escaping `Exec` (kutip, `$`, backtick, `%`→`%%`) dengan parser pembalik. Penolakan menimpa/menghapus file milik orang lain berdasarkan penanda milik sendiri. Windows: rencana nilai `HKCU\...\Run` (unverified).
- `shell-hooks.ts`: generator bash/zsh/fish/PowerShell/cmd; escaping per-shell; parser pembalik untuk POSIX/fish; penolakan path relatif, NUL, newline; cmd menolak `%`/`&`/`"` alih-alih menghasilkan output rusak.
- `process-kill.ts`: rencana dua fase grup proses Linux (`-TERM -<pgid>` lalu `-KILL`), builder `taskkill /PID n /T /F`, catatan Job Object. Menolak PID yang tidak dimiliki dan PID berbahaya (≤1 Linux, ≤4 Windows). Tidak mengirim sinyal apa pun.
- `health.ts`: probe TCP loopback nyata (open/closed/timeout terbedakan) dan `OwnedProcess` yang hanya menghentikan child yang ia spawn sendiri.
- `capabilities.ts`: matriks kapabilitas; **tidak ada status `verified` tanpa bukti yang diberikan pemanggil**; Windows seluruhnya `unverified`; trust/elevation/port tanpa command = `unsupported`. `availabilityRows` selalu `unverified`.
- `results.ts`: `buildResult` menurunkan `completed|partial|failed|unknown` dari item dan memvalidasi dengan `OperationResultSchema` frozen; warning suplementer terpisah.
- `composition.ts`: composition root per platform + `CertManager` yang selalu `NOT_IMPLEMENTED` (tidak memalsukan sukses).
- `runner-linux.ts`: runner nyata `shell: false`, batas capture, timeout membunuh **grup proses** (perbaikan bug yang ditemukan tes), abort, pemetaan `missing|permission|timeout|failed|aborted`.

## BUKTI

Mesin aktual: Linux x86_64, kernel `7.1.13-070113-generic`, Ubuntu 26.04.1 LTS (`ID=ubuntu`, `ID_LIKE=debian`), Node `v24.21.0`, pnpm `10.32.1`, uid `1000` (non-root).

Dijalankan dari `/tmp/opencode/stackmanage-platform/stackmanage/`:

| Perintah | Hasil |
|---|---|
| `pnpm install --frozen-lockfile` | Berhasil |
| `TURBO_FORCE=1 pnpm typecheck` | Berhasil, 9/9 paket (0 cached) |
| `pnpm lint` | Berhasil, nol warning (`eslint . --max-warnings 0`) |
| `pnpm test` | Berhasil, 15 berkas / 151 tes (12 tes lama + 139 tes platform) |
| `TURBO_FORCE=1 pnpm build` | Berhasil, 9/9 paket (0 cached); `packages/platform/dist/*.js|.d.ts` dihasilkan |
| `pnpm exec vitest run packages/platform` | Berhasil, 11 berkas / 139 tes |
| `npx tsc -p packages/platform/tsconfig.json --noEmit` | Berhasil |
| `npx eslint packages/platform` | Berhasil |
| `npx esbuild packages/platform/src/index.ts --bundle` + import bundel | Berhasil; `partial`, deteksi `linux/x64`, root `/xdg/StackManage`, rencana Windows `unverified` |

Bukti host nyata (komposisi nyata, tanpa elevasi): `pkexec` ada di `/usr/bin/pkexec`, `sudo` ada di `/usr/bin/sudo` (**tidak dipakai**), `setcap` `/usr/sbin/setcap`, `getcap` `/usr/sbin/getcap`, `update-ca-certificates` `/usr/sbin/update-ca-certificates`; `update-ca-trust` **tidak ada**; `/proc/sys/net/ipv4/ip_unprivileged_port_start = 1024`; `/etc/hosts` **tidak writable** oleh user → adapter benar melaporkan `unavailable` dengan rencana `pkexec` alih-alih menulis. Rencana trust Debian terbentuk: `pkexec /usr/sbin/update-ca-certificates` (`execution: unverified`, tidak dijalankan). Probe loopback nyata: port ephemeral listening → `open` (~2 ms), setelah ditutup → `closed` (`ECONNREFUSED`).

Cakupan tes (139) per berkas: `shell-hooks.test.ts` 24, `hosts.test.ts` 18, `trust.test.ts` 15, `semantics.test.ts` 14, `autostart.test.ts` 13, `detect-paths.test.ts` 13, `hosts-block.test.ts` 13, `ports-capability.test.ts` 10, `process-health.test.ts` 10, `fs.test.ts` 6, `hosts-elevated-e2e.test.ts` 3.

Bukti isolasi: tidak ada tes yang menulis `/etc/hosts`, `/etc/ca-certificates`, `/etc/pki`, atau registry. `hosts-elevated-e2e.test.ts` membandingkan byte `/etc/hosts` sebelum/sesudah dan menguji jalur elevated dengan **stub `pkexec`** di PATH temp yang `exec "$@"` sebagai user biasa — membuktikan staging, tata letak argv, semantik helper, backup dan verifikasi; **bukan** bukti prompt polkit/autentikasi. `fs.test.ts` memakai `mkdtemp` nyata. Tes runner membuktikan `a b; touch <marker>` tidak membuat file marker (tanpa shell). Hook bash nyata dijalankan dan diuji idempoten (prepend hanya direktori yang ada; entri `$(...)` tidak dieksekusi).

Bug yang ditemukan dan diperbaiki selama verifikasi:

1. Runner membunuh `sh` induk sehingga cucu menahan pipe → timeout dilaporkan `timeout`, abort dilaporkan salah. Diperbaiki dengan `detached: true` + kill grup proses; tes abort kini lulus dalam ~0,5 s.
2. Autostart menimpa file `[Desktop Entry]` milik pihak lain. Kepemilikan kini dideteksi lewat penanda `Name`/`Comment` kita sendiri.
3. Override data root Linux/Windows salah menyisipkan `StackManage` pada path eksplisit; pemisah path Windows memakai `/`. Diganti `path.win32`/`path.posix` per platform dan override kini mengganti root utuh (cache ikut ter-anchor agar tidak menyentuh `~/.cache` nyata).
4. Vitest tidak me-resolve impor `../` di paket flat (berkas berada di `test/`, sumber di `src/`) — impor diseragamkan ke `./`.

## RISIKO/BUG

- **Windows sepenuhnya UNVERIFIED.** Hosts write, trust store, autostart registry, process-tree kill dan Job Object hanya rencana; tidak ada eksekusi Windows. Jangan menaikkan status Windows ke `supported`/`verified` tanpa bukti host Windows nyata.
- Jalur `pkexec` nyata (prompt polkit, kebijakan, autentikasi, kegagalan otorisasi) belum diuji; hanya kontrak argv/helper yang teruji. Atribut `execution` pada rencana elevated tetap `unverified`.
- `cap_net_bind_service` tidak pernah diterapkan; hanya direncanakan. Status bind untuk port privilese dilaporkan `risk`/tidak diketahui sampai `getcap` membuktikan.
- Trust store Linux hanya direncanakan; anchor tidak disalin dan refresh tidak dijalankan. Distro di luar debian/rhel/arch (mis. Alpine) = unknown/unsupported.
- Cert issue/renew belum diimplementasikan (`NOT_IMPLEMENTED`).
- Turbo cache dipakai bersama antar-worktree (`/tmp/opencode/stackmanage-architect`); semua bukti di atas dijalankan dengan `TURBO_FORCE=1` atau vitest langsung agar tidak memakai cache worktree lain.
- `packages/core` (frozen) mengekspor TS source; `dist` platform tidak dapat di-`import` mentah oleh `node` — diverifikasi lewat bundel esbuild, pola yang sama dengan aplikasi.
- `ci/platform.yml` tidak aktif: GitHub hanya menjalankan `.github/workflows` di root repo; aktivasi di luar scope branch ini. Tidak ada run CI yang diklaim.

## DEPENDENSI

Tidak ada dependensi runtime baru selain `@stackmanage/core` (workspace) dan `zod@4.6.7` yang sudah dipakai core; `@types/node@24.10.0` sebagai devDependency (versi sama dengan root). `pnpm-lock.yaml` hanya bertambah entri untuk paket platform. Versi dipatok (`save-exact` di `.npmrc`).

## LANGKAH BERIKUT

1. Integrator meninjau commit `agent/platform` dan menyatukannya ke `integration/phase1`; jangan menyentuh `packages/core` frozen.
2. Uji host Linux **dengan** elevasi nyata terkontrol (persetujuan eksplisit) untuk hosts/trust, lalu catat bukti agar `execution` boleh menjadi `verified`.
3. Uji Windows nyata (hosts, trust, autostart, kill) sebelum mengubah status `unverified`.
4. Aktivasi `ci/platform.yml` di root `.github/workflows` hanya dengan persetujuan; jalankan matriks Ubuntu + Windows sungguhan.
5. QA tetap harus membuktikan fitur/vendor/arsitektur; scaffold dan tes unit tidak menaikkan status `U` pada matriks fitur.
