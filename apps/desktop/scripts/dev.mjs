import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { bundleProcesses } from './bundle.mjs';

await bundleProcesses();
const server = await createServer();
await server.listen();
server.printUrls();
const env = { ...process.env, STACKMANAGE_DEV_URL: 'http://127.0.0.1:5179/' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await server.close();
  process.exitCode = code;
}
child.once('error', error => { console.error(error); void stop(1); });
child.once('exit', code => { void stop(code ?? 1); });
process.once('SIGINT', () => { void stop(130); });
process.once('SIGTERM', () => { void stop(143); });
