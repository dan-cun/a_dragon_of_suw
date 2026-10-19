import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const python = process.env['SWU_PYTHON'];
const output = process.env['SWU_ENGINE_DIST'];
const work = process.env['SWU_ENGINE_BUILD'];
if (python === undefined || !existsSync(python)) throw new Error('Set SWU_PYTHON to the project Python executable.');
if (output === undefined || work === undefined) throw new Error('Set SWU_ENGINE_DIST and SWU_ENGINE_BUILD to dedicated build directories.');
const child = Bun.spawn([python, '-m', 'PyInstaller', '--noconfirm', '--distpath', resolve(output, '..'), '--workpath', resolve(work), 'engine/engine.spec'], { stdout: 'inherit', stderr: 'inherit' });
if (await child.exited !== 0) throw new Error('Lepao engine compilation failed.');
if (!existsSync(resolve(output, 'lepao-engine.exe')) || !existsSync(resolve(output, 'mitmweb.exe')) || !existsSync(resolve(output, 'captcha-ocr.exe'))) throw new Error('The engine build did not produce all required executables.');
const notices = Bun.spawn([python, 'scripts/export-python-notices.py', output], { stdout: 'inherit', stderr: 'inherit' });
if (await notices.exited !== 0) throw new Error('Python license export failed.');
