<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ status: string }>();
const { t } = useI18n();
const label = computed(() => {
  const map: Record<string, string> = {
    running: 'statusRunning',
    stopped: 'statusStopped',
    starting: 'statusStarting',
    stopping: 'statusStopping',
    failed: 'statusFailed',
    unknown: 'statusUnknown'
  };
  return t(map[props.status] ?? 'statusUnknown');
});
const tone = computed(() => (props.status === 'running' ? 'badge-success' : props.status === 'failed' ? 'badge-danger' : props.status === 'starting' || props.status === 'stopping' ? 'badge-warn' : 'badge'));
</script>

<template>
  <span class="badge" :class="tone">
    <span class="badge-dot" aria-hidden="true" />
    {{ label }}
  </span>
</template>
