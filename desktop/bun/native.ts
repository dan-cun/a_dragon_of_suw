import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import locationScript from '../native/location.ps1' with { type: 'file' };
import protectScript from '../native/protect.ps1' with { type: 'file' };
import unprotectScript from '../native/unprotect.ps1' with { type: 'file' };
import startupScript from '../native/startup.ps1' with { type: 'file' };
import closeWindowsScript from '../native/close-app-windows.ps1' with { type: 'file' };
import { DakaError } from '../core/errors';
import { assertPosition } from '../core/time';
import type { Position } from '../shared/contracts';

export function powershellPath(): string {
  const systemRoot = process.env['SystemRoot'];
  if (systemRoot === undefined) throw new Error('无法定位 Windows 系统目录。');
  const executable = join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  if (!existsSync(executable)) throw new Error('未找到系统自带的 Windows PowerShell 5.1。');
  return executable;
}

function runScript(scriptPath: string, input: string, timeout: number): Promise<string> {
  const source = readFileSync(scriptPath, 'utf8');
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = execFile(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
      { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          if (stdout.trim() !== '') {
            try {
              const decoded: unknown = JSON.parse(stdout.trim());
              const failure = z.object({ ok: z.literal(false), error: z.object({ message: z.string().max(1000) }) }).safeParse(decoded);
              if (failure.success) { reject(new Error(failure.data.error.message, { cause: error })); return; }
            } catch (parseError) {
              reject(new Error('Windows 系统服务的错误响应无法读取。', { cause: parseError })); return;
            }
          }
          reject(new Error('Windows 系统服务调用失败。请检查系统权限和服务状态。', { cause: new Error(`Native process error: ${error.code}`) }));
          return;
        }
        resolve(stdout);
      });
    child.stdin?.end(input, 'utf8');
  });
}

export async function protectToken(token: string): Promise<string> {
  const protectedValue = (await runScript(protectScript, token, 10_000)).trim();
  if (!/^[A-Za-z0-9+/]+=*$/.test(protectedValue)) throw new Error('Windows 加密服务返回了无效数据。');
  return protectedValue;
}

export async function unprotectToken(protectedValue: string): Promise<string> {
  const value = await runScript(unprotectScript, protectedValue, 10_000);
  if (!value || /[\r\n\0]/.test(value)) throw new Error('本地登录会话无法解密，请重新登录。');
  return value;
}

export async function locateWindows(): Promise<Position> {
  let output: string;
  try { output = await runScript(locationScript, '', 30_000); }
  catch (error) { throw new DakaError('WINDOWS_LOCATION_FAILED', `无法获取 Windows 当前位置：${error instanceof Error ? error.message : '系统服务错误'}。请开启位置服务和桌面应用位置权限，并检查网络。`, error instanceof Error ? error : undefined); }
  const schema = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: z.object({ latitude: z.number().finite(), longitude: z.number().finite(), accuracy: z.number().finite(), timestamp: z.number().finite(), address: z.literal('') }) }),
    z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) })
  ]);
  const response = schema.parse(JSON.parse(output.trim()));
  if (!response.ok) throw new DakaError('WINDOWS_LOCATION_FAILED', 'Windows 定位失败，请开启位置服务并确认桌面应用具有位置权限。', new Error(response.error.message));
  assertPosition(response.value, new Date());
  return response.value;
}

export function resolveEdge(): string {
  const candidates = [process.env['ProgramFiles(x86)'], process.env['ProgramFiles'], process.env['LOCALAPPDATA']]
    .filter((path): path is string => path !== undefined)
    .map((directory) => join(directory, 'Microsoft/Edge/Application/msedge.exe'));
  const executable = candidates.find(existsSync);
  if (executable === undefined) throw new Error('未找到 Microsoft Edge。请安装或修复 Windows 自带的 Edge 后重新打开程序。');
  return executable;
}

export async function launchWindow(edgePath: string, profile: string, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(edgePath, [
      `--app=${url}`, `--user-data-dir=${profile}`, '--edge-skip-compat-layer-relaunch',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
      '--disable-background-mode', '--window-size=1240,860',
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', error => reject(new Error('无法打开 Edge 应用窗口，请检查 Edge 是否可正常启动。', { cause: error })));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function openDataFolder(directory: string): Promise<void> {
  const systemRoot = process.env['SystemRoot'];
  if (systemRoot === undefined) throw new Error('无法定位 Windows 资源管理器。');
  await new Promise<void>((resolve, reject) => {
    execFile(join(systemRoot, 'explorer.exe'), [directory], { windowsHide: true }, (error) => {
      if (error !== null && error.code !== 1) reject(new Error('无法打开数据目录。', { cause: error }));
      else resolve();
    });
  });
}

export async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  if (!process.execPath.toLowerCase().endsWith('.exe') || process.execPath.toLowerCase().endsWith('bun.exe')) {
    if (enabled) throw new Error('开机启动仅支持打包后的 EXE。');
    return;
  }
  const response = await runScript(startupScript, JSON.stringify({ enabled, executable: process.execPath }), 10_000);
  if (response !== 'ok') throw new Error('Windows 未确认开机启动设置已保存。');
}

export async function closeApplicationWindows(directory: string): Promise<void> {
  const response = await runScript(closeWindowsScript, JSON.stringify({ profiles: [join(directory, 'window-profile'), join(directory, 'app-window-profile')] }), 15_000);
  if (response !== 'ok') throw new Error('Windows 未确认应用窗口已关闭。');
}
