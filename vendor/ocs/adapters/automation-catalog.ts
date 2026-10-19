export interface SourceAutomationField { key: string; label: string; secret: boolean; initialValue: string }
export interface SourceAutomationDefinition { name: string; fields: SourceAutomationField[] }

/** Ported configuration declarations from the fixed OCS Desktop 2.12.0 source.
 * Sources: packages/app/src/scripts/automation/wk/{cx,zhs,icve,zjy}.ts
 * and packages/app/src/scripts/automation/common/index.ts.
 * Only data is ported here; platform credential submission remains unavailable.
 */
export function sourceAutomationCatalog(): SourceAutomationDefinition[] {
  const field = (key: string, label: string, secret: boolean): SourceAutomationField => ({ key, label, secret, initialValue: '' });
  return [
    { name: '超星-手机密码登录', fields: [field('phone', '手机号', false), field('password', '密码', true)] },
    { name: '超星-学校机构登录', fields: [field('unit', '学校/单位', false), field('id', '学号/工号', false), field('password', '密码', true)] },
    { name: '智慧树-手机密码登录', fields: [field('phone', '手机号', false), field('password', '密码', true)] },
    { name: '智慧树-学校登录', fields: [field('schoolname', '学校', false), field('id', '学号', false), field('password', '密码', true)] },
    { name: '职教云-账号密码登录', fields: [field('username', '账号', false), field('password', '密码', true)] },
    { name: '智慧职教-账号密码登录', fields: [field('username', '账号', false), field('password', '密码', true)] },
    { name: '通用-新建页面', fields: [field('url', '网页链接', false)] }
  ];
}
