import { describe, expect, it } from 'vitest';
import { LinuxSystemTrust } from '../src/system-trust-linux';
import { FakeRunner, MemoryFileSystem, recordingContext } from './fakes';

const certPath = '/sandbox/user/caddy/root.crt';
const targetDir = '/sandbox/usr/local/share/ca-certificates';
const bundlePath = '/sandbox/etc/ssl/certs/ca-certificates.crt';
const helperDir = '/sandbox/var/lib/stackmanage/helpers';
const cert = '-----BEGIN CERTIFICATE-----\nQUJDREVGRw==\n-----END CERTIFICATE-----\n';

function manager(fs: MemoryFileSystem, runner: FakeRunner, elevation: () => Promise<{ kind: 'pkexec'; wrapper: { file: string; args: string[] } }> = async () => ({ kind: 'pkexec', wrapper: { file: '/usr/bin/pkexec', args: [] } })) {
  return new LinuxSystemTrust({ fs, runner, certPath, targetDirectory: targetDir, bundlePath, helperDirectory: helperDir, elevation: elevation as never });
}

describe('LinuxSystemTrust', () => {
  it('detects a certificate already present in the system bundle', async () => {
    const fs = new MemoryFileSystem({ [certPath]: cert, [bundlePath]: `other\n${cert}` });
    expect(await manager(fs, new FakeRunner()).status()).toEqual({ status: 'trusted' });
  });

  it('stages a fixed helper and uses only an absolute elevated argv plan', async () => {
    const fs = new MemoryFileSystem({ [certPath]: cert });
    const runner = new FakeRunner().withCommand('pkexec');
    const trust = manager(fs, runner);
    const context = recordingContext('trust-system');
    const result = await trust.install(context as never);
    expect(result.status).toBe('completed');
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]?.command.file).toBe('/usr/bin/pkexec');
    expect(runner.runs[0]?.command.args).toEqual(['/bin/sh', `${helperDir}/stackmanage-ca-install.sh`, certPath, targetDir, 'stackmanage-local.crt']);
    const script = fs.files.get(`${helperDir}/stackmanage-ca-install.sh`) as string;
    expect(script).toContain('update-ca-certificates');
    expect(script).not.toContain(cert);
    expect(context.events.at(-1)?.type).toBe('terminal');
  });

  it('returns skipped and does not execute without an elevation provider', async () => {
    const fs = new MemoryFileSystem({ [certPath]: cert });
    const runner = new FakeRunner();
    const trust = manager(fs, runner, async () => ({ kind: 'none', reason: 'no polkit' }) as never);
    const result = await trust.install(recordingContext('trust-no-elevation') as never);
    expect(result.status).toBe('failed');
    expect(result.items[0]).toMatchObject({ status: 'skipped', error: { code: 'UNAVAILABLE' } });
    expect(runner.runs).toHaveLength(0);
  });

  it('reports a missing certificate rather than fabricating trust', async () => {
    const fs = new MemoryFileSystem({ [bundlePath]: cert });
    expect(await manager(fs, new FakeRunner()).status()).toEqual({ status: 'missing-certificate' });
  });
});
