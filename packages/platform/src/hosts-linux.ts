import type { OperationContext, OperationResult } from '@stackmanage/core';
import type { CommandPlan, ProcessRunner, RunResult } from './command.js';
import { elevateWith, type Elevation } from './elevation.js';
import type { FileSystemPort } from './ports.js';
import { buildResult, emitTerminal, operationError, type ItemOutcomeInput } from './results.js';
import { HOSTS_BLOCK_MAX_BYTES, LINUX_HOSTS_EXIT, buildLinuxHostsScript, helperFileName } from './scripts.js';
import { mergeManagedBlock, parseManagedBlock, validateEntries, type HostsEntry } from './hosts-block.js';

export const LINUX_HOSTS_PATH = '/etc/hosts';
export const LINUX_HELPER_DIRECTORY = '/var/lib/stackmanage/helpers';

export interface LinuxHostsOptions {
  readonly fs: FileSystemPort;
  readonly runner: ProcessRunner;
  readonly hostsPath?: string;
  readonly helperDirectory?: string;
  readonly backupSuffix?: string;
  readonly elevation?: () => Promise<Elevation>;
  readonly now?: () => Date;
  readonly runTimeoutMs?: number;
}

export type HostsWriteOutcome =
  | { readonly status: 'written'; readonly backedUp: boolean; readonly plan?: CommandPlan }
  | { readonly status: 'unchanged'; readonly plan?: CommandPlan }
  | { readonly status: 'unavailable'; readonly reason: string; readonly plan?: CommandPlan }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string; readonly code?: number; readonly plan?: CommandPlan };

export type HostsInspection =
  | { readonly status: 'absent' }
  | { readonly status: 'valid'; readonly entries: readonly HostsEntry[] }
  | { readonly status: 'malformed'; readonly reason: string }
  | { readonly status: 'unreadable'; readonly reason: string };

/**
 * Linux hosts manager. Writing the managed block is the required dependency of
 * `apply`. The backup and any later DNS refresh are supplementary and never
 * convert a completed write into a failure. Paths, runner, elevation probe and
 * clock are injected, so tests use temp directories and never touch /etc/hosts.
 */
export class LinuxHostsManager {
  private readonly hostsPath: string;
  private readonly helperDirectory: string;
  private readonly backupSuffix: string;
  private readonly now: () => Date;
  private readonly runTimeoutMs: number;

  constructor(private readonly options: LinuxHostsOptions) {
    this.hostsPath = options.hostsPath ?? LINUX_HOSTS_PATH;
    this.helperDirectory = options.helperDirectory ?? LINUX_HELPER_DIRECTORY;
    this.backupSuffix = options.backupSuffix ?? '.stackmanage.bak';
    this.now = options.now ?? (() => new Date());
    this.runTimeoutMs = options.runTimeoutMs ?? 30000;
  }

  get path(): string {
    return this.hostsPath;
  }

  private timestamp(): string {
    return this.now().toISOString().replace(/[:.]/g, '-');
  }

