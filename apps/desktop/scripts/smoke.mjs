import { spawn } from 'node:child_process';
import electron from 'electron';
const env = { ...process.env, STACKMANAGE_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.STACKMANAGE_DEV_URL;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
const timer = setTimeout(() => { child.kill('SIGKILL'); process.exitCode = 1; }, 20000);
child.once('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.once('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
