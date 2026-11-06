<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import RedisCard from '../components/RedisCard.vue';
import { redisController } from '../redis/controller';
const { t } = useI18n();
onMounted(() => redisController.attach());
onBeforeUnmount(() => redisController.detach());
</script>
<template>
  <section class="page-head"><span class="eyebrow">{{ t('navCache') }}</span><h1 class="page-title">{{ t('navCache') }}</h1><p class="page-subtitle">{{ t('cacheMvpIntro') }}</p></section>
  <div class="grid grid-2">
    <section class="panel"><RedisCard /></section>
    <section class="panel"><div class="panel-head"><h2 class="panel-title">{{ t('cacheScopeTitle') }}</h2></div><div class="panel-body"><p class="help">{{ t('cacheRedisAvailable') }}</p><p class="help">{{ t('cacheUnavailableList') }}</p></div></section>
  </div>
</template>
