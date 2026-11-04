#!/usr/bin/env bash
#
# Export-stage script: verify the runtime, create a deterministic tar.gz, and
# write a manifest. It runs inside the disposable export image with /out mounted
# from the host. No network access is required.
set -euo pipefail
IFS=$'\n\t'
umask 022

export LC_ALL=C
export TZ=UTC
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

PHP_PREFIX="${PHP_PREFIX:-/opt/php/8.5.12}"
OUT_DIR="${OUT_DIR:-/out}"
META="$PHP_PREFIX/share/stackmanage/build-metadata.txt"

fail() {
  printf 'PHP_EXPORT_FAILED: %s\n' "$*" >&2
  exit 1
}

meta() {
  local key="$1"
  awk -v k="$key" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$META"
}

[ -x "$PHP_PREFIX/bin/php" ] || fail "missing $PHP_PREFIX/bin/php"
[ -x "$PHP_PREFIX/sbin/php-fpm" ] || fail "missing $PHP_PREFIX/sbin/php-fpm"
[ -f "$PHP_PREFIX/etc/php.ini" ] || fail "missing php.ini"
[ -f "$PHP_PREFIX/etc/php-fpm.conf" ] || fail "missing php-fpm.conf"
[ -f "$META" ] || fail "missing build metadata: $META"
[ -s "$PHP_PREFIX/share/stackmanage/configure-args.txt" ] || fail "missing configure arguments"
[ -s "$PHP_PREFIX/share/stackmanage/expected-extensions.txt" ] || fail "missing expected extensions"
[ -s "$PHP_PREFIX/share/stackmanage/apt-build-packages.txt" ] || fail "missing build package inventory"
[ -s "$PHP_PREFIX/share/stackmanage/apt-runtime-packages.txt" ] || fail "missing runtime package inventory"
[ -d "$OUT_DIR" ] || fail "output directory is not mounted: $OUT_DIR"
command -v jq >/dev/null 2>&1 || fail "jq is required in the export stage"

PHP_VERSION="$(meta php_version)"
PHP_SOURCE_URL="$(meta php_source_url)"
PHP_SOURCE_SHA256="$(meta php_source_sha256)"
PHP_SOURCE_BYTES="$(meta php_source_bytes)"
PHP_SOURCE_TOP_LEVEL="$(meta php_source_top_level)"
PHP_RELEASE_DATE="$(meta php_release_date)"
SOURCE_DATE_EPOCH="$(meta source_date_epoch)"
TARGET="$(meta target)"
BASE_IMAGE="$(meta base_image)"
UBUNTU_SNAPSHOT="$(meta ubuntu_snapshot)"
BUILD_JOBS="$(meta build_jobs)"
COMPILER="$(meta compiler)"
MAKE_VERSION="$(meta make)"

[ -n "$PHP_VERSION" ] || fail "metadata is missing php_version"
[ -n "$PHP_SOURCE_SHA256" ] || fail "metadata is missing php_source_sha256"
[ -n "$PHP_SOURCE_BYTES" ] || fail "metadata is missing php_source_bytes"
[ -n "$SOURCE_DATE_EPOCH" ] || fail "metadata is missing source_date_epoch"
[ -n "$BUILD_JOBS" ] || fail "metadata is missing build_jobs"
[ -n "$TARGET" ] || fail "metadata is missing target"

ARTIFACT_NAME="php-${PHP_VERSION}-${TARGET}.tar.gz"
MANIFEST_NAME="php-${PHP_VERSION}-${TARGET}.manifest.json"
TOP_LEVEL="php-${PHP_VERSION}-${TARGET}"
EXPECTED_BUILD_DATE="$(date -u -d "@${SOURCE_DATE_EPOCH}" '+%b %e %Y %H:%M:%S')"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/php-export.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

