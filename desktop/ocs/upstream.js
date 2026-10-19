import { NewPageScript } from '../../vendor/ocs/source/packages/app/src/scripts/automation/common/index.ts';
import { sourceAutomationCatalog } from '../../vendor/ocs/adapters/automation-catalog.ts';

// This JavaScript boundary keeps unmodified third-party types outside strict host compilation.
export function automationCatalog() {
  return sourceAutomationCatalog();
}

// Only the upstream navigation script is executed; credential retries are not imported.
export async function runNavigation(page, name, values) {
  if (name !== NewPageScript.name) throw new Error('该自动化的安全运行适配尚未完成；已保存参数但不会自动提交登录。');
  await NewPageScript.run(page, Object.fromEntries(values.map(item => [item.key, item.value])));
}
