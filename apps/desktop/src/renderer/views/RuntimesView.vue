<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BridgeResponse, RuntimeInstallationView, RuntimeStatusView, RuntimeVersionsView, Snapshot } from '@stackmanage/core';
import { runtimeController } from '../runtime/controller';

defineProps<{ snapshot: Snapshot | undefined }>();
const { t } = useI18n();

const versions = ref<RuntimeVersionsView | undefined>();
const status = ref<RuntimeStatusView | undefined>();
const installations = ref<RuntimeInstallationView[]>([]);
const loadErrorKey = ref<string | undefined>();
const loading = ref(true);

const busy = computed(() => runtimeController.state.operation !== undefined);
const notice = computed(() => runtimeController.state.notice);
const progress = computed(() => runtimeController.state.progress);
const progressPercent = computed(() => Math.round((progress.value?.value ?? 0) * 100));
const pinnedVersion = computed(() => versions.value?.pinnedVersion ?? '24.22.2');
const supported = computed(() => status.value?.supported ?? versions.value?.supported ?? false);
const tested = computed(() => status.value?.tested ?? versions.value?.tested ?? false);
const installed = computed(() => status.value?.installed === true && status.value.installation !== undefined);
const installation = computed(() => status.value?.installation);
const evidenceKey = computed(() => {
  if (!supported.value) return 'runtimeUnsupported';
  return tested.value ? 'runtimeTested' : 'runtimeUnverified';
});
const platformFacts = computed(() => `${status.value?.platform ?? versions.value?.platform ?? '—'} / ${status.value?.architecture ?? versions.value?.architecture ?? '—'}`);
const pathSeparator = computed(() => status.value?.platform === 'win32' ? ';' : ':');
const operationKey = computed(() => {
  const operation = runtimeController.state.operation;
  if (operation === 'install') return 'runtimeOperationInstall';
  if (operation === 'uninstall') return 'runtimeOperationUninstall';
  return undefined;
});

function operationId(): string {
  return `ui-${crypto.randomUUID()}`;
}

function resultError(response: BridgeResponse): string | undefined {
  if (!response.ok) return 'runtimeErrorUnavailable';
  const data = response.data;
  if ('data' in data && typeof data.data === 'object' && data.data !== null && 'status' in data.data) {
    const result = data.data as { status: string; items?: Array<{ error?: { messageKey: string } }> };
    if (result.status === 'failed' || result.status === 'partial') {
      const key = result.items?.find(item => item.error !== undefined)?.error?.messageKey;
      const map: Record<string, string> = {
        'runtime.notInstalled': 'runtimeErrorNotInstalled',
        'runtime.uninstallOutsideManagedRoot': 'runtimeErrorOutsideRoot',
        'runtime.digestMismatch': 'runtimeErrorDigestMismatch',
        'runtime.downloadFailed': 'runtimeErrorDownloadFailed',
        'runtime.downloadTooLarge': 'runtimeErrorDownloadTooLarge',
        'runtime.platformUnsupported': 'runtimeErrorPlatformUnsupported',
        'runtime.platformMismatch': 'runtimeErrorPlatformMismatch',
        'runtime.installBusy': 'runtimeErrorBusy',
        'runtime.commitFailed': 'runtimeErrorCommitFailed'
      };
      return (key !== undefined ? map[key] : undefined) ?? 'runtimeErrorUnknown';
    }
  }
  return undefined;
}

async function refresh(): Promise<void> {
  loadErrorKey.value = undefined;
  const [versionsResponse, statusResponse, listResponse] = await Promise.all([
    runtimeController.versions('node'),
    runtimeController.status('node'),
    runtimeController.list('node')
  ]);
  if (versionsResponse.ok && versionsResponse.data.method === 'runtime.versions') versions.value = versionsResponse.data.data;
  else loadErrorKey.value = resultError(versionsResponse) ?? 'runtimeErrorUnknown';

  if (statusResponse.ok && statusResponse.data.method === 'runtime.status') status.value = statusResponse.data.data;
  else loadErrorKey.value = resultError(statusResponse) ?? 'runtimeErrorUnknown';

  if (listResponse.ok && listResponse.data.method === 'runtime.list') installations.value = listResponse.data.data.installations;
  else loadErrorKey.value = resultError(listResponse) ?? 'runtimeErrorUnknown';
  loading.value = false;
}

async function install(): Promise<void> {
  if (!supported.value || status.value === undefined) return;
  await runtimeController.install({
    operationId: operationId(),
    moduleId: 'node',
    version: pinnedVersion.value,
    platform: status.value.platform,
    architecture: status.value.architecture
  });
  await refresh();
}

