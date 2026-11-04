import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DataRoots } from '../data/roots.js';
import { readHeadWithin } from '../data/read.js';
import { redactSecrets, truncateUtf8 } from '../data/redact.js';
import { LIMITS } from '../limits.js';
import { runTool } from './common.js';

export type ConfigModule = 'caddy' | 'nginx';

export function configReadTool(roots: DataRoots, moduleId: ConfigModule): Promise<CallToolResult> {
  return runTool('config.read', async () => {
    const root = moduleId === 'caddy' ? roots.caddyRoot : roots.nginxRoot;
    const relativePath = moduleId === 'caddy' ? 'caddyfiles/default.Caddyfile' : 'service/conf/nginx.conf';
    const result = await readHeadWithin(root, relativePath, LIMITS.maxConfigBytes);
    if (result.state === 'absent') {
      return {
        moduleId,
        path: relativePath,
        exists: false,
        bytes: 0,
        truncated: false,
        redacted: false,
        redactions: 0,
        maxBytes: LIMITS.maxConfigBytes,
        content: ''
      };
    }
    const redacted = redactSecrets(result.text);
    const trimmedByRedaction = Buffer.byteLength(redacted.text, 'utf8') > LIMITS.maxConfigBytes;
    const content = truncateUtf8(redacted.text, LIMITS.maxConfigBytes);
    return {
      moduleId,
      path: relativePath,
      exists: true,
      bytes: result.bytes,
      truncated: result.truncated || trimmedByRedaction,
      redacted: redacted.count > 0,
      redactions: redacted.count,
      maxBytes: LIMITS.maxConfigBytes,
      content
    };
  });
}
