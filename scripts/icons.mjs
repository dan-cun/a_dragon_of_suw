import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../assets/logo-master.png', import.meta.url));
const output = fileURLToPath(new URL('../assets/', import.meta.url));
const script = fileURLToPath(new URL('./compile-icons.ps1', import.meta.url));
const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Source', source, '-Output', output], { windowsHide: true, encoding: 'utf8' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Windows icon packaging failed: ${result.stderr.trim()}`);
