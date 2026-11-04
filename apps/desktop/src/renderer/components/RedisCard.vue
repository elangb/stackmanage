<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BridgeResponse, RedisInstallationView, RedisLogsView, RedisStatusView, RedisVersionsView } from '@stackmanage/core';
import { redisController, redisNoticeFor } from '../redis/controller';
import StatusBadge from './StatusBadge.vue';

const { t } = useI18n();

const versions = ref<RedisVersionsView | undefined>();
const status = ref<RedisStatusView | undefined>();
const installations = ref<RedisInstallationView[]>([]);
const logs = ref<RedisLogsView | undefined>();
const loading = ref(true);
const loadErrorKey = ref<string | undefined>();
const logsOpen = ref(false);

const pinnedVersion = computed(() => versions.value?.pinnedVersion ?? status.value?.pinnedVersion ?? '7.2.7');
const supported = computed(() => status.value?.supported ?? versions.value?.supported ?? false);
const tested = computed(() => status.value?.tested ?? versions.value?.tested ?? false);
const installed = computed(() => status.value?.installed === true && status.value?.installation !== undefined);
const installation = computed(() => status.value?.installation);
const serviceState = computed(() => status.value?.service.state ?? 'stopped');
const servicePort = computed(() => status.value?.service.port ?? 16379);
const busy = computed(() => redisController.state.operation !== undefined);
const notice = computed(() => redisController.state.notice);
const progress = computed(() => redisController.state.progress);
const progressPercent = computed(() => Math.round((progress.value?.value ?? 0) * 100));
const operationKey = computed(() => {
  const operation = redisController.state.operation;
  if (operation === undefined) return undefined;
  return `redisOperation${operation.charAt(0).toUpperCase()}${operation.slice(1)}`;
});
const evidenceKey = computed(() => (!supported.value ? 'redisUnsupported' : tested.value ? 'redisTested' : 'redisUnverified'));
const platformFacts = computed(() => `${status.value?.platform ?? '—'} / ${status.value?.architecture ?? '—'}`);
const runDisabled = computed(() => busy.value || !installed.value);
const uninstallDisabled = computed(() => busy.value || serviceState.value === 'running' || (serviceState.value === 'unknown' && status.value?.service.pid !== undefined));

function operationId(): string {
  return `ui-${crypto.randomUUID()}`;
}

function resultError(response: BridgeResponse): string | undefined {
  if (!response.ok) return 'redisErrorUnavailable';
  const data = response.data;
  if ('data' in data && typeof data.data === 'object' && data.data !== null && 'status' in data.data) {
    const result = data.data as { status: string; items?: Array<{ error?: { code: string; messageKey: string; retryable: boolean } }> };
    if (result.status === 'failed' || result.status === 'partial' || result.status === 'unknown') {
      const error = result.items?.find(item => item.error !== undefined)?.error;
      return error !== undefined ? redisNoticeFor(error).messageKey : 'redisErrorUnknown';
    }
  }
  return undefined;
}

async function refresh(): Promise<void> {
  loadErrorKey.value = undefined;
  const [versionsResponse, statusResponse, listResponse] = await Promise.all([
    redisController.versions(),
    redisController.status(),
    redisController.list()
  ]);
  if (versionsResponse.ok && versionsResponse.data.method === 'redis.versions') versions.value = versionsResponse.data.data;
  else loadErrorKey.value = resultError(versionsResponse) ?? 'redisErrorUnknown';

  if (statusResponse.ok && statusResponse.data.method === 'redis.status') status.value = statusResponse.data.data;
  else loadErrorKey.value = resultError(statusResponse) ?? 'redisErrorUnknown';

  if (listResponse.ok && listResponse.data.method === 'redis.list') installations.value = listResponse.data.data.installations;
  else loadErrorKey.value = resultError(listResponse) ?? 'redisErrorUnknown';
  loading.value = false;
}

async function install(): Promise<void> {
  if (!supported.value || status.value === undefined) return;
  await redisController.install({
    operationId: operationId(),
    moduleId: 'redis',
    version: pinnedVersion.value,
    platform: status.value.platform,
    architecture: status.value.architecture
  });
  await refresh();
}

async function uninstall(): Promise<void> {
  if (installation.value === undefined) return;
  await redisController.uninstall({ operationId: operationId(), installationId: installation.value.id });
  await refresh();
}

async function start(): Promise<void> {
  await redisController.start({ operationId: operationId() });
  await refresh();
}

async function stop(): Promise<void> {
  await redisController.stop({ operationId: operationId() });
  await refresh();
}

async function toggleLogs(): Promise<void> {
  logsOpen.value = !logsOpen.value;
  if (!logsOpen.value) return;
  const response = await redisController.logs({ maxBytes: 65536 });
  if (response.ok && response.data.method === 'redis.logs') logs.value = response.data.data;
}

let poll: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  await refresh();
  poll = setInterval(() => {
    if (!busy.value) void refresh();
  }, 6000);
});
onBeforeUnmount(() => {
  if (poll !== undefined) clearInterval(poll);
});
</script>

