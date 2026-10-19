import type { ScriptProgram } from '../bun/ocs-assets';
import { parseMatchPattern, matchScriptPattern } from './script-matching';

/** Keep grant-none and isolated-world scripts on the same explicit URL matching grammar. */
export function acceptsScript(program: Omit<ScriptProgram, 'content'>, value: string, parse: typeof parseMatchPattern, match: typeof matchScriptPattern): boolean {
  const wildcard = (pattern: string): boolean => {
    if (pattern.startsWith('/') && pattern.endsWith('/')) return new RegExp(pattern.slice(1, -1)).test(value);
    return new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(value);
  };
  return !program.excludes.some(wildcard) && !program.excludeMatches.some(pattern => match(pattern, value, parse))
    && (program.matches.some(pattern => match(pattern, value, parse)) || program.includes.some(wildcard));
}
