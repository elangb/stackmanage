import { build } from 'esbuild';

export async function bundleProcesses() {
  await build({ entryPoints: { main: 'src/main/index.ts', preload: 'src/preload/index.ts', worker: '../worker/src/index.ts' }, outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true, external: ['electron'], platform: 'node', target: 'node24', format: 'cjs', sourcemap: true });
}
