<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { locales, type Locale } from '@stackmanage/i18n';
import { bootstrapController } from './bootstrap/controller';
import { caddyController } from './caddy/controller';
import { nginxController } from './nginx/controller';
import { redisController } from './redis/controller';
import AppSidebar from './components/AppSidebar.vue';
import HomeView from './views/HomeView.vue';
import CaddyView from './views/CaddyView.vue';
import RuntimesView from './views/RuntimesView.vue';
import DatabasesView from './views/DatabasesView.vue';
import SettingsView from './views/SettingsView.vue';
import UnavailableView from './views/UnavailableView.vue';
import { PAGE_TITLE_KEYS, type PageKey } from './pages';

const { t, locale } = useI18n();
const page = ref<PageKey>((localStorage.getItem('stackmanage.page') as PageKey | null) ?? 'home');
const theme = ref<'dark' | 'light'>((localStorage.getItem('stackmanage.theme') as 'dark' | 'light' | null) ?? 'dark');
const snapshot = computed(() => bootstrapController.state.snapshot);
const localeModel = computed<Locale>({ get: () => locale.value as Locale, set: value => { locale.value = value; } });
const workerStatus = computed(() => bootstrapController.state.status);

watchEffect(() => {
  document.documentElement.dataset['theme'] = theme.value;
  document.documentElement.lang = locale.value;
  document.title = `${t('brand')} · ${t(PAGE_TITLE_KEYS[page.value])}`;
  localStorage.setItem('stackmanage.theme', theme.value);
  localStorage.setItem('stackmanage.page', page.value);
  localStorage.setItem('stackmanage.locale', locale.value);
});
const savedLocale = localStorage.getItem('stackmanage.locale');
if (savedLocale !== null && (locales as readonly string[]).includes(savedLocale)) locale.value = savedLocale as Locale;

function navigate(next: PageKey): void {
  page.value = next;
}
function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
}

onMounted(() => {
  caddyController.attach();
  nginxController.attach();
  redisController.attach();
  void bootstrapController.refresh();
});
onBeforeUnmount(() => {
  caddyController.detach();
  nginxController.detach();
  redisController.detach();
});
</script>

<template>
  <a class="skip-link" href="#main-content">{{ t('skipToContent') }}</a>
  <div class="app-shell">
    <AppSidebar :page="page" :version="snapshot?.appVersion ?? ''" @select="navigate" />

    <div class="main">
      <header class="topbar">
        <div>
          <div class="topbar-title">{{ t(PAGE_TITLE_KEYS[page]) }}</div>
          <div class="faint" style="font-size: 0.72rem">{{ t('tagline') }}</div>
        </div>
        <div class="topbar-actions">
          <span class="badge" :class="workerStatus === 'ready' ? 'badge-success' : workerStatus === 'pending' ? 'badge-warn' : workerStatus === 'failed' ? 'badge-danger' : ''" role="status" aria-live="polite">
            <span class="badge-dot" aria-hidden="true" />
            {{ t('statWorker') }}: {{ t(workerStatus) }}
          </span>
          <button type="button" class="btn btn-sm btn-ghost" :aria-label="t('theme')" @click="toggleTheme">
            {{ theme === 'dark' ? '☾' : '☀' }} {{ theme === 'dark' ? t('themeDark') : t('themeLight') }}
          </button>
        </div>
      </header>

      <main id="main-content" class="content" tabindex="-1">
        <HomeView v-if="page === 'home'" key="home" :snapshot="snapshot" :worker-status="workerStatus" @navigate="navigate" />
        <CaddyView v-else-if="page === 'web'" key="web" :snapshot="snapshot" />
        <RuntimesView v-else-if="page === 'runtimes'" key="runtimes" :snapshot="snapshot" />
        <DatabasesView v-else-if="page === 'databases'" key="databases" :snapshot="snapshot" />
        <SettingsView v-else-if="page === 'settings'" key="settings" v-model:theme="theme" v-model:locale="localeModel" :snapshot="snapshot" :worker-status="workerStatus" />
        <UnavailableView v-else :key="page" :page="page" />
        <footer class="faint" style="margin-top: 36px; font-size: 0.75rem">{{ t('footer') }}</footer>
      </main>
    </div>
  </div>
</template>
