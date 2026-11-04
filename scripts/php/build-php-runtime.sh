#!/usr/bin/env bash
#
# Build the pinned PHP 8.5.12 Linux x64 runtime with Docker or Podman.
#
# The script downloads the official php.net source, verifies the official
# SHA-256, stages an isolated build context, builds the multi-stage image, and
# exports:
#   release/php/php-8.5.12-linux-x64.tar.gz
#   release/php/php-8.5.12-linux-x64.tar.gz.sha256
#   release/php/php-8.5.12-linux-x64.manifest.json
#
# It is idempotent: a valid existing artifact is verified and reused unless
# --force is supplied. It never needs root on the host and never uses eval.
set -euo pipefail
IFS=$'\n\t'
umask 022

export LC_ALL=C
export TZ=UTC

readonly PHP_VERSION="8.5.12"
readonly TARGET="linux-x64"
readonly PHP_SOURCE_URL="https://www.php.net/distributions/php-8.5.12.tar.gz"
readonly PHP_SOURCE_SHA256="81a0f450349e84b08eb43faa85f8a4c835684f3cc1c50471775d1317a046c525"
readonly PHP_SOURCE_BYTES="24469403"
readonly PHP_SOURCE_TOP_LEVEL="php-8.5.12"
readonly PHP_RELEASE_DATE="2026-10-21"
readonly PHP_SOURCE_DATE_EPOCH="1792540800"
# Resolved from Docker Hub library/ubuntu:24.04 on 2026-11-05.
readonly UBUNTU_IMAGE="ubuntu:24.04@sha256:78d4744ead1f5b19b04d0df558ab182a5300903900755e515b2ca4d10eb2044d"
readonly UBUNTU_SNAPSHOT="20261021T000000Z"
readonly MIN_TIMEOUT_SECONDS=60
readonly MAX_TIMEOUT_SECONDS=86400
readonly MAX_JOBS=8

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
DOCKERFILE="${ROOT}/build/php/Dockerfile"
SUPPORT_DIR="${ROOT}/build/php"

OUTPUT_DIR="${ROOT}/release/php"
CACHE_DIR="${STACKMANAGE_CACHE_HOME:-${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}/stackmanage/php}"
JOBS=""
BUILD_TIMEOUT_SECONDS="${STACKMANAGE_BUILD_TIMEOUT:-3600}"
FORCE=0
VERIFY_ONLY=0
ENGINE=""
ENGINE_BIN=""
CONTEXT_DIR=""
VERIFY_DIR=""
BUILD_LOG=""
FAILED=0

usage() {
  cat <<'EOF'
Usage: scripts/php/build-php-runtime.sh [options]

Build the pinned PHP 8.5.12 Linux x64 runtime with Docker or Podman.

Options:
  --output-dir DIR   Artifact directory (default: <workspace>/release/php)
  --cache-dir DIR    Source cache directory (default: user cache)
  --engine NAME      Container engine: docker or podman (default: auto)
  --jobs N           Parallel make jobs, 1-8 (default: min(4, nproc))
  --timeout SECONDS  Bound for the image build and export run (60-86400)
  --force            Rebuild even when a valid artifact already exists
  --verify-only      Verify an existing artifact; do not need Docker/Podman
  --version VERSION  Must be the pinned version 8.5.12
  -h, --help         Show this help

Environment:
  STACKMANAGE_CONTAINER_ENGINE  docker or podman, same as --engine
  STACKMANAGE_BUILD_TIMEOUT     same as --timeout
  STACKMANAGE_CACHE_HOME        source cache root

The artifact is built for linux-x64 only. PHP source and the Ubuntu package
snapshot are pinned; see docs/php-build-runner.md.
EOF
}

