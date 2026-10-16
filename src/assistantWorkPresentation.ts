import type { AppData, SourceReference, Task } from './store';
import { generationConfigurationFingerprint, generationMaterialFingerprint, makeSourceReference, provenanceAvailable, selectedTaskMaterials, sourceTurn, taskSourceAvailable, taskVisible } from './sourceAccess';
import { taskBelongsToMe, taskClosed, taskPersonalContext } from './taskWorkflow';
import { personalContextCurrent, type PersonalContextSnapshot } from './personalAssistant';

/** These are existing worker capabilities, separate from the local draft's output mode. */
export const ASSISTANT_WORK_CHOICES = [
  { kind: 'research', label: '查资料', description: '围绕一个明确问题检索资料，整理结论与来源。', output: '资料报告与来源链接', icon: 'magnifying-glass' },
  { kind: 'report', label: '整理报告', description: '整理背景、讨论要点、决定、行动与未决问题。', output: '报告正文与飞书文档', icon: 'file-text' },
  { kind: 'ppt', label: '做 PPT', description: '先组织汇报大纲，再生成演示文件。', output: '汇报提纲与 PPTX 文件', icon: 'presentation' },
] as const;
export type AssistantWorkKind = typeof ASSISTANT_WORK_CHOICES[number]['kind'];
export type AssistantWorkScenario = 'normal' | 'offline' | 'generation-failure' | 'delivery-failure';
export type AssistantWorkStage = 'idle' | 'queued' | 'preparing' | 'generation-failed' | 'delivery-failed' | 'ready' | 'revoked' | 'cancelled';
export type AssistantWorkPreview = {
  kind: AssistantWorkKind;
  scenario: AssistantWorkScenario;
  stage: AssistantWorkStage;
  requestId?: string;
  taskId?: string;
  space?: string;
  fingerprint?: string;
  sources?: SourceReference[];
  personalContext?: PersonalContextSnapshot;
  authorized: boolean;
  message?: string;
};
export type AssistantServiceResult = {
  source: 'server';
  taskId: string;
  sessionId?: string;
  jobId: string;
  space: string;
  kind: AssistantWorkKind;
  fingerprint: string;
  sources: SourceReference[];
  docUrl?: string;
  files?: { name: string; url?: string; bytes?: number }[];
};

