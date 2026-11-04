import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DataRoots } from '../data/roots.js';
import { inspectProcess, probeLoopback } from '../data/process.js';
import { readServiceRecords, type PersistedServiceRecord, type Warning } from '../data/state.js';
import { runTool } from './common.js';

export type ServiceModule = 'caddy' | 'nginx';

interface ServiceView {
  readonly moduleId: ServiceModule;
  readonly instanceId: string;
  readonly recordState: 'present' | 'unknown';
  readonly state: 'running' | 'stopped' | 'unknown';
  readonly recordedStatus: 'running' | 'stopped' | 'unknown' | null;
  readonly pid: number | null;
  readonly identity: 'verified' | 'mismatch' | 'gone' | 'unverifiable' | 'not-checked';
  readonly identityReason: string | null;
  readonly port: number | null;
  readonly portListening: boolean | null;
  readonly observedAt: string;
  readonly warnings: readonly Warning[];
}

async function inspectService(moduleId: ServiceModule, record: PersistedServiceRecord): Promise<ServiceView> {
  const base = {
    moduleId,
    instanceId: record.instanceId,
    recordState: 'present' as const,
    recordedStatus: record.status,
    pid: record.process?.pid ?? null,
    port: record.process?.port ?? null,
    observedAt: new Date().toISOString()
  };
  const warnings: Warning[] = [];

  if (record.unverified !== undefined) {
    warnings.push({ code: 'UNVERIFIED_RECORD', message: 'A previous process identity check failed; running state is not claimed.' });
    return {
      ...base,
      state: 'unknown',
      identity: 'unverifiable',
      identityReason: record.unverified.reason,
      portListening: null,
      warnings
    };
  }

  if (record.process === undefined) {
    if (record.status === 'running') {
      warnings.push({ code: 'STALE_RECORD', message: 'The record says running but has no process identity; running state is not claimed.' });
      return { ...base, state: 'unknown', identity: 'not-checked', identityReason: null, portListening: null, warnings };
    }
    return {
      ...base,
      state: record.status === 'unknown' ? 'unknown' : 'stopped',
      identity: 'not-checked',
      identityReason: null,
      portListening: null,
      warnings
    };
  }

  const identity = await inspectProcess(record.process);
  if (identity.status === 'gone') {
    warnings.push({ code: 'STALE_RECORD', message: 'The recorded PID no longer exists; the persisted record was not modified.' });
    return { ...base, state: 'stopped', identity: 'gone', identityReason: null, portListening: null, warnings };
  }
  if (identity.status === 'mismatch') {
    warnings.push({ code: 'IDENTITY_MISMATCH', message: 'The live process does not match the persisted identity; running state is not claimed.' });
    return {
      ...base,
      state: 'unknown',
      identity: identity.reason === 'unverifiable' ? 'unverifiable' : 'mismatch',
      identityReason: identity.reason,
      portListening: null,
      warnings
    };
  }

  const port = record.process.port;
  const listening = await probeLoopback(port);
  if (!listening) {
    warnings.push({ code: 'NOT_LISTENING', message: 'The verified process is alive but the recorded loopback port is not accepting connections.' });
    return { ...base, state: 'unknown', identity: 'verified', identityReason: null, portListening: false, warnings };
  }
  if (record.status !== 'running') {
    warnings.push({ code: 'RECORD_STALE', message: 'The live verified process is listening; the persisted status is stale.' });
  }
  return { ...base, state: 'running', identity: 'verified', identityReason: null, portListening: true, warnings };
}

export function servicesStatusTool(roots: DataRoots, moduleId?: ServiceModule): Promise<CallToolResult> {
  return runTool('services.status', async () => {
    const selected: ServiceModule[] = moduleId === undefined ? ['caddy', 'nginx'] : [moduleId];
    const modules = [];
    for (const id of selected) {
      const listing = await readServiceRecords(roots, id);
      const services: ServiceView[] = [];
      for (const entry of listing.entries) {
        if (entry.state === 'present' && entry.record !== undefined) {
          services.push(await inspectService(id, entry.record));
        } else {
          services.push({
            moduleId: id,
            instanceId: entry.instanceId,
            recordState: 'unknown',
            state: 'unknown',
            recordedStatus: null,
            pid: null,
            identity: 'not-checked',
            identityReason: null,
            port: null,
            portListening: null,
            observedAt: new Date().toISOString(),
            warnings: entry.warning !== undefined ? [entry.warning] : []
          });
        }
      }
      modules.push({
        moduleId: id,
        recordState: listing.state,
        services,
        warnings: listing.warnings
      });
    }
    return {
      modules,
      note: 'State comes from persisted worker records plus read-only PID identity and loopback checks. Renderer state is never used.'
    };
  });
}