fail() {
  FAILED=1
  printf 'PHP_RUNTIME_FAILED: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local status=$?
  if [ -n "${CONTEXT_DIR}" ]; then rm -rf -- "$CONTEXT_DIR"; fi
  if [ -n "${VERIFY_DIR}" ]; then rm -rf -- "$VERIFY_DIR"; fi
  if [ "$status" -ne 0 ] && [ "$FAILED" -eq 0 ]; then
    printf 'PHP_RUNTIME_FAILED: exit=%s' "$status" >&2
    if [ -n "${BUILD_LOG}" ] && [ -f "${BUILD_LOG}" ]; then
      printf ' (log: %s)' "$BUILD_LOG" >&2
    fi
    printf '\n' >&2
  fi
  exit "$status"
}
trap cleanup EXIT

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required"
  fi
}

run_bounded() {
  if command -v timeout >/dev/null 2>&1; then
    local status
    set +e
    timeout --signal=TERM --kill-after=30s "${BUILD_TIMEOUT_SECONDS}s" "$@"
    status=$?
    set -e
    if [ "$status" -eq 124 ]; then
      fail "operation timed out after ${BUILD_TIMEOUT_SECONDS}s"
    fi
    return "$status"
  fi
  "$@"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version)
        [ "$#" -ge 2 ] || fail "--version requires a value"
        [ "$2" = "$PHP_VERSION" ] || fail "only PHP ${PHP_VERSION} is pinned; got '$2'"
        shift 2
        ;;
      --output-dir)
        [ "$#" -ge 2 ] || fail "--output-dir requires a value"
        OUTPUT_DIR="$2"
        shift 2
        ;;
      --cache-dir)
        [ "$#" -ge 2 ] || fail "--cache-dir requires a value"
        CACHE_DIR="$2"
        shift 2
        ;;
      --engine)
        [ "$#" -ge 2 ] || fail "--engine requires a value"
        case "$2" in
          docker|podman) ENGINE="$2" ;;
          *) fail "--engine must be docker or podman" ;;
        esac
        shift 2
        ;;
      --jobs)
        [ "$#" -ge 2 ] || fail "--jobs requires a value"
        JOBS="$2"
        shift 2
        ;;
      --timeout)
        [ "$#" -ge 2 ] || fail "--timeout requires a value"
        BUILD_TIMEOUT_SECONDS="$2"
        shift 2
        ;;
      --force)
        FORCE=1
        shift
        ;;
      --verify-only)
        VERIFY_ONLY=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "unknown option: $1 (use --help)"
        ;;
    esac
  done

  if [ "$VERIFY_ONLY" -eq 1 ] && [ "$FORCE" -eq 1 ]; then
    fail "--verify-only and --force cannot be combined"
  fi

  case "$BUILD_TIMEOUT_SECONDS" in
    ''|*[!0-9]*) fail "--timeout must be an integer" ;;
  esac
  if [ "$BUILD_TIMEOUT_SECONDS" -lt "$MIN_TIMEOUT_SECONDS" ] \
    || [ "$BUILD_TIMEOUT_SECONDS" -gt "$MAX_TIMEOUT_SECONDS" ]; then
    fail "--timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds"
  fi

  if [ -z "$JOBS" ]; then
    if command -v nproc >/dev/null 2>&1; then
      JOBS="$(nproc)"
    else
      JOBS=2
    fi
    case "$JOBS" in
      ''|*[!0-9]*) JOBS=2 ;;
    esac
    if [ "$JOBS" -gt 4 ]; then JOBS=4; fi
  fi
  case "$JOBS" in
    ''|*[!0-9]*) fail "--jobs must be an integer" ;;
  esac
  if [ "$JOBS" -lt 1 ] || [ "$JOBS" -gt "$MAX_JOBS" ]; then
    fail "--jobs must be between 1 and ${MAX_JOBS}"
  fi
}

resolve_output() {
  mkdir -p -- "$OUTPUT_DIR"
  OUTPUT_DIR="$(cd -- "$OUTPUT_DIR" && pwd -P)"
  BUILD_LOG="${OUTPUT_DIR}/build.log"
}