export function assistantWorkKind(value?: string): AssistantWorkKind {
  return ASSISTANT_WORK_CHOICES.some(choice => choice.kind === value) ? value as AssistantWorkKind : 'report';
}
export function initialAssistantWorkPreview(kind: AssistantWorkKind = 'report', scenario: AssistantWorkScenario = 'normal'): AssistantWorkPreview {
  return { kind, scenario, stage: 'idle', authorized: false };
}
export function assistantWorkFingerprint(task: Task): string {
  return JSON.stringify([generationConfigurationFingerprint(task), generationMaterialFingerprint(selectedTaskMaterials(task)), task.status, task.inquiries]);
}
function sourceReferences(data: AppData, task: Task): SourceReference[] {
  return [
    ...(task.sources || []),
    ...(task.scope?.includeSource !== false && task.sourceSession ? [{ kind: 'session' as const, id: task.sourceSession, sourceId: task.sourceId, sourceTime: task.sourceTime }] : []),
    ...selectedTaskMaterials(task).flatMap<SourceReference>(material => material.memoryId ? [{ kind: 'memory', id: material.memoryId }] : material.sourceSession ? [{ kind: 'session', id: material.sourceSession, sourceId: material.sourceId, sourceTime: material.sourceTime }] : []),
  ].map(ref => makeSourceReference(data, ref));
}
export function assistantWorkConsentKey(data: AppData, task: Task, kind: AssistantWorkKind, scenario: AssistantWorkScenario): string {
  return JSON.stringify([data.settings.space, kind, scenario, assistantWorkFingerprint(task), sourceReferences(data, task), taskPersonalContext(data, task, kind === 'research' ? '研究' : '汇报').fingerprint]);
}
function workError(data: AppData, task: Task | undefined): string | undefined {
  if (!task || !taskVisible(data, task)) return '这项任务当前不可见。';
  if (!taskBelongsToMe(data, task)) return '由当前负责人核对准备范围。';
  if (taskClosed(task)) return '任务已结束，已有草稿和回执继续保留。';
  if (!['已承接', '进行中', '待验收'].includes(task.status)) return '先核对并承接这项工作。';
  if (task.scope?.includeSource !== false && task.sourceSession && !sourceTurn(data, task)) return '先选择明确的任务原话，不会用整场会议代替选中片段。';
  if (task.scope?.materialIds?.some(id => !task.materialRefs?.some(material => material.id === id))) return '选择中有已移除的资料，请重新核对范围。';
  if (!taskSourceAvailable(data, task, new Set(), true)) return '所选原话或资料已变化，请重新核对。';
  return undefined;
}
export function validateAssistantWorkPreview(data: AppData, state: AssistantWorkPreview): AssistantWorkPreview {
  if (!state.requestId || !state.authorized) return state;
  const task = data.tasks.find(item => item.id === state.taskId);
  const contextCurrent = !state.personalContext || personalContextCurrent(data, state.personalContext) && !!task && state.personalContext.fingerprint === taskPersonalContext(data, task, state.kind === 'research' ? '研究' : '汇报').fingerprint;
  if (data.settings.space === state.space && !workError(data, task) && task && state.fingerprint === assistantWorkFingerprint(task) && provenanceAvailable(data, state.sources) && contextCurrent) return state;
  return { ...state, stage: 'revoked', authorized: false, message: '任务、空间、个人上下文或所选资料已变化，本次允许已撤回。已有草稿保留，请重新核对范围。' };
}
export function startAssistantWorkPreview(data: AppData, taskId: string, previous: AssistantWorkPreview, permissions: { read: boolean; draft: boolean }, requestId: string): { state: AssistantWorkPreview; error?: string } {
  const state = validateAssistantWorkPreview(data, previous);
  if (['queued', 'preparing'].includes(state.stage)) return { state, error: '当前示例正在等待或准备，没有重复启动。' };
  if (state.requestId && requestId === state.requestId) return { state, error: '本次示例已有结果，没有重复启动。' };
  const task = data.tasks.find(item => item.id === taskId), error = workError(data, task);
  if (error || !task) return { state, error };
  if (!permissions.read || !permissions.draft) return { state, error: '请分别核对读取范围与个人草稿允许。' };
  if (!requestId.trim()) return { state, error: '缺少本次示例编号，请重试。' };
  const personalContext = taskPersonalContext(data, task, state.kind === 'research' ? '研究' : '汇报');
  return { state: { kind: state.kind, scenario: state.scenario, stage: state.scenario === 'offline' ? 'queued' : 'preparing', requestId, taskId, space: data.settings.space, fingerprint: assistantWorkFingerprint(task), sources: [...sourceReferences(data, task), ...personalContext.sources], personalContext, authorized: true } };
}
export function advanceAssistantWorkPreview(data: AppData, state: AssistantWorkPreview, event: 'online' | 'result' | 'recover-result', requestId: string): AssistantWorkPreview {
  const current = validateAssistantWorkPreview(data, state);
  if (!current.authorized || current.requestId !== requestId) return current;
  if (current.stage === 'queued' && event === 'online') return { ...current, stage: 'preparing' };
  if (current.stage === 'preparing' && event === 'result') return { ...current, stage: current.scenario === 'generation-failure' ? 'generation-failed' : current.scenario === 'delivery-failure' ? 'delivery-failed' : 'ready' };
  if (current.stage === 'delivery-failed' && event === 'recover-result') return { ...current, stage: 'ready' };
  return current;
}
export function cancelAssistantWorkPreview(state: AssistantWorkPreview): AssistantWorkPreview {
  return { ...state, stage: 'cancelled', authorized: false, message: '示例已停止，个人草稿和实际任务状态保持原样。' };
}
export function assistantWorkStageLabel(stage: AssistantWorkStage): string {
  return ({ idle: '等待核对范围', queued: '助手离线，等待上线', preparing: '准备中', 'generation-failed': '生成失败', 'delivery-failed': '服务交付失败', ready: '示例结果可查看', revoked: '范围变化，允许已撤回', cancelled: '已停止示例' })[stage];
}
function trustedHttpsUrl(value: unknown, fileOrigins: string[] = [], document = false): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    if ([...url.searchParams.keys()].some(key => /^(token|access_token|authorization|api_key)$/i.test(key))) return undefined;
    const feishu = /(?:^|\.)(?:feishu\.cn|larksuite\.com)$/.test(url.hostname);
    if (document ? !feishu || !/^\/(?:docx?|wiki)\/[A-Za-z0-9_-]+/.test(url.pathname) : !fileOrigins.includes(url.origin)) return undefined;
    return url.href;
  } catch { return undefined; }
}
/** Future authenticated adapters must supply explicit results; no URL is constructed from IDs. */
export function existingAssistantResult(data: AppData, task: Task, result?: AssistantServiceResult, fileOrigins: string[] = []): { status: 'absent' | 'current' | 'historical' | 'blocked'; docUrl?: string; files: { name: string; url?: string; bytes?: number }[] } {
  if (!result) return { status: 'absent', files: [] };
  if (result.source !== 'server' || result.taskId !== task.id || result.sessionId !== task.sourceSession || !/^[A-Za-z0-9_-]{1,100}$/.test(result.jobId) || !ASSISTANT_WORK_CHOICES.some(choice => choice.kind === result.kind) || result.space !== data.settings.space || !taskVisible(data, task)) return { status: 'blocked', files: [] };
  const required = sourceReferences(data, task);
  const sourcesComplete = Array.isArray(result.sources) && required.every(ref => result.sources.some(found => found.kind === ref.kind && found.id === ref.id && found.sourceId === ref.sourceId && found.sourceTime === ref.sourceTime && found.fingerprint !== undefined && found.fingerprint === ref.fingerprint));
  const current = !task.sourceNeedsReview && taskSourceAvailable(data, task, new Set(), true) && result.fingerprint === assistantWorkFingerprint(task) && sourcesComplete && provenanceAvailable(data, result.sources);
  if (!current && data.settings.space !== '我的空间') return { status: 'blocked', files: [] };
  const docUrl = trustedHttpsUrl(result.docUrl, [], true);
  if (!current) return { status: 'historical', docUrl, files: [] };
  return { status: 'current', docUrl, files: (result.files || []).filter(file => typeof file.name === 'string' && !!file.name.trim()).map(file => ({ name: file.name.trim().slice(0, 120), url: trustedHttpsUrl(file.url, fileOrigins), ...(Number.isFinite(file.bytes) && file.bytes! >= 0 ? { bytes: file.bytes } : {}) })) };
}
