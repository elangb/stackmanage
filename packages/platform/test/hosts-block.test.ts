import { describe, expect, it } from 'vitest';
import { HOSTS_MARKER_BEGIN, HOSTS_MARKER_END } from '../src/scripts';
import { isIpv6, isValidAddress, mergeManagedBlock, normalizeEntries, parseManagedBlock, renderBlock, validateEntries } from '../src/hosts-block';

const begin = HOSTS_MARKER_BEGIN;
const end = HOSTS_MARKER_END;

describe('hosts managed block parsing', () => {
  it('treats a file without markers as absent and preserves unrelated content', () => {
    const content = '127.0.0.1 localhost\n# custom\n10.0.0.1 router.lan\n';
    const parsed = parseManagedBlock(content);
    expect(parsed.status).toBe('absent');
    const merged = mergeManagedBlock(content, [{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect(merged.changed).toBe(true);
    expect(merged.content.startsWith(content)).toBe(true);
    expect(merged.content).toContain(`${begin}\n127.0.0.1\tapp.test\n${end}`);
  });

  it('replaces only the managed block, keeping lines before and after', () => {
    const content = ['127.0.0.1 localhost', begin, '127.0.0.1 old.test', end, '10.0.0.9 after.lan', ''].join('\n');
    const merged = mergeManagedBlock(content, [{ hostname: 'new.test', address: '::1' }]);
    expect(merged.content).toContain('127.0.0.1 localhost');
    expect(merged.content).toContain('10.0.0.9 after.lan');
    expect(merged.content).not.toContain('old.test');
    expect(merged.content).toContain('::1\tnew.test');
  });

  it('is idempotent for identical entries regardless of input order or IPv6 form', () => {
    const first = mergeManagedBlock('127.0.0.1 localhost\n', [{ hostname: 'b.test', address: '127.0.0.1' }, { hostname: 'a.test', address: '::1' }]);
    const second = mergeManagedBlock(first.content, [{ hostname: 'a.test', address: '::1' }, { hostname: 'b.test', address: '127.0.0.1' }, { hostname: 'b.test', address: '127.0.0.1' }]);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('normalizes duplicate entries and sorts deterministically', () => {
    const entries = normalizeEntries([{ hostname: 'z.test', address: '127.0.0.1' }, { hostname: 'a.test', address: '127.0.0.1' }, { hostname: 'a.test', address: '127.0.0.1' }]);
    expect(entries).toEqual([{ hostname: 'a.test', address: '127.0.0.1' }, { hostname: 'z.test', address: '127.0.0.1' }]);
  });

  it('accepts CRLF files and keeps their line endings', () => {
    const content = '127.0.0.1 localhost\r\n';
    const merged = mergeManagedBlock(content, [{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect(merged.content.includes('\r\n')).toBe(true);
    expect(merged.content.replace(/\r\n/g, '\n')).not.toMatch(/\r/);
  });

  it('rejects duplicated, unterminated and inverted markers', () => {
    expect(parseManagedBlock(`${begin}\n${begin}\n${end}\n`).status).toBe('malformed');
    expect(parseManagedBlock(`${begin}\n127.0.0.1 a.test\n`).status).toBe('malformed');
    expect(parseManagedBlock(`${end}\n${begin}\n`).status).toBe('malformed');
    expect(parseManagedBlock(`${begin}\n127.0.0.1 a.test\n${end}\n${begin}\n${end}\n`).status).toBe('malformed');
  });

  it('rejects invalid entries inside the block rather than importing them', () => {
    expect(parseManagedBlock(`${begin}\nnot-an-ip a.test\n${end}\n`).status).toBe('malformed');
    expect(parseManagedBlock(`${begin}\n127.0.0.1\n${end}\n`).status).toBe('malformed');
    expect(parseManagedBlock(`${begin}\n127.0.0.1 bad_host.test\n${end}\n`).status).toBe('malformed');
    // Multiple hostnames on one address are valid /etc/hosts syntax.
    const multi = parseManagedBlock(`${begin}\n127.0.0.1 a.test b.test\n${end}\n`);
    expect(multi.status).toBe('valid');
    if (multi.status === 'valid') expect(multi.entries.map(e => e.hostname)).toEqual(['a.test', 'b.test']);
    // Inline comments inside the block are accepted and dropped.
    const commented = parseManagedBlock(`${begin}\n127.0.0.1 a.test # note\n${end}\n`);
    expect(commented.status).toBe('valid');
  });

  it('refuses to merge when the existing block is malformed', () => {
    expect(() => mergeManagedBlock(`${begin}\n`, [{ hostname: 'a.test', address: '127.0.0.1' }])).toThrow(/malformed/);
  });

  it('does not treat a marker-like comment with trailing text as a marker', () => {
    const content = `${begin} extra\n127.0.0.1 localhost\n`;
    expect(parseManagedBlock(content).status).toBe('absent');
  });
});

describe('entry validation', () => {
  it('rejects injection attempts but keeps valid siblings diagnosable', () => {
    const result = validateEntries([
      { hostname: 'ok.test', address: '127.0.0.1' },
      { hostname: 'evil.test\n127.0.0.1 bad.test', address: '127.0.0.1' },
      { hostname: 'x.test', address: '127.0.0.1  # comment' },
      { hostname: 'localhost', address: '127.0.0.1' }
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected.map(r => r.id)).toEqual(['entries[1]', 'entries[2]', 'entries[3]']);
  });

  it('accepts IPv4 and structural IPv6 only', () => {
    for (const address of ['127.0.0.1', '::1', '2001:db8::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isValidAddress(address)).toBe(true);
    for (const address of ['127.0.0.256', '1.2.3', '::1%eth0', '[::1]', '2001:db8:::1', 'g::1', '', '1.2.3.4:80']) expect(isValidAddress(address)).toBe(false);
    expect(isIpv6('12345::')).toBe(false);
  });

  it('rejects an empty request', () => {
    expect(validateEntries([]).ok).toBe(true);
    expect(mergeManagedBlock('', []).content).toBe(`${begin}\n${end}\n`);
  });

  it('renders a block whose size is bounded', () => {
    const entries = Array.from({ length: 10 }, (_v, i) => ({ hostname: `h${i}.test`, address: '127.0.0.1' }));
    const block = renderBlock(entries);
    expect(block.startsWith(begin)).toBe(true);
    expect(block.trimEnd().endsWith(end)).toBe(true);
    expect(block.split('\n').filter(l => l.includes('h')).length).toBe(10);
  });
});
