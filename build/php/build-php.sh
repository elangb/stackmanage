#!/usr/bin/env bash
#
# Builder-stage script for the pinned PHP runtime. It runs as root inside the
# disposable builder container, installs into /opt/php/<version>, verifies the
# resulting binaries, and leaves a small provenance bundle in
# share/stackmanage. It never uses the network.
set -euo pipefail
IFS=$'\n\t'
umask 022

export LC_ALL=C
export TZ=UTC
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

fail() {
  printf 'PHP_BUILD_FAILED: %s\n' "$*" >&2
  exit 1
}

: "${PHP_VERSION:?PHP_VERSION is required}"
: "${PHP_SOURCE_SHA256:?PHP_SOURCE_SHA256 is required}"
: "${PHP_SOURCE_BYTES:?PHP_SOURCE_BYTES is required}"
: "${PHP_SOURCE_URL:?PHP_SOURCE_URL is required}"
: "${PHP_SOURCE_TOP_LEVEL:?PHP_SOURCE_TOP_LEVEL is required}"
: "${PHP_RELEASE_DATE:?PHP_RELEASE_DATE is required}"
: "${SOURCE_DATE_EPOCH:?SOURCE_DATE_EPOCH is required}"
: "${TARGET:?TARGET is required}"
: "${BUILD_JOBS:?BUILD_JOBS is required}"
: "${BASE_IMAGE:?BASE_IMAGE is required}"
: "${UBUNTU_SNAPSHOT:?UBUNTU_SNAPSHOT is required}"

case "$BUILD_JOBS" in
  ''|*[!0-9]*) fail "BUILD_JOBS must be an integer" ;;
esac
if [ "$BUILD_JOBS" -lt 1 ] || [ "$BUILD_JOBS" -gt 8 ]; then
  fail "BUILD_JOBS must be between 1 and 8"
fi

[ "$(uname -s)" = "Linux" ] || fail "the builder must run on Linux"
[ "$(uname -m)" = "x86_64" ] || fail "this runner currently supports linux-x64 only"
[ "$TARGET" = "linux-x64" ] || fail "unsupported target: $TARGET"

SOURCE_DIR=/build/php-src
PREFIX="/opt/php/${PHP_VERSION}"
SUPPORT_DIR=/usr/local/share/stackmanage

[ -f "$SOURCE_DIR/configure" ] || fail "configure is missing from the extracted source"
[ -f "$SUPPORT_DIR/configure-args.txt" ] || fail "configure-args.txt is missing"
[ -f "$SUPPORT_DIR/expected-extensions.txt" ] || fail "expected-extensions.txt is missing"

printf 'PHP_BUILD_STAGE extract version=%s\n' "$PHP_VERSION"
grep -q "#define PHP_VERSION \"${PHP_VERSION}\"" "$SOURCE_DIR/main/php_version.h" \
  || fail "source tree does not contain PHP ${PHP_VERSION}"

cd "$SOURCE_DIR"

export CFLAGS="-O2 -pipe -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fdebug-prefix-map=${SOURCE_DIR}=/usr/src/php -ffile-prefix-map=${SOURCE_DIR}=/usr/src/php"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-Wl,-O1 -Wl,-z,relro -Wl,-z,now"

mapfile -t CONFIGURE_ARGS < "$SUPPORT_DIR/configure-args.txt"
printf 'PHP_BUILD_STAGE configure args=%s\n' "${#CONFIGURE_ARGS[@]}"
./configure "${CONFIGURE_ARGS[@]}"

printf 'PHP_BUILD_STAGE make jobs=%s\n' "$BUILD_JOBS"
make -j"$BUILD_JOBS"

printf 'PHP_BUILD_STAGE install prefix=%s\n' "$PREFIX"
rm -rf "$PREFIX"
make install

# Remove development-only output and upstream sample ini files. The artifact is
# a runtime, not a phpize/SDK tree. Keep shared extensions if a future configure
# change produces any.
rm -rf \
  "$PREFIX/include" \
  "$PREFIX/man" \
  "$PREFIX/bin/phpize" \
  "$PREFIX/bin/php-config"
rm -f \
  "$PREFIX/etc/php.ini-development" \
  "$PREFIX/etc/php.ini-production" \
  "$PREFIX/etc/php-fpm.conf.default" \
  "$PREFIX/etc/php-fpm.d/www.conf.default"
if ! find "$PREFIX/lib/php" -type f -name '*.so' -print -quit 2>/dev/null | grep -q .; then
  rm -rf "$PREFIX/lib/php"
fi
rmdir "$PREFIX/lib" 2>/dev/null || true

strip --strip-unneeded "$PREFIX/bin/php" "$PREFIX/sbin/php-fpm"

install -d \
  "$PREFIX/etc/conf.d" \
  "$PREFIX/etc/php-fpm.d" \
  "$PREFIX/var/log" \
  "$PREFIX/var/run" \
  "$PREFIX/share/stackmanage/licenses"