  async inspect(): Promise<HostsInspection> {
    let content: string;
    try {
      content = await this.options.fs.readFile(this.hostsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
      return { status: 'unreadable', reason: 'hosts file could not be read' };
    }
    const parsed = parseManagedBlock(content);
    if (parsed.status === 'malformed') return { status: 'malformed', reason: parsed.reason };
    return { status: 'valid', entries: parsed.entries };
  }

  /** Computes the exact new file content without writing. */
  async preview(entries: readonly unknown[]): Promise<{ readonly content: string; readonly changed: boolean } | { readonly error: string }> {
    if (entries.length === 0) return { error: 'at least one entry is required' };
    const validation = validateEntries(entries);
    if (!validation.ok) return { error: validation.rejected.map(r => `${r.id}: ${r.message}`).join('; ') };
    const existing = await this.options.fs.readFile(this.hostsPath).catch(() => '');
    const parsed = parseManagedBlock(existing);
    if (parsed.status === 'malformed') return { error: `existing managed block is malformed: ${parsed.reason}` };
    const merged = mergeManagedBlock(existing, validation.entries);
    return { content: merged.content, changed: merged.changed };
  }

  /** Writes entries into the managed block. Expected failures are returned, not thrown. */
  async write(entries: readonly unknown[]): Promise<HostsWriteOutcome> {
    if (entries.length === 0) return { status: 'invalid', reason: 'at least one entry is required' };
    const validation = validateEntries(entries);
    if (!validation.ok) return { status: 'invalid', reason: validation.rejected.map(r => `${r.id}: ${r.message}`).join('; ') };

    let existing: string;
    try {
      existing = await this.options.fs.readFile(this.hostsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unavailable', reason: 'hosts file is missing' };
      return { status: 'failed', reason: 'hosts file could not be read' };
    }
    const parsed = parseManagedBlock(existing);
    if (parsed.status === 'malformed') return { status: 'invalid', reason: `existing managed block is malformed: ${parsed.reason}` };

    const merged = mergeManagedBlock(existing, validation.entries);
    if (Buffer.byteLength(merged.block, 'utf8') > HOSTS_BLOCK_MAX_BYTES) return { status: 'invalid', reason: 'managed block exceeds size limit' };

    const direct = await this.options.fs.canWrite(this.hostsPath);
    if (direct) {
      if (!merged.changed) return { status: 'unchanged' };
      // Required dependency: the replace itself. The backup is supplementary and
      // only reported; it never converts a successful replace into a failure.
      const backedUp = await this.backupFile(existing);
      try {
        await this.options.fs.writeFileAtomic(this.hostsPath, merged.content);
      } catch {
        return { status: 'failed', reason: 'atomic replace failed' };
      }
      const verification = await this.verify(validation.entries);
      if (!verification.ok) return { status: 'failed', reason: `verification failed after write: ${verification.reason}` };
      return { status: 'written', backedUp };
    }

    const elevation = await (this.options.elevation ?? (async (): Promise<Elevation> => ({ kind: 'none', reason: 'no elevation provider configured' })))();
    const script = buildLinuxHostsScript({ helperDirectory: this.helperDirectory });
    const scriptPath = `${this.helperDirectory}/${helperFileName(script)}`;
    const blockPath = `${scriptPath}.block`;
    const backupPath = `${this.hostsPath}${this.backupSuffix}-${this.timestamp()}`;
    const helperCommand = { file: '/bin/sh', args: [scriptPath, this.hostsPath, blockPath, backupPath] };
    const elevated = elevateWith(elevation, helperCommand);

    if (!elevated) {
      return { status: 'unavailable', reason: elevation.reason ?? 'hosts file is not writable and no elevation is available', plan: { description: 'hosts helper requires elevation', command: helperCommand, privilege: 'required-unavailable', execution: 'unverified', notes: ['no supported elevation program (pkexec) is available; nothing was executed'] } };
    }
    const plan: CommandPlan = {
      description: 'elevated hosts helper',
      command: helperCommand,
      elevated,
      privilege: 'required',
      execution: 'unverified',
      notes: [
        'pkexec runs the helper with hosts path, block file and backup path as separate argv elements',
        'the elevated path is covered only with a stub pkexec that runs the helper unprivileged; a real polkit prompt is unverified'
      ]
    };

    const staging = await this.stageHelper(script.content, scriptPath, blockPath, merged.block);
    if (staging) return { ...staging, plan };

    const result: RunResult = await this.options.runner.run(elevated, { timeoutMs: this.runTimeoutMs });
    if (!result.ok) {
      if (result.reason === 'missing') return { status: 'unavailable', reason: 'elevation program is unavailable', plan };
      if (result.reason === 'timeout' || result.reason === 'aborted') return { status: 'failed', reason: `elevated helper ${result.reason === 'timeout' ? 'timed out' : 'was cancelled'}; file state is unknown`, plan };
      return { status: 'failed', reason: `elevated helper failed (${result.reason})`, ...(result.code === undefined ? {} : { code: result.code }), plan };
    }
    if (result.code !== LINUX_HOSTS_EXIT.replaced && result.code !== 0) {
      const reason =
        result.code === LINUX_HOSTS_EXIT.missing ? 'hosts file missing'
        : result.code === LINUX_HOSTS_EXIT.notWritable ? 'hosts file not writable'
        : result.code === LINUX_HOSTS_EXIT.malformed ? 'managed block malformed'
        : result.code === LINUX_HOSTS_EXIT.backupFailed ? 'backup or replace failed'
        : `helper exited ${result.code}`;
      return { status: 'failed', reason, code: result.code, plan };
    }
    const verification = await this.verify(validation.entries);
    if (!verification.ok) return { status: 'failed', reason: `verification failed after elevated write: ${verification.reason}`, plan };
    return { status: 'written', backedUp: true, plan };
  }

  private async backupFile(existing: string): Promise<boolean> {
    try {
      await this.options.fs.writeFile(`${this.hostsPath}${this.backupSuffix}-${this.timestamp()}`, existing);
      return true;
    } catch {
      return false;
    }
  }

  private async stageHelper(scriptContent: string, scriptPath: string, blockPath: string, block: string): Promise<{ status: 'unavailable'; reason: string } | undefined> {
    try {
      await this.options.fs.mkdirp(this.helperDirectory);
      await this.options.fs.writeFileAtomic(scriptPath, scriptContent);
      await this.options.fs.writeFileAtomic(blockPath, block);
      return undefined;
    } catch {
      return { status: 'unavailable', reason: 'helper staging directory is not writable' };
    }
  }

  private async verify(entries: readonly HostsEntry[]): Promise<{ ok: true } | { ok: false; reason: string }> {
    let content: string;
    try {
      content = await this.options.fs.readFile(this.hostsPath);
    } catch {
      return { ok: false, reason: 'file unreadable' };
    }
    const parsed = parseManagedBlock(content);
    if (parsed.status !== 'valid') return { ok: false, reason: parsed.status };
    const expected = new Set(entries.map(e => `${e.address}\t${e.hostname}`));
    const actual = new Set(parsed.entries.map(e => `${e.address}\t${e.hostname}`));
    if (expected.size !== actual.size) return { ok: false, reason: 'entry count mismatch' };
    for (const key of expected) if (!actual.has(key)) return { ok: false, reason: 'entry missing after write' };
    return { ok: true };
  }

  /** `HostsManager.apply` adapter: emits exactly one terminal result. */
  async apply(entries: readonly HostsEntry[], context: OperationContext): Promise<OperationResult> {
    if (context.signal.aborted) {
      const cancelled = buildResult(context.operationId, [], [operationError('CANCELLED', 'hosts.cancelled')]);
      emitTerminal(context, cancelled);
      return cancelled;
    }
    context.emit({ type: 'progress', operationId: context.operationId, sequence: 0, stageKey: 'hosts.validating' });
    const outcome = await this.write(entries);
    const result = buildResult(context.operationId, [itemForOutcome(outcome)]);
    emitTerminal(context, result);
    return result;
  }
}

export function itemForOutcome(outcome: HostsWriteOutcome): ItemOutcomeInput {
  switch (outcome.status) {
    case 'written':
    case 'unchanged':
      return { id: 'hosts', status: 'completed' };
    case 'invalid':
      return { id: 'hosts', status: 'failed', error: operationError('INVALID_REQUEST', 'hosts.invalidEntries') };
    case 'unavailable':
      return { id: 'hosts', status: 'skipped', error: operationError('UNAVAILABLE', 'hosts.privilegeUnavailable') };
    case 'failed':
      return { id: 'hosts', status: outcome.reason.includes('unknown') ? 'unknown' : 'failed', error: operationError('IO_ERROR', 'hosts.writeFailed') };
  }
}
