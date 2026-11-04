import { build } from 'vite';
import { bundleProcesses } from './bundle.mjs';
await bundleProcesses();
await build();
