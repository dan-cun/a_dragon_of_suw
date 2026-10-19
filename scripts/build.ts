import { mkdir, cp, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import packageMetadata from '../package.json';
import { writeBuildMetadata } from './build-metadata';
import { exportNpmNotices } from './npm-notices';
import { windowsVersion } from './version';
import { editionLabel } from '../desktop/shared/edition';
await import('./icons.mjs');
const output = resolve(process.env['SWU_BUILD_OUTPUT'] ?? 'releases');
const engine = process.env['SWU_ENGINE_DIST'];
if (engine === undefined) throw new Error('Set SWU_ENGINE_DIST to the built lepao-engine directory.');
await access(resolve(engine, 'lepao-engine.exe'));
await access(resolve(engine, 'mitmweb.exe'));
await mkdir(output, { recursive: true });
const result = await Bun.build({
  entrypoints: ['desktop/bun/launch.ts'], target: 'bun', minify: true,
  compile: {
    outfile: resolve(output, '打卡助手.exe'),
    autoloadDotenv: false, autoloadBunfig: false,
    windows: {
      icon: 'assets/icon.ico', hideConsole: true, title: `西大日常 ${packageMetadata.version} · ${editionLabel}`,
      publisher: 'swu-daka contributors / dan-cun', version: windowsVersion(packageMetadata.version),
      description: '西大日常 · 查寝与乐跑，基于 dan-cun/swu-daka 与 lepao3', copyright: 'Copyright (c) 2026 dan-cun'
    }
  }
});
if (!result.success) throw new AggregateError(result.logs, 'Windows EXE build failed.');
await cp(engine, resolve(output, 'engine'), { recursive: true });
await cp('licenses', resolve(output, 'licenses'), { recursive: true });
await mkdir(resolve(output, 'licenses/lepao3'), { recursive: true });
await cp('vendor/lepao3/LICENSE', resolve(output, 'licenses/lepao3/LICENSE'));
await cp('vendor/lepao3/NOTICE', resolve(output, 'licenses/lepao3/NOTICE'));
await cp('vendor/lepao3/DISCLAIMER.md', resolve(output, 'licenses/lepao3/DISCLAIMER.md'));
await cp('LICENSE', resolve(output, 'LICENSE.txt'));
await cp('NOTICE', resolve(output, 'NOTICE'));
await cp('DISCLAIMER.md', resolve(output, 'DISCLAIMER.md'));
await exportNpmNotices(output);
await writeBuildMetadata(output, packageMetadata.version);
console.log(`Built: ${resolve(output, '打卡助手.exe')}`);
