import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(packageRoot, 'src', 'runtime', 'runner.mjs');
const target = join(packageRoot, 'dist', 'runtime', 'runner.mjs');
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
