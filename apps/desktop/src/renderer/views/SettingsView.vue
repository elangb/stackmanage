<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { Snapshot } from '@stackmanage/core';
import { locales } from '@stackmanage/i18n';
import type { Locale } from '@stackmanage/i18n';

defineProps<{ snapshot: Snapshot | undefined; workerStatus: string }>();
const theme = defineModel<'dark' | 'light'>('theme', { required: true });
const locale = defineModel<Locale>('locale', { required: true });
const { t } = useI18n();
</script>

<template>
  <section class="page-head">
    <span class="eyebrow">{{ t('navSettings') }}</span>
    <h1 class="page-title">{{ t('settingsTitle') }}</h1>
    <p class="page-subtitle">{{ t('intro') }}</p>
  </section>

  <div class="grid grid-2">
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">{{ t('settingsAppearance') }}</h2>
          <p class="panel-desc">{{ t('settingsAppearanceBody') }}</p>
        </div>
      </div>
      <div class="panel-body stack">
        <div class="field">
          <label for="theme-select">{{ t('theme') }}</label>
          <select id="theme-select" v-model="theme" class="select">
            <option value="dark">{{ t('themeDark') }}</option>
            <option value="light">{{ t('themeLight') }}</option>
          </select>
        </div>
        <div class="field">
          <label for="locale-select">{{ t('settingsLanguage') }}</label>
          <select id="locale-select" v-model="locale" class="select">
            <option v-for="item in locales" :key="item" :value="item">{{ t(`locales.${item}`) }}</option>
          </select>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">{{ t('settingsPlatform') }}</h2>
      </div>
      <div class="panel-body">
        <dl class="kv">
          <dt>{{ t('platformLabel') }}</dt>
          <dd class="mono">{{ snapshot?.platform ?? '—' }}</dd>
          <dt>{{ t('archLabel') }}</dt>
          <dd class="mono">{{ snapshot?.architecture ?? '—' }}</dd>
          <dt>{{ t('statWorker') }}</dt>
          <dd>{{ t(workerStatus) }}</dd>
          <dt>{{ t('managedSitesRoot') }}</dt>
          <dd class="mono" style="font-size: 0.72rem">{{ snapshot?.sitesRoot ?? '—' }}</dd>
        </dl>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">{{ t('settingsLimits') }}</h2>
      </div>
      <div class="panel-body">
        <p class="help" style="margin: 0">{{ t('settingsLimitsBody') }}</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">{{ t('settingsData') }}</h2>
      </div>
      <div class="panel-body">
        <p class="help" style="margin: 0">{{ t('settingsDataBody') }}</p>
      </div>
    </section>
  </div>
</template>