artifact_paths() {
  ARTIFACT="${OUTPUT_DIR}/php-${PHP_VERSION}-${TARGET}.tar.gz"
  SHA_FILE="${ARTIFACT}.sha256"
  MANIFEST="${OUTPUT_DIR}/php-${PHP_VERSION}-${TARGET}.manifest.json"
}

detect_engine() {
  if [ -z "$ENGINE" ] && [ -n "${STACKMANAGE_CONTAINER_ENGINE:-}" ]; then
    ENGINE="$STACKMANAGE_CONTAINER_ENGINE"
  fi
  if [ -n "$ENGINE" ]; then
    case "$ENGINE" in
      docker|podman) ;;
      *) fail "unsupported engine: $ENGINE" ;;
    esac
  elif command -v docker >/dev/null 2>&1; then
    ENGINE=docker
  elif command -v podman >/dev/null 2>&1; then
    ENGINE=podman
  else
    fail "no container runtime found (docker or podman). Install one, or use --verify-only for an existing artifact. No build was attempted."
  fi

  ENGINE_BIN="$(command -v "$ENGINE" || true)"
  [ -n "$ENGINE_BIN" ] || fail "container runtime '$ENGINE' is not on PATH"
  if ! "$ENGINE_BIN" info >/dev/null 2>&1; then
    fail "container runtime '$ENGINE' is installed but not usable (daemon/permissions). Fix access first."
  fi
}

is_rootless() {
  case "$ENGINE" in
    podman)
      [ "$("$ENGINE_BIN" info --format '{{.Host.Security.Rootless}}' 2>/dev/null || true)" = "true" ]
      ;;
    docker)
      "$ENGINE_BIN" info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q 'rootless' \
        || "$ENGINE_BIN" info 2>/dev/null | grep -qi 'rootless'
      ;;
    *)
      return 1
      ;;
  esac
}

download_source() {
  local dest="$1"
  local part="${dest}.part.$$"
  local actual size
  rm -f -- "$part"
  printf 'PHP_SOURCE_DOWNLOAD url=%s\n' "$PHP_SOURCE_URL"
  if ! curl \
    --fail \
    --location \
    --silent \
    --show-error \
    --proto '=https' \
    --tlsv1.2 \
    --connect-timeout 20 \
    --max-time 300 \
    --retry 3 \
    --retry-delay 2 \
    --max-filesize 67108864 \
    --output "$part" \
    "$PHP_SOURCE_URL"
  then
    rm -f -- "$part"
    fail "source download failed: $PHP_SOURCE_URL"
  fi

  size="$(wc -c < "$part" | tr -d ' ')"
  if [ "$size" != "$PHP_SOURCE_BYTES" ]; then
    rm -f -- "$part"
    fail "source size mismatch: expected ${PHP_SOURCE_BYTES}, got ${size}"
  fi
  actual="$(sha256_file "$part")"
  if [ "$actual" != "$PHP_SOURCE_SHA256" ]; then
    rm -f -- "$part"
    fail "source SHA-256 mismatch: expected ${PHP_SOURCE_SHA256}, got ${actual}"
  fi
  mv -f -- "$part" "$dest"
}

ensure_source_cache() {
  command -v curl >/dev/null 2>&1 || fail "curl is required to fetch the pinned source"
  mkdir -p -- "$CACHE_DIR" || fail "cannot create source cache directory: $CACHE_DIR"
  CACHE_FILE="${CACHE_DIR}/php-${PHP_VERSION}.tar.gz"
  if [ -f "$CACHE_FILE" ]; then
    local size actual
    size="$(wc -c < "$CACHE_FILE" | tr -d ' ')"
    actual="$(sha256_file "$CACHE_FILE")"
    if [ "$size" = "$PHP_SOURCE_BYTES" ] && [ "$actual" = "$PHP_SOURCE_SHA256" ]; then
      printf 'PHP_SOURCE_CACHE_HIT file=%s sha256=%s\n' "$CACHE_FILE" "$actual"
      return 0
    fi
    printf 'PHP_SOURCE_CACHE_INVALID file=%s\n' "$CACHE_FILE" >&2
    rm -f -- "$CACHE_FILE"
  fi
  download_source "$CACHE_FILE"
  printf 'PHP_SOURCE_OK file=%s sha256=%s bytes=%s\n' "$CACHE_FILE" "$PHP_SOURCE_SHA256" "$PHP_SOURCE_BYTES"
}

