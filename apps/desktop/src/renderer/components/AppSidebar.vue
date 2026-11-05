<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import brandIcon from '../assets/stackmanage-icon.png';
import { NAV_GROUPS, type PageKey } from '../pages';

defineProps<{ page: PageKey; version: string }>();
const emit = defineEmits<{ select: [page: PageKey] }>();
const { t } = useI18n();
</script>

<template>
  <aside class="sidebar" aria-label="StackManage">
    <div class="brand">
      <img class="brand-mark" :src="brandIcon" alt="" aria-hidden="true">
      <span>
        <span class="brand-name">{{ t('brand') }}</span>
        <span class="brand-tagline">{{ t('tagline') }}</span>
      </span>
    </div>

    <nav class="nav-groups" :aria-label="t('navGroupWorkspace')">
      <div v-for="group in NAV_GROUPS" :key="group.labelKey" class="nav-group">
        <div class="nav-label">{{ t(group.labelKey) }}</div>
        <button
          v-for="item in group.items"
          :key="item.key"
          type="button"
          class="nav-item"
          :aria-current="page === item.key ? 'page' : undefined"
          @click="emit('select', item.key)"
        >
          <span class="nav-icon" aria-hidden="true">{{ item.icon }}</span>
          <span class="nav-text">{{ t(item.labelKey) }}</span>
          <span v-if="!item.implemented" class="nav-soon" :title="t('unavailable')" :aria-label="t('unavailable')" aria-hidden="true">○</span>
        </button>
      </div>
    </nav>

    <div class="sidebar-footer">
      <div>{{ t('brand') }} · v{{ version || '0.1.0' }}</div>
      <div style="margin-top: 4px">{{ t('unlimited') }} · {{ t('telemetry') }} {{ t('off') }}</div>
    </div>
  </aside>
</template>
