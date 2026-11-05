<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PhpLogsView, PhpStatusView, PhpVersionsView } from '@stackmanage/core';
import { phpController } from '../php/controller';

const { t } = useI18n();
const versions = ref<PhpVersionsView | undefined>();
const status = ref<PhpStatusView | undefined>();
const logs = ref<PhpLogsView | undefined>();
const loadErrorKey = ref<string | undefined>();
const loading = ref(true);

const busy = computed(() => phpController.state.operation !== undefined);
const notice = computed(() => phpController.state.notice);
const progress = computed(() => phpController.state.progress);
const progressPercent = computed(() => Math.round((progress.value?.value ?? 0) * 100));
const pinned = computed(() => versions.value?.pinnedVersion ?? status.value?.pinnedVersion ?? '8.5.12');
const supported = computed(() => status.value?.supported ?? versions.value?.supported ?? false);
const installed = computed(() => status.value?.installed === true && status.value.installation !== undefined);
const installation = computed(() => status.value?.installation);
const serviceState = computed(() => status.value?.service.state ?? 'stopped');
const running = computed(() => serviceState.value === 'running');

function operationId(): string {
  return `ui-${crypto.randomUUID()}`;
}

async function refresh(): Promise<void> {
  loadErrorKey.value = undefined;
  const [versionsResponse, statusResponse, logsResponse] = await Promise.all([
    phpController.versions(),
    phpController.status(),
    phpController.logs({ maxBytes: 16384 })
  ]);
  if (versionsResponse.ok && versionsResponse.data.method === 'php.versions') versions.value = versionsResponse.data.data;
  if (statusResponse.ok && statusResponse.data.method === 'php.status') status.value = statusResponse.data.data;
  else loadErrorKey.value = 'phpErrorUnknown';
  if (logsResponse.ok && logsResponse.data.method === 'php.logs') logs.value = logsResponse.data.data;
  loading.value = false;
}

async function run(action: () => Promise<unknown>): Promise<void> {
  await action();
  await refresh();
}

async function install(): Promise<void> {
  if (status.value === undefined) return;
  await run(() =>
    phpController.install({
      operationId: operationId(),
      moduleId: 'php',
      version: pinned.value,
      platform: status.value?.platform ?? 'linux',
      architecture: status.value?.architecture ?? 'x64'
    })
  );
}

async function uninstall(): Promise<void> {
  if (installation.value === undefined) return;
  await run(() => phpController.uninstall({ operationId: operationId(), installationId: installation.value!.id }));
}

async function start(): Promise<void> {
  await run(() => phpController.start({ operationId: operationId() }));
}

async function stop(): Promise<void> {
  await run(() => phpController.stop({ operationId: operationId() }));
}

let poll: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  phpController.attach();
  await refresh();
  poll = setInterval(() => {
    if (!busy.value) void refresh();
  }, 5000);
});
onBeforeUnmount(() => {
  if (poll !== undefined) clearInterval(poll);
  phpController.detach();
});
</script>

<template>
  <section class="panel" aria-labelledby="php-runtime-title">
    <div class="panel-head">
      <div>
        <h2 id="php-runtime-title" class="panel-title">{{ t('phpTitle') }}</h2>
        <p class="panel-desc">{{ t('phpSubtitle') }}</p>
      </div>
      <span class="badge" :class="installed ? 'badge-success' : ''">
        <span class="badge-dot" aria-hidden="true" />
        {{ installed ? t('phpInstalled') : t('phpNotInstalled') }}
      </span>
    </div>
    <div class="panel-body stack">
      <div v-if="notice" class="notice notice-error" role="alert">
        <span class="notice-icon" aria-hidden="true">!</span>
        <span style="flex: 1">{{ t(notice.messageKey) }}</span>
        <button type="button" class="btn btn-sm btn-ghost" @click="phpController.clearNotice()">{{ t('dismiss') }}</button>
      </div>
      <div v-if="loadErrorKey" class="notice notice-warn" role="alert">
        <span class="notice-icon" aria-hidden="true">!</span>
        <span>{{ t(loadErrorKey) }}</span>
      </div>

      <div class="notice notice-info">
        <span class="notice-icon" aria-hidden="true">i</span>
        <span>{{ t('phpRuntimeHint') }}</span>
      </div>

      <div v-if="busy" aria-live="polite">
        <div class="progress-label">
          <span>{{ t('progressTitle') }}</span>
          <span class="mono">{{ t('percent', { value: progressPercent }) }}</span>
        </div>
        <div class="progress" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-bar" :style="{ width: `${progressPercent}%` }" />
        </div>
        <p v-if="progress" class="help" style="margin: 8px 0 0">{{ t('progressStage') }}: <span class="mono">{{ progress.stage }}</span></p>
      </div>

      <div class="row">
        <button v-if="!installed" type="button" class="btn btn-primary" :disabled="busy || !supported || loading" @click="install">
          {{ phpController.state.operation === 'install' ? t('phpInstalling') : t('phpInstall') }}
        </button>
        <template v-else>
          <button v-if="!running" type="button" class="btn btn-primary" :disabled="busy" @click="start">
            {{ phpController.state.operation === 'start' ? t('phpStarting') : t('phpStart') }}
          </button>
          <button v-else type="button" class="btn" :disabled="busy" @click="stop">
            {{ phpController.state.operation === 'stop' ? t('phpStopping') : t('phpStop') }}
          </button>
          <button type="button" class="btn btn-danger" :disabled="busy || running" @click="uninstall">
            {{ phpController.state.operation === 'uninstall' ? t('phpUninstalling') : t('phpUninstall') }}
          </button>
          <button type="button" class="btn btn-ghost" :disabled="busy" @click="refresh">{{ t('phpRefresh') }}</button>
        </template>
      </div>

      <template v-if="installation">
        <div class="divider" />
        <dl class="kv">
          <dt>{{ t('phpVersionLabel') }}</dt>
          <dd class="mono">{{ installation.versionOutput }}</dd>
          <dt>{{ t('phpFpmBinary') }}</dt>
          <dd class="mono" style="font-size: 0.72rem">{{ installation.fpmPath }}</dd>
          <dt>{{ t('phpFastcgi') }}</dt>
          <dd class="mono">127.0.0.1:19000</dd>
          <dt>{{ t('phpServiceState') }}</dt>
          <dd>{{ t(`status${serviceState.charAt(0).toUpperCase()}${serviceState.slice(1)}`) }}<span v-if="status?.service.pid" class="mono faint"> · PID {{ status.service.pid }}</span></dd>
          <dt>{{ t('phpPinned') }}</dt>
          <dd class="mono">v{{ pinned }}</dd>
        </dl>
        <div v-if="logs" class="stack" style="gap: 6px">
          <div class="stat-label">{{ t('phpLogs') }}</div>
          <pre class="mono" style="max-height: 160px; overflow: auto; font-size: 0.7rem; margin: 0">{{ logs.text.trim() === '' ? t('logsEmpty') : logs.text }}</pre>
        </div>
      </template>
      <p v-else-if="!loading" class="empty">{{ t('phpRuntimeHint') }}</p>
    </div>
  </section>
</template>
