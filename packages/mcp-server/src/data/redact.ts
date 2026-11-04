export interface RedactionResult {
  readonly text: string;
  readonly count: number;
}

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string | ((substring: string, ...groups: string[]) => string);
}

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const RULES: readonly RedactionRule[] = [
  { pattern: PRIVATE_KEY, replacement: '[REDACTED PRIVATE KEY]' },
  {
    pattern: /^(\s*(?:authorization|proxy-authorization)\s*:\s*).+$/gim,
    replacement: (_match, prefix: string) => `${prefix}[REDACTED]`
  },
  {
    pattern: /^(\s*(?:set-cookie|cookie)\s*:\s*).+$/gim,
    replacement: (_match, prefix: string) => `${prefix}[REDACTED]`
  },
  {
    pattern:
      /((?:["']?(?:password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|private[_-]?key)["']?\s*[:=]\s*))(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;]+)/gi,
    replacement: (_match, prefix: string) => `${prefix}[REDACTED]`
  },
  {
    pattern: /(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
    replacement: (_match, scheme: string) => `${scheme}[REDACTED]:[REDACTED]@`
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
    replacement: 'Bearer [REDACTED]'
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[REDACTED JWT]'
  }
];

/** Removes common credential forms before any log or config text leaves the process. */
export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let count = 0;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const match = args[0];
      const groups = args.slice(1, -2).filter((value): value is string => typeof value === 'string');
      count += 1;
      return typeof rule.replacement === 'string' ? rule.replacement : rule.replacement(String(match), ...groups);
    });
  }
  return { text, count };
}

/** Remove URL credentials but keep the host and path useful for diagnostics. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username !== '' || parsed.password !== '') {
      parsed.username = '[REDACTED]';
      parsed.password = '[REDACTED]';
    }
    return parsed.toString();
  } catch {
    return redactSecrets(url).text;
  }
}

/** Bound a string without splitting a trailing multibyte character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  return buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}
