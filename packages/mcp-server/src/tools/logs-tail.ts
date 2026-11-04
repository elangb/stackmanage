import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DataRoots } from '../data/roots.js';
import { readTailWithin } from '../data/read.js';
import { redactSecrets, truncateUtf8 } from '../data/redact.js';
import { LIMITS } from '../limits.js';
import { runTool } from './common.js';

export type LogModule = 'caddy' | 'nginx';

function location(moduleId: LogModule): { root: string; relativePath: string } | null {
  if (moduleId === 'caddy') return { root: 'caddy', relativePath: 'logs/default.log' };
  if (moduleId === 'nginx') return { root: 'nginx', relativePath: 'service/logs/error.log' };
  return null;
}

export function logsTailTool(roots: DataRoots, moduleId: LogModule, requestedMaxBytes?: number): Promise<CallToolResult> {
  return runTool('logs.tail', async () => {
    const maxBytes = Math.min(Math.max(requestedMaxBytes ?? LIMITS.defaultLogBytes, 256), LIMITS.maxLogBytes);
    const target = location(moduleId);
    if (target === null) return { moduleId, path: null, exists: false, bytes: 0, truncated: false, redacted: false, redactions: 0, maxBytes, text: '' };
    const root = target.root === 'caddy' ? roots.caddyRoot : roots.nginxRoot;
    const result = await readTailWithin(root, target.relativePath, maxBytes);
    if (result.state === 'absent') {
      return {
        moduleId,
        path: target.relativePath,
        exists: false,
        bytes: 0,
        truncated: false,
        redacted: false,
        redactions: 0,
        maxBytes,
        text: ''
      };
    }
    const redacted = redactSecrets(result.text);
    const trimmedByRedaction = Buffer.byteLength(redacted.text, 'utf8') > maxBytes;
    const text = truncateUtf8(redacted.text, maxBytes);
    return {
      moduleId,
      path: target.relativePath,
      exists: true,
      bytes: result.bytes,
      truncated: result.truncated || trimmedByRedaction,
      redacted: redacted.count > 0,
      redactions: redacted.count,
      maxBytes,
      text
    };
  });
}
