import type { z } from 'zod';
import { ArchitectureSchema, PlatformSchema } from '@stackmanage/core';

export type SupportedPlatform = 'linux' | 'win32';
export type SupportedArchitecture = z.infer<typeof ArchitectureSchema>;

export interface HostFacts {
  /** `process.platform` style value. Anything outside `linux`/`win32` is unsupported. */
  readonly platform: string;
  /** `process.arch` style value such as `x64` or `arm64`. */
  readonly arch: string;
}

export type Detection =
  | { readonly supported: true; readonly platform: SupportedPlatform; readonly architecture: SupportedArchitecture }
  | { readonly supported: false; readonly reason: string; readonly platform: string; readonly architecture: string };

const SUPPORTED_PLATFORMS = new Set<string>(PlatformSchema.options.filter(p => p !== 'darwin'));
const SUPPORTED_ARCHITECTURES = new Set<string>(ArchitectureSchema.options);

/**
 * Pure classification of the host. Darwin is a declared contract platform but has
 * no adapter in this phase, so it is reported unsupported rather than guessed.
 */
export function detectPlatform(facts: HostFacts): Detection {
  if (!SUPPORTED_PLATFORMS.has(facts.platform)) {
    return { supported: false, reason: `platform "${facts.platform}" has no Phase 1 adapter`, platform: facts.platform, architecture: facts.arch };
  }
  if (!SUPPORTED_ARCHITECTURES.has(facts.arch)) {
    return { supported: false, reason: `architecture "${facts.arch}" is not part of the v1 contract`, platform: facts.platform, architecture: facts.arch };
  }
  return {
    supported: true,
    platform: facts.platform as SupportedPlatform,
    architecture: facts.arch as SupportedArchitecture
  };
}

export function detectCurrentHost(): Detection {
  return detectPlatform({ platform: process.platform, arch: process.arch });
}
