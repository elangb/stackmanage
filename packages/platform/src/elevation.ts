import type { CommandSpec, ProcessRunner } from './command.js';

export type ElevationKind = 'pkexec' | 'none';

export interface Elevation {
  readonly kind: ElevationKind;
  /** Present only when a supported elevation program was found. */
  readonly wrapper?: CommandSpec;
  readonly reason?: string;
}

/**
 * Finds a supported elevation entry point without prompting the user. Only
 * `pkexec` is accepted: it keeps argv separate and does not require a terminal,
 * unlike `sudo` which would need an interactive TTY or a NOPASSWD rule.
 * `sudo` is deliberately NOT auto-invoked.
 */
export async function detectLinuxElevation(runner: ProcessRunner): Promise<Elevation> {
  const pkexec = await runner.which('pkexec');
  if (!pkexec) return { kind: 'none', reason: 'pkexec not found; privileged hosts write is unavailable' };
  return { kind: 'pkexec', wrapper: { file: pkexec, args: [] } };
}

/** Wraps a command for elevation: `pkexec <file> <args...>`. Args stay separate argv elements. */
export function elevateWith(elevation: Elevation, command: CommandSpec): CommandSpec | undefined {
  if (elevation.kind === 'none' || !elevation.wrapper) return undefined;
  return { file: elevation.wrapper.file, args: [...elevation.wrapper.args, command.file, ...command.args] };
}
