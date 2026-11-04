<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type {
  BridgeResponse,
  ConfigReadView,
  NginxInstallationView,
  NginxLogsView,
  NginxStatusView,
  NginxVersionsView
} from '@stackmanage/core';
import { nginxController, nginxNoticeFor } from '../nginx/controller';
import StatusBadge from './StatusBadge.vue';

const { t } = useI18n();

const versions = ref<NginxVersionsView | undefined>();
const status = ref<NginxStatusView | undefined>();
const installations = ref<NginxInstallationView[]>([]);
const logs = ref<NginxLogsView | undefined>();
const config = ref<ConfigReadView | undefined>();
const loading = ref(true);
const loadErrorKey = ref<string | undefined>();
const logsOpen = ref(false);
const configOpen = ref(false);

const pinnedVersion = computed(() => versions.value?.pinnedVersion ?? status.value?.pinnedVersion ?? '1.30.6');
const supported = computed(() => status.value?.supported ?? versions.value?.supported ?? false);
const tested = computed(() => status.value?.tested ?? versions.value?.tested ?? false);
const installed = computed(() => status.value?.installed === true && status.value?.installation !== undefined);
const installation = computed(() => status.value?.installation);
const serviceState = computed(() => status.value?.service.state ?? 'stopped');
const servicePort = computed(() => status.value?.service.port ?? 18081);
const serviceUrl = computed(() => `http://127.0.0.1:${servicePort.value}/`);
const busy = computed(() => nginxController.state.operation !== undefined);
const notice = computed(() => nginxController.state.notice);
const progress = computed(() => nginxController.state.progress);
const progressPercent = computed(() => Math.round((progress.value?.value ?? 0) * 100));
const operationKey = computed(() => {
  const operation = nginxController.state.operation;
  if (operation === undefined) return undefined;
  return `nginxOperation${operation.charAt(0).toUpperCase()}${operation.slice(1)}`;
});
const evidenceKey = computed(() => (!supported.value ? 'nginxUnsupported' : tested.value ? 'nginxTested' : 'nginxUnverified'));
const platformFacts = computed(() => `${status.value?.platform ?? '—'} / ${status.value?.architecture ?? '—'}`);
const runDisabled = computed(() => busy.value || !installed.value);

function operationId(): string {
  return `ui-${crypto.randomUUID()}`;
}

function resultError(response: BridgeResponse): string | undefined {
  if (!response.ok) return 'nginxErrorUnavailable';
  const data = response.data;
  if ('data' in data && typeof data.data === 'object' && data.data !== null && 'status' in data.data) {
    const result = data.data as { status: string; items?: Array<{ error?: { code: string; messageKey: string; retryable: boolean } }> };
    if (result.status === 'failed' || result.status === 'partial' || result.status === 'unknown') {
      const error = result.items?.find(item => item.error !== undefined)?.error;
      return error !== undefined ? nginxNoticeFor(error).messageKey : 'nginxErrorUnknown';
    }
  }
  return undefined;
}

async function refresh(): Promise<void> {
  loadErrorKey.value = undefined;
  const [versionsResponse, statusResponse, listResponse] = await Promise.all([
    nginxController.versions(),
    nginxController.status(),
    nginxController.list()
  ]);
  if (versionsResponse.ok && versionsResponse.data.method === 'nginx.versions') versions.value = versionsResponse.data.data;
  else loadErrorKey.value = resultError(versionsResponse) ?? 'nginxErrorUnknown';

  if (statusResponse.ok && statusResponse.data.method === 'nginx.status') status.value = statusResponse.data.data;
  else loadErrorKey.value = resultError(statusResponse) ?? 'nginxErrorUnknown';

  if (listResponse.ok && listResponse.data.method === 'nginx.list') installations.value = listResponse.data.data.installations;
  else loadErrorKey.value = resultError(listResponse) ?? 'nginxErrorUnknown';
  loading.value = false;
}

async function install(): Promise<void> {
  if (!supported.value || status.value === undefined) return;
  await nginxController.install({
    operationId: operationId(),
    moduleId: 'nginx',
    version: pinnedVersion.value,
    platform: status.value.platform,
    architecture: status.value.architecture
  });
  await refresh();
}

async function uninstall(): Promise<void> {
  if (installation.value === undefined) return;
  await nginxController.uninstall({ operationId: operationId(), installationId: installation.value.id });
  await refresh();
}

async function start(): Promise<void> {
  await nginxController.start({ operationId: operationId() });
  await refresh();
}

async function stop(): Promise<void> {
  await nginxController.stop({ operationId: operationId() });
  await refresh();
}

async function reload(): Promise<void> {
  await nginxController.reload({ operationId: operationId() });
  await refresh();
}

async function toggleLogs(): Promise<void> {
  logsOpen.value = !logsOpen.value;
  if (!logsOpen.value) return;
  const response = await nginxController.logs({ maxBytes: 65536 });
  if (response.ok && response.data.method === 'nginx.logs') logs.value = response.data.data;
}

