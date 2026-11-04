/**
 * Caddy local-CA trust for browsers.
 *
 * Caddy stores its internal CA under the worker's isolated HOME. Chromium-based
 * browsers (Chrome, Edge) and Firefox read NSS databases, so trust can be added
 * per user without elevation. The system trust store is intentionally not
 * modified: that would require a privileged helper and is reported separately.
 */
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OperationResultSchema } from '@stackmanage/core';
import type { CertificateStatusView, OperationContext, OperationResult } from '@stackmanage/core';

const ALIAS = 'StackManage Local CA';
const MAX_OUTPUT = 32 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
const CERTUTIL = 'certutil';

export interface CertificateDeps {
  /** Caddy module home; the CA lives below this directory. */
  readonly home: string;
  /** Test/portable override; defaults to the real user's NSS database. */
  readonly nssDbPath?: string;
  readonly userHome?: string;
  readonly platform?: NodeJS.Platform | string;
}

interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly missing: boolean;
}

export class CaddyCertificates {
  private readonly platform: string;
  private readonly nssDb: string;
  private readonly userHome: string;

  constructor(private readonly deps: CertificateDeps) {
    this.platform = deps.platform ?? process.platform;
    this.userHome = deps.userHome ?? homedir();
    this.nssDb = deps.nssDbPath ?? join(this.userHome, '.pki', 'nssdb');
  }