prepare_context() {
  [ -f "$DOCKERFILE" ] || fail "Dockerfile is missing: $DOCKERFILE"
  for support_file in \
    build-php.sh \
    export-runtime.sh \
    php.ini \
    php-fpm.conf \
    www.conf \
    configure-args.txt \
    expected-extensions.txt
  do
    [ -f "${SUPPORT_DIR}/${support_file}" ] \
      || fail "build support file is missing: ${SUPPORT_DIR}/${support_file}"
  done
  CONTEXT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stackmanage-php-context.XXXXXX")"
  cp -- "$DOCKERFILE" "${CONTEXT_DIR}/Dockerfile"
  cp -- \
    "${SUPPORT_DIR}/build-php.sh" \
    "${SUPPORT_DIR}/export-runtime.sh" \
    "${SUPPORT_DIR}/php.ini" \
    "${SUPPORT_DIR}/php-fpm.conf" \
    "${SUPPORT_DIR}/www.conf" \
    "${SUPPORT_DIR}/configure-args.txt" \
    "${SUPPORT_DIR}/expected-extensions.txt" \
    "${CONTEXT_DIR}/"
  cp -- "$CACHE_FILE" "${CONTEXT_DIR}/php-${PHP_VERSION}.tar.gz"
  chmod 0644 -- "${CONTEXT_DIR}/php-${PHP_VERSION}.tar.gz"
  chmod 0755 -- "${CONTEXT_DIR}/build-php.sh" "${CONTEXT_DIR}/export-runtime.sh"
}

verify_manifest() {
  local manifest="$1"
  local artifact="$2"
  if command -v node >/dev/null 2>&1; then
    node - "$manifest" "$artifact" "$PHP_VERSION" "$PHP_SOURCE_SHA256" "$TARGET" "$PHP_SOURCE_URL" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [manifestPath, artifactPath, expectedVersion, expectedSourceSha, expectedTarget, expectedSourceUrl] = process.argv.slice(2);

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const stat = fs.statSync(artifactPath);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
  const name = path.basename(artifactPath);
  const topLevel = `php-${expectedVersion}-${expectedTarget}`;

  expect(manifest.schema === 'stackmanage.php-runtime/1', 'unexpected manifest schema');
  expect(manifest.version === expectedVersion, 'manifest version does not match the pin');
  expect(manifest.target === expectedTarget, 'manifest target does not match linux-x64');
  expect(manifest.source.url === expectedSourceUrl, 'manifest source URL does not match the pin');
  expect(manifest.source.sha256 === expectedSourceSha, 'manifest source SHA-256 does not match the pin');
  expect(manifest.source.fileName === `php-${expectedVersion}.tar.gz`, 'manifest source filename is wrong');
  expect(manifest.artifact.fileName === name, 'manifest artifact filename does not match');
  expect(manifest.artifact.sha256 === hash, 'manifest artifact SHA-256 does not match the file');
  expect(manifest.artifact.bytes === stat.size, 'manifest artifact size does not match the file');
  expect(manifest.artifact.topLevelDir === topLevel, 'manifest top-level directory is wrong');
  expect(manifest.runtime.phpFpmTestOk === true, 'manifest does not record a successful php-fpm -t');
  expect(Array.isArray(manifest.runtime.extensions) && manifest.runtime.extensions.length > 0, 'manifest has no extension list');
  expect(manifest.verification.sourceSha256 === true, 'manifest source verification is not asserted');

  console.log(`PHP_MANIFEST_OK file=${name} sha256=${hash} bytes=${stat.size}`);
} catch (error) {
  console.error(`PHP_MANIFEST_INVALID: ${error.message}`);
  process.exit(1);
}
NODE
  elif command -v jq >/dev/null 2>&1; then
    local artifact_sha artifact_bytes
    artifact_sha="$(sha256_file "$artifact")"
    artifact_bytes="$(wc -c < "$artifact" | tr -d ' ')"
    jq -e \
      --arg name "$(basename -- "$artifact")" \
      --arg sha "$artifact_sha" \
      --argjson bytes "$artifact_bytes" \
      --arg version "$PHP_VERSION" \
      --arg source_sha "$PHP_SOURCE_SHA256" \
      --arg target "$TARGET" \
      --arg source_url "$PHP_SOURCE_URL" \
      '.schema == "stackmanage.php-runtime/1"
       and .version == $version
       and .target == $target
       and .source.url == $source_url
       and .source.sha256 == $source_sha
       and .artifact.fileName == $name
       and .artifact.sha256 == $sha
       and .artifact.bytes == $bytes
       and .runtime.phpFpmTestOk == true
       and (.runtime.extensions | length > 0)' \
      "$manifest" >/dev/null
    printf 'PHP_MANIFEST_OK file=%s sha256=%s bytes=%s\n' "$(basename -- "$artifact")" "$artifact_sha" "$artifact_bytes"
  else
    fail "manifest verification requires node or jq"
  fi
}

