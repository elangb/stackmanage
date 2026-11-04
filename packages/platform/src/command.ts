/** A fully resolved, non-shell command. argv elements are opaque strings, never interpolated into a shell. */
export interface CommandSpec {
  readonly file: string;
  readonly args: readonly string[];
}

export interface RunOptions {
  /** Hard deadline; exceeding it is reported as a timeout, never as success. */
  readonly timeoutMs: number;
  /** Raw bytes written to stdin. Used for PowerShell `-EncodedCommand` only. */
  readonly stdin?: string;
  readonly signal?: AbortSignal;
}

export type RunResult =
  | { readonly ok: true; readonly code: number; readonly stdout: string; readonly stderr: string; readonly timedOut: false }
  | { readonly ok: false; readonly reason: 'missing' | 'permission' | 'timeout' | 'failed' | 'aborted'; readonly code?: number; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean };

export interface ProcessRunner {
  /** Returns the absolute path or `undefined` when the program is not on PATH. */
  which(file: string): Promise<string | undefined>;
  run(command: CommandSpec, options: RunOptions): Promise<RunResult>;
}

export interface CommandPlan {
  /** Human-auditable description used in reports and logs; never secret-bearing. */
  readonly description: string;
  /** The exact command an executor would spawn (without elevation wrapper). */
  readonly command: CommandSpec;
  /** Elevation wrapper, e.g. `pkexec`, when privilege is required and available. */
  readonly elevated?: CommandSpec;
  readonly privilege: 'not-required' | 'required' | 'required-unavailable' | 'unverified';
  /** Whether this adapter has actually executed this plan on this platform. */
  readonly execution: 'verified' | 'unverified';
  readonly notes: readonly string[];
}
