import type { OperationContext, OperationResult } from '@stackmanage/core';
import type { CommandPlan, CommandSpec, ProcessRunner } from './command.js';
import type { FileSystemPort } from './ports.js';
import { buildResult, emitTerminal, operationError, type ItemOutcomeInput } from './results.js';
import { WINDOWS_HOSTS_FALLBACK, WINDOWS_HOSTS_KEY, WINDOWS_HOSTS_VALUE, buildWindowsHostsScript, isAbsoluteWindowsPath, powershellCommand } from './scripts.js';
import { mergeManagedBlock, parseManagedBlock, validateEntries, type HostsEntry } from './hosts-block.js';

export const WINDOWS_HOSTS_SCRIPT_NAME = 'stackmanage-hosts.ps1';

export interface WindowsHostsOptions {
  readonly fs: FileSystemPort;
  readonly runner: ProcessRunner;
  /** Resolved hosts path; defaults to the registry-independent system location. */
  readonly hostsPath?: string;
  /** Per-user staging directory, usually `<data>/helpers`. Absolute Windows path. */
  readonly stagingDirectory: string;
  readonly now?: () => Date;
}

export type WindowsHostsPlan = {
  readonly status: 'planned';
  readonly plan: CommandPlan;
  readonly willChange: boolean;
  readonly staged: readonly { readonly path: string; readonly content: string }[];
  readonly notes: readonly string[];
};

export type WindowsHostsOutcome =
  | WindowsHostsPlan
  | { readonly status: 'unchanged'; readonly plan?: CommandPlan }
  | { readonly status: 'invalid'; readonly reason: string };

/** Read-only query plan for the effective hosts path, kept for diagnostics. */
export function windowsHostsPathQuery(): { readonly script: string; readonly command: CommandSpec } {
  const property = `${WINDOWS_HOSTS_KEY}\\${WINDOWS_HOSTS_VALUE}`.replace(/'/g, "''");
  const script = `(Get-ItemProperty -LiteralPath '${property}' -ErrorAction Stop).${WINDOWS_HOSTS_VALUE}`;
  return { script, command: powershellCommand(script) };
}

/**
 * Windows hosts adapter. It only PLANS. The plan embeds validated absolute paths
 * as PowerShell literals, stages the managed block, and reports
 * `privilege: 'unverified'` / `execution: 'unverified'`. No runner call is made
 * and no file is written for the elevated step.
 */
export class WindowsHostsManager {
  private readonly hostsPath: string;
  private readonly now: () => Date;
  constructor(private readonly options: WindowsHostsOptions) {
    this.hostsPath = options.hostsPath ?? WINDOWS_HOSTS_FALLBACK;
    this.now = options.now ?? (() => new Date());
  }

  get path(): string {
    return this.hostsPath;
  }

  async inspect(): Promise<{ readonly status: 'absent' } | { readonly status: 'valid'; readonly entries: readonly HostsEntry[] } | { readonly status: 'malformed'; readonly reason: string }> {
    let content: string;
    try {
      content = await this.options.fs.readFile(this.hostsPath);
    } catch {
      return { status: 'absent' };
    }
    const parsed = parseManagedBlock(content);
    return parsed.status === 'malformed' ? { status: 'malformed', reason: parsed.reason } : { status: 'valid', entries: parsed.entries };
  }

  /** Pure planning: no process spawn, no host file mutation. */
  async plan(entries: readonly unknown[]): Promise<WindowsHostsOutcome> {
    if (entries.length === 0) return { status: 'invalid', reason: 'at least one entry is required' };
    if (!isAbsoluteWindowsPath(this.options.stagingDirectory) || !isAbsoluteWindowsPath(this.hostsPath)) {
      return { status: 'invalid', reason: 'staging and hosts paths must be absolute Windows paths' };
    }
    const validation = validateEntries(entries);
    if (!validation.ok) return { status: 'invalid', reason: validation.rejected.map(r => `${r.id}: ${r.message}`).join('; ') };
    const existing = await this.options.fs.readFile(this.hostsPath).catch(() => '');
    const parsed = parseManagedBlock(existing);
    if (parsed.status === 'malformed') return { status: 'invalid', reason: `existing managed block is malformed: ${parsed.reason}` };
    const merged = mergeManagedBlock(existing, validation.entries);
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const scriptPath = `${this.options.stagingDirectory}\\${WINDOWS_HOSTS_SCRIPT_NAME}`;
    const blockPath = `${this.options.stagingDirectory}\\block-${stamp}.txt`;
    const backupPath = `${this.options.stagingDirectory}\\hosts-${stamp}.bak`;
    const script = buildWindowsHostsScript({ hostsPath: this.hostsPath, blockPath, backupPath });
    const command = powershellCommand(script.content);
    const plan: CommandPlan = {
      description: 'elevated Windows hosts helper',
      command,
      privilege: 'unverified',
      execution: 'unverified',
      notes: [
        'script is UTF-16LE/base64 encoded via -EncodedCommand; no shell string or Invoke-Expression is used',
        'paths are embedded as PowerShell single-quoted literals and the block is read from its own file',
        'elevation needs a signed helper or UAC broker that this phase does not provide; nothing was executed',
        'Windows hosts write has NOT been executed or verified on a Windows machine'
      ]
    };
    if (!merged.changed) return { status: 'unchanged', plan };
    return { status: 'planned', plan, willChange: true, staged: [{ path: scriptPath, content: script.content }, { path: blockPath, content: merged.block }], notes: plan.notes };
  }

  /** Contract adapter: plan-only, never executes, always emits one terminal. */
  async apply(entries: readonly HostsEntry[], context: OperationContext): Promise<OperationResult> {
    context.emit({ type: 'progress', operationId: context.operationId, sequence: 0, stageKey: 'hosts.planning' });
    const outcome = await this.plan(entries);
    const item: ItemOutcomeInput =
      outcome.status === 'planned'
        ? { id: 'hosts', status: 'unknown', error: operationError('NOT_IMPLEMENTED', 'hosts.windowsExecutionUnverified') }
        : outcome.status === 'unchanged'
          ? { id: 'hosts', status: 'completed' }
          : { id: 'hosts', status: 'failed', error: operationError('INVALID_REQUEST', 'hosts.invalidEntries') };
    const warnings = outcome.status === 'planned' ? [operationError('NOT_IMPLEMENTED', 'hosts.windowsExecutionUnverified')] : [];
    const result = buildResult(context.operationId, [item], warnings);
    emitTerminal(context, result);
    return result;
  }
}

/** Test/diagnostic helper: decodes the `-EncodedCommand` payload of a planned invoke. */
export function decodeWindowsArgs(plan: CommandPlan): { readonly script: string; readonly extra: readonly string[] } {
  const index = plan.command.args.indexOf('-EncodedCommand');
  if (index < 0) throw new Error('encoded command missing');
  const encoded = plan.command.args[index + 1] as string;
  return { script: Buffer.from(encoded, 'base64').toString('utf16le'), extra: plan.command.args.slice(index + 2) };
}