STAGE="$TMP_DIR/$TOP_LEVEL"
mkdir -p "$STAGE"
cp -a "$PHP_PREFIX/." "$STAGE/"
rm -f "$STAGE"/var/log/* "$STAGE"/var/run/*

printf 'PHP_EXPORT_STAGE verify version=%s\n' "$PHP_VERSION"

"$PHP_PREFIX/bin/php" -c "$PHP_PREFIX/etc/php.ini" -v > "$TMP_DIR/php-v.txt" 2> "$TMP_DIR/php-v.err"
[ ! -s "$TMP_DIR/php-v.err" ] || { cat "$TMP_DIR/php-v.err" >&2; fail "php -v wrote to stderr"; }
grep -q "PHP ${PHP_VERSION} (cli)" "$TMP_DIR/php-v.txt" \
  || fail "php -v does not report PHP ${PHP_VERSION} (cli)"
grep -q "built: ${EXPECTED_BUILD_DATE}" "$TMP_DIR/php-v.txt" \
  || fail "php -v build date is not SOURCE_DATE_EPOCH (${EXPECTED_BUILD_DATE})"

# shellcheck disable=SC2016 # $argv is PHP code, not a shell expansion
"$PHP_PREFIX/bin/php" -c "$PHP_PREFIX/etc/php.ini" -r \
  'exit((PHP_VERSION === $argv[1] && !PHP_ZTS && !PHP_DEBUG && PHP_INT_SIZE === 8) ? 0 : 1);' \
  "$PHP_VERSION" \
  || fail "php version/ZTS/debug/int-size check failed"

"$PHP_PREFIX/sbin/php-fpm" -v > "$TMP_DIR/php-fpm-v.txt" 2>&1
grep -q "PHP ${PHP_VERSION} (fpm-fcgi)" "$TMP_DIR/php-fpm-v.txt" \
  || fail "php-fpm -v does not report PHP ${PHP_VERSION} (fpm-fcgi)"
grep -q "built: ${EXPECTED_BUILD_DATE}" "$TMP_DIR/php-fpm-v.txt" \
  || fail "php-fpm -v build date is not SOURCE_DATE_EPOCH (${EXPECTED_BUILD_DATE})"

set +e
"$PHP_PREFIX/sbin/php-fpm" -t -y "$PHP_PREFIX/etc/php-fpm.conf" -p "$PHP_PREFIX" \
  > "$TMP_DIR/php-fpm-t.txt" 2>&1
FPM_TEST_STATUS=$?
set -e
if [ "$FPM_TEST_STATUS" -ne 0 ]; then
  cat "$TMP_DIR/php-fpm-t.txt" >&2
  fail "php-fpm -t failed with exit ${FPM_TEST_STATUS}"
fi
grep -q "test is successful" "$TMP_DIR/php-fpm-t.txt" \
  || { cat "$TMP_DIR/php-fpm-t.txt" >&2; fail "php-fpm -t did not report success"; }
# FPM writes a timestamped line to its error log during -t. Remove it so the
# artifact and manifest do not embed the build time.
rm -f "$PHP_PREFIX"/var/log/* "$PHP_PREFIX"/var/run/*
sed -E 's/^\[[0-9]{2}-[A-Za-z]{3}-[0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2}\] /[timestamp] /' \
  "$TMP_DIR/php-fpm-t.txt" > "$TMP_DIR/php-fpm-t.sanitized.txt"

"$PHP_PREFIX/bin/php" -c "$PHP_PREFIX/etc/php.ini" -m \
  > "$TMP_DIR/php-m.raw" 2> "$TMP_DIR/php-m.err"
[ ! -s "$TMP_DIR/php-m.err" ] || { cat "$TMP_DIR/php-m.err" >&2; fail "php -m wrote to stderr"; }
awk '
  /^\[PHP Modules\]$/ { section = 1; next }
  /^\[Zend Modules\]$/ { section = 1; next }
  /^\[/ { section = 0; next }
  section && NF { print }
' "$TMP_DIR/php-m.raw" | LC_ALL=C sort -u > "$TMP_DIR/extensions.txt"

MISSING=0
while IFS= read -r extension; do
  [ -z "$extension" ] && continue
  if ! grep -Fxq "$extension" "$TMP_DIR/extensions.txt"; then
    printf 'missing required extension: %s\n' "$extension" >&2
    MISSING=1
  fi
done < "$PHP_PREFIX/share/stackmanage/expected-extensions.txt"
[ "$MISSING" -eq 0 ] || fail "one or more required extensions are missing"

ldd "$PHP_PREFIX/bin/php" > "$TMP_DIR/ldd-php.txt" 2>&1 || {
  cat "$TMP_DIR/ldd-php.txt" >&2
  fail "ldd failed for bin/php"
}
ldd "$PHP_PREFIX/sbin/php-fpm" > "$TMP_DIR/ldd-php-fpm.txt" 2>&1 || {
  cat "$TMP_DIR/ldd-php-fpm.txt" >&2
  fail "ldd failed for sbin/php-fpm"
}
if grep -q 'not found' "$TMP_DIR/ldd-php.txt" "$TMP_DIR/ldd-php-fpm.txt"; then
  grep 'not found' "$TMP_DIR/ldd-php.txt" "$TMP_DIR/ldd-php-fpm.txt" >&2
  fail "runtime libraries are missing"
fi
# ldd prints ASLR-dependent load addresses; strip them from the manifest.
sed -E 's/ \(0x[0-9a-f]+\)$//' "$TMP_DIR/ldd-php.txt" > "$TMP_DIR/ldd-php.sanitized.txt"
sed -E 's/ \(0x[0-9a-f]+\)$//' "$TMP_DIR/ldd-php-fpm.txt" > "$TMP_DIR/ldd-php-fpm.sanitized.txt"

find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f -exec chmod 0644 {} +
chmod 0755 "$STAGE/bin/php" "$STAGE/sbin/php-fpm"
if find "$STAGE" -type f -perm /6000 -print -quit | grep -q .; then
  fail "staged artifact contains a setuid/setgid file"
fi
if find "$STAGE" -type f -perm -0002 -print -quit | grep -q .; then
  fail "staged artifact contains a world-writable file"
fi
if find "$STAGE" -type l -print -quit | grep -q .; then
  fail "staged artifact contains a symlink; refusing to export"
fi

printf 'PHP_EXPORT_STAGE tar\n'
tar \
  --sort=name \
  --mtime="@${SOURCE_DATE_EPOCH}" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --format=gnu \
  -C "$TMP_DIR" \
  -cf - "$TOP_LEVEL" \
  | gzip -n -9 > "$TMP_DIR/$ARTIFACT_NAME"

tar -tzf "$TMP_DIR/$ARTIFACT_NAME" > "$TMP_DIR/tar-list.txt"
if grep -Eq '(^/|(^|/)\.\.(/|$))' "$TMP_DIR/tar-list.txt"; then
  fail "tar contains an absolute or traversal path"
fi
if tar -tvzf "$TMP_DIR/$ARTIFACT_NAME" | awk '$1 ~ /^l/ { found = 1 } END { exit(found ? 0 : 1) }'; then
  fail "tar contains a symlink"
fi
for required in \
  bin/php \
  sbin/php-fpm \
  etc/php.ini \
  etc/php-fpm.conf \
  etc/php-fpm.d/www.conf \
  share/stackmanage/LICENSE \
  share/stackmanage/README.REDIST.BINS \
  share/stackmanage/build-metadata.txt \
  share/stackmanage/configure-args.txt \
  share/stackmanage/expected-extensions.txt \
  share/stackmanage/apt-build-packages.txt \
  share/stackmanage/apt-runtime-packages.txt
do
  grep -qx "$TOP_LEVEL/$required" "$TMP_DIR/tar-list.txt" \
    || fail "tar is missing $required"
done

ARTIFACT_SHA="$(sha256sum "$TMP_DIR/$ARTIFACT_NAME" | awk '{print $1}')"
ARTIFACT_BYTES="$(wc -c < "$TMP_DIR/$ARTIFACT_NAME" | tr -d ' ')"
GENERATED_AT="$(date -u -d "@${SOURCE_DATE_EPOCH}" +%Y-%m-%dT%H:%M:%SZ)"

printf 'PHP_EXPORT_STAGE manifest\n'
jq -n \
  --arg schema "stackmanage.php-runtime/1" \
  --arg generatedAt "$GENERATED_AT" \
  --arg version "$PHP_VERSION" \
  --arg target "$TARGET" \
  --arg releaseDate "$PHP_RELEASE_DATE" \
  --arg buildDate "$EXPECTED_BUILD_DATE" \
  --arg sourceUrl "$PHP_SOURCE_URL" \
  --arg sourceSha "$PHP_SOURCE_SHA256" \
  --argjson sourceBytes "$PHP_SOURCE_BYTES" \
  --arg sourceTopLevel "$PHP_SOURCE_TOP_LEVEL" \
  --arg artifactName "$ARTIFACT_NAME" \
  --arg artifactSha "$ARTIFACT_SHA" \
  --argjson artifactBytes "$ARTIFACT_BYTES" \
  --arg artifactTopLevel "$TOP_LEVEL" \
  --arg prefix "$PHP_PREFIX" \
  --arg baseImage "$BASE_IMAGE" \
  --arg ubuntuSnapshot "$UBUNTU_SNAPSHOT" \
  --arg compiler "$COMPILER" \
  --arg makeVersion "$MAKE_VERSION" \
  --argjson buildJobs "$BUILD_JOBS" \
  --argjson sourceDateEpoch "$SOURCE_DATE_EPOCH" \
  --rawfile configure "$PHP_PREFIX/share/stackmanage/configure-args.txt" \
  --rawfile expectedExtensions "$PHP_PREFIX/share/stackmanage/expected-extensions.txt" \
  --rawfile aptBuildPackages "$PHP_PREFIX/share/stackmanage/apt-build-packages.txt" \
  --rawfile aptRuntimePackages "$PHP_PREFIX/share/stackmanage/apt-runtime-packages.txt" \
  --rawfile extensions "$TMP_DIR/extensions.txt" \
  --rawfile phpVersion "$TMP_DIR/php-v.txt" \
  --rawfile phpFpmVersion "$TMP_DIR/php-fpm-v.txt" \
  --rawfile phpFpmTest "$TMP_DIR/php-fpm-t.sanitized.txt" \
  --rawfile lddPhp "$TMP_DIR/ldd-php.sanitized.txt" \
  --rawfile lddPhpFpm "$TMP_DIR/ldd-php-fpm.sanitized.txt" \
  '
  def lines: split("\n") | map(select(length > 0));
  {
    schema: $schema,
    generatedAt: $generatedAt,
    version: $version,
    target: $target,
    releaseDate: $releaseDate,
    buildDate: $buildDate,
    source: {
      url: $sourceUrl,
      fileName: ("php-" + $version + ".tar.gz"),
      sha256: $sourceSha,
      bytes: $sourceBytes,
      topLevelDir: $sourceTopLevel
    },
    artifact: {
      fileName: $artifactName,
      sha256: $artifactSha,
      bytes: $artifactBytes,
      format: "tar.gz",
      topLevelDir: $artifactTopLevel,
      prefix: $prefix,
      compression: "gzip -9 -n",
      tarOptions: [
        "--sort=name",
        "--mtime=@" + ($sourceDateEpoch | tostring),
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--format=gnu"
      ]
    },
    builder: {
      baseImage: $baseImage,
      ubuntuSnapshot: $ubuntuSnapshot,
      sourceDateEpoch: $sourceDateEpoch,
      jobs: $buildJobs,
      compiler: $compiler,
      make: $makeVersion,
      configure: ($configure | lines),
      aptBuildPackages: ($aptBuildPackages | lines),
      aptRuntimePackages: ($aptRuntimePackages | lines)
    },
    runtime: {
      phpVersion: $phpVersion,
      phpFpmVersion: $phpFpmVersion,
      phpFpmTest: $phpFpmTest,
      phpFpmTestOk: true,
      zts: false,
      debug: false,
      intSize: 8,
      extensions: ($extensions | lines),
      requiredExtensions: (($expectedExtensions | lines) | sort),
      ldd: {
        php: ($lddPhp | lines),
        phpFpm: ($lddPhpFpm | lines)
      }
    },
    verification: {
      sourceSha256: true,
      version: true,
      requiredExtensions: true,
      lddNoMissing: true,
      tarSafe: true,
      deterministicTar: true
    }
  }
  ' > "$TMP_DIR/$MANIFEST_NAME"

jq -e \
  --arg sha "$ARTIFACT_SHA" \
  --argjson bytes "$ARTIFACT_BYTES" \
  '.schema == "stackmanage.php-runtime/1"
   and .artifact.sha256 == $sha
   and .artifact.bytes == $bytes
   and .runtime.phpFpmTestOk == true
   and (.artifact.fileName | length > 0)
   and (.runtime.extensions | length > 0)' \
  "$TMP_DIR/$MANIFEST_NAME" >/dev/null \
  || fail "generated manifest failed validation"

(
  cd "$TMP_DIR"
  sha256sum "$ARTIFACT_NAME" > "$ARTIFACT_NAME.sha256"
)

for file in "$ARTIFACT_NAME" "$ARTIFACT_NAME.sha256" "$MANIFEST_NAME"; do
  mv -f "$TMP_DIR/$file" "$OUT_DIR/$file"
done

printf 'PHP_EXPORT_OK file=%s sha256=%s bytes=%s extensions=%s\n' \
  "$ARTIFACT_NAME" "$ARTIFACT_SHA" "$ARTIFACT_BYTES" "$(wc -l < "$TMP_DIR/extensions.txt" | tr -d ' ')"