check_tar() {
  local artifact="$1"
  local tmp="$2"
  local top="php-${PHP_VERSION}-${TARGET}"
  tar -tzf "$artifact" > "${tmp}/tar-list.txt" \
    || fail "artifact is not a readable tar.gz"
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "${tmp}/tar-list.txt"; then
    fail "tar contains an absolute or traversal path"
  fi
  if tar -tvzf "$artifact" | awk '$1 ~ /^l/ { found = 1 } END { exit(found ? 0 : 1) }'; then
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
    grep -qx "${top}/${required}" "${tmp}/tar-list.txt" \
      || fail "tar is missing ${required}"
  done
  printf 'PHP_TAR_OK file=%s\n' "$(basename -- "$artifact")"
}

verify_artifact() {
  local artifact="$1"
  local sha_file="$2"
  local manifest="$3"
  local tmp="$4"
  [ -f "$artifact" ] || fail "artifact is missing: $artifact"
  [ -f "$sha_file" ] || fail "SHA-256 sidecar is missing: $sha_file"
  [ -f "$manifest" ] || fail "manifest is missing: $manifest"

  if command -v sha256sum >/dev/null 2>&1; then
    (cd -- "$(dirname -- "$artifact")" && sha256sum -c "$(basename -- "$sha_file")") \
      || fail "artifact SHA-256 verification failed"
  elif command -v shasum >/dev/null 2>&1; then
    (cd -- "$(dirname -- "$artifact")" && shasum -a 256 -c "$(basename -- "$sha_file")") \
      || fail "artifact SHA-256 verification failed"
  else
    fail "sha256sum or shasum is required for verification"
  fi

  verify_manifest "$manifest" "$artifact"
  check_tar "$artifact" "$tmp"
  printf 'PHP_RUNTIME_VERIFY_OK file=%s\n' "$(basename -- "$artifact")"
}

verify_existing() {
  VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stackmanage-php-verify.XXXXXX")"
  verify_artifact "$ARTIFACT" "$SHA_FILE" "$MANIFEST" "$VERIFY_DIR"
}

