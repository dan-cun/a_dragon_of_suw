export interface MatchPattern { scheme: string; host: string; path: string }

/** Parse the supported browser match-pattern grammar and reject ambiguous host syntax. */
export function parseMatchPattern(pattern: string): MatchPattern {
  if (pattern === '<all_urls>') return { scheme: '*all', host: '*', path: '/*' };
  const parts = /^(\*|http|https|file):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!parts) throw new TypeError('用户脚本 @match/@exclude-match 格式无效。');
  const scheme = parts[1]; const host = parts[2]; const path = parts[3];
  if (scheme === undefined || host === undefined || path === undefined || /[\s#]/.test(pattern)) throw new TypeError('用户脚本匹配规则含无效字符。');
  if (scheme === 'file') {
    if (host !== '') throw new TypeError('file 匹配规则必须使用空主机。');
  } else if (host !== '*') {
    const domain = host.startsWith('*.') ? host.slice(2) : host;
    if (domain.length > 253 || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new TypeError('用户脚本匹配规则主机无效；不支持端口或任意位置通配符。');
  }
  return { scheme, host: host.toLowerCase(), path };
}

/** Match scheme, domain boundary and path independently, including the wildcard root domain. */
export function matchScriptPattern(pattern: string, value: string, parse: (pattern: string) => MatchPattern): boolean {
  const rule = parse(pattern);
  const url = new URL(value);
  if (rule.scheme === '*all') return ['http:', 'https:', 'file:'].includes(url.protocol);
  if (rule.scheme === '*' ? !['http:', 'https:'].includes(url.protocol) : url.protocol !== rule.scheme + ':') return false;
  if (rule.host !== '*' && !(rule.host.startsWith('*.') ? url.hostname === rule.host.slice(2) || url.hostname.endsWith(rule.host.slice(1)) : url.hostname === rule.host)) return false;
  return new RegExp('^' + rule.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(url.pathname + url.search);
}