async function uninstall(): Promise<void> {
  const current = installation.value;
  if (current === undefined) return;
  await runtimeController.uninstall({ operationId: operationId(), installationId: current.id });
  await refresh();
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
  <section class="page-head">
    <div class="spread">
      <div>
        <span class="eyebrow">{{ t('navRuntimes') }}</span>
        <h1 class="page-title">{{ t('runtimeTitle') }}</h1>
        <p class="page-subtitle">{{ t('runtimeSubtitle') }}</p>
      </div>
      <span class="badge badge-info">{{ t('runtimePinned') }} v{{ pinnedVersion }}</span>
    </div>
  </section>

  <div v-if="notice" class="notice" :class="notice.level === 'error' ? 'notice-error' : 'notice-info'" role="alert" style="margin-bottom: 18px">
    <span class="notice-icon" aria-hidden="true">{{ notice.level === 'error' ? '!' : 'i' }}</span>
    <span style="flex: 1">{{ t(notice.messageKey) }}</span>
    <button type="button" class="btn btn-sm btn-ghost" @click="runtimeController.clearNotice()">{{ t('dismiss') }}</button>
  </div>
  <div v-if="loadErrorKey" class="notice notice-warn" role="alert" style="margin-bottom: 18px">
    <span class="notice-icon" aria-hidden="true">!</span>
    <span>{{ t(loadErrorKey) }}</span>
  </div>

  <div class="grid grid-2">
    <div class="stack">
      <section class="panel" aria-labelledby="node-runtime-title">
        <div class="panel-head">
          <div>
            <h2 id="node-runtime-title" class="panel-title">{{ t('runtimeTitle') }}</h2>
            <p class="panel-desc">{{ t('runtimeNoService') }}</p>
          </div>
          <span class="badge" :class="installed ? 'badge-success' : ''">
            <span class="badge-dot" aria-hidden="true" />
            {{ installed ? t('runtimeInstalled') : t('runtimeNotInstalled') }}
          </span>
        </div>
        <div class="panel-body stack">
          <div v-if="!supported" class="notice notice-warn">
            <span class="notice-icon" aria-hidden="true">!</span>
            <span>{{ t('runtimeUnsupported') }}</span>
          </div>
          <div v-else-if="!tested" class="notice notice-warn">
            <span class="notice-icon" aria-hidden="true">!</span>
            <span>{{ t('runtimeUnverified') }}</span>
          </div>
          <div v-else class="notice notice-info">
            <span class="notice-icon" aria-hidden="true">✓</span>
            <span>{{ t('runtimeTested') }}</span>
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
              {{ runtimeController.state.operation === 'install' ? t('runtimeInstalling') : t('runtimeInstall') }}
            </button>
            <button v-else type="button" class="btn btn-danger" :disabled="busy" @click="uninstall">
              {{ runtimeController.state.operation === 'uninstall' ? t('runtimeUninstalling') : t('runtimeUninstall') }}
            </button>
            <button type="button" class="btn btn-ghost" :disabled="busy" @click="refresh">{{ t('runtimeRefresh') }}</button>
          </div>

          <template v-if="installation">
            <div class="divider" />
            <dl class="kv">
              <dt>{{ t('runtimeInstalledVersion') }}</dt>
              <dd class="mono">{{ installation.versionOutput }}</dd>
              <dt>{{ t('runtimeBinary') }}</dt>
              <dd class="mono" style="font-size: 0.72rem">{{ installation.binaryPath }}</dd>
              <dt>{{ t('runtimePathPlan') }}</dt>
              <dd class="mono" style="font-size: 0.72rem">{{ installation.pathPrepend.join(pathSeparator) }}</dd>
            </dl>
            <p class="help" style="margin: 0">{{ t('runtimePathHint') }}</p>
          </template>
          <p v-else-if="!loading" class="empty">{{ t('runtimeNoInstallations') }}</p>
        </div>
      </section>

      <section class="panel" aria-labelledby="node-artifacts-title">
        <div class="panel-head">
          <div>
            <h2 id="node-artifacts-title" class="panel-title">{{ t('runtimeArtifacts') }}</h2>
            <p class="panel-desc">{{ t('runtimeEvidence') }}</p>
          </div>
          <span class="badge">{{ installations.length }}</span>
        </div>
        <div class="panel-body">
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">{{ t('platformLabel') }}</th>
                  <th scope="col">{{ t('archLabel') }}</th>
                  <th scope="col">{{ t('runtimeEvidenceColumn') }}</th>
                  <th scope="col">{{ t('checksum') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="version in versions?.versions ?? []" :key="`${version.platform}-${version.architecture}`">
                  <td>{{ version.platform }}</td>
                  <td class="mono">{{ version.architecture }}</td>
                  <td>
                    <span class="badge" :class="version.tested ? 'badge-success' : 'badge-warn'">
                      {{ version.tested ? t('runtimeTestedShort') : t('runtimeUnverifiedShort') }}
                    </span>
                  </td>
                  <td class="mono" style="font-size: 0.7rem">{{ version.sha256.slice(0, 16) }}…</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>

    <div class="stack">
      <section class="panel" aria-labelledby="node-facts-title">
        <div class="panel-head">
          <h2 id="node-facts-title" class="panel-title">{{ t('runtimeVendor') }}</h2>
        </div>
        <div class="panel-body">
          <dl class="kv">
            <dt>{{ t('runtimePinned') }}</dt>
            <dd class="mono">v{{ pinnedVersion }}</dd>
            <dt>{{ t('platformLabel') }}</dt>
            <dd class="mono">{{ platformFacts }}</dd>
            <dt>{{ t('runtimeSupport') }}</dt>
            <dd>{{ t(evidenceKey) }}</dd>
            <dt>{{ t('checksum') }}</dt>
            <dd aria-label="verified">✓ SHA-256</dd>
            <dt>{{ t('runtimeService') }}</dt>
            <dd>{{ t('runtimeNoServiceShort') }}</dd>
          </dl>
          <p class="help" style="margin: 18px 0 0">{{ t('runtimeEvidence') }}</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.table-wrap { overflow-x: auto; }
.table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
.table th, .table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.table th { color: var(--text-faint); font-size: 0.7rem; letter-spacing: 0.05em; text-transform: uppercase; }
.table tr:last-child td { border-bottom: 0; }
</style>
