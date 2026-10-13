import type { AppData, Session } from './store';
import { newStoragePolicy } from './storagePolicy';
import { inListeningQuietHours, readListeningConfig } from './listeningLogic';

export type DeviceCondition = 'off' | 'ready' | 'permission' | 'background' | 'disconnected' | 'quiet' | 'service';
export type DeviceStartupRuntime = { condition: DeviceCondition; recoveryRequired: boolean };
export const initialDeviceRuntime = (): DeviceStartupRuntime => ({ condition: 'off', recoveryRequired: false });
export const startupPreferenceKey = (device: string) => 'device-auto-listen:' + device;
const holdKey = (device: string) => 'device-startup-hold:' + device;
const lastKey = (device: string) => 'device-startup-last:' + device;
const ownerKey = (sessionId: string) => 'device-startup-owner:' + sessionId;
export const autoListenEnabled = (data: AppData, device: string) => data.settings.toggles[startupPreferenceKey(device)] === true;
const activeSessions = (data: AppData) => data.sessions.filter(s => !s.archived && ['进行中', '暂停'].includes(s.status));
export const startupOwnsSession = (data: AppData, device: string, session: Session) =>
  data.settings.retention[ownerKey(session.id)] === device && session.storage?.mode === 'daily';

export function pairStartupDevice(data: AppData, device: string, enabled: boolean): AppData {
  if (!['录音豆', '桌面伙伴', '会议室入口'].includes(device)) return data;
  const retention = { ...data.settings.retention, ['device-status:' + device]: '在线', ['device-battery:' + device]: '86%' };
  delete retention[lastKey(device)];
  retention[holdKey(device)] = 'paired';
  return { ...data, settings: { ...data.settings, devices: { ...data.settings.devices, [device]: true },
    toggles: { ...data.settings.toggles, [startupPreferenceKey(device)]: enabled }, retention } };
}

/** Saving an explicit preference never starts a recording or grants other capabilities. */
export function setAutoListenPreference(data: AppData, device: string, enabled: boolean): AppData {
  if (!data.settings.devices[device]) return data;
  return { ...data, settings: { ...data.settings,
    toggles: { ...data.settings.toggles, [startupPreferenceKey(device)]: enabled } } };
}

export function unpairStartupDevice(data: AppData, device: string): AppData {
  return { ...data, sessions: data.sessions.map(s => startupOwnsSession(data, device, s) && s.status === '进行中' ? { ...s, status: '暂停' } : s),
    settings: { ...data.settings, devices: { ...data.settings.devices, [device]: false },
      toggles: { ...data.settings.toggles, [startupPreferenceKey(device)]: false },
      retention: { ...data.settings.retention, [holdKey(device)]: 'detached', ['device-status:' + device]: '离线' } } };
}

/** Cross-page manual controls win over later device signals, including after daily cleanup. */
export function reconcileDeviceStartupHolds(previous: AppData, next: AppData): AppData {
  let retention = next.settings.retention;
  const write = (device: string, value: string) => {
    if (retention[holdKey(device)] === value) return;
    retention = { ...retention, [holdKey(device)]: value };
  };
  for (const before of previous.sessions) {
    const device = previous.settings.retention[ownerKey(before.id)];
    if (!device || before.storage?.mode !== 'daily') continue;
    const after = next.sessions.find(s => s.id === before.id);
    if (before.status !== '已结束' && (!after || after.status === '已结束' || after.archived)) write(device, 'stopped');
    else if (before.status === '进行中' && after?.status === '暂停') {
      if (!['blocked', 'detached'].includes(retention[holdKey(device)])) write(device, 'paused');
    } else if (before.status === '暂停' && after?.status === '进行中') write(device, '');
  }
  return retention === next.settings.retention ? next : { ...next, settings: { ...next.settings, retention } };
}

const conditionCopy: Record<DeviceCondition, string> = {
  off: '尚未收到设备开机信号', ready: '设备与服务就绪', permission: '声音记录权限未就绪',
  background: '后台运行受限', disconnected: '设备已断连', quiet: '现在是安静时段', service: '聆听服务暂不可用',
};
type Status = { phase: 'unpaired' | 'disabled' | 'blocked' | 'held' | 'occupied' | 'listening' | 'ready'; title: string; body: string; canRecover: boolean; sessionId?: string };
export function deviceStartupStatus(data: AppData, device: string, runtime: DeviceStartupRuntime, now = new Date()): Status {
  const quiet = inListeningQuietHours(readListeningConfig({ ...data, settings: { ...data.settings, space: '我的空间' } }), now);
  if (!data.settings.devices[device]) return { phase: 'unpaired', title: '先配对声音入口', body: '配对时单独选择是否开机自动聆听。', canRecover: false };
  const active = activeSessions(data);
  if (active.some(s => !startupOwnsSession(data, device, s)) || active.length > 1) return {
    phase: 'occupied', title: '已有活动记录，设备让位', body: '继续原来的记录；设备开机或重连不会另开一场，也不会改变会议保存方式。', canRecover: false,
    sessionId: active.find(s => s.id === data.activeSessionId)?.id,
  };
  const own = active.find(s => startupOwnsSession(data, device, s));
  if (own && data.activeSessionId !== own.id) return { phase: 'occupied', title: '先回到已有记录', body: '已有记录的状态需要核对，设备不会重复启动。', canRecover: false };
  const hold = data.settings.retention[holdKey(device)];
  if (data.settings.toggles.recordingAllowed === false || ['permission', 'background', 'disconnected', 'quiet', 'service', 'off'].includes(runtime.condition) || quiet) {
    const condition = data.settings.toggles.recordingAllowed === false ? 'permission' : quiet ? 'quiet' : runtime.condition;
    return { phase: 'blocked', title: conditionCopy[condition], body: '检查原因后回到就绪，再明确恢复。不会自动绕过权限或安静时段。', canRecover: false, sessionId: own?.id };
  }
  if (own?.status === '进行中') return { phase: 'listening', title: '日常临时聆听中', body: '完整原音与临时全文只滚动保留最近5分钟；停止后清除，候选重点另行核对。', canRecover: false, sessionId: own.id };
  if (!autoListenEnabled(data, device)) return { phase: 'disabled', title: '开机自动聆听已关闭', body: '开机只连接；需要记录时可手动开始。', canRecover: false, sessionId: own?.id };
  const last = data.sessions.find(s => s.id === data.settings.retention[lastKey(device)]);
  if (['paused', 'stopped', 'blocked', 'detached'].includes(hold) || own?.status === '暂停' || last?.status === '已结束' || runtime.recoveryRequired) return {
    phase: 'held', title: hold === 'stopped' || last?.status === '已结束' && !own ? '已停止，等待你重新开始' : own?.status === '暂停' && hold !== 'blocked' ? '已暂停，等待你继续' : '条件已恢复，等待你确认',
    body: own?.status === '暂停' ? '重连不会自行恢复这段记录，继续时沿用原记录。' : '重连不会自行新建记录；明确恢复后才开始新的日常记录。', canRecover: true, sessionId: own?.id,
  };
  return { phase: 'ready', title: '下次开机可自动进入日常聆听', body: '已保存你的选择，当前没有开始录音。', canRecover: true };
}

