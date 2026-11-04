<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BridgeResponse, CertificateStatusView, Installation, ServiceState, Site, Snapshot } from '@stackmanage/core';
import { caddyController } from '../caddy/controller';
import StatusBadge from '../components/StatusBadge.vue';
import NginxCard from '../components/NginxCard.vue';

const props = defineProps<{ snapshot: Snapshot | undefined }>();
const { t } = useI18n();

const VERSION = '2.11.8';
const INSTALLATION_ID = 'caddy-2.11.8';
const INSTANCE_ID = 'default';
const REF = Object.freeze({ moduleId: 'caddy', installationId: INSTALLATION_ID, instanceId: INSTANCE_ID });

const installations = ref<Installation[]>([]);
const service = ref<ServiceState | undefined>();
const sites = ref<Site[]>([]);
const logText = ref('');
const logTruncated = ref(false);
const loading = ref(true);
const loadErrorKey = ref<string | undefined>();
const copied = ref(false);
const siteForm = reactive({ hostname: 'app.localhost', port: 18081, tls: false });
const certificate = ref<CertificateStatusView | undefined>();

const supported = computed(() => {
  const platform = props.snapshot?.platform;
  const architecture = props.snapshot?.architecture;
  return (platform === 'linux' && (architecture === 'x64' || architecture === 'arm64')) || (platform === 'win32' && architecture === 'x64');
});
const installed = computed(() => installations.value.length > 0);
const busy = computed(() => caddyController.state.operation !== undefined);
const statusValue = computed(() => service.value?.state ?? (installed.value ? 'unknown' : 'stopped'));
const notice = computed(() => caddyController.state.notice);
const progress = computed(() => caddyController.state.progress);
const progressPercent = computed(() => Math.round((progress.value?.value ?? 0) * 100));
const activeOperationKey = computed(() => {
  const operation = caddyController.state.operation;
  return operation === undefined ? undefined : t(`operation${operation.charAt(0).toUpperCase()}${operation.slice(1)}`);
});
const siteRoot = computed(() => props.snapshot?.sitesRoot ?? '');
const newSiteRoot = computed(() => {
  const slug = siteForm.hostname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'site';
  return siteRoot.value === '' ? '' : `${siteRoot.value}/${slug}`;
});
const primarySite = computed(() => sites.value.find(site => site.id === 'default') ?? sites.value[0]);
const primaryUrl = computed(() => {
  const site = primarySite.value;
  if (site === undefined) return undefined;
  return `${site.tls ? 'https' : 'http'}://${site.hostname}:${site.port}`;
});

function operationId(): string {
  return `ui-${crypto.randomUUID()}`;
}

function resultError(response: BridgeResponse): string | undefined {
  if (!response.ok) return 'caddyErrorUnavailable';
  const data = response.data;
  if ('data' in data && typeof data.data === 'object' && data.data !== null && 'status' in data.data) {
    const result = data.data as { status: string; items?: Array<{ error?: { messageKey: string } }> };
    if (result.status === 'failed' || result.status === 'partial') {
      const key = result.items?.find(item => item.error !== undefined)?.error?.messageKey;
      const map: Record<string, string> = {
        'caddy.notInstalled': 'caddyNotInstalledError',
        'install.digestMismatch': 'caddyInstallDigest',
        'install.downloadTooLarge': 'caddyInstallTooLarge',
        'install.downloadFailed': 'caddyInstallDownloadFailed',
        'install.platformUnsupported': 'caddyInstallUnsupported',
        'service.portInUse': 'caddyPortInUse',
        'service.identityMismatch': 'caddyIdentityMismatch',
        'service.startFailed': 'caddyStartFailed',
        'site.invalid': 'sitesValidation',
        'site.duplicatePort': 'caddyPortInUse'
      };
      return (key !== undefined ? map[key] : undefined) ?? 'errorGeneric';
    }
  }
  return undefined;
}

