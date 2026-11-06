<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { StartupGroup, ManagedServicesView, OperationResult } from '@stackmanage/core';

const { t } = useI18n();
const services = ref<ManagedServicesView['services']>([]);
const groups = ref<StartupGroup[]>([]);
const selected = ref<string[]>([]);
const dependencyByService = ref<Record<string, string>>({});
const name = ref('Local development');
const notice = ref('');
const busy = ref(false);
const operationId = (): string => `ui-${crypto.randomUUID()}`;
async function refresh(): Promise<void> {
  try {
    const [serviceResponse, groupResponse] = await Promise.all([window.stackmanage.managedServicesList({}), window.stackmanage.workflowGroupsList({})]);
    const serviceData = (serviceResponse as { data?: { method: string; data: ManagedServicesView } }).data;
    const groupData = (groupResponse as { data?: { method: string; data: { groups: StartupGroup[] } } }).data;
    if (serviceData?.method !== 'services.managed-list' || groupData?.method !== 'workflow.groups.list') throw new Error('Workflow refresh failed');
    services.value = serviceData.data.services;
    groups.value = groupData.data.groups;
  } catch {
    services.value = [];
    groups.value = [];
    notice.value = t('workflowFailed');
  }
}
async function save(): Promise<void> {
  if (!name.value.trim() || selected.value.length === 0) { notice.value = t('workflowFailed'); return; }
  busy.value = true;
  try {
    const entries = services.value.filter(item => selected.value.includes(item.ref.instanceId)).map(item => ({ service: item.ref, dependsOn: dependencyByService.value[item.ref.instanceId] ? [dependencyByService.value[item.ref.instanceId]!] : [], required: true }));
    if (entries.some((entry, index) => entry.dependsOn.some(dep => !entries.slice(0, index).some(previous => previous.service.instanceId === dep)))) { notice.value = t('workflowFailed'); return; }
    const response = (await window.stackmanage.workflowGroupSave({ id: `group-${Date.now()}`, name: name.value.trim(), entries, execution: 'ordered', onFailure: 'skip-dependents' })) as { ok?: boolean; data?: { method: string; data: OperationResult } };
    const result = response.ok && response.data?.method === 'workflow.groups.save' ? response.data.data : undefined;
    if (result?.status === 'completed') { notice.value = t('workflowSaved'); await refresh(); }
    else notice.value = t('workflowFailed');
  } catch { notice.value = t('workflowFailed'); }
  finally { busy.value = false; }
}
async function runGroup(id: string, action: 'start' | 'stop'): Promise<void> {
  busy.value = true;
  try {
    const response = (await window.stackmanage.workflowGroupRun({ operationId: operationId(), id, action })) as { ok?: boolean; data?: { method: string; data: OperationResult } };
    const result = response.ok && response.data?.method === 'workflow.groups.run' ? response.data.data : undefined;
    notice.value = result ? `${t('workflowResult')}: ${t(`workflowStatus.${result.status}`)} (${result.items.filter(item => item.status === 'completed').length}/${result.items.length})` : t('workflowFailed');
  } catch { notice.value = t('workflowFailed'); }
  finally { busy.value = false; await refresh(); }
}
async function removeGroup(id: string): Promise<void> {
  busy.value = true;
  try {
    const response = (await window.stackmanage.workflowGroupRemove({ id })) as { ok?: boolean; data?: { method: string; data: OperationResult } };
    const result = response.ok && response.data?.method === 'workflow.groups.remove' ? response.data.data : undefined;
    notice.value = result?.status === 'completed' ? t('workflowSaved') : t('workflowFailed');
  } catch { notice.value = t('workflowFailed'); }
  finally { busy.value = false; await refresh(); }
}
function dependsOn(instanceId: string): string { return dependencyByService.value[instanceId] ?? ''; }
function setDependency(instanceId: string, dependencyId: string): void {
  if (dependencyId === '') delete dependencyByService.value[instanceId];
  else dependencyByService.value[instanceId] = dependencyId;
}
onMounted(() => { void refresh(); });
</script>

<template>
  <section class="page-head"><span class="eyebrow">{{ t('workflowMvpTitle') }}</span><h1 class="page-title">{{ t('navWorkflow') }}</h1><p class="page-subtitle">{{ t('workflowMvpBody') }}</p></section>
  <div class="grid grid-2" :aria-busy="busy">
    <section class="panel">
      <div class="panel-head"><h2 class="panel-title">{{ t('workflowManagedServices') }}</h2></div>
      <div class="panel-body stack">
        <p v-if="services.length === 0" class="help">{{ t('workflowNoServices') }}</p>
        <div v-for="service in services" :key="`${service.ref.moduleId}:${service.ref.instanceId}`" class="spread"><label><input v-model="selected" type="checkbox" :value="service.ref.instanceId" /> {{ service.ref.moduleId }} · {{ service.state }}</label><select v-if="selected.includes(service.ref.instanceId)" :value="dependsOn(service.ref.instanceId)" class="select" :aria-label="t('workflowDependsOn')" @change="setDependency(service.ref.instanceId, ($event.target as HTMLSelectElement).value)"><option value="">{{ t('workflowNoDependency') }}</option><option v-for="dependency in services.filter(item => item.ref.instanceId !== service.ref.instanceId && selected.includes(item.ref.instanceId))" :key="dependency.ref.instanceId" :value="dependency.ref.instanceId">{{ dependency.ref.moduleId }}</option></select><span class="mono">{{ service.ports.join(', ') || '—' }}</span></div>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2 class="panel-title">{{ t('workflowGroups') }}</h2></div>
      <div class="panel-body stack">
        <label class="field">{{ t('workflowGroupName') }}<input v-model="name" class="input" maxlength="80" /></label>
        <button type="button" class="btn btn-primary" :disabled="selected.length === 0 || busy" @click="save">{{ t('workflowSaveGroup') }}</button>
        <article v-for="group in groups" :key="group.id" class="spread"><strong>{{ group.name }}</strong><div class="actions"><button class="btn btn-sm btn-primary" :disabled="busy" @click="runGroup(group.id, 'start')">{{ t('workflowStart') }}</button><button class="btn btn-sm btn-ghost" :disabled="busy" @click="runGroup(group.id, 'stop')">{{ t('workflowStop') }}</button><button class="btn btn-sm btn-ghost" :disabled="busy" @click="removeGroup(group.id)">{{ t('workflowRemove') }}</button></div></article>
        <p v-if="notice" class="help" role="status">{{ notice }}</p>
      </div>
    </section>
  </div>
</template>
