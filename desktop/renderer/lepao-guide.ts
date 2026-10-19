import type { LepaoState } from '../shared/lepao';
import { getShanghaiClock } from '../core/time';

export function lepaoGuidance(state: LepaoState | null, selected: string, now: Date) {
  const member = state?.members.find(member => member.key === selected);
  const cap = state?.capabilities;
  const hasTodaySubmission = member?.lastSubmission != null && getShanghaiClock(new Date(member.lastSubmission.submittedAt)).date === getShanghaiClock(now).date;
  const environmentBlock = state === null ? '正在读取乐跑状态，请稍候。'
    : state.proxyRecoveryNeeded ? '上次代理进程或网络设置尚未恢复。请先点击“停止并恢复代理”。'
    : !cap ? '先点击“检查本机环境”，确认电脑上的必要条件。'
    : !cap.proxyReady ? '内置代理引擎不可用，请查看检查结果并修复完整安装。'
    : !cap.licenseValid ? '随包声明文件校验未通过，请重新安装完整安装包。'
    : cap.upstreamMode === 'proxy' && !cap.upstreamReady ? '当前系统代理不可达，请检查网络后重新检测。'
    : !cap.certificateTrusted ? '首次使用需要安装并信任本应用证书，完成后才能采集会话。'
    : null;
  const captureBlock = !member ? '先添加并选择要使用的乐跑成员。' : environmentBlock;
  const dryBlock = captureBlock ?? (member?.sessionState === 'consumed' ? '会话已用于提交，请先核对已有结果；这不代表提交失败。' : member?.sessionState !== 'available' ? '先完成“采集登录会话”，再验证当前会话。' : null);
  const step: 1 | 2 | 3 | 4 = !member ? 1 : hasTodaySubmission ? 4 : environmentBlock !== null ? 2 : member.sessionState !== 'available' ? 3 : 4;
  return { member, environmentBlock, captureBlock, dryBlock, step, hasTodaySubmission };
}

export const phaseNames = {
  preparing: '准备中', 'waiting-login': '等待电脑微信登录', validating: '核验会话', executing: '执行中',
  confirming: '等待平台复核', restoring: '恢复代理与清理', stopping: '等待停止与代理恢复', finished: '已结束',
};

export function lepaoResult(state: LepaoState | null, selected: string): { title: string; message: string; context: string } {
  const operation = state?.operation;
  if (!operation || (operation.member !== null && operation.member !== selected)) return {
    title: '当前成员尚无本次运行结果', message: '完成操作后会显示对应成员的结果。其他成员的结果不会显示为当前成员结果。', context: '',
  };
  const context = `${operation.memberLabel ?? '这台电脑'} · ${new Date(operation.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`;
  if (operation.status === 'running') return { title: phaseNames[operation.phase], message: operation.cancelRequested
    ? '停止请求已发出。等待当前调用退出和代理恢复；停止请求本身不代表平台没有受理。'
    : operation.phase === 'waiting-login' ? '代理已启动。若电脑微信在采集前已经打开，请先从微信菜单正常退出再重开，然后进入“数体智慧体育 → 校园乐跑”。不用点击“开始乐跑”。'
    : '请等待本阶段完成。只有显示“等待电脑微信登录”时才需要配合打开小程序。', context };
  const endings = operation.proxyRestored === true ? '本应用代理已停止，未检测到待恢复备份。'
    : operation.proxyRestored === false ? '代理尚未恢复，请先停止并恢复代理。' : '代理恢复状态尚未核实，请重启程序并检查网络。';
  if (operation.status === 'cancelled') return { title: '本次操作已取消', message: `本次流程已停止。${endings}`, context };
  if (operation.status === 'timed-out') return { title: '采集等待超时', message: `未在等待时间内取得新的登录会话。核对电脑微信与所选成员后可重新采集。${endings}`, context };
  if (operation.status === 'needs-session') return { title: '需要重新采集会话', message: `当前成员没有可用的本地会话，请回到第 3 步重新采集。${endings}`, context };
  if (operation.status === 'pending-review') return { title: '平台结果待核对', message: `平台结果尚未确认，请在小程序“我的跑步”核对，先不要重复执行。${endings}`, context };
  if (operation.status === 'invalid') return { title: '平台返回记录无效', message: `本次结果未通过平台判断，请到小程序核对原因。${endings}`, context };
  if (operation.status === 'failed') return { title: '本次操作未完成', message: `${operation.message} ${endings}`, context };
  if (operation.action === 'capture') return { title: '会话采集完成', message: '已核对并保存所选成员的会话。本次没有提交运动记录，下一步可进行不提交验证。', context };
  if (operation.action === 'dry') return { title: '不提交验证完成', message: '本次验证流程返回完成，没有提交运动记录；不代表已产生有效运动记录。', context };
  if (operation.action === 'run') return { title: '平台复核通过', message: `本次平台回查已通过。会话使用后会清除，这是正常状态；请核对已有记录，不要因会话显示“已使用”重复提交。${endings}`, context };
  return { title: '本机操作结果', message: operation.message, context };
}
