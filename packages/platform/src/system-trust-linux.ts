import type { OperationContext, OperationResult } from '@stackmanage/core';
import { OperationResultSchema } from '@stackmanage/core';
import type { FileSystemPort } from './ports.js';
import type { CommandPlan, ProcessRunner } from './command.js';
import { elevateWith, type Elevation } from './elevation.js';
import { buildResult, emitTerminal, operationError } from './results.js';

export const LINUX_CA_TARGET_DIRECTORY = '/usr/local/share/ca-certificates';
export const LINUX_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
export const LINUX_TRUST_HELPER_DIRECTORY = '/var/lib/stackmanage/helpers';

export interface LinuxSystemTrustOptions {
  readonly fs: FileSystemPort;
  readonly runner: ProcessRunner;
  readonly certPath: string;
  readonly targetDirectory?: string;
  readonly targetName?: string;
  readonly bundlePath?: string;
  readonly helperDirectory?: string;
  readonly elevation?: () => Promise<Elevation>;
  readonly runTimeoutMs?: number;
}

export type SystemTrustStatus =
  | { readonly status: 'trusted' }
  | { readonly status: 'untrusted' }
  | { readonly status: 'missing-certificate' }
  | { readonly status: 'unknown'; readonly reason: string };

export type SystemTrustInstall =
  | { readonly status: 'installed'; readonly plan: CommandPlan }
  | { readonly status: 'unavailable'; readonly reason: string; readonly plan?: CommandPlan }
  | { readonly status: 'failed'; readonly reason: string; readonly plan?: CommandPlan };

/**
 * System-wide CA trust on Linux. This always requires an explicit elevation
 * provider; nothing is written directly and no password is requested silently.
 * The helper receives only absolute paths as argv and never a shell string.
 */
export class LinuxSystemTrust {
  private readonly targetDirectory: string;
  private readonly targetName: string;
  private readonly bundlePath: string;
  private readonly helperDirectory: string;
  private readonly runTimeoutMs: number;