<template>
  <section class="panel" aria-labelledby="redis-title">
    <div class="panel-head">
      <div>
        <h2 id="redis-title" class="panel-title">{{ t('redisTitle') }}</h2>
        <p class="panel-desc">{{ t('redisSubtitle') }}</p>
      </div>
      <div class="row" style="gap: 8px; align-items: center">
        <span class="badge badge-info">{{ t('redisPinned') }} {{ pinnedVersion }}</span>
        <StatusBadge :status="serviceState" />
      </div>
    </div>
    <div class="panel-body stack">
      <div v-if="notice" class="notice" :class="notice.level === 'error' ? 'notice-error' : 'notice-info'" role="alert">
        <span class="notice-icon" aria-hidden="true">{{ notice.level === 'error' ? '!' : 'i' }}</span>
        <span style="flex: 1">{{ t(notice.messageKey) }}</span>
        <button type="button" class="btn btn-sm btn-ghost" @click="redisController.clearNotice()">{{ t('dismiss') }}</button>
      </div>
      <div v-if="loadErrorKey" class="notice notice-warn" role="alert">
        <span class="notice-icon" aria-hidden="true">!</span>
        <span>{{ t(loadErrorKey) }}</span>
      </div>

      <div v-if="!supported" class="notice notice-warn">
        <span class="notice-icon" aria-hidden="true">!</span>
        <span>{{ t('redisUnsupported') }}</span>
      </div>
      <div v-else-if="!tested" class="notice notice-warn">
        <span class="notice-icon" aria-hidden="true">!</span>
        <span>{{ t('redisUnverified') }}</span>
      </div>
      <div v-else class="notice notice-info">
        <span class="notice-icon" aria-hidden="true">✓</span>
        <span>{{ t('redisTested') }}</span>
      </div>

      <div v-if="busy" aria-live="polite">
        <div class="progress-label">
          <span>{{ t('progressTitle') }} · {{ operationKey !== undefined ? t(operationKey) : '' }}</span>
          <span class="mono">{{ t('percent', { value: progressPercent }) }}</span>
        </div>
        <div class="progress" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-bar" :style="{ width: `${progressPercent}%` }" />
        </div>
        <p v-if="progress" class="help" style="margin: 8px 0 0">{{ t('progressStage') }}: <span class="mono">{{ progress.stage }}</span></p>
      </div>

      <div class="row">
        <button v-if="!installed" type="button" class="btn btn-primary" :disabled="busy || !supported || loading" @click="install">
          {{ redisController.state.operation === 'install' ? t('redisInstalling') : t('redisInstall') }}
        </button>
        <template v-else>
          <button v-if="serviceState !== 'running'" type="button" class="btn btn-primary" :disabled="runDisabled" @click="start">
            {{ redisController.state.operation === 'start' ? t('redisStarting') : t('redisStart') }}
          </button>
          <button v-else type="button" class="btn" :disabled="busy" @click="stop">
            {{ redisController.state.operation === 'stop' ? t('redisStopping') : t('redisStop') }}
          </button>
          <button type="button" class="btn btn-danger" :disabled="uninstallDisabled" @click="uninstall">
            {{ redisController.state.operation === 'uninstall' ? t('redisUninstalling') : t('redisUninstall') }}
          </button>
        </template>
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="refresh">{{ t('redisRefresh') }}</button>
      </div>
      <p v-if="installed && serviceState === 'running'" class="help" style="margin: 0">{{ t('redisStopBeforeUninstall') }}</p>

      <template v-if="status">
        <div class="divider" />
        <dl class="kv">
          <dt>{{ t('redisVersion') }}</dt>
          <dd class="mono">{{ installation?.versionOutput ?? pinnedVersion }}</dd>
          <dt>{{ t('redisCliVersion') }}</dt>
          <dd class="mono">{{ installation?.cliVersionOutput ?? '—' }}</dd>
          <dt>{{ t('platformLabel') }}</dt>
          <dd class="mono">{{ platformFacts }}</dd>
          <dt>{{ t('redisEndpoint') }}</dt>
          <dd class="mono">{{ status.service.bind }}:{{ servicePort }}</dd>
          <dt>{{ t('pid') }}</dt>
          <dd>{{ status.service.pid ?? '—' }}</dd>
          <dt>{{ t('redisBinary') }}</dt>
          <dd class="mono" style="font-size: 0.72rem">{{ installation?.serverPath ?? '—' }}</dd>
          <dt>{{ t('redisDataDir') }}</dt>
          <dd class="mono" style="font-size: 0.72rem">{{ status.service.dataDir }}</dd>
          <dt>{{ t('redisConfigPath') }}</dt>
          <dd class="mono" style="font-size: 0.72rem">{{ status.service.configPath }}</dd>
          <dt>{{ t('redisEvidence') }}</dt>
          <dd>{{ t(evidenceKey) }}</dd>
        </dl>
        <div class="row">
          <button type="button" class="btn btn-sm btn-ghost" :disabled="busy" @click="toggleLogs">
            {{ logsOpen ? t('redisHideLogs') : t('redisShowLogs') }}
          </button>
        </div>
        <p v-if="installation === undefined && !loading" class="empty">{{ t('redisNotInstalledHint') }}</p>
      </template>

      <div v-if="logsOpen">
        <p class="help" style="margin: 0 0 6px">{{ t('redisLogsHint') }} <span class="mono">{{ logs?.path ?? status?.service.logPath ?? '—' }}</span></p>
        <pre v-if="logs?.text" class="log" aria-live="polite">{{ logs.text }}</pre>
        <p v-else class="empty">{{ t('redisLogsEmpty') }}</p>
      </div>

      <p class="help" style="margin: 0">{{ t('redisBuildHint') }}</p>
      <p class="help" style="margin: 0">{{ t('redisSecurityNote') }}</p>
    </div>
  </section>
</template>
