import { showStartupError } from './startup-error';
const control = process.argv.includes('--shutdown') || process.argv.includes('--uninstall');
try {
  if (control) {
    const { stopRunningApplication } = await import('./control');
    await stopRunningApplication();
    if (process.argv.includes('--uninstall')) {
      const { setLaunchAtLogin } = await import('./native');
      await setLaunchAtLogin(false);
    }
  } else await import('./index');
}
catch (error) {
  const message = error instanceof Error ? error.message : '应用启动失败，请检查 Windows 系统与 Edge 浏览器。';
  if (control) { console.error(message); process.exit(1); }
  try { await showStartupError(message); }
  finally { process.exit(1); }
}
