<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { PageKey } from '../pages';
import { PAGE_TITLE_KEYS } from '../pages';

defineProps<{ page: PageKey }>();
const { t } = useI18n();
const detailsKey = (page: string): string => ({ workflow: 'workflowMvpBody', ai: 'aiMvpBody', infra: 'infraMvpBody', cache: 'cacheMvpIntro', plugins: 'pluginsMvpBody' })[page] ?? 'notImplemented';
const statusTitleKey = (page: string): string => ({ workflow: 'workflowMvpTitle', ai: 'aiMvpTitle', infra: 'infraMvpTitle', cache: 'cacheScopeTitle', plugins: 'pluginsMvpTitle' })[page] ?? 'comingSoon';
</script>

<template>
  <section class="page-head">
    <span class="eyebrow">{{ t(statusTitleKey(page)) }}</span>
    <h1 class="page-title">{{ t(PAGE_TITLE_KEYS[page]) }}</h1>
    <p class="page-subtitle">{{ t(detailsKey(page)) }}</p>
  </section>

  <section class="panel">
    <div class="panel-body">
      <div class="empty" role="status">
        <div style="font-size: 1.5rem; margin-bottom: 10px" aria-hidden="true">◇</div>
        <p style="margin: 0">{{ t(detailsKey(page)) }}</p>
      </div>
    </div>
  </section>
</template>
