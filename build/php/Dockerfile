#
# Reproducible PHP 8.5.12 runtime for StackManage.
#
# The build context is staged by scripts/php/build-php-runtime.sh. It must
# contain the verified php-8.5.12.tar.gz and the support files from this
# directory. Direct `docker build build/php` is not supported unless those
# files are present; use the script so the official SHA-256 is enforced.
#
# Ubuntu 24.04 LTS (noble), pinned by digest. APT uses an immutable Ubuntu
# snapshot and exact package versions. The first small APT step bootstraps
# ca-certificates from the base image's HTTP archive; the packages are then
# replaced by the snapshot-pinned versions before anything is built.

ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:78d4744ead1f5b19b04d0df558ab182a5300903900755e515b2ca4d10eb2044d
FROM ${UBUNTU_IMAGE} AS ubuntu-base

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG UBUNTU_SNAPSHOT=20261021T000000Z
ARG CA_CERTIFICATES_VERSION=20260816ubuntu0.24.04.1
ARG OPENSSL_VERSION=3.0.13-0ubuntu3.16
ARG LIBSSL3_VERSION=3.0.13-0ubuntu3.16

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

# Bootstrap HTTPS support from the base image's signed HTTP archive. This only
# installs ca-certificates and its openssl dependency; the exact snapshot
# versions replace them immediately afterwards. The bootstrap version cannot
# be pinned before HTTPS works; GPG package signatures still apply.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Switch to the immutable snapshot at the PHP release date. The Release file
# has an old Valid-Until date, so explicitly disable that check; packages are
# still authenticated by the Ubuntu archive keyring.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
 && printf '%s\n' \
      "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT} noble main universe" \
      "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT} noble-updates main universe" \
      "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT} noble-security main universe" \
      > /etc/apt/sources.list

