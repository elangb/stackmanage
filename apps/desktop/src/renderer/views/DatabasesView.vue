<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { Snapshot } from '@stackmanage/core';

defineProps<{ snapshot: Snapshot | undefined }>();
const { t } = useI18n();
</script>

<template>
  <section class="page-head">
    <div class="spread">
      <div>
        <span class="eyebrow">{{ t('navDatabases') }}</span>
        <h1 class="page-title">{{ t('databasesTitle') }}</h1>
        <p class="page-subtitle">{{ t('databasesSubtitle') }}</p>
      </div>
      <span class="badge badge-info">{{ t('databasesScope') }}</span>
    </div>
  </section>

  <div class="grid grid-2">
    <div class="stack">
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">{{ t('databaseRoadmapTitle') }}</h2></div>
        <div class="panel-body"><p class="help">{{ t('databaseRoadmapBody') }}</p></div>
      </section>
    </div>
  </div>
</template>
