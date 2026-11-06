<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { Snapshot } from '@stackmanage/core';
import RedisCard from '../components/RedisCard.vue';
import { redisController } from '../redis/controller';
import { onBeforeUnmount, onMounted } from 'vue';

defineProps<{ snapshot: Snapshot | undefined }>();
const { t } = useI18n();
onMounted(() => redisController.attach());
onBeforeUnmount(() => redisController.detach());
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
        <RedisCard />
      </section>
    </div>

    <div class="stack">
      <section class="panel" aria-labelledby="databases-policy-title">
        <div class="panel-head">
          <h2 id="databases-policy-title" class="panel-title">{{ t('databasesPolicy') }}</h2>
        </div>
        <div class="panel-body">
          <dl class="kv">
            <dt>{{ t('databasesLicence') }}</dt>
            <dd>{{ t('databasesLicenceValue') }}</dd>
            <dt>{{ t('databasesNotIncluded') }}</dt>
            <dd>{{ t('databasesNotIncludedValue') }}</dd>
          </dl>
          <p class="help" style="margin: 18px 0 0">{{ t('databasesEvidence') }}</p>
        </div>
      </section>
    </div>
  </div>
</template>
