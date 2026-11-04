import { HostsEntrySchema, HostnameSchema } from '@stackmanage/core';
import { HOSTS_BLOCK_MAX_BYTES, HOSTS_MARKER_BEGIN, HOSTS_MARKER_END } from './scripts.js';

export interface HostsEntry {
  readonly hostname: string;
  readonly address: string;
}

/** Result of parsing the exact managed block. Never throws on user data. */
export type BlockParse =
  | { readonly status: 'absent'; readonly entries: readonly HostsEntry[] }
  | { readonly status: 'valid'; readonly entries: readonly HostsEntry[]; readonly block: string; readonly range: { readonly start: number; readonly end: number } }
  | { readonly status: 'malformed'; readonly reason: 'duplicate-markers' | 'unterminated' | 'invalid-entry' | 'invalid-address'; readonly detail: string };

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** Structural IPv6 check without DNS resolution; rejects zone IDs and brackets. */
export function isIpv6(address: string): boolean {
  if (address.length === 0 || address.length > 45) return false;
  if (/[^0-9a-fA-F:.]/.test(address)) return false;
  if ((address.match(/::/g) ?? []).length > 1) return false;
  if (address.includes(':::')) return false;
  const hasV4Tail = address.includes('.');
  if (hasV4Tail && !IPV4.test(address.slice(address.lastIndexOf(':') + 1))) return false;
  const groups = address.split(':');
  if (!address.includes('::') && groups.length !== 8) return false;
  if (groups.length > 8) return false;
  const hexGroups = groups.filter(g => g.length > 0 && !g.includes('.'));
  return hexGroups.every(g => /^[0-9a-fA-F]{1,4}$/.test(g));
}

export function isValidAddress(address: string): boolean {
  return IPV4.test(address) || isIpv6(address);
}

/** Canonical ordering so an unchanged entry set never rewrites the file. */
export function normalizeEntries(entries: readonly HostsEntry[]): HostsEntry[] {
  const seen = new Set<string>();
  const unique: HostsEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.address} ${entry.hostname.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ hostname: entry.hostname, address: entry.address });
  }
  return unique.sort((a, b) => {
    if (a.hostname === b.hostname) return a.address.localeCompare(b.address);
    return a.hostname.localeCompare(b.hostname);
  });
}

export type EntryValidation =
  | { readonly ok: true; readonly entries: readonly HostsEntry[] }
  | { readonly ok: false; readonly reason: string; readonly rejected: readonly { readonly id: string; readonly message: string }[] };

/**
 * Validates every requested entry independently. Invalid entries are rejected
 * with a reason but do not discard valid siblings; the caller decides whether a
 * partial set may be applied.
 */
export function validateEntries(input: readonly unknown[]): EntryValidation {
  const accepted: HostsEntry[] = [];
  const rejected: { id: string; message: string }[] = [];
  input.forEach((candidate, index) => {
    const parsed = HostsEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      rejected.push({ id: `entries[${index}]`, message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    if (parsed.data.hostname === 'localhost' || parsed.data.hostname.endsWith('.localhost')) {
      rejected.push({ id: `entries[${index}]`, message: 'localhost is reserved and never managed' });
      return;
    }
    accepted.push(parsed.data);
  });
  if (rejected.length > 0) return { ok: false, reason: 'validation failed', rejected };
  return { ok: true, entries: normalizeEntries(accepted) };
}

export function renderBlock(entries: readonly HostsEntry[]): string {
  const lines = [HOSTS_MARKER_BEGIN, ...normalizeEntries(entries).map(e => `${e.address}\t${e.hostname}`), HOSTS_MARKER_END];
  const block = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(block, 'utf8') > HOSTS_BLOCK_MAX_BYTES) throw new Error('managed block exceeds size limit');
  return block;
}

function tokenize(line: string): { address: string; hostnames: string[] } | undefined {
  const withoutComment = line.replace(/#.*$/, '').trim();
  if (withoutComment.length === 0) return undefined;
  const tokens = withoutComment.split(/\s+/);
  if (tokens.length < 2) return undefined;
  const [address, ...hostnames] = tokens as [string, ...string[]];
  return { address, hostnames };
}

/**
 * Parses only the exact marker-delimited managed block. Unrelated lines are
 * ignored. A single unmatched or duplicated marker is malformed, never
 * silently repaired or treated as absent.
 */
export function parseManagedBlock(content: string): BlockParse {
  const lines = content.split(/\r?\n/);
  const starts: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, index) => {
    if (line === HOSTS_MARKER_BEGIN) starts.push(index);
    if (line === HOSTS_MARKER_END) ends.push(index);
  });
  if (starts.length === 0 && ends.length === 0) return { status: 'absent', entries: [] };
  if (starts.length !== ends.length) return { status: 'malformed', reason: starts.length > ends.length ? 'unterminated' : 'unterminated', detail: 'marker counts differ' };
  if (starts.length > 1) return { status: 'malformed', reason: 'duplicate-markers', detail: `${starts.length} managed blocks present` };
  const start = starts[0] as number;
  const end = ends[0] as number;
  if (end <= start) return { status: 'malformed', reason: 'duplicate-markers', detail: 'end marker precedes start marker' };
  const entries: HostsEntry[] = [];
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index] as string;
    if (line.trim().length === 0) continue;
    const tokens = tokenize(line);
    if (!tokens) return { status: 'malformed', reason: 'invalid-entry', detail: `line ${index + 1}: unusable entry` };
    if (!isValidAddress(tokens.address)) return { status: 'malformed', reason: 'invalid-address', detail: `line ${index + 1}: invalid address` };
    for (const hostname of tokens.hostnames) {
      if (!HostnameSchema.safeParse(hostname).success) return { status: 'malformed', reason: 'invalid-entry', detail: `line ${index + 1}: invalid hostname` };
      entries.push({ hostname, address: tokens.address });
    }
  }
  return { status: 'valid', entries: normalizeEntries(entries), block: lines.slice(start, end + 1).join('\n') + '\n', range: { start, end } };
}

/**
 * Produces the next file content and whether it differs from `current`. The
 * caller uses the boolean to keep updates idempotent: no write when unchanged.
 */
export function mergeManagedBlock(current: string, entries: readonly HostsEntry[]): { readonly content: string; readonly changed: boolean; readonly block: string } {
  const block = renderBlock(entries);
  const parsed = parseManagedBlock(current);
  if (parsed.status === 'malformed') throw new Error(`refusing to modify a malformed managed block: ${parsed.reason}`);
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const blockForFile = block.split('\n').join(eol);
  let content: string;
  if (parsed.status === 'absent') {
    const separator = current.length === 0 || current.endsWith('\n') || current.endsWith('\r\n') ? '' : eol;
    content = `${current}${separator}${blockForFile}`;
  } else {
    const lines = current.split(/\r?\n/);
    const { start, end } = parsed.range;
    const before = lines.slice(0, start);
    const after = lines.slice(end + 1);
    content = [...before, ...blockForFile.split(/\r?\n/).slice(0, -1), ...after].join(eol);
  }
  const normalizedContent = content.endsWith('\n') || content.endsWith('\r\n') ? content : `${content}${eol}`;
  return { content: normalizedContent, changed: normalizedContent !== current, block };
}
