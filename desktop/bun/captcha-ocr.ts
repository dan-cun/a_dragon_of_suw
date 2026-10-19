import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export interface CaptchaRecognizer { recognize(imageDataUrl: string, signal: AbortSignal): Promise<string> }

const TIMEOUT_MS = 20_000;
const MAXIMUM_OUTPUT_BYTES = 64 * 1024;
const dataUrlSchema = z.string().regex(/^data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+$/);
const replySchema = z.object({ code: z.string() });

export function createCaptchaRecognizer(executablePath: string): CaptchaRecognizer {
  if (!isAbsolute(executablePath) || !existsSync(executablePath)) {
    throw new Error('未找到验证码识别组件，请使用包含完整 engine 文件夹的安装包。');
  }
  return {
    recognize(imageDataUrl, signal) {
      const parsed = dataUrlSchema.safeParse(imageDataUrl);
      if (!parsed.success) return Promise.reject(new Error('验证码图片格式无效，无法自动识别。'));
      if (signal.aborted) return Promise.reject(new Error('验证码识别已取消。'));
      const image = parsed.data.slice(parsed.data.indexOf(',') + 1);
      return new Promise<string>((resolve, reject) => {
        const child = spawn(executablePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (outcome: { code: string } | { error: Error }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          if (child.exitCode === null && child.signalCode === null) child.kill();
          if ('error' in outcome) reject(outcome.error);
          else resolve(outcome.code);
        };
        const abort = () => finish({ error: new Error('验证码识别已取消。') });
        const timer = setTimeout(() => finish({ error: new Error('验证码识别超过 20 秒。') }), TIMEOUT_MS);
        signal.addEventListener('abort', abort, { once: true });
        child.once('error', cause => finish({ error: new Error('无法启动验证码识别组件。', { cause }) }));
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          stdout += chunk;
          if (Buffer.byteLength(stdout) > MAXIMUM_OUTPUT_BYTES) finish({ error: new Error('验证码识别组件输出过长。') });
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2_000); });
        child.once('close', code => {
          if (settled) return;
          if (code !== 0) {
            finish({ error: new Error(`验证码识别组件退出码 ${code}${stderr.trim() ? `：${stderr.trim()}` : ''}`) });
            return;
          }
          let reply: unknown;
          try { reply = JSON.parse(stdout.trim() || '{}'); }
          catch (cause) { finish({ error: new Error('验证码识别组件返回了无效数据。', { cause }) }); return; }
          const parsedReply = replySchema.safeParse(reply);
          if (!parsedReply.success) { finish({ error: new Error('验证码识别组件返回了无效数据。') }); return; }
          finish({ code: /^\d{4}$/.test(parsedReply.data.code) ? parsedReply.data.code : '' });
        });
        child.stdin.end(`${JSON.stringify({ image })}\n`);
      });
    },
  };
}
