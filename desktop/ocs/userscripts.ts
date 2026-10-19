import type { BrowserContext } from 'playwright-core';
import { parseUserScript, type ScriptProgram } from '../bun/ocs-assets';
import { parseMatchPattern, matchScriptPattern } from './script-matching';
import { acceptsScript } from './gm-matching';
import { attachGmScripts } from './gm-runtime';
import type { UserScriptController, UserScriptStorageOptions } from './gm-types';
export type { UserScriptController, UserScriptStorageOptions } from './gm-types';

/** Preserve page-world grant-none source; route explicit GM grants into native isolated worlds. */
export async function attachUserScripts(context: BrowserContext, programs: ScriptProgram[], report: (id: string, outcome: 'executed' | 'failed') => void, storage: UserScriptStorageOptions | null): Promise<UserScriptController> {
  const verified = programs.map(program => {
    const parsed = parseUserScript(program.id, program.content);
    if (!program.supported || !parsed.supported || parsed.digest !== program.digest) throw new Error('An enabled script declares unsupported capabilities or its source digest changed.');
    return parsed;
  });
  const privileged = verified.filter(program => program.grants.length > 0);
  if (privileged.length && !storage) throw new Error('Explicit GM storage root and profile identity are required before registering GM scripts.');
  await context.exposeBinding('__swuOcsScriptOutcome', (_source, id: string, outcome: string) => {
    if (typeof id === 'string' && verified.some(program => program.id === id && program.grants.length === 0) && (outcome === 'executed' || outcome === 'failed')) report(id, outcome);
  });
  for (const program of verified.filter(program => program.grants.length === 0)) {
    const { content, ...metadata } = program;
    // Serialize every pure helper dependency; imported source is never passed to eval/Function.
    const prefix = `(() => { const metadata = ${JSON.stringify(metadata)}; const parseMatchPattern = ${parseMatchPattern.toString()}; const matchScriptPattern = ${matchScriptPattern.toString()}; const accepts = ${acceptsScript.toString()}; const notify = outcome => { const binding = Reflect.get(globalThis, '__swuOcsScriptOutcome'); if (typeof binding === 'function') binding(metadata.id, outcome); }; try { if (!accepts(metadata, location.href, parseMatchPattern, matchScriptPattern)) return; } catch { notify('failed'); return; } const execute = () => { try { (() => {\n`;
    const suffix = `\n})(); notify('executed'); } catch { notify('failed'); } }; if (metadata.runAt === 'document-start') execute(); else if (metadata.runAt === 'document-idle') window.addEventListener('load', execute, {once:true}); else window.addEventListener('DOMContentLoaded', execute, {once:true}); })();`;
    await context.addInitScript({ content: prefix + content + suffix });
  }
  if (storage && privileged.length) return await attachGmScripts(context, privileged, storage, report);
  let disposed = false;
  const disposal = Promise.resolve();
  return { async flush(): Promise<void> {}, dispose(): Promise<void> { disposed = true; return disposal; }, isSettled(): boolean { return disposed; } };
}