async function toggleConfig(): Promise<void> {
  configOpen.value = !configOpen.value;
  if (!configOpen.value) return;
  const response = await nginxController.config();
  if (response.ok && response.data.method === 'nginx.config') config.value = response.data.data;
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
  <section class="panel" aria-labelledby="nginx-title" style="margin-top: 18px">
    <div class="panel-head">
      <div>
        <h2 id="nginx-title" class="panel-title">{{ t('nginxTitle') }}</h2>
        <p class="panel-desc">{{ t('nginxSubtitle') }}</p>
      </div>
      <div class="row" style="gap: 8px; align-items: center">
        <span class="badge badge-info">{{ t('nginxPinned') }} {{ pinnedVersion }}</span>
        <StatusBadge :status="serviceState" />
      </div>
    </div>
    <div class="panel-body stack">
      <div v-if="notice" class="notice" :class="notice.level === 'error' ? 'notice-error' : 'notice-info'" role="alert">
        <span class="notice-icon" aria-hidden="true">{{ notice.level === 'error' ? '!' : 'i' }}</span>
        <span style="flex: 1">{{ t(notice.messageKey) }}</span>
        <button type="button" class="btn btn-sm btn-ghost" @click="nginxController.clearNotice()">{{ t('dismiss') }}</button>
      </div>
      <div v-if="loadErrorKey" class="notice notice-warn" role="alert">
        <span class="notice-icon" aria-hidden="true">!</span>
        <span>{{ t(loadErrorKey) }}</span>
      </div>

      <div v-if="!supported" class="notice notice-warn">
        <span class="notice-icon" aria-hidden="true">!</span>
        <span>{{ t('nginxUnsupported') }}</span>
      </div>
      <div v-else-if="!tested" class="notice notice-warn">
        <span class="notice-icon" aria-hidden="true">!</span>
        <span>{{ t('nginxUnverified') }}</span>
      </div>
      <div v-else class="notice notice-info">
        <span class="notice-icon" aria-hidden="true">✓</span>
        <span>{{ t('nginxTested') }}</span>
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
          {{ nginxController.state.operation === 'install' ? t('nginxInstalling') : t('nginxInstall') }}
        </button>
        <template v-else>
          <button v-if="serviceState !== 'running'" type="button" class="btn btn-primary" :disabled="runDisabled" @click="start">
            {{ nginxController.state.operation === 'start' ? t('nginxStarting') : t('nginxStart') }}
          </button>
          <button v-else type="button" class="btn" :disabled="busy" @click="stop">
            {{ nginxController.state.operation === 'stop' ? t('nginxStopping') : t('nginxStop') }}
          </button>
          <button type="button" class="btn" :disabled="busy || serviceState !== 'running'" @click="reload">
            {{ nginxController.state.operation === 'reload' ? t('nginxReloading') : t('nginxReload') }}
          </button>
          <button type="button" class="btn btn-danger" :disabled="busy || serviceState === 'running'" @click="uninstall">
            {{ nginxController.state.operation === 'uninstall' ? t('nginxUninstalling') : t('nginxUninstall') }}
          </button>
        </template>
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="refresh">{{ t('nginxRefresh') }}</button>
      </div>
      <p v-if="installed && serviceState === 'running'" class="help" style="margin: 0">{{ t('nginxStopBeforeUninstall') }}</p>

      <template v-if="status">
        <div class="divider" />
        <dl class="kv">
          <dt>{{ t('nginxVersion') }}</dt>
          <dd class="mono">{{ installation?.versionOutput ?? pinnedVersion }}</dd>
          <dt>{{ t('platformLabel') }}</dt>
          <dd class="mono">{{ platformFacts }}</dd>
          <dt>{{ t('nginxPort') }}</dt>
          <dd class="mono">{{ servicePort }}</dd>
          <dt>{{ t('nginxDefaultUrl') }}</dt>
          <dd class="mono">{{ serviceUrl }}</dd>
          <dt>{{ t('pid') }}</dt>
          <dd>{{ status.service.pid ?? '—' }}</dd>
          <dt>{{ t('nginxBinary') }}</dt>
          <dd class="mono" style="font-size: 0.72rem">{{ installation?.binaryPath ?? '—' }}</dd>
          <dt>{{ t('nginxEvidence') }}</dt>
          <dd>{{ t(evidenceKey) }}</dd>
          <dt>{{ t('nginxSignature') }}</dt>
          <dd>{{ t('nginxSignatureNote') }}</dd>
        </dl>
        <div class="row">
          <button type="button" class="btn btn-sm btn-ghost" :disabled="busy" @click="toggleLogs">
            {{ logsOpen ? t('nginxHideLogs') : t('nginxShowLogs') }}
          </button>
          <button type="button" class="btn btn-sm btn-ghost" :disabled="busy" @click="toggleConfig">
            {{ configOpen ? t('nginxHideConfig') : t('nginxShowConfig') }}
          </button>
        </div>
        <p v-if="installation === undefined && !loading" class="empty">{{ t('nginxNotInstalledHint') }}</p>
      </template>

      <div v-if="logsOpen">
        <p class="help" style="margin: 0 0 6px">{{ t('nginxLogsHint') }} <span class="mono">{{ logs?.path ?? status?.service.logPath ?? '—' }}</span></p>
        <pre v-if="logs?.text" class="log" aria-live="polite">{{ logs.text }}</pre>
        <p v-else class="empty">{{ t('nginxLogsEmpty') }}</p>
      </div>
      <div v-if="configOpen">
        <p class="help" style="margin: 0 0 6px">{{ config?.path ?? '' }}</p>
        <pre v-if="config?.exists" class="log">{{ config.content }}</pre>
        <p v-else class="empty">{{ t('nginxConfigMissing') }}</p>
      </div>

      <p class="help" style="margin: 0">{{ t('nginxBuildHint') }}</p>
      <p class="help" style="margin: 0">{{ t('nginxWindowsPlan') }}</p>
    </div>
  </section>
</template>
