import type { CommandPlan, CommandSpec, ProcessRunner, RunOptions, RunResult } from '../src/command';
import type { FileSystemPort, PathKind } from '../src/ports';

export interface FakeRun {
  readonly command: CommandSpec;
  readonly options: RunOptions;
  readonly elevated: boolean;
}

/**
 * In-memory filesystem with real atomic-replace semantics (temp file then
 * rename) so tests can assert that a half-written file is never observable.
 */
export class MemoryFileSystem implements FileSystemPort {
  readonly files = new Map<string, string>();
  readonly writes: { path: string; atomic: boolean }[] = [];
  readonly directories = new Set<string>();
  /** Paths whose write must fail, used to exercise failure reporting. */
  readonly failWrites = new Set<string>();
  /** Paths the current user cannot write, used for the elev* path. */
  readonly readOnly = new Set<string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
  }

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return value;
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (this.failWrites.has(path)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    this.writes.push({ path, atomic: false });
    this.files.set(path, content);
  }

  async writeFileAtomic(path: string, content: string): Promise<void> {
    if (this.failWrites.has(path)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    // A real implementation never mutates the destination before rename; the
    // fake deletes only at the end to make that contract visible to callers.
    this.files.set(`${path}.tmp`, content);
    this.writes.push({ path, atomic: true });
    this.files.set(path, this.files.get(`${path}.tmp`) as string);
    this.files.delete(`${path}.tmp`);
  }

  async mkdirp(path: string): Promise<void> {
    this.directories.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    this.files.set(to, value);
    this.files.delete(from);
  }

  async modifiedAt(path: string): Promise<number | undefined> {
    return this.files.has(path) ? 1 : undefined;
  }

  async kind(path: string): Promise<PathKind> {
    if (this.files.has(path)) return 'file';
    return this.directories.has(path) ? 'directory' : 'missing';
  }

  async readdir(path: string): Promise<string[]> {
    const prefix = `${path.replace(/\/+$/, '')}/`;
    return [...this.files.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
  }

  async canWrite(path: string): Promise<boolean> {
    return !this.readOnly.has(path);
  }
}

export class FakeRunner implements ProcessRunner {
  readonly runs: FakeRun[] = [];
  private readonly available = new Set<string>();
  private readonly results = new Map<string, RunResult>();

  withCommand(file: string, path = `/usr/bin/${file}`): this {
    this.available.add(file);
    this.paths.set(file, path);
    return this;
  }

  readonly paths = new Map<string, string>();

  respond(file: string, result: RunResult): this {
    this.results.set(file, result);
    return this;
  }

  async which(file: string): Promise<string | undefined> {
    return this.available.has(file) ? (this.paths.get(file) ?? `/usr/bin/${file}`) : undefined;
  }

  async run(command: CommandSpec, options: RunOptions): Promise<RunResult> {
    this.runs.push({ command, options, elevated: command.file === '/usr/bin/pkexec' });
    const result = this.results.get(command.file);
    return result ?? { ok: true, code: 0, stdout: '', stderr: '', timedOut: false };
  }
}

export function okResult(code = 0, stdout = ''): RunResult {
  return { ok: true, code, stdout, stderr: '', timedOut: false };
}

export function failedResult(reason: 'missing' | 'permission' | 'timeout' | 'failed' | 'aborted', code?: number): RunResult {
  return { ok: false, reason, stdout: '', stderr: 'failure', timedOut: reason === 'timeout', ...(code === undefined ? {} : { code }) };
}

export interface RecordingContext {
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly events: { type: string }[];
  emit(event: { type: 'progress' } | { type: 'terminal'; result: unknown }): void;
}

export function recordingContext(operationId = 'op-1', signal = new AbortController().signal): RecordingContext {
  const events: { type: string }[] = [];
  return {
    operationId,
    signal,
    events,
    emit(event) {
      events.push(event);
    }
  };
}

export function planCommand(plan: CommandPlan | undefined): CommandSpec | undefined {
  return plan?.elevated ?? plan?.command;
}
