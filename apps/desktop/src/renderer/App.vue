<script setup lang="ts">
import { watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { locales } from '@stackmanage/i18n';
import { bootstrapController as controller } from './bootstrap/controller';

const { t, locale } = useI18n();
watchEffect(() => { document.documentElement.lang = locale.value; document.title = t('brand'); });
</script>

<template>
  <main>
    <header>
      <strong>{{ t('brand') }}</strong>
      <div class="language">
        <label for="language">{{ t('language') }}</label>
        <select id="language" v-model="locale">
          <option v-for="language in locales" :key="language" :value="language">{{ t(`locales.${language}`) }}</option>
        </select>
      </div>
    </header>
    <span class="eyebrow">{{ t('phase') }}</span>
    <h1>{{ t('title') }}</h1>
    <p>{{ t('intro') }}</p>
    <section class="panel" aria-labelledby="connection-title">
      <h2 id="connection-title">{{ t('healthTitle') }}</h2>
      <p class="status" role="status" aria-live="polite">{{ t(controller.state.status) }}</p>
      <button :disabled="controller.state.status === 'pending'" @click="controller.refresh()">{{ t('check') }}</button>
    </section>
    <section class="panel" aria-labelledby="policy-title">
      <h2 id="policy-title">{{ t('policyTitle') }}</h2>
      <dl>
        <dt>{{ t('licensing') }}</dt><dd>{{ t('unlimited') }}</dd>
        <dt>{{ t('telemetry') }}</dt><dd>{{ t('off') }}</dd>
      </dl>
    </section>
    <footer>{{ t('footer') }}</footer>
  </main>
</template>