  get authorityPath(): string {
    return join(this.deps.home, '.local', 'share', 'caddy', 'pki', 'authorities', 'local', 'root.crt');
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<CertificateStatusView> {
    const exists = await this.exists(this.authorityPath);
    if (!exists) return { authorityPath: this.authorityPath, exists: false, browserTrust: 'untrusted', systemTrust: 'not-modified' };
    if (this.platform !== 'linux') {
      return { authorityPath: this.authorityPath, exists: true, browserTrust: 'unsupported', systemTrust: 'unsupported', detail: 'NSS trust integration is implemented and tested on Linux only' };
    }
    let certutil: ExecResult;
    try {
      certutil = await runCertutil(['-L', '-d', `sql:${this.nssDb}`, '-n', ALIAS, '-a']);
    } catch {
      return { authorityPath: this.authorityPath, exists: true, browserTrust: 'unsupported', systemTrust: 'not-modified', detail: 'certutil is not available' };
    }
    if (certutil.missing) return { authorityPath: this.authorityPath, exists: true, browserTrust: 'unsupported', systemTrust: 'not-modified', detail: 'certutil is not available' };
    if (certutil.code !== 0) return { authorityPath: this.authorityPath, exists: true, browserTrust: 'untrusted', systemTrust: 'not-modified' };
    const installed = normalizePem(certutil.stdout);
    const authority = normalizePem(await readFile(this.authorityPath, 'utf8'));
    return {
      authorityPath: this.authorityPath,
      exists: true,
      browserTrust: installed.length > 0 && installed === authority ? 'trusted' : 'untrusted',
      systemTrust: 'not-modified'
    };
  }

  async trust(context: OperationContext): Promise<OperationResult> {
    const items: Array<{ id: string; status: 'completed' | 'failed' | 'skipped'; error?: { code: 'UNAVAILABLE' | 'IO_ERROR' | 'INVALID_REQUEST'; messageKey: string; retryable: boolean } }> = [];
    try {
      if (!(await this.exists(this.authorityPath))) {
        const result = OperationResultSchema.parse({
          operationId: context.operationId,
          status: 'failed',
          items: [{ id: 'ca', status: 'failed', error: { code: 'UNAVAILABLE', messageKey: 'certificate.notGenerated', retryable: true } }],
          warnings: []
        });
        context.emit({ type: 'terminal', result });
        return result;
      }
      if (this.platform !== 'linux') {
        const result = OperationResultSchema.parse({
          operationId: context.operationId,
          status: 'failed',
          items: [{ id: 'ca', status: 'failed', error: { code: 'UNAVAILABLE', messageKey: 'certificate.unsupported', retryable: false } }],
          warnings: []
        });
        context.emit({ type: 'terminal', result });
        return result;
      }

      context.emit({ type: 'progress', operationId: context.operationId, sequence: 0, stageKey: 'certificate.prepare', fraction: 0.1 });
      await mkdir(this.nssDb, { recursive: true });
      const initialized = await runCertutil(['-N', '-d', `sql:${this.nssDb}`, '--empty-password']);
      // Existing databases return non-zero for -N; only treat missing certutil as unavailable.
      if (initialized.missing) {
        const result = OperationResultSchema.parse({
          operationId: context.operationId,
          status: 'failed',
          items: [{ id: 'nss', status: 'failed', error: { code: 'UNAVAILABLE', messageKey: 'certificate.certutilMissing', retryable: false } }],
          warnings: []
        });
        context.emit({ type: 'terminal', result });
        return result;
      }
      await runCertutil(['-D', '-d', `sql:${this.nssDb}`, '-n', ALIAS]);
      context.emit({ type: 'progress', operationId: context.operationId, sequence: 1, stageKey: 'certificate.nss', fraction: 0.5 });
      const added = await runCertutil(['-A', '-d', `sql:${this.nssDb}`, '-t', 'C,,', '-n', ALIAS, '-i', this.authorityPath]);
      items.push(added.code === 0 ? { id: 'chromium-nss', status: 'completed' } : { id: 'chromium-nss', status: 'failed', error: { code: 'IO_ERROR', messageKey: 'certificate.trustFailed', retryable: true } });

      for (const profile of await this.firefoxProfiles()) {
        await runCertutil(['-D', '-d', `sql:${profile}`, '-n', ALIAS]);
        const result = await runCertutil(['-A', '-d', `sql:${profile}`, '-t', 'C,,', '-n', ALIAS, '-i', this.authorityPath]);
        items.push(result.code === 0 ? { id: `firefox-${profile.split(/[\\/]/).pop() ?? 'profile'}`, status: 'completed' } : { id: `firefox-${profile.split(/[\\/]/).pop() ?? 'profile'}`, status: 'failed', error: { code: 'IO_ERROR', messageKey: 'certificate.trustFailed', retryable: true } });
      }

      const failed = items.filter(item => item.status === 'failed').length;
      const completed = items.filter(item => item.status === 'completed').length;
      const status = failed === 0 ? 'completed' : completed > 0 ? 'partial' : 'failed';
      const result = OperationResultSchema.parse({ operationId: context.operationId, status, items, warnings: [] });
      context.emit({ type: 'terminal', result });
      return result;
    } catch {
      const result = OperationResultSchema.parse({
        operationId: context.operationId,
        status: 'failed',
        items: [{ id: 'nss', status: 'failed', error: { code: 'IO_ERROR', messageKey: 'certificate.trustFailed', retryable: true } }],
        warnings: []
      });
      context.emit({ type: 'terminal', result });
      return result;
    }
  }

  /** Existing Firefox profiles only; never create or modify a profile that is not present. */
  private async firefoxProfiles(): Promise<string[]> {
    const root = join(this.userHome, '.mozilla', 'firefox');
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const profiles: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = join(root, entry.name);
        if (await this.exists(join(candidate, 'cert9.db'))) profiles.push(candidate);
      }
      return profiles;
    } catch {
      return [];
    }
  }
}

function normalizePem(value: string): string {
  return value.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, '');
}

function runCertutil(args: string[]): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = spawn(CERTUTIL, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stdout, stderr, missing: false });
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8').slice(0, MAX_OUTPUT - stdout.length);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8').slice(0, MAX_OUTPUT - stderr.length);
    });
    child.on('error', error => finish({ code: null, stdout, stderr: error.message, missing: (error as NodeJS.ErrnoException).code === 'ENOENT' }));
    child.on('close', code => finish({ code, stdout, stderr, missing: false }));
  });
}
