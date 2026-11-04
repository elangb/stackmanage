import type { CommandPlan } from './command.js';

/**
 * Pure kill planners. Nothing here delivers a signal or spawns a process; the
 * Linux plan exposes a `kill` closure only so a caller that already owns the
 * process can supply its own function, and the returned plan documents the
 * exact syscall/argv that would run.
 */
export type KillPlan =
  | {
      readonly status: 'planned';
      readonly strategy: 'process-group' | 'taskkill-tree';
      readonly graceful: { readonly method: 'SIGTERM'; readonly pid: number; readonly group: boolean };
      readonly forceful: { readonly method: 'SIGKILL' | 'taskkill'; readonly pid: number; readonly group: boolean };
      readonly plan: CommandPlan;
      readonly gracePeriodMs: number;
      readonly notes: readonly string[];
    }
  | { readonly status: 'invalid'; readonly reason: string };

export interface KillTarget {
  /** Process or group-leader PID; positive integer. */
  readonly pid: number;
  /** Must be true: the caller spawned and still owns the process. */
  readonly owned: boolean;
  readonly platform: 'linux' | 'win32';
}

export const GRACE_PERIOD_MS = 5000;

export function planLinuxKill(target: KillTarget, gracePeriodMs = GRACE_PERIOD_MS): KillPlan {
  if (!Number.isInteger(target.pid) || target.pid <= 1) return { status: 'invalid', reason: 'pid must be an integer greater than 1' };
  if (!target.owned) return { status: 'invalid', reason: 'refusing to plan a kill for a process this session does not own' };
  const notes = [
    `spawn the service with setsid/detached so PID ${target.pid} is the group leader`,
    `SIGTERM the group (-${target.pid}) first; SIGKILL the group after ${gracePeriodMs} ms only if members remain`,
    'group signalling also stops companions that stayed in the same group'
  ];
  return {
    status: 'planned',
    strategy: 'process-group',
    graceful: { method: 'SIGTERM', pid: target.pid, group: true },
    forceful: { method: 'SIGKILL', pid: target.pid, group: true },
    plan: { description: 'terminate process group', command: { file: '/bin/kill', args: ['-TERM', `-${target.pid}`] }, privilege: 'not-required', execution: 'verified', notes },
    gracePeriodMs,
    notes
  };
}

export function planWindowsKill(target: KillTarget): KillPlan {
  if (!Number.isInteger(target.pid) || target.pid <= 4) return { status: 'invalid', reason: 'pid must be an integer greater than 4' };
  if (!target.owned) return { status: 'invalid', reason: 'refusing to plan a kill for a process this session does not own' };
  const notes = [
    'taskkill /T walks live parent-child links only; detached descendants survive',
    'a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is the durable containment strategy',
    'Windows termination is NOT verified; this plan is never executed by this package'
  ];
  return {
    status: 'planned',
    strategy: 'taskkill-tree',
    graceful: { method: 'SIGTERM', pid: target.pid, group: false },
    forceful: { method: 'taskkill', pid: target.pid, group: true },
    plan: { description: 'terminate Windows process tree', command: { file: 'taskkill.exe', args: ['/PID', String(target.pid), '/T', '/F'] }, privilege: 'not-required', execution: 'unverified', notes },
    gracePeriodMs: 0,
    notes
  };
}

/**
 * Windows Job Object design note. Real containment requires a native addon or
 * helper; this phase returns documentation with an explicit unverified status.
 */
export function describeWindowsJobObject(): { readonly strategy: 'job-object'; readonly execution: 'unverified'; readonly notes: readonly string[] } {
  return {
    strategy: 'job-object',
    execution: 'unverified',
    notes: [
      'CreateJobObject + SetInformationJobObject(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE), assign the child at spawn',
      'TerminateJobObject on shutdown; closing the last handle kills the whole tree',
      'requires a native addon or helper; not implemented and not verified in this phase'
    ]
  };
}
