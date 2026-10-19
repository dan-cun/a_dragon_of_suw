import { execFile } from 'node:child_process';
import { join } from 'node:path';

export async function showStartupError(message: string): Promise<void> {
  const systemRoot = process.env['SystemRoot'];
  if (systemRoot === undefined) { console.error(message); return; }
  const script = "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $message = [Console]::In.ReadToEnd(); [void][System.Windows.Forms.MessageBox]::Show($message, '打卡助手 · 启动失败', 'OK', 'Error')";
  await new Promise<void>((resolve, reject) => {
    const child = execFile(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true },
      error => error === null ? resolve() : reject(new Error('启动错误提示窗口无法显示。', { cause: error })));
    child.stdin?.end(message);
  });
}