  constructor(private readonly options: LinuxSystemTrustOptions) {
    this.targetDirectory = options.targetDirectory ?? LINUX_CA_TARGET_DIRECTORY;
    this.targetName = options.targetName ?? 'stackmanage-local.crt';
    this.bundlePath = options.bundlePath ?? LINUX_CA_BUNDLE;
    this.helperDirectory = options.helperDirectory ?? LINUX_TRUST_HELPER_DIRECTORY;
    this.runTimeoutMs = options.runTimeoutMs ?? 30000;
    assertSafePath(options.certPath);
    assertSafePath(this.targetDirectory);
    assertSafePath(this.bundlePath);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(this.targetName)) throw new Error('invalid target name');
  }

  get installedPath(): string {
    return `${this.targetDirectory}/${this.targetName}`;
  }

  async status(): Promise<SystemTrustStatus> {
    let cert: string;
    try {
      cert = await this.options.fs.readFile(this.options.certPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing-certificate' };
      return { status: 'unknown', reason: 'certificate is unreadable' };
    }
    let bundle: string;
    try {
      bundle = await this.options.fs.readFile(this.bundlePath);
    } catch {
      return { status: 'unknown', reason: 'CA bundle is unreadable' };
    }
    return fingerprint(cert) !== '' && fingerprint(bundle).includes(fingerprint(cert)) ? { status: 'trusted' } : { status: 'untrusted' };
  }

  /** Plan/install the certificate through pkexec + a fixed helper script. */
  async install(context: OperationContext): Promise<OperationResult> {
    context.emit({ type: 'progress', operationId: context.operationId, sequence: 0, stageKey: 'systemTrust.preparing', fraction: 0.1 });
    const outcome = await this.installInternal();
    if (outcome.status === 'installed') {
      const result = OperationResultSchema.parse({ operationId: context.operationId, status: 'completed', items: [{ id: 'system-trust', status: 'completed' }], warnings: [] });
      emitTerminal(context, result);
      return result;
    }
    const result = buildResult(context.operationId, [
      {
        id: 'system-trust',
        status: outcome.status === 'unavailable' ? 'skipped' : 'failed',
        error: operationError(outcome.status === 'unavailable' ? 'UNAVAILABLE' : 'IO_ERROR', outcome.status === 'unavailable' ? 'systemTrust.privilegeUnavailable' : 'systemTrust.failed')
      }
    ]);
    emitTerminal(context, result);
    return result;
  }

  async remove(context: OperationContext): Promise<OperationResult> {
    const helper = '#!/bin/sh\nset -eu\nrm -f "$1"\nupdate-ca-certificates\n';
    const scriptPath = `${this.helperDirectory}/stackmanage-ca-remove.sh`;
    const plan: CommandPlan = {
      description: 'remove StackManage local CA from the system trust store',
      command: { file: '/bin/sh', args: [scriptPath, this.installedPath] },
      privilege: 'required',
      execution: 'unverified',
      notes: ['requires an interactive polkit prompt; never executed by tests']
    };
    const elevation = await (this.options.elevation ?? defaultElevation)();
    const elevated = elevateWith(elevation, plan.command);
    if (elevated === undefined) {
      const result = buildResult(context.operationId, [{ id: 'system-trust', status: 'skipped', error: operationError('UNAVAILABLE', 'systemTrust.privilegeUnavailable') }]);
      emitTerminal(context, result);
      return result;
    }
    const staged = await this.stage(scriptPath, helper);
    if (!staged) {
      const result = buildResult(context.operationId, [{ id: 'system-trust', status: 'failed', error: operationError('IO_ERROR', 'systemTrust.failed') }]);
      emitTerminal(context, result);
      return result;
    }
    const run = await this.options.runner.run(elevated, { timeoutMs: this.runTimeoutMs });
    const ok = run.ok && run.code === 0;
    const result = buildResult(context.operationId, [{ id: 'system-trust', status: ok ? 'completed' : run.ok || run.code === undefined ? 'unknown' : 'failed', ...(ok ? {} : { error: operationError('IO_ERROR', 'systemTrust.failed') }) }]);
    emitTerminal(context, result);
    return result;
  }

  async planInstall(): Promise<CommandPlan> {
    const script = this.helperScript();
    const scriptPath = `${this.helperDirectory}/stackmanage-ca-install.sh`;
    const command = { file: '/bin/sh', args: [scriptPath, this.options.certPath, this.targetDirectory, this.targetName] };
    const elevation = await (this.options.elevation ?? defaultElevation)();
    const elevated = elevateWith(elevation, command);
    return {
      description: 'install StackManage local CA into the system trust store',
      command,
      privilege: 'required',
      execution: 'unverified',
      notes: [script, ...(elevated === undefined ? ['no supported elevation program is available; nothing will execute'] : ['runs through an interactive elevation prompt'])]
    };
  }

  private async installInternal(): Promise<SystemTrustInstall> {
    const elevation = await (this.options.elevation ?? defaultElevation)();
    const script = this.helperScript();
    const scriptPath = `${this.helperDirectory}/stackmanage-ca-install.sh`;
    const command = { file: '/bin/sh', args: [scriptPath, this.options.certPath, this.targetDirectory, this.targetName] };
    const elevated = elevateWith(elevation, command);
    const plan = await this.planInstall();
    if (elevated === undefined) return { status: 'unavailable', reason: 'no elevation provider', plan };
    if (!(await this.stage(scriptPath, script))) return { status: 'unavailable', reason: 'helper staging failed', plan };
    const run = await this.options.runner.run(elevated, { timeoutMs: this.runTimeoutMs });
    if (!run.ok) return { status: run.reason === 'missing' ? 'unavailable' : 'failed', reason: run.reason ?? 'runner failed', plan };
    if (run.code !== 0) return { status: 'failed', reason: `helper exited ${run.code}`, plan };
    return { status: 'installed', plan };
  }

  private async stage(path: string, content: string): Promise<boolean> {
    try {
      await this.options.fs.mkdirp(this.helperDirectory);
      await this.options.fs.writeFileAtomic(path, content);
      return true;
    } catch {
      return false;
    }
  }

  private helperScript(): string {
    return [
      '#!/bin/sh',
      'set -eu',
      'cert="$1"; target="$2"; name="$3"',
      'install -m 0644 "$cert" "$target/$name"',
      'update-ca-certificates',
      ''
    ].join('\n');
  }
}

async function defaultElevation(): Promise<Elevation> {
  return { kind: 'none', reason: 'no elevation provider was supplied' };
}

function assertSafePath(path: string): void {
  const hasControl = [...path].some(character => character.charCodeAt(0) < 32);
  if (!path.startsWith('/') || hasControl || /["'`$\\]/.test(path) || path.includes('..')) throw new Error('unsafe absolute path');
}

function fingerprint(pem: string): string {
  const matches = [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)];
  return matches.map(match => (match[1] ?? '').replace(/\s+/g, '')).join('\n');
}
