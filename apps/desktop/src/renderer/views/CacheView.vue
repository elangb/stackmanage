<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import RedisCard from '../components/RedisCard.vue';
import { redisController } from '../redis/controller';
const { t } = useI18n();
onMounted(() => redisController.attach());
onBeforeUnmount(() => redisController.detach());
</script>
<template><section class="page-head"><span class="eyebrow">{{ t('navCache') }}</span><h1 class="page-title">{{ t('navCache') }}</h1><p class="page-subtitle">{{ t('cacheMvpIntro') }}</p></section><RedisCard /></template>