install -m 0644 "$SUPPORT_DIR/php.ini" "$PREFIX/etc/php.ini"
install -m 0644 "$SUPPORT_DIR/php-fpm.conf" "$PREFIX/etc/php-fpm.conf"
install -m 0644 "$SUPPORT_DIR/www.conf" "$PREFIX/etc/php-fpm.d/www.conf"
install -m 0644 "$SUPPORT_DIR/configure-args.txt" "$PREFIX/share/stackmanage/configure-args.txt"
install -m 0644 "$SUPPORT_DIR/expected-extensions.txt" "$PREFIX/share/stackmanage/expected-extensions.txt"

# Upstream licence and bundled-source notices. The complete REDIST list points
# at source paths; the referenced notices that apply to this build are copied.
install -m 0644 "$SOURCE_DIR/LICENSE" "$PREFIX/share/stackmanage/LICENSE"
install -m 0644 "$SOURCE_DIR/README.REDIST.BINS" "$PREFIX/share/stackmanage/README.REDIST.BINS"
for spec in \
  "libmagic:ext/fileinfo/libmagic/LICENSE" \
  "libmbfl:ext/mbstring/libmbfl/LICENSE" \
  "libbcmath:ext/bcmath/libbcmath/LICENSE" \
  "libavifinfo:ext/standard/libavifinfo/LICENSE" \
  "lexbor:ext/lexbor/LICENSE" \
  "uriparser:ext/uri/uriparser/COPYING.BSD-3-Clause"
do
  name=${spec%%:*}
  path=${spec#*:}
  [ -f "$SOURCE_DIR/$path" ] || fail "expected licence file is missing: $path"
  install -m 0644 "$SOURCE_DIR/$path" "$PREFIX/share/stackmanage/licenses/${name}-LICENSE"
done

printf 'PHP_BUILD_STAGE metadata\n'
{
  printf 'php_version=%s\n' "$PHP_VERSION"
  printf 'php_source_url=%s\n' "$PHP_SOURCE_URL"
  printf 'php_source_sha256=%s\n' "$PHP_SOURCE_SHA256"
  printf 'php_source_bytes=%s\n' "$PHP_SOURCE_BYTES"
  printf 'php_source_top_level=%s\n' "$PHP_SOURCE_TOP_LEVEL"
  printf 'php_release_date=%s\n' "$PHP_RELEASE_DATE"
  printf 'source_date_epoch=%s\n' "$SOURCE_DATE_EPOCH"
  printf 'target=%s\n' "$TARGET"
  printf 'base_image=%s\n' "$BASE_IMAGE"
  printf 'ubuntu_snapshot=%s\n' "$UBUNTU_SNAPSHOT"
  printf 'build_jobs=%s\n' "$BUILD_JOBS"
  printf 'compiler=%s\n' "$(gcc --version | head -n 1)"
  printf 'make=%s\n' "$(make --version | head -n 1)"
} > "$PREFIX/share/stackmanage/build-metadata.txt"

dpkg-query -W -f='${Package}=${Version}\n' \
  | LC_ALL=C sort \
  > "$PREFIX/share/stackmanage/apt-build-packages.txt"

printf 'PHP_BUILD_STAGE verify\n'
"$PREFIX/bin/php" -c "$PREFIX/etc/php.ini" -v
# shellcheck disable=SC2016 # $argv is PHP code, not a shell expansion
"$PREFIX/bin/php" -c "$PREFIX/etc/php.ini" -r \
  'exit((PHP_VERSION === $argv[1] && !PHP_ZTS && !PHP_DEBUG && PHP_INT_SIZE === 8) ? 0 : 1);' \
  "$PHP_VERSION"
"$PREFIX/bin/php" -c "$PREFIX/etc/php.ini" -m > /tmp/php-modules.txt
while IFS= read -r extension; do
  [ -z "$extension" ] && continue
  grep -Fxq "$extension" /tmp/php-modules.txt \
    || fail "required extension is missing: $extension"
done < "$SUPPORT_DIR/expected-extensions.txt"
"$PREFIX/sbin/php-fpm" -v
"$PREFIX/sbin/php-fpm" -t -y "$PREFIX/etc/php-fpm.conf" -p "$PREFIX"
rm -f "$PREFIX"/var/log/* "$PREFIX"/var/run/*

# Deterministic, non-root-friendly modes. Directories are traversable and files
# are readable; only the two runtime binaries are executable.
find "$PREFIX" -type d -exec chmod 0755 {} +
find "$PREFIX" -type f -exec chmod 0644 {} +
chmod 0755 "$PREFIX/bin/php" "$PREFIX/sbin/php-fpm"
if find "$PREFIX" -type f -perm /6000 -print -quit | grep -q .; then
  fail "artifact contains a setuid/setgid file"
fi
if find "$PREFIX" -type f -perm -0002 -print -quit | grep -q .; then
  fail "artifact contains a world-writable file"
fi
if find "$PREFIX" -type l -print -quit | grep -q .; then
  fail "artifact contains a symlink; the exporter rejects symlinks"
fi

rm -rf /build /tmp/php.tar.gz
printf 'PHP_BUILD_STAGE ok version=%s prefix=%s\n' "$PHP_VERSION" "$PREFIX"