async function refresh(): Promise<void> {
  loadErrorKey.value = undefined;
  const [installationResponse, serviceResponse, siteResponse, logResponse, certificateResponse] = await Promise.all([
    caddyController.listInstallations(),
    caddyController.status({ instanceId: INSTANCE_ID }),
    caddyController.sitesList(),
    caddyController.logsTail({ instanceId: INSTANCE_ID, maxBytes: 65536 }),
    caddyController.certificateStatus()
  ]);
  if (installationResponse.ok && installationResponse.data.method === 'installations.list') installations.value = installationResponse.data.data.installations;
  else loadErrorKey.value = resultError(installationResponse) ?? 'errorGeneric';

  if (serviceResponse.ok && serviceResponse.data.method === 'service.status') service.value = serviceResponse.data.data;

  if (siteResponse.ok && siteResponse.data.method === 'sites.list') sites.value = siteResponse.data.data.sites;

  if (logResponse.ok && logResponse.data.method === 'logs.tail') {
    logText.value = logResponse.data.data.text;
    logTruncated.value = logResponse.data.data.truncated;
  }
  if (certificateResponse.ok && certificateResponse.data.method === 'certificates.status') certificate.value = certificateResponse.data.data;
  loading.value = false;
}

async function run(action: () => Promise<BridgeResponse>): Promise<void> {
  await action();
  await refresh();
}

async function install(): Promise<void> {
  if (!supported.value || props.snapshot?.platform === undefined || props.snapshot.architecture === undefined) return;
  await run(() =>
    caddyController.install({
      operationId: operationId(),
      moduleId: 'caddy',
      version: VERSION,
      platform: props.snapshot?.platform as 'win32' | 'linux',
      architecture: props.snapshot?.architecture as 'x64' | 'arm64'
    })
  );
}

function start(): Promise<void> {
  return run(() => caddyController.start({ operationId: operationId(), ref: REF }));
}

function stop(): Promise<void> {
  return run(() => caddyController.stop({ operationId: operationId(), ref: REF }));
}

function restart(): Promise<void> {
  return run(() => caddyController.restart({ operationId: operationId(), ref: REF }));
}

async function addSite(): Promise<void> {
  if (newSiteRoot.value === '' || siteRoot.value === '') return;
  const next = siteForm.hostname.trim().toLowerCase();
  const id = `${next.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${siteForm.port}`;
  if (sites.value.some(site => site.id === id || site.port === siteForm.port)) {
    loadErrorKey.value = 'caddyPortInUse';
    return;
  }
  const site: Site = {
    id,
    hostname: next,
    aliases: [],
    server: REF,
    root: newSiteRoot.value,
    port: siteForm.port,
    tls: siteForm.tls
  };
  await run(() => caddyController.sitesApply({ operationId: operationId(), sites: [...sites.value, site] }));
}

async function removeSite(id: string): Promise<void> {
  await run(() => caddyController.sitesRemove({ operationId: operationId(), siteId: id }));
}

async function trustCertificate(): Promise<void> {
  await run(() => caddyController.trustCertificate(operationId()));
}

const certificateLabel = computed(() => {
  if (certificate.value === undefined) return t('certificateUnknown');
  if (!certificate.value.exists) return t('certificateNotGenerated');
  if (certificate.value.browserTrust === 'trusted') return t('certificateTrusted');
  if (certificate.value.browserTrust === 'unsupported') return t('certificateUnsupported');
  return t('certificateUntrusted');
});

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false;
  }
}

async function copyUrl(): Promise<void> {
  if (primaryUrl.value !== undefined) await copyText(primaryUrl.value);
}

let poll: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  await refresh();
  poll = setInterval(() => {
    if (!busy.value) void refresh();
  }, 4000);
});
onBeforeUnmount(() => {
  if (poll !== undefined) clearInterval(poll);
});
</script>

