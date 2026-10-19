import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';

export function instancePipeName(directory: string): string {
  return `\\\\.\\pipe\\swu-daka-${createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0, 24)}`;
}

export async function hasRunningInstance(directory: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(instancePipeName(directory));
    socket.setTimeout(5000, () => socket.destroy(new Error('本机实例管道超过 5 秒未响应。')));
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      if ('code' in error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) resolve(false);
      else reject(new Error('无法检查本机程序实例。', { cause: error }));
    });
  });
}
