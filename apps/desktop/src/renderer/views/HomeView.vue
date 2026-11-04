<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Snapshot } from '@stackmanage/core';
import { caddyController } from '../caddy/controller';
import type { PageKey } from '../pages';

const props = defineProps<{ snapshot: Snapshot | undefined; workerStatus: string }>();
const emit = defineEmits<{ navigate: [page: PageKey] }>();
const { t } = useI18n();

const installed = ref(0);
const running = ref(0);
const sites = ref(0);
const loaded = ref(false);

const workerOnline = computed(() => props.workerStatus === 'ready');
const platformFacts = computed(() => `${props.snapshot?.platform ?? '—'} / ${props.snapshot?.architecture ?? '—'}`);

onMounted(async () => {
  const [installations, services, siteList] = await Promise.all([
    caddyController.listInstallations(),
    caddyController.listServices(),
    caddyController.sitesList()
  ]);
  if (installations.ok && installations.data.method === 'installations.list') installed.value = installations.data.data.installations.length;
  if (services.ok && services.data.method === 'services.list') running.value = services.data.data.services.filter(service => service.state === 'running').length;
  if (siteList.ok && siteList.data.method === 'sites.list') sites.value = siteList.data.data.sites.length;
  loaded.value = true;
});
</script>

<template>
  <section class="page-head">
    <span class="eyebrow">{{ t('homeEyebrow') }}</span>
    <h1 class="page-title">{{ t('homeTitle') }}</h1>
    <p class="page-subtitle">{{ t('homeSubtitle') }}</p>
  </section>

  <div class="stat-grid" aria-live="polite">
    <div class="stat">
      <div class="stat-label">{{ t('statWorker') }}</div>
      <div class="stat-value">{{ workerOnline ? t('online') : t('offline') }}</div>
      <div class="stat-note">{{ t(workerStatus) }}</div>
    </div>
    <div class="stat">
      <div class="stat-label">{{ t('statInstalled') }}</div>
      <div class="stat-value">{{ loaded ? installed : t('statUnknown') }}</div>
      <div class="stat-note">Caddy</div>
    </div>
    <div class="stat">
      <div class="stat-label">{{ t('statRunning') }}</div>
      <div class="stat-value">{{ loaded ? running : t('statUnknown') }}</div>
      <div class="stat-note">{{ t('caddyStatus') }}</div>
    </div>
    <div class="stat">
      <div class="stat-label">{{ t('statSites') }}</div>
      <div class="stat-value">{{ loaded ? sites : t('statUnknown') }}</div>
      <div class="stat-note">{{ t('sitesTitle') }}</div>
    </div>
  </div>

  <div class="grid grid-2">
    <section class="panel" aria-labelledby="quick-start-title">
      <div class="panel-head">
        <div>
          <h2 id="quick-start-title" class="panel-title">{{ t('quickStart') }}</h2>
          <p class="panel-desc">{{ t('quickStartBody') }}</p>
        </div>
        <span class="badge badge-info">{{ t('caddyVersion') }} 2.11.8</span>
      </div>
      <div class="panel-body stack">
        <div class="row">
          <button type="button" class="btn btn-primary" @click="emit('navigate', 'web')">{{ t('openWeb') }} →</button>
          <button type="button" class="btn" @click="emit('navigate', 'web')">{{ t('viewLogs') }}</button>
        </div>
        <p class="help" style="margin: 0">{{ t('evidenceNote') }}</p>
      </div>
    </section>

    <section class="panel" aria-labelledby="platform-facts-title">
      <div class="panel-head">
        <h2 id="platform-facts-title" class="panel-title">{{ t('settingsPlatform') }}</h2>
      </div>
      <div class="panel-body">
        <dl class="kv">
          <dt>{{ t('platformLabel') }}</dt>
          <dd class="mono">{{ platformFacts }}</dd>
          <dt>{{ t('licensing') }}</dt>
          <dd>{{ t('unlimited') }}</dd>
          <dt>{{ t('telemetry') }}</dt>
          <dd>{{ t('off') }}</dd>
          <dt>{{ t('caddyVersion') }}</dt>
          <dd class="mono">2.11.8</dd>
        </dl>
      </div>
    </section>
  </div>
</template>