build_image() {
  local image_tag="stackmanage/php-build:${PHP_VERSION}-${TARGET}-${PHP_SOURCE_SHA256:0:12}"
  local -a build_args=(
    build
    --file "${CONTEXT_DIR}/Dockerfile"
    --target export
    --tag "$image_tag"
    --build-arg "UBUNTU_IMAGE=${UBUNTU_IMAGE}"
    --build-arg "PHP_VERSION=${PHP_VERSION}"
    --build-arg "PHP_SOURCE_URL=${PHP_SOURCE_URL}"
    --build-arg "PHP_SOURCE_SHA256=${PHP_SOURCE_SHA256}"
    --build-arg "PHP_SOURCE_BYTES=${PHP_SOURCE_BYTES}"
    --build-arg "PHP_SOURCE_TOP_LEVEL=${PHP_SOURCE_TOP_LEVEL}"
    --build-arg "PHP_RELEASE_DATE=${PHP_RELEASE_DATE}"
    --build-arg "PHP_SOURCE_DATE_EPOCH=${PHP_SOURCE_DATE_EPOCH}"
    --build-arg "TARGET=${TARGET}"
    --build-arg "BUILD_JOBS=${JOBS}"
    --build-arg "BASE_IMAGE=${UBUNTU_IMAGE}"
    --build-arg "UBUNTU_SNAPSHOT=${UBUNTU_SNAPSHOT}"
    --label "org.opencontainers.image.title=StackManage PHP build"
    --label "org.opencontainers.image.version=${PHP_VERSION}"
    --label "org.opencontainers.image.licenses=PHP-3.01"
    --label "org.opencontainers.image.source=https://www.php.net/"
    --label "org.opencontainers.image.created=2026-10-21T00:00:00Z"
    "$CONTEXT_DIR"
  )
  printf 'PHP_BUILD_IMAGE tag=%s engine=%s jobs=%s\n' "$image_tag" "$ENGINE" "$JOBS"
  run_bounded "$ENGINE_BIN" "${build_args[@]}" \
    || fail "container image build failed (engine=${ENGINE}); see ${BUILD_LOG}"
  IMAGE_TAG="$image_tag"
}

export_artifact() {
  local tmpfs_spec="/tmp:rw,size=256m,mode=1777"
  local -a run_args=(
    run
    --rm
    --network none
    --cap-drop ALL
    --security-opt no-new-privileges
    --tmpfs "$tmpfs_spec"
    --volume "${OUTPUT_DIR}:/out:rw"
    --env HOME=/tmp
  )
  if is_rootless; then
    run_args+=(--user 0:0)
  else
    run_args+=(--user "$(id -u):$(id -g)")
  fi
  run_args+=("$IMAGE_TAG")
  printf 'PHP_EXPORT_RUN image=%s output=%s\n' "$IMAGE_TAG" "$OUTPUT_DIR"
  run_bounded "$ENGINE_BIN" "${run_args[@]}" \
    || fail "runtime export failed (engine=${ENGINE}); see ${BUILD_LOG}"
}

main() {
  parse_args "$@"
  resolve_output
  artifact_paths

  if [ "$VERIFY_ONLY" -eq 1 ]; then
    verify_existing
    return 0
  fi

  if [ "$FORCE" -eq 0 ] && [ -f "$ARTIFACT" ] && [ -f "$SHA_FILE" ] && [ -f "$MANIFEST" ]; then
    if verify_existing; then
      printf 'PHP_RUNTIME_ALREADY_BUILT file=%s (use --force to rebuild)\n' "$ARTIFACT"
      return 0
    fi
    fail "existing artifact is invalid; use --force to rebuild"
  fi

  [ "$(uname -s)" = "Linux" ] || fail "this runner currently supports Linux only"
  [ "$(uname -m)" = "x86_64" ] || fail "this runner currently supports linux-x64 only"
  detect_engine

  # Everything from here is build output; keep a bounded diagnostic log.
  : > "$BUILD_LOG"
  exec > >(tee -a "$BUILD_LOG") 2>&1

  ensure_source_cache
  prepare_context
  build_image
  export_artifact
  VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stackmanage-php-verify.XXXXXX")"
  verify_artifact "$ARTIFACT" "$SHA_FILE" "$MANIFEST" "$VERIFY_DIR"
  printf 'PHP_RUNTIME_BUILD_OK artifact=%s log=%s\n' "$ARTIFACT" "$BUILD_LOG"
}

main "$@"