# Replace the bootstrap packages with their snapshot-pinned versions.
RUN apt-get update -o Acquire::Check-Valid-Until=false \
 && apt-get install -y --no-install-recommends --allow-downgrades \
      "ca-certificates=${CA_CERTIFICATES_VERSION}" \
      "openssl=${OPENSSL_VERSION}" \
      "libssl3t64=${LIBSSL3_VERSION}" \
 && rm -rf /var/lib/apt/lists/*


FROM ubuntu-base AS builder

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG PHP_VERSION=8.5.12
ARG PHP_SOURCE_URL=https://www.php.net/distributions/php-8.5.12.tar.gz
ARG PHP_SOURCE_SHA256=81a0f450349e84b08eb43faa85f8a4c835684f3cc1c50471775d1317a046c525
ARG PHP_SOURCE_BYTES=24469403
ARG PHP_SOURCE_TOP_LEVEL=php-8.5.12
ARG PHP_RELEASE_DATE=2026-10-21
ARG PHP_SOURCE_DATE_EPOCH=1792540800
ARG TARGET=linux-x64
ARG BUILD_JOBS=4
ARG BASE_IMAGE=ubuntu:24.04@sha256:78d4744ead1f5b19b04d0df558ab182a5300903900755e515b2ca4d10eb2044d
ARG UBUNTU_SNAPSHOT=20261021T000000Z

ENV PHP_VERSION=${PHP_VERSION} \
    PHP_SOURCE_URL=${PHP_SOURCE_URL} \
    PHP_SOURCE_SHA256=${PHP_SOURCE_SHA256} \
    PHP_SOURCE_BYTES=${PHP_SOURCE_BYTES} \
    PHP_SOURCE_TOP_LEVEL=${PHP_SOURCE_TOP_LEVEL} \
    PHP_RELEASE_DATE=${PHP_RELEASE_DATE} \
    SOURCE_DATE_EPOCH=${PHP_SOURCE_DATE_EPOCH} \
    TARGET=${TARGET} \
    BUILD_JOBS=${BUILD_JOBS} \
    BASE_IMAGE=${BASE_IMAGE} \
    UBUNTU_SNAPSHOT=${UBUNTU_SNAPSHOT}

# Exact noble/2026-10-21 packages. aws/ccache are intentionally absent: the
# script does not use them and they would add nondeterministic state.
RUN apt-get update -o Acquire::Check-Valid-Until=false \
 && apt-get install -y --no-install-recommends --allow-downgrades \
      "autoconf=2.71-3" \
      "bison=2:3.8.2+dfsg-1ubuntu0.24.04.1" \
      "build-essential=12.10ubuntu1" \
      "libargon2-dev=0~20190702+dfsg-4build1" \
      "libcurl4-openssl-dev=8.5.0-2ubuntu10.16" \
      "libfreetype-dev=2.13.2+dfsg-1ubuntu0.2" \
      "libicu-dev=74.2-1ubuntu3.1" \
      "libjpeg-turbo8-dev=2.1.5-2ubuntu2" \
      "libncurses-dev=6.4+20240113-1ubuntu2.2" \
      "libonig-dev=6.9.9-1build1" \
      "libpcre2-dev=10.42-4ubuntu2.1" \
      "libpng-dev=1.6.43-5ubuntu0.7" \
      "libreadline-dev=8.2-4build1" \
      "libsodium-dev=1.0.18-1ubuntu0.24.04.1" \
      "libsqlite3-dev=3.45.1-1ubuntu2.8" \
      "libssl-dev=3.0.13-0ubuntu3.16" \
      "libwebp-dev=1.3.2-0.4build3" \
      "libxml2-dev=2.9.14+dfsg-1.3ubuntu3.10" \
      "libxslt1-dev=1.1.39-0exp1ubuntu0.24.04.3" \
      "libzip-dev=1.7.3-1.1ubuntu2" \
      "pkg-config=1.8.1-2build1" \
      "re2c=3.1-1build1" \
      "zlib1g-dev=1:1.3.dfsg-3.1ubuntu2.2" \
 && rm -rf /var/lib/apt/lists/*

COPY php-8.5.12.tar.gz /tmp/php.tar.gz
RUN printf '%s  %s\n' "$PHP_SOURCE_SHA256" /tmp/php.tar.gz | sha256sum -c - \
 && test "$(wc -c < /tmp/php.tar.gz | tr -d ' ')" -eq "$PHP_SOURCE_BYTES" \
 && mkdir -p /build/php-src \
 && tar -xzf /tmp/php.tar.gz -C /build/php-src --strip-components=1 \
 && test -f /build/php-src/configure

COPY build-php.sh export-runtime.sh php.ini php-fpm.conf www.conf configure-args.txt expected-extensions.txt /usr/local/share/stackmanage/
RUN chmod 0755 /usr/local/share/stackmanage/build-php.sh /usr/local/share/stackmanage/export-runtime.sh \
 && /usr/local/share/stackmanage/build-php.sh


FROM ubuntu-base AS runtime

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG PHP_VERSION=8.5.12

LABEL org.opencontainers.image.title="StackManage PHP runtime" \
      org.opencontainers.image.description="Pinned PHP 8.5.12 FPM/CLI runtime for StackManage" \
      org.opencontainers.image.version="${PHP_VERSION}" \
      org.opencontainers.image.licenses="PHP-3.01" \
      org.opencontainers.image.source="https://www.php.net/" \
      org.opencontainers.image.created="2026-10-21T00:00:00Z"

# Exact runtime libraries for the statically linked PHP extensions. curl pulls
# its own proxy/TLS dependencies from the same snapshot.
RUN apt-get update -o Acquire::Check-Valid-Until=false \
 && apt-get install -y --no-install-recommends --allow-downgrades \
      "libargon2-1=0~20190702+dfsg-4build1" \
      "libcrypt1=1:4.4.36-4build1" \
      "libcurl4t64=8.5.0-2ubuntu10.16" \
      "libfreetype6=2.13.2+dfsg-1ubuntu0.2" \
      "libicu74=74.2-1ubuntu3.1" \
      "libjpeg-turbo8=2.1.5-2ubuntu2" \
      "libonig5=6.9.9-1build1" \
      "libpcre2-8-0=10.42-4ubuntu2.1" \
      "libpng16-16t64=1.6.43-5ubuntu0.7" \
      "libreadline8t64=8.2-4build1" \
      "libsodium23=1.0.18-1ubuntu0.24.04.1" \
      "libsqlite3-0=3.45.1-1ubuntu2.8" \
      "libstdc++6=14.2.0-4ubuntu2~24.04.1" \
      "libtinfo6=6.4+20240113-1ubuntu2.2" \
      "libwebp7=1.3.2-0.4build3" \
      "libxml2=2.9.14+dfsg-1.3ubuntu3.10" \
      "libxslt1.1=1.1.39-0exp1ubuntu0.24.04.3" \
      "libzip4t64=1.7.3-1.1ubuntu2" \
      "tzdata=2026e-0ubuntu0.24.04.1" \
      "zlib1g=1:1.3.dfsg-3.1ubuntu2.2" \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 php \
 && mkdir -p /opt/php/8.5.12 \
 && useradd --system --uid 10001 --gid php \
      --home-dir /opt/php/8.5.12 \
      --shell /usr/sbin/nologin php

COPY --from=builder --chown=php:php /opt/php /opt/php
RUN dpkg-query -W -f='${Package}=${Version}\n' \
      | LC_ALL=C sort \
      > /opt/php/8.5.12/share/stackmanage/apt-runtime-packages.txt \
 && chown php:php /opt/php/8.5.12/share/stackmanage/apt-runtime-packages.txt

ENV PHP_VERSION=${PHP_VERSION}
ENV PATH=/opt/php/8.5.12/bin:/opt/php/8.5.12/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /opt/php/8.5.12
USER php

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/opt/php/8.5.12/sbin/php-fpm", "-t"]

CMD ["/opt/php/8.5.12/sbin/php-fpm", "-F"]


FROM runtime AS export

ARG JQ_VERSION=1.7.1-3ubuntu0.24.04.2

USER root
RUN apt-get update -o Acquire::Check-Valid-Until=false \
 && apt-get install -y --no-install-recommends --allow-downgrades \
      "jq=${JQ_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

COPY export-runtime.sh /usr/local/bin/export-runtime.sh
RUN chmod 0755 /usr/local/bin/export-runtime.sh \
 && chmod 0777 /opt/php/8.5.12/var/log /opt/php/8.5.12/var/run

USER php
ENTRYPOINT ["/usr/local/bin/export-runtime.sh"]