<template>
  <section class="page-head">
    <div class="spread">
      <div>
        <span class="eyebrow">{{ t('navWeb') }}</span>
        <h1 class="page-title">{{ t('caddyTitle') }}</h1>
        <p class="page-subtitle">{{ t('caddySubtitle') }}</p>
      </div>
      <span class="badge badge-info">{{ t('caddyVersion') }} {{ VERSION }}</span>
    </div>
  </section>

  <div v-if="notice" class="notice notice-error" role="alert" style="margin-bottom: 18px">
    <span class="notice-icon" aria-hidden="true">!</span>
    <span style="flex: 1">{{ t(notice.messageKey) }}</span>
    <button type="button" class="btn btn-sm btn-ghost" @click="caddyController.clearNotice()">{{ t('dismiss') }}</button>
  </div>
  <div v-if="loadErrorKey" class="notice notice-warn" role="alert" style="margin-bottom: 18px">
    <span class="notice-icon" aria-hidden="true">!</span>
    <span>{{ t(loadErrorKey) }}</span>
  </div>

  <div class="grid grid-2">
    <div class="stack">
      <section class="panel" aria-labelledby="caddy-service-title">
        <div class="panel-head">
          <div>
            <h2 id="caddy-service-title" class="panel-title">{{ t('caddyStatus') }}</h2>
            <p class="panel-desc">{{ t('caddyRunHint') }}</p>
          </div>
          <StatusBadge :status="statusValue" />
        </div>
        <div class="panel-body stack">
          <div v-if="!supported" class="notice notice-warn">
            <span class="notice-icon" aria-hidden="true">!</span>
            <span>{{ t('caddyUnavailablePlatform') }}</span>
          </div>

          <div v-if="!installed && supported" class="notice notice-info">
            <span class="notice-icon" aria-hidden="true">i</span>
            <span>{{ t('caddyRequiresInstall') }}</span>
          </div>

          <div v-if="busy" aria-live="polite">
            <div class="progress-label">
              <span>{{ t('progressTitle') }} · {{ activeOperationKey }}</span>
              <span class="mono">{{ t('percent', { value: progressPercent }) }}</span>
            </div>
            <div class="progress" role="progressbar" :aria-valuenow="progressPercent" aria-valuemin="0" aria-valuemax="100">
              <div class="progress-bar" :style="{ width: `${progressPercent}%` }" />
            </div>
            <p v-if="progress" class="help" style="margin: 8px 0 0">{{ t('progressStage') }}: <span class="mono">{{ progress.stage }}</span></p>
          </div>

          <div class="row">
            <button v-if="!installed" type="button" class="btn btn-primary" :disabled="busy || !supported" @click="install">
              {{ busy && caddyController.state.operation === 'install' ? t('caddyInstalling') : t('caddyInstall') }}
            </button>
            <template v-else>
              <button v-if="statusValue !== 'running'" type="button" class="btn btn-primary" :disabled="busy" @click="start">
                {{ caddyController.state.operation === 'start' ? t('caddyStarting') : t('caddyStart') }}
              </button>
              <button v-else type="button" class="btn" :disabled="busy" @click="stop">
                {{ caddyController.state.operation === 'stop' ? t('caddyStopping') : t('caddyStop') }}
              </button>
              <button type="button" class="btn" :disabled="busy" @click="restart">
                {{ caddyController.state.operation === 'restart' ? t('caddyRestarting') : t('caddyRestart') }}
              </button>
              <button type="button" class="btn btn-ghost" :disabled="busy" @click="refresh">{{ t('caddyRefresh') }}</button>
            </template>
          </div>

          <div v-if="primaryUrl" class="spread" style="border-top: 1px solid var(--border); padding-top: 16px">
            <div>
              <div class="stat-label">{{ t('caddyDefaultUrl') }}</div>
              <div class="mono" style="margin-top: 4px">{{ primaryUrl }}</div>
            </div>
            <button type="button" class="btn btn-sm" :disabled="statusValue !== 'running'" @click="copyUrl">
              {{ copied ? '✓' : '⧉' }} {{ t('copyUrl') }}
            </button>
          </div>
        </div>
      </section>

      <section class="panel" aria-labelledby="sites-title">
        <div class="panel-head">
          <div>
            <h2 id="sites-title" class="panel-title">{{ t('sitesTitle') }}</h2>
            <p class="panel-desc">{{ t('caddyRunHint') }}</p>
          </div>
          <span class="badge">{{ sites.length }}</span>
        </div>
        <div class="panel-body">
          <p v-if="sites.length === 0" class="empty">{{ t('sitesEmpty') }}</p>
          <ul v-else class="site-list">
            <li v-for="site in sites" :key="site.id" class="site-item">
              <div>
                <div class="site-host mono">{{ site.hostname }}<span class="faint">:{{ site.port }}</span></div>
                <div class="site-meta mono">{{ site.root }}</div>
              </div>
              <div class="row">
                <button type="button" class="btn btn-sm" @click="copyText(`${site.tls ? 'https' : 'http'}://${site.hostname}:${site.port}`)">{{ t('copyUrl') }}</button>
                <button type="button" class="btn btn-sm btn-danger" :disabled="busy || site.id === 'default'" @click="removeSite(site.id)">{{ t('sitesRemove') }}</button>
              </div>
            </li>
          </ul>

          <div class="divider" />
          <form v-if="installed" class="site-form" @submit.prevent="addSite">
            <div class="field" style="margin: 0">
              <label for="site-hostname">{{ t('sitesHostname') }}</label>
              <input id="site-hostname" v-model="siteForm.hostname" class="input mono" required pattern="[a-zA-Z0-9.-]+" />
            </div>
            <div class="field" style="margin: 0">
              <label for="site-port">{{ t('sitesPort') }}</label>
              <input id="site-port" v-model.number="siteForm.port" class="input mono" type="number" min="1024" max="65535" required />
            </div>
            <label class="row" style="gap: 8px; align-items: center; font-size: 0.82rem">
              <input v-model="siteForm.tls" type="checkbox" />
              <span>{{ t('sitesTls') }}</span>
            </label>
            <div class="field" style="margin: 0">
              <label class="sr-only" for="add-site">&nbsp;</label>
              <button id="add-site" type="submit" class="btn" :disabled="busy || newSiteRoot === ''">{{ t('sitesAdd') }}</button>
            </div>
          </form>
          <p v-if="installed" class="help" style="margin-top: 12px">{{ t('sitesValidation') }} <span class="mono">{{ newSiteRoot }}</span></p>
        </div>
      </section>
    </div>

    <div class="stack">
      <section class="panel" aria-labelledby="facts-title">
        <div class="panel-head">
          <h2 id="facts-title" class="panel-title">{{ t('caddyVendor') }}</h2>
        </div>
        <div class="panel-body">
          <dl class="kv">
            <dt>{{ t('platformLabel') }}</dt>
            <dd class="mono">{{ snapshot?.platform ?? '—' }} / {{ snapshot?.architecture ?? '—' }}</dd>
            <dt>{{ t('statInstalled') }}</dt>
            <dd>{{ installed ? t('caddyInstalled') : t('caddyNotInstalled') }}</dd>
            <dt>{{ t('pid') }}</dt>
            <dd>{{ service?.pid ?? '—' }}</dd>
            <dt>{{ t('checksum') }}</dt>
            <dd aria-label="verified">✓ SHA-256</dd>
            <dt>{{ t('certificateTitle') }}</dt>
            <dd>{{ certificateLabel }}</dd>
          </dl>
          <div class="divider" />
          <button type="button" class="btn btn-sm" :disabled="busy || certificate?.exists !== true || certificate?.browserTrust === 'trusted'" @click="trustCertificate">
            {{ caddyController.state.operation === 'trustCertificate' ? t('certificateTrusting') : t('certificateTrust') }}
          </button>
          <p class="help" style="margin-top: 10px">{{ t('certificateHint') }}</p>
          <p class="help" style="margin-top: 18px">{{ t('evidenceNote') }}</p>
        </div>
      </section>
    </div>
  </div>
  <section class="panel" aria-labelledby="logs-title" style="margin-top: 18px">
    <div class="panel-head">
      <div>
        <h2 id="logs-title" class="panel-title">{{ t('logsTitle') }}</h2>
        <p class="panel-desc">{{ t('logsDesc') }}</p>
      </div>
      <button type="button" class="btn btn-sm btn-ghost" @click="refresh">{{ t('logsRefresh') }}</button>
    </div>
    <div class="panel-body">
      <p v-if="logTruncated" class="help" style="margin-top: 0">{{ t('logsTruncated') }}</p>
      <pre v-if="logText" class="log" aria-live="polite">{{ logText }}</pre>
      <p v-else class="empty">{{ t('logsEmpty') }}</p>
    </div>
  </section>
  <NginxCard />
</template>

<style scoped>
.site-form { display: grid; grid-template-columns: minmax(0, 1fr) 130px; gap: 14px; align-items: end; }
.site-form > :last-child { grid-column: 1 / -1; }
.site-form > :last-child .btn { width: 100%; }
@media (max-width: 560px) { .site-form { grid-template-columns: 1fr; } }
</style>
