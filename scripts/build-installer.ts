import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import packageMetadata from '../package.json';
import { assertOcsBuildOutputIsolated, verifyBuildMetadata } from './build-metadata';
import { windowsVersion } from './version';
import { editionLabel } from '../desktop/shared/edition';

const compiler = process.env['SWU_INNO_COMPILER'];
if (compiler === undefined || !existsSync(compiler)) throw new Error('Set SWU_INNO_COMPILER to the installed Inno Setup 6.5+ ISCC.exe path.');
const output = resolve(process.env['SWU_BUILD_OUTPUT'] ?? 'releases');
await assertOcsBuildOutputIsolated(output);
if (!existsSync(resolve(output, '打卡助手.exe'))) throw new Error('Run bun run build before building the installer.');
if (!existsSync(resolve(output, 'build-info.json'))) throw new Error('build-info.json is missing. Run bun run build before packaging the installer.');
await verifyBuildMetadata(output, packageMetadata.version);
const result = Bun.spawn([compiler, `/DAppVersion=${packageMetadata.version}`, `/DWindowsVersion=${windowsVersion(packageMetadata.version)}`, `/DEditionLabel=${editionLabel}`, `/DSourceDir=${output}`, `/DOutputPath=${output}`, resolve('installer/setup.iss')], { stdout: 'inherit', stderr: 'inherit' });
const exitCode = await result.exited;
if (exitCode !== 0) throw new Error(`Inno Setup compilation failed with exit code ${exitCode}.`);
