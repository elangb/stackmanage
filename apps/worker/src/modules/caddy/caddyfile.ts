/**
 * Deterministic Caddyfile rendering for local static sites.
 *
 * - `admin off`: no admin API socket is exposed.
 * - `auto_https off`: no ACME/public CA traffic for local hostnames.
 * - Each site binds an explicit loopback address; nothing is published on a
 *   wildcard interface.
 * - Inputs are validated before rendering so no caller string can inject a
 *   directive or escape the managed root.
 */
import { isAbsolute, resolve, sep } from 'node:path';
import type { Site } from '@stackmanage/core';
import { LOOPBACK_ADDRESS } from './manifest';

export interface RenderedCaddyfile {
  content: string;
  sites: Site[];
}

const SAFE_PATH = /^[^"'`{}$\\\r\n\0]+$/;

export function assertRenderableSite(site: Site, siteRootsBase: string): void {
  if (!isAbsolute(site.root)) throw new Error('root must be absolute');
  const base = resolve(siteRootsBase);
  const root = resolve(site.root);
  if (root !== base && !root.startsWith(`${base}${sep}`)) throw new Error('root outside managed directory');
  if (!SAFE_PATH.test(site.root)) throw new Error('unsafe root characters');
  for (const hostname of [site.hostname, ...site.aliases]) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(hostname)) throw new Error('invalid hostname');
  }
  if (site.tls) throw new Error('tls is not implemented in phase 1');
  if (site.proxyTarget !== undefined) {
    const target = new URL(site.proxyTarget);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('invalid proxy protocol');
    if (!SAFE_PATH.test(target.href)) throw new Error('unsafe proxy target');
  }
}

/** Sort by port then id so the rendered file and its digest are stable across calls. */
export function renderCaddyfile(sites: Site[], siteRootsBase: string): RenderedCaddyfile {
  const ordered = [...sites].sort((a, b) => a.port - b.port || a.id.localeCompare(b.id));
  const seen = new Set<number>();
  for (const site of ordered) {
    assertRenderableSite(site, siteRootsBase);
    if (seen.has(site.port)) throw new Error('duplicate port');
    seen.add(site.port);
  }
  const blocks: string[] = ['{', '\tadmin off', '\tauto_https off', '}', ''];
  for (const site of ordered) {
    const addresses = [site.hostname, ...site.aliases].map(hostname => `${hostname}:${site.port}`).join(', ');
    blocks.push(`# site: ${site.id}`);
    blocks.push(`${addresses} {`);
    blocks.push(`\tbind ${LOOPBACK_ADDRESS}`);
    if (site.proxyTarget !== undefined) {
      blocks.push(`\treverse_proxy ${site.proxyTarget}`);
    } else {
      blocks.push(`\troot * "${site.root}"`);
      blocks.push('\tfile_server');
    }
    blocks.push('\tlog {', '\t\toutput stdout', '\t\tformat console', '\t}', '}');
    blocks.push('');
  }
  return { content: `${blocks.join('\n').trimEnd()}\n`, sites: ordered };
}
