import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import type { DataRoots } from '../data/roots.js';
import { isPathInside } from '../data/roots.js';
import { redactUrl } from '../data/redact.js';
import { readCaddySites, type Warning } from '../data/state.js';
import { runTool } from './common.js';

interface SiteView {
  readonly id: string;
  readonly hostname: string;
  readonly aliases: readonly string[];
  readonly port: number;
  readonly tls: boolean;
  readonly root: string;
  readonly rootWithinManagedSites: boolean;
  readonly proxyTarget: string | null;
  readonly server: { readonly moduleId: string; readonly installationId: string; readonly instanceId: string };
}

export function sitesListTool(roots: DataRoots): Promise<CallToolResult> {
  return runTool('sites.list', async () => {
    const read = await readCaddySites(roots);
    if (read.state === 'absent') return { moduleId: 'caddy', state: 'absent', sites: [], warnings: [] };
    if (read.state === 'unknown') {
      const warnings: Warning[] = [{ code: 'STATE_UNREADABLE', message: `Persisted Caddy sites are ${read.reason}; no sites are claimed.` }];
      return { moduleId: 'caddy', state: 'unknown', sites: [], warnings };
    }
    const warnings: Warning[] = [];
    const managedRoot = join(roots.caddyRoot, 'sites');
    const sites: SiteView[] = read.value.sites.map(site => {
      const rootWithinManagedSites = isPathInside(managedRoot, site.root);
      if (!rootWithinManagedSites) {
        warnings.push({ code: 'SITE_ROOT_OUTSIDE_MANAGED', message: `Site ${site.id} has a document root outside the managed sites directory.` });
      }
      return {
        id: site.id,
        hostname: site.hostname,
        aliases: site.aliases,
        port: site.port,
        tls: site.tls,
        root: site.root,
        rootWithinManagedSites,
        proxyTarget: site.proxyTarget !== undefined ? redactUrl(site.proxyTarget) : null,
        server: {
          moduleId: site.server.moduleId,
          installationId: site.server.installationId,
          instanceId: site.server.instanceId
        }
      };
    });
    return { moduleId: 'caddy', state: sites.length === 0 ? 'empty' : 'present', sites, warnings };
  });
}
