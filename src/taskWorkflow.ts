import type { AppData, SourceReference, Task, TaskArtifact, TaskCompletion, TaskInquiry, TaskOutputMode, TaskScope, TaskWorkKind } from './store';
import { generationConfigurationFingerprint, generationMaterialFingerprint, makeSourceReference, PERSONAL_SPACE, provenanceAvailable, selectedTaskMaterials, sourceAvailable, taskSourceAvailable, taskVisible } from './sourceAccess';
import { taskAttentionReason, taskClosed, taskInquiries } from './taskAttention';
import { normalizeMoment, parseLocalMoment } from './dateLogic';
export { taskAttentionReason, taskClosed, taskInquiries, selectedTaskMaterials };

const stamp = () => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());
const uid = () => `task-op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
export type TaskMutation = { data: AppData; error?: string; token?: string; cost?: number };
const me = (data: AppData, value: string) => value === '我' || value === data.settings.name;
export function taskBelongsToMe(data: AppData, task: Task): boolean { return me(data, task.owner); }
export function taskFollowedByMe(data: AppData, task: Task): boolean {
  return !taskBelongsToMe(data, task) && (me(data, task.requester) || !!task.transferRequest && me(data, task.transferRequest.fromOwner) || data.settings.retention['task-follow:' + task.id] === data.settings.name || data.settings.retention['task-follow:' + task.id] === '我');
}
export function taskIsMyAttention(data: AppData, task: Task, now: number | Date = Date.now()): boolean {
  if (taskClosed(task)) return false;
  if (taskBelongsToMe(data, task)) return taskAttentionReason(task, now) !== null;
  if (!taskFollowedByMe(data, task)) return false;
  if (taskInquiries(task).some(inquiry => inquiry.status === '已回答')) return true;
  const at = now instanceof Date ? now.getTime() : now;
  if (taskInquiries(task).some(inquiry => inquiry.status === '待回答' && (parseLocalMoment(inquiry.nextFollowUp || task.nextFollowUp, at) ?? Infinity) <= at)) return true;
  const followUp = task.transferRequest?.nextFollowUp || task.nextFollowUp;
  const due = parseLocalMoment(followUp, at);
  return due !== undefined && due <= at;
}

export function taskWorkKind(task: Task): TaskWorkKind {
  if (task.workKind) return task.workKind;
  return task.id === 'TASK-021' || /交付|汇报|报告|复盘|PPT|方案|文档/.test(task.title) ? '交付' : '行动';
}
export function taskOutputMode(task: Task): TaskOutputMode {
  if (task.outputMode === '完整框架与PPT') return '文档与PPT';
  if (task.outputMode === '仅提纲') return '文档';
  if (['资料整理', '回复草稿', '行动清单', '文档', '文档与PPT'].includes(task.outputMode || '')) return task.outputMode as TaskOutputMode;
  if (taskWorkKind(task) === '交付') return task.id === 'TASK-021' || /PPT|汇报/.test(task.title + task.description) ? '文档与PPT' : '文档';
  return /回复|消息|邮件|沟通/.test(task.title) ? '回复草稿' : /核实|查|资料|库存/.test(task.title) ? '资料整理' : '行动清单';
}
export function outputCost(mode: TaskOutputMode | string): number {
  return mode === '文档与PPT' || mode === '完整框架与PPT' ? 16 : mode === '行动清单' ? 4 : 6;
}
export function taskArtifacts(task: Task): TaskArtifact[] {
  if (task.artifacts?.length) return task.artifacts;
  return task.results.length ? [{ id: `seed-${task.id}`, kind: task.id === 'TASK-032' ? '资料' : '文档', title: task.id === 'TASK-032' ? '蓝色椅子库存摘录' : `${task.title} · 已有内容`, version: task.version, body: task.results, created: '已有成果', needsReview: task.needsReview !== false, sourceNeedsReview: task.sourceNeedsReview, sourceSession: task.sourceSession, sourceId: task.sourceId, sourceTime: task.sourceTime, sources: task.sources }] : [];
}
export function latestTaskArtifacts(task: Task): TaskArtifact[] {
  const all = taskArtifacts(task);
  const lastByKind = new Map<TaskArtifact['kind'], TaskArtifact>();
  all.forEach(artifact => { const previous = lastByKind.get(artifact.kind); if (!previous || artifact.version >= previous.version) lastByKind.set(artifact.kind, artifact); });
  return [...lastByKind.values()];
}
export function taskPrimaryAction(task: Task, now: number | Date = Date.now()): { label: string; view: string; mode?: string } | null {
  if (taskClosed(task)) return null;
  if (task.sourceNeedsReview) return { label: '核对来源与要求', view: 'task-edit' };
  if (task.status === '待承接') return { label: '核对并承接', view: 'task-accept' };
  if (task.status === '待转交') return { label: taskAttentionReason(task, now) ? '跟进转交回应' : '查看转交进展', view: 'task-transfer-response' };
  if (task.aiStatus === '失败' || task.failure) return { label: '补充资料后继续', view: 'task-attachment' };
  if (taskInquiries(task).some(inquiry => inquiry.status === '已回答')) return { label: '核对问题答复', view: 'task-ask' };
  if (task.aiStatus === '准备中') return { label: '查看助手进度', view: 'task-progress' };
  if (task.needsReview && taskArtifacts(task).length) return { label: '核对助手草稿', view: 'task-complete', mode: '草稿核对' };
  if (task.status === '待验收' || taskWorkKind(task) === '交付' && task.deliveryArtifactIds?.length) return { label: '检查本次交付', view: 'task-complete', mode: '交付验收' };
  if (taskInquiries(task).some(inquiry => inquiry.status === '待回答')) return { label: '查看问题与跟进', view: 'task-ask' };
  if (taskWorkKind(task) === '行动') return task.status === '已承接' ? { label: '开始处理', view: 'task-progress-note' } : { label: '记录完成结果', view: 'task-complete', mode: '人工完成' };
  return { label: taskArtifacts(task).length ? '选择本次交付版本' : '准备交付草稿', view: taskArtifacts(task).length ? 'task-result' : 'task-plan' };
}
function changeTask(data: AppData, task: Task, patch: Partial<Task>, activity: string): AppData {
  return { ...data, tasks: data.tasks.map(current => current.id === task.id ? { ...current, ...patch, activities: [...current.activities, `${stamp()} · ${activity}`] } : current) };
}
function workError(data: AppData, task: Task | undefined): string | undefined {
  if (!task) return '没有找到这项工作';
  if (!taskVisible(data, task)) return '这项工作不在当前空间';
  if (taskClosed(task)) return '这项工作已经结束，结果与历史仍可查看';
  if (!taskBelongsToMe(data, task)) return '请由当前负责人处理这项工作';
  return undefined;
}
export function archiveTaskCompletion(task: Task): Pick<Task, 'completion' | 'completionHistory'> {
  const history = task.completionHistory || [];
  return { completion: undefined, completionHistory: task.completion && !history.some(item => item.id === task.completion!.id) ? [...history, task.completion] : history };
}
export function taskArtifactExportAccess(data: AppData, task: Task, artifact: TaskArtifact): { mode: 'normal' | 'history' | 'blocked'; error?: string } {
  const personal = data.settings.space === PERSONAL_SPACE;
  const available = taskVisible(data, task) && taskSourceAvailable(data, task) && !artifact.sourceNeedsReview && sourceAvailable(data, artifact, { publicOnly: !personal, requireShared: !personal }) && provenanceAvailable(data, artifact.sources);
  if (available && (personal || !artifact.needsReview && !!artifact.reviewedAt)) return { mode: 'normal' };
  if (personal) return { mode: 'history' };
  return { mode: 'blocked', error: '这版成果尚未核对有效的团队来源，不能复制或下载。可回个人空间查看历史。' };
}
export function acceptTask(data: AppData, id: string, input: { due?: string }): TaskMutation {
  const task = data.tasks.find(current => current.id === id), error = workError(data, task);
  if (error || !task) return { data, error };
  if (task.status !== '待承接' || task.transferRequest?.status === '待回应') return { data, error: '只有待承接的工作可以确认承接；转交请求需先处理回应' };
  const due = normalizeMoment(input.due || '');
  if (input.due?.trim() && input.due.trim() !== '无固定期限' && !due) return { data, error: '期限需为有效的本地日期时间，或留空' };
  if (!taskSourceAvailable(data, task)) return { data, error: '先核对当前任务来源与资料' };
  return { data: changeTask(data, task, { owner: '我', due: due || '无固定期限', status: '已承接' }, '本人确认承接工作') };
}
export function saveTaskProgress(data: AppData, id: string, input: { note: string; nextFollowUp?: string }): TaskMutation {
  const task = data.tasks.find(current => current.id === id), error = workError(data, task);
  if (error || !task) return { data, error };
  if (!['已承接', '进行中', '待验收', '待转交'].includes(task.status)) return { data, error: '先确认承接这项工作' };
  if (!input.note.trim()) return { data, error: '填写实际进展' };
  const nextFollowUp = normalizeMoment(input.nextFollowUp || '');
  if (input.nextFollowUp?.trim() && !nextFollowUp) return { data, error: '填写有效的本地跟进时间' };
  if (!taskSourceAvailable(data, task)) return { data, error: '先核对当前任务来源与资料' };
  const waiting = task.status === '待转交';
  return { data: changeTask(data, task, { status: waiting ? '待转交' : '进行中', nextFollowUp, ...(waiting && task.transferRequest?.status === '待回应' ? { transferRequest: { ...task.transferRequest, nextFollowUp } } : {}) }, `实际进展：${input.note.trim()}${nextFollowUp ? `；下次跟进${nextFollowUp.replace('T', ' ')}` : ''}`) };
}
function withCurrentSelectedMaterials(data: AppData, task: Task): Task {
  const selected = new Set(selectedTaskMaterials(task).map(material => material.id));
  return { ...task, materialRefs: task.materialRefs?.map(material => {
    const memory = selected.has(material.id) && material.memoryId ? data.memories.find(current => current.id === material.memoryId) : undefined;
    return memory ? { ...material, body: memory.body, sourceSession: memory.sourceSession, sourceId: memory.sourceId, sourceTime: memory.sourceTime, needsReview: material.needsReview || memory.needsReview } : material;
  }) };
}
export function createManualCompletion(data: AppData, id: string, input: { summary: string; remaining?: string }): TaskMutation {
  const task = data.tasks.find(current => current.id === id); const error = workError(data, task);
  if (error || !task) return { data, error };
  if (!['已承接', '进行中', '待验收'].includes(task.status)) return { data, error: '先确认本人承接再记录完成结果' };
  if (taskWorkKind(task) !== '行动') return { data, error: '这项工作需要检查明确的交付版本' };
  if (!input.summary.trim()) return { data, error: '请填写实际完成结果' };
  if (!taskSourceAvailable(data, task)) return { data, error: '先核对变化后的任务来源或资料' };
  const completion: TaskCompletion = { id: uid(), kind: '人工完成', summary: input.summary.trim(), completedAt: stamp(), remaining: input.remaining?.trim() };
  return { data: changeTask(data, task, { status: '已完成', completion, authorized: false, generationToken: undefined, generationSnapshot: undefined, needsReview: false, sourceNeedsReview: false, aiStatus: task.aiStatus === '准备中' ? '已停止' : task.aiStatus }, '本人记录实际完成结果：' + completion.summary) };
}
export function taskReviewArtifacts(data: AppData, id: string, artifactIds: string[]): TaskMutation {
  const task = data.tasks.find(current => current.id === id); const error = workError(data, task);
  if (error || !task) return { data, error };
  const all = taskArtifacts(task), selected = all.filter(artifact => artifactIds.includes(artifact.id));
  if (!selected.length || selected.length !== new Set(artifactIds).size) return { data, error: '选择要核对的实际成果版本' };
  if (!taskSourceAvailable(data, task) || !selected.every(artifact => !artifact.sourceNeedsReview && sourceAvailable(data, artifact) && provenanceAvailable(data, artifact.sources))) return { data, error: '成果或任务来源已变化，先重新核对并保存有效的新版本' };
  const reviewedAt = stamp(); const updated = all.map(artifact => artifactIds.includes(artifact.id) ? { ...artifact, needsReview: false, reviewedAt } : artifact);
  const needsReview = latestTaskArtifacts({ ...task, artifacts: updated }).some(artifact => artifact.needsReview || !artifact.reviewedAt);
  return { data: changeTask(data, task, { artifacts: updated, needsReview }, '本人核对草稿，工作责任与交付状态保持不变') };
}
export function createDeliveryCompletion(data: AppData, id: string, input: { artifactIds: string[]; summary: string; remaining?: string }): TaskMutation {
  const task = data.tasks.find(current => current.id === id); const error = workError(data, task);
  if (error || !task) return { data, error };
  if (!['已承接', '进行中', '待验收'].includes(task.status)) return { data, error: '先确认承接再完成交付' };
  const selected = taskArtifacts(task).filter(artifact => input.artifactIds.includes(artifact.id));
  if (!selected.length || selected.length !== new Set(input.artifactIds).size) return { data, error: '选择实际提交的交付版本' };
  if (!input.summary.trim()) return { data, error: '填写本次交付结果或验收说明' };
  if (!taskSourceAvailable(data, task) || !selected.every(artifact => !artifact.sourceNeedsReview && !artifact.needsReview && !!artifact.reviewedAt && sourceAvailable(data, artifact) && provenanceAvailable(data, artifact.sources))) return { data, error: '先核对所选版本的正文与来源' };
  const completion: TaskCompletion = { id: uid(), kind: '交付验收', summary: input.summary.trim(), completedAt: stamp(), artifactIds: selected.map(artifact => artifact.id), remaining: input.remaining?.trim() };
  return { data: changeTask(data, task, { status: '已完成', completion, deliveryArtifactIds: completion.artifactIds, needsReview: false, authorized: false, generationToken: undefined, generationSnapshot: undefined, aiStatus: task.aiStatus === '准备中' ? '已停止' : task.aiStatus }, '本人验收指定交付版本：' + selected.map(artifact => `${artifact.title} v${artifact.version}`).join('、')) };
}
export function beginTransfer(data: AppData, id: string, input: { to: string; reason: string; nextFollowUp?: string }): TaskMutation {
  const task = data.tasks.find(current => current.id === id); const error = workError(data, task);
  if (error || !task) return { data, error };
  if (task.status === '待转交' || task.transferRequest?.status === '待回应') return { data, error: '已有转交请求，先等待回应或撤回' };
  if (!input.to.trim() || me(data, input.to.trim()) || input.to.trim() === task.owner || /待确认|待选择|请选择/.test(input.to)) return { data, error: '选择另一位明确的接收人' };
  if (!input.reason.trim()) return { data, error: '补充转交说明' };
  const nextFollowUp = normalizeMoment(input.nextFollowUp || '');
  if (input.nextFollowUp?.trim() && !nextFollowUp) return { data, error: '填写有效的本地跟进时间' };
  const request = { id: uid(), fromOwner: task.owner, fromStatus: task.status, to: input.to.trim(), status: '待回应' as const, reason: input.reason.trim(), created: stamp(), nextFollowUp };
  return { data: changeTask(data, task, { status: '待转交', transferRequest: request, transferTo: request.to, nextFollowUp, authorized: false, generationToken: undefined, generationSnapshot: undefined, aiStatus: task.aiStatus === '未启动' ? '未启动' : '已停止' }, '建议转交给' + request.to + '，收到确认前保留原责任') };
}
export function resolveTransfer(data: AppData, id: string, requestId: string, response: '同意'|'婉拒'|'撤回'): TaskMutation {
  const task = data.tasks.find(current => current.id === id), request = task?.transferRequest;
  if (!task || !request || request.id !== requestId || request.status !== '待回应' || task.status !== '待转交') return { data, error: '这条转交请求已处理或已失效' };
  if (!taskVisible(data, task)) return { data, error: '这项工作不在当前空间' };
  if (!me(data, request.fromOwner)) return { data, error: '这条转交请求由原负责人管理' };
  const agreed = response === '同意';
  return { data: changeTask(data, task, { owner: agreed ? request.to : request.fromOwner, status: agreed ? '已承接' : request.fromStatus, transferTo: undefined, transferRequest: { ...request, status: agreed ? '已同意' : response === '婉拒' ? '已婉拒' : '已撤回' }, authorized: false, generationToken: undefined, generationSnapshot: undefined, aiStatus: agreed ? '未启动' : task.aiStatus }, agreed ? `${request.to}接受转交（演示回应），原负责人可继续跟进` : `${response}转交，恢复原工作状态，助手需重新允许`) };
}
export function setInquiry(data: AppData, id: string, inquiry: TaskInquiry): TaskMutation {
  const task = data.tasks.find(current => current.id === id);
  if (!task || taskClosed(task)) return { data, error: '这项工作已结束或不存在' };
  if (!taskVisible(data, task)) return { data, error: '这项工作不在当前空间' };
  if (!taskBelongsToMe(data, task) && !taskFollowedByMe(data, task)) return { data, error: '当前工作不由本人负责或跟进' };
  if (!inquiry.question.trim() || inquiry.status !== '待回答' && !inquiry.answer?.trim()) return { data, error: '填写具体问题与已收到的答复' };
  const nextFollowUp = normalizeMoment(inquiry.nextFollowUp || '');
  if (inquiry.nextFollowUp?.trim() && !nextFollowUp) return { data, error: '填写有效的本地跟进时间' };
  inquiry = { ...inquiry, nextFollowUp };
  const inquiries = taskInquiries(task); const existing = inquiries.find(current => current.id === inquiry.id);
  return { data: changeTask(data, task, { inquiries: existing ? inquiries.map(current => current.id === inquiry.id ? { ...current, ...inquiry } : current) : [...inquiries, inquiry] }, inquiry.status === '已解决' ? '本人确认问题已解决' : inquiry.status === '已回答' ? '收到答复，等待本人核对' : '记录问题与下一次跟进') };
}
export function authorizeTask(data: AppData, id: string, scope: TaskScope, mode?: TaskOutputMode): TaskMutation {
  const task = data.tasks.find(current => current.id === id); const error = workError(data, task);
  if (error || !task) return { data, error };
  if (!['已承接', '进行中', '待验收'].includes(task.status) || !scope.sources.trim() || !scope.destination.trim()) return { data, error: '先承接并明确这次允许的范围' };
  const next: Task = withCurrentSelectedMaterials(data, { ...task, scope: { ...scope, materialIds: scope.materialIds?.slice(), space: scope.space || data.settings.space }, outputMode: mode || taskOutputMode(task) });
  const actorData = { ...data, settings: { ...data.settings, space: next.scope!.space! } };
  if (scope.materialIds?.some(materialId => !task.materialRefs?.some(material => material.id === materialId)) || !taskSourceAvailable(actorData, next, new Set(), true)) return { data, error: '所选资料或任务来源已失效' };
  return { data: changeTask(data, task, { scope: next.scope, materialRefs: next.materialRefs, outputMode: next.outputMode, authorized: true, generationToken: undefined, generationSnapshot: undefined, aiStatus: '未启动' }, '本人允许已勾选的资料与本次草稿范围') };
}
export function beginGeneration(data: AppData, id: string, input: { token?: string; retry?: boolean } = {}): TaskMutation {
  const original = data.tasks.find(current => current.id === id); const error = workError(data, original);
  if (error || !original) return { data, error };
  const task = withCurrentSelectedMaterials(data, original);
  if (!['已承接', '进行中', '待验收'].includes(task.status)) return { data, error: '先确认承接，再允许助手准备' };
  if (!task.authorized || !task.scope?.sources.trim() || !task.scope.destination.trim()) return { data, error: '先核对本次资料与准备范围' };
  if (task.aiStatus === '准备中') return { data, error: '助手正在准备，没有重复启动' };
  const actorData = { ...data, settings: { ...data.settings, space: task.scope.space || data.settings.space } };
  if (task.scope.materialIds?.some(materialId => !task.materialRefs?.some(material => material.id === materialId)) || !taskSourceAvailable(actorData, task, new Set(), true)) return { data, error: '所选资料或任务来源已变化' };
  const mode = taskOutputMode(task), cost = outputCost(mode);
  if ((task.budget ?? 40) - (task.used ?? 0) < cost) return { data, error: '当前额度不足以覆盖这次准备' };
  const token = input.token || uid(), all = taskArtifacts(task), version = all.length ? Math.max(task.version, ...all.map(artifact => artifact.version)) + 1 : Math.max(task.version, 1);
  const materials = selectedTaskMaterials(task).map(material => ({ ...material }));
  const sourceRefs = [...(task.sources || []), ...(task.scope.includeSource !== false && task.sourceSession ? [{ kind: 'session' as const, id: task.sourceSession, sourceId: task.sourceId, sourceTime: task.sourceTime }] : []), ...materials.flatMap<SourceReference>(material => material.memoryId ? [{ kind: 'memory' as const, id: material.memoryId }] : material.sourceSession && (material.sourceId !== undefined || material.sourceTime) ? [{ kind: 'session' as const, id: material.sourceSession, sourceId: material.sourceId, sourceTime: material.sourceTime }] : [])].map(ref => makeSourceReference(actorData, ref));
  const started: Task = { ...task, workKind: taskWorkKind(task), outputMode: mode, version, generationToken: token, generationSources: sourceRefs, generationSpace: actorData.settings.space, aiStatus: '准备中', retryMissing: !!input.retry, failure: undefined };
  started.generationSnapshot = { token, mode, cost, version, space: actorData.settings.space, scope: { ...task.scope, materialIds: task.scope.materialIds?.slice() }, fingerprint: generationConfigurationFingerprint(started), materialFingerprint: generationMaterialFingerprint(materials), materials, sourceRefs, businessStatus: task.status === '进行中' ? '进行中' : '已承接', task: { id: task.id, title: task.title, description: task.description, owner: task.owner, due: task.due, workKind: started.workKind!, criteria: [...(task.criteria || [])], questions: taskInquiries(task).filter(inquiry => inquiry.status !== '已解决').map(inquiry => inquiry.question), ...(task.scope.includeSource !== false ? { sourceSession: task.sourceSession, sourceId: task.sourceId, sourceTime: task.sourceTime } : {}) } };
  return { data: changeTask(data, task, started, input.retry ? '固定本次补充后的准备范围，旧成果保留' : '固定已允许的资料、产出与额度，开始准备草稿'), token, cost };
}