type Event = { type: 'condition'; condition: DeviceCondition } | { type: 'signal' | 'recover' | 'pause' };
type Result = { data: AppData; runtime: DeviceStartupRuntime; message: string; sessionId?: string };
export function transitionDeviceStartup(data: AppData, runtime: DeviceStartupRuntime, device: string, event: Event,
  options: { sessionId: string; now?: Date }): Result {
  const now = options.now || new Date();
  const result = (next: AppData, state: DeviceStartupRuntime, message: string, sessionId?: string): Result => ({ data: next, runtime: state, message, sessionId });
  if (event.type === 'condition') {
    const blocked = event.condition !== 'ready';
    const nextRuntime = { condition: event.condition, recoveryRequired: runtime.recoveryRequired || blocked };
    const own = activeSessions(data).find(s => startupOwnsSession(data, device, s));
    const next = blocked && own?.status === '进行中' ? { ...data, sessions: data.sessions.map(s => s.id === own.id ? { ...s, status: '暂停' as const } : s),
      settings: { ...data.settings, retention: { ...data.settings.retention, [holdKey(device)]: 'blocked' } } } : data;
    return result(next, nextRuntime, blocked ? conditionCopy[event.condition] + '，等待恢复' : '示例条件已更新，尚未发出开机信号');
  }
  const status = deviceStartupStatus(data, device, runtime, now);
  if (event.type === 'pause') {
    if (status.phase !== 'listening' || !status.sessionId) return result(data, runtime, '当前没有这台设备正在聆听的日常记录');
    return result({ ...data, sessions: data.sessions.map(s => s.id === status.sessionId ? { ...s, status: '暂停' as const } : s),
      settings: { ...data.settings, retention: { ...data.settings.retention, [holdKey(device)]: 'paused' } } }, runtime, '已暂停，设备重连不会自行恢复', status.sessionId);
  }
  if (['unpaired', 'occupied', 'blocked', 'disabled'].includes(status.phase)) return result(data, runtime, status.title);
  if (status.phase === 'listening') return result(data, runtime, '沿用当前记录，不重复创建', status.sessionId);
  if (event.type === 'signal' && status.phase === 'held') return result(data, runtime, status.title + '；重连不恢复');
  if (!autoListenEnabled(data, device)) return result(data, runtime, '开机只连接，未选择自动聆听');
  const own = activeSessions(data).find(s => startupOwnsSession(data, device, s));
  if (own?.status === '暂停') return result({ ...data, sessions: data.sessions.map(s => s.id === own.id ? { ...s, status: '进行中' as const } : s),
    settings: { ...data.settings, retention: { ...data.settings.retention, [holdKey(device)]: '' } } },
    { ...runtime, recoveryRequired: false }, '继续原来的日常记录', own.id);
  if (!options.sessionId || data.sessions.some(s => s.id === options.sessionId) || !Number.isFinite(now.getTime())) return result(data, runtime, '这次启动已处理，请返回当前记录');
  const session: Session = { id: options.sessionId, kind: '日常', title: device + ' · 日常聆听（示例）',
    date: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    duration: '00:00', status: '进行中', transcript: [], summary: [], agenda: [], participants: ['我'], attachments: [], privateNotes: [], project: '个人记录',
    storage: newStoragePolicy(data, 'daily', false, now.getTime()) };
  return result({ ...data, sessions: [session, ...data.sessions], activeSessionId: session.id,
    settings: { ...data.settings, space: '我的空间', toggles: { ...data.settings.toggles, ['shared-' + session.id]: false },
      retention: { ...data.settings.retention, [ownerKey(session.id)]: device, [lastKey(device)]: session.id, [holdKey(device)]: '',
        ['session-space:' + session.id]: '我的空间', ['session-' + session.id]: '手动选择片段' } } },
    { ...runtime, recoveryRequired: false }, '已进入日常临时聆听示例', session.id);
}
