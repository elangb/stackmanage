<script setup lang="ts">
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
</script>
<template><section class="page-head"><span class="eyebrow">{{ t('pluginsMvpTitle') }}</span><h1 class="page-title">{{ t('navPlugins') }}</h1><p class="page-subtitle">{{ t('pluginsMvpBody') }}</p></section><section class="panel"><div class="panel-body"><p class="help" role="status">{{ t('pluginsMvpBody') }}</p></div></section></template>
