import { lstat, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import packageMetadata from '../package.json';
import { assertBuildOutputPathsSafe } from './prepare-ocs-source';
import { assertLocalOnlyOutputSeparate, localOnlyBuildInputs, localOnlyInstallTarget, localOnlyLabels, requiredAbsolutePath, verifyLocalOnlyBuild } from './build-local-only';
import { windowsVersion } from './version';

async function buildLocalOnlyInstaller(): Promise<void> {
  const inputs = await localOnlyBuildInputs();
  const compiler = requiredAbsolutePath('SWU_INNO_COMPILER');
  const output = requiredAbsolutePath('SWU_INSTALLER_OUTPUT');
  if (!(await lstat(compiler)).isFile()) throw new TypeError(`SWU_INNO_COMPILER must identify an existing ISCC.exe file: ${compiler}.`);
  assertLocalOnlyOutputSeparate(output, [inputs.source, inputs.output, inputs.engine, inputs.browser, localOnlyInstallTarget]);
  await assertBuildOutputPathsSafe(output);
  const metadata = await verifyLocalOnlyBuild(inputs);
  await mkdir(output);
  const child = Bun.spawn([compiler,
    `/DAppVersion=${packageMetadata.version}`, `/DWindowsVersion=${windowsVersion(packageMetadata.version)}`,
    `/DProjectSource=${inputs.source}`, `/DSourceDir=${inputs.output}`, `/DOutputPath=${output}`,
    resolve(import.meta.dir, '../installer/local-only.iss')
  ], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`LOCAL_ONLY Inno Setup compilation failed; exitCode=${exitCode}, source=${inputs.output}, output=${output}.`);
  const installer = resolve(output, `西大日常-${packageMetadata.version}-LOCAL_ONLY-TEST_ONLY-RELEASE_BLOCKED-本机安装程序.exe`);
  const entry = await lstat(installer);
  if (!entry.isFile() || entry.size === 0) throw new TypeError(`LOCAL_ONLY installer is missing or empty: ${installer}.`);
  console.log(JSON.stringify({ event: 'local-only-installer-built', installer, sourceRevision: metadata.sourceRevision, installTarget: localOnlyInstallTarget, labels: localOnlyLabels, formalReleaseAllowed: false, installationExecuted: false }));
}

if (import.meta.main) await buildLocalOnlyInstaller();
