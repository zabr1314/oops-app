import type { AppData, ArtifactBinding, Receipt, SourceReference, Task, TaskArtifact, TaskDraft } from './store';
import { latestTaskArtifacts, taskArtifacts } from './taskWorkflow';
import { makeSourceReference, provenanceAvailable, sourceAvailable, taskSourceAvailable, taskVisible } from './sourceAccess';

export type Draft = TaskDraft;
export type CommunicationKind = '消息' | '邮件' | '日程';
export type CommunicationTask = Task & { criteria?: string[]; questions?: string[]; inquiries?: { id: string; question: string; status: string; target?: string; answer?: string }[]; drafts?: Record<string, Draft>; draftHistory?: { kind: string; draft: Draft; date: string }[] };
export type CommunicationOptions = { data?: AppData; space?: string; replyToInquiryId?: string };
export type CommunicationReview = { taskId: string; kind: CommunicationKind; draft: Draft; signature: string; space: string; actor: string; conflictSignature: string };
export type CommunicationReceipt = Receipt & { space?: string; actor?: string; signature?: string; draftSnapshot?: Draft; artifactRefs?: ArtifactBinding[]; start?: string; end?: string; calendar?: string };
const PERSONAL = '我的空间';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const usable = (value: string) => !!value.trim() && !/待选择|请选择|未设置|待确认|^未知$/.test(value.trim());
export function communicationFingerprint(value: unknown): string {
  const text = JSON.stringify(value); let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
export function artifactFingerprint(artifact: TaskArtifact): string { return communicationFingerprint([artifact.id, artifact.version, artifact.kind, artifact.title, artifact.body, artifact.sourceSession, artifact.sourceId, artifact.sourceTime, artifact.sources, (artifact as TaskArtifact & { sourceNeedsReview?: boolean }).sourceNeedsReview]); }
export function latestCommunicationArtifacts(task: CommunicationTask): TaskArtifact[] {
  return latestTaskArtifacts(task);
}
export function communicationTaskSnapshot(task: CommunicationTask): string {
  return communicationFingerprint([task.id, task.version, task.title, task.description, task.owner, task.requester, task.due, task.status, task.transferTo, task.sourceSession, task.sourceId, task.sourceTime, task.sources, task.materialRefs, task.criteria, task.inquiries, task.questions]);
}
export function artifactSelectionFingerprint(task: CommunicationTask): string { return communicationFingerprint(taskArtifacts(task).map(artifact => [artifact.id, artifact.version, artifactFingerprint(artifact)])); }
function sourcesFor(task: CommunicationTask, selected: TaskArtifact[], data?: AppData): SourceReference[] {
  const refs: SourceReference[] = [...(task.sources || []), ...selected.flatMap(artifact => artifact.sources || [])];
  (task.materialRefs || []).forEach(material => { if (material.memoryId) refs.push({ kind: 'memory', id: material.memoryId }); });
  [task, ...(task.materialRefs || []), ...selected].forEach(pointer => { if (pointer.sourceSession) refs.push({ kind: 'session', id: pointer.sourceSession, ...(pointer.sourceId !== undefined ? { sourceId: pointer.sourceId } : {}), sourceTime: pointer.sourceTime }); });
  const unique = refs.filter((ref, index) => refs.findIndex(other => other.kind === ref.kind && other.id === ref.id && other.sourceId === ref.sourceId && other.sourceTime === ref.sourceTime) === index);
  return unique.map(ref => data && ref.fingerprint === undefined ? makeSourceReference(data, ref) : clone(ref));
}
export function formatArtifactBody(artifact: Pick<TaskArtifact, 'title' | 'kind' | 'version' | 'body'>): string {
  const body = artifact.kind === 'PPT' ? artifact.body.map((page, index) => `第${index + 1}页\n${page}`).join('\n\n') : artifact.body.join('\n\n');
  return `${artifact.title} · v${artifact.version}\n${body}`;
}
export function formatDraftAttachments(task: CommunicationTask, draft: Draft): string {
  return (draft.artifactRefs || []).map(ref => {
    const current = taskArtifacts(task).find(artifact => artifact.id === ref.id && artifact.version === ref.version);
    return `${ref.title || current?.title || '已绑定成果'} · v${ref.version}`;
  }).join('、');
}
export function buildCommunicationDraft(task: CommunicationTask, kind: CommunicationKind, myName = '我', selectedIds?: string[], options: CommunicationOptions = {}): Draft {
  const all = taskArtifacts(task), selected = selectedIds === undefined ? latestCommunicationArtifacts(task) : all.filter(artifact => selectedIds.includes(artifact.id));
  const external = (name?: string) => !!name && usable(name) && !['我', myName].includes(name.trim());
  const inquiry = options.replyToInquiryId ? task.inquiries?.find(item => item.id === options.replyToInquiryId) : undefined;
  const target = external(inquiry?.target) ? inquiry!.target! : external(task.transferTo) && task.status === '待转交' ? task.transferTo! : external(task.owner) ? task.owner : external(task.requester) ? task.requester : '';
  const detail = selected.map(formatArtifactBody).join('\n\n');
  const questionBody = inquiry ? `需要核对的问题：${inquiry.question}${inquiry.answer?.trim() ? '\n答复：' + inquiry.answer.trim() : '\n请帮忙确认上述问题。'}` : '';
  const body = kind === '日程' ? `讨论「${task.title}」。\n${questionBody || '要求：' + task.description}${detail ? '\n\n本次讨论的成果版本：\n' + detail : '\n核对目标、资料和下一步。'}` : `${target ? target + '，你好。' : '你好。'}\n${questionBody || `关于「${task.title}」，请核对以下${selected.length ? '成果内容' : '要求'}。\n要求：${task.description}`}${detail ? '\n\n' + detail : ''}${!inquiry ? '\n\n需核对：' + (task.criteria?.join('；') || '资料、结果和下一步') : ''}\n谢谢。`;
  const draft: Draft = { target, body, attachments: '', subject: `${inquiry ? '请确认' : '请核对'}：${task.title}`, account: '我的演示账号', cc: '', start: '', end: '', calendar: '我的工作日历', artifactRefs: selected.map(artifact => ({ id: artifact.id, version: artifact.version, fingerprint: artifactFingerprint(artifact), title: artifact.title, kind: artifact.kind, body: [...artifact.body], sourceSession: artifact.sourceSession, sourceId: artifact.sourceId, sourceTime: artifact.sourceTime, sources: clone(artifact.sources || []), sourceNeedsReview: (artifact as TaskArtifact & { sourceNeedsReview?: boolean }).sourceNeedsReview })), basedOnVersion: task.version, sourceSnapshots: sourcesFor(task, selected, options.data), taskSnapshot: communicationTaskSnapshot(task), snapshotSpace: options.space || options.data?.settings.space, versionChoice: 'current', artifactSelectionFingerprint: artifactSelectionFingerprint(task), replyToInquiryId: inquiry?.id };
  return { ...draft, attachments: formatDraftAttachments(task, draft) };
}
export function initialCommunicationDraft(task: CommunicationTask, kind: CommunicationKind, myName = '我', selectedIds?: string[], options: CommunicationOptions = {}): Draft {
  const stored = task.drafts?.[kind];
  const saved = selectedIds === undefined && (!options.replyToInquiryId || stored?.replyToInquiryId === options.replyToInquiryId) ? stored : undefined;
  const space = options.space || options.data?.settings.space;
  return saved && (!space || (saved.snapshotSpace || PERSONAL) === space) ? clone(saved) : buildCommunicationDraft(task, kind, myName, selectedIds, options);
}
export function communicationDraftStatus(task: CommunicationTask, draft: Draft): { stale: boolean; reasons: string[]; bindingChanged: boolean; unbound: boolean } {
  const reasons: string[] = [], all = taskArtifacts(task);
  const unbound = draft.artifactRefs === undefined || !draft.taskSnapshot || !draft.artifactSelectionFingerprint || (draft.sourceSnapshots || []).some(ref => ref.fingerprint === undefined);
  const bindingChanged = (draft.artifactRefs || []).some(ref => { const current = all.find(artifact => artifact.id === ref.id && artifact.version === ref.version); return !current || !ref.fingerprint || artifactFingerprint(current) !== ref.fingerprint; });
  if (unbound) reasons.push('旧草稿尚未绑定明确成果版本');
  if (bindingChanged) reasons.push('已绑定的附件内容变化或原版本不再存在');
  if ((draft.recheckedTaskSnapshot || draft.taskSnapshot) !== communicationTaskSnapshot(task)) reasons.push('任务要求、归属或状态已更新');
  if (draft.artifactSelectionFingerprint !== artifactSelectionFingerprint(task)) reasons.push('成果列表已有更新');
  if (draft.attachments !== formatDraftAttachments(task, draft)) reasons.push('附件文字与实际绑定不一致');
  return { stale: !!reasons.length, reasons, bindingChanged, unbound };
}
export function communicationDraftStale(task: CommunicationTask, draft: Draft): boolean { return communicationDraftStatus(task, draft).stale; }
export function keepCommunicationDraft(task: CommunicationTask, draft: Draft): { draft?: Draft; error?: string } {
  const status = communicationDraftStatus(task, draft);
  if (status.unbound) return { error: '旧草稿没有可核对的附件绑定，请选择成果重新起草；原稿可继续保存。' };
  if (status.bindingChanged) return { error: '原附件版本已变化，不能沿用旧绑定。请选择可查看的成果版本，原稿仍保留。' };
  return { draft: { ...clone(draft), attachments: formatDraftAttachments(task, draft), recheckedTaskSnapshot: communicationTaskSnapshot(task), artifactSelectionFingerprint: artifactSelectionFingerprint(task), versionChoice: 'keep' } };
}
export function saveCommunicationDraft(data: AppData, taskId: string, draft: Draft, kind: CommunicationKind, archivePrevious = false, previousDraft?: Draft): AppData {
  return { ...data, tasks: data.tasks.map(task => {
    if (task.id !== taskId) return task;
    const prior = previousDraft || task.drafts?.[kind], history = task.draftHistory || [];
    const recorded = archivePrevious && prior && communicationDraftSignature(prior) !== communicationDraftSignature(draft) && !history.some(item => item.kind === kind && communicationDraftSignature(item.draft) === communicationDraftSignature(prior));
    return { ...task, drafts: { ...task.drafts, [kind]: clone(draft) }, draftHistory: recorded ? [...history, { kind, draft: clone(prior), date: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }] : history, activities: [...task.activities, `${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · 保存${kind}草稿，尚未外部提交${recorded ? '；原稿保留' : ''}`] };
  }) };
}
export function validCommunicationMoment(value: string): number | undefined {
  const match = value.trim().match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?[ T]*(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number), date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (year < 2020 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.getTime() - 8 * 60 * 60 * 1000;
}
export function communicationDraftSignature(draft: Draft): string {
  return communicationFingerprint([draft.target, draft.body, draft.subject, draft.cc, draft.account, draft.start, draft.end, draft.calendar, draft.artifactRefs, draft.sourceSnapshots, draft.taskSnapshot, draft.recheckedTaskSnapshot, draft.artifactSelectionFingerprint, draft.snapshotSpace, draft.replyToInquiryId]);
}
export function canSubmitCommunication(data: AppData, task: CommunicationTask, draft: Draft, kind: CommunicationKind = '消息'): { ok: boolean; error?: string } {
  const fail = (error: string) => ({ ok: false, error });
  if (!taskVisible(data, task)) return fail('当前空间无法查看这项任务。');
  if (draft.snapshotSpace && draft.snapshotSpace !== data.settings.space) return fail('草稿属于另一个空间，请回到原空间核对。');
  if (['已拒绝', '已取消'].includes(task.status)) return fail('这项任务已结束处理，不能继续本次通信。');
  if (task.sourceNeedsReview || !taskSourceAvailable(data, task) || !provenanceAvailable(data, draft.sourceSnapshots)) return fail('来源已变化，先核对原话与资料。原草稿可以保留。');
  const status = communicationDraftStatus(task, draft);
  if (status.stale) return fail(status.reasons.join('；') + '。请明确保留旧稿或按所选版本更新。');
  if ((draft.artifactRefs || []).some(ref => (ref as ArtifactBinding & { sourceNeedsReview?: boolean }).sourceNeedsReview || (taskArtifacts(task).find(artifact => artifact.id === ref.id && artifact.version === ref.version) as (TaskArtifact & { sourceNeedsReview?: boolean }) | undefined)?.sourceNeedsReview)) return fail('所选旧成果的来源已失效，请选择重新核对后产生的成果。原稿可保留。');
  if ((draft.artifactRefs || []).some(ref => !sourceAvailable(data, ref, { publicOnly: data.settings.space !== PERSONAL, requireShared: data.settings.space !== PERSONAL }) || !provenanceAvailable(data, ref.sources))) return fail('所选附件的原始来源不可用，不能确认本次发送。');
  if (!usable(draft.target) || !draft.body.trim()) return fail('请明确对象与完整正文。');
  if (kind !== '日程' && !usable(draft.account || '')) return fail('请选择明确发送账号。');
  if (kind === '邮件' && !draft.subject?.trim()) return fail('请填写邮件主题。');
  if (kind === '日程') {
    const start = validCommunicationMoment(draft.start || ''), end = validCommunicationMoment(draft.end || '');
    if (!draft.subject?.trim() || !usable(draft.calendar || '') || start === undefined || end === undefined || end <= start || Math.floor((start + 8 * 3600000) / 86400000) !== Math.floor((end + 8 * 3600000) / 86400000)) return fail('填写有效的同日日期时间，结束需晚于开始。');
  }
  return { ok: true };
}
export function visibleCalendarConflicts(data: AppData, task: CommunicationTask, draft: Draft): CommunicationReceipt[] {
  const start = validCommunicationMoment(draft.start || ''), end = validCommunicationMoment(draft.end || '');
  if (start === undefined || end === undefined) return [];
  return (data.receipts as CommunicationReceipt[]).filter(receipt => {
    if (receipt.kind !== '日程' || (receipt.space || PERSONAL) !== data.settings.space || receipt.actor && !['我', data.settings.name].includes(receipt.actor)) return false;
    const owned = data.tasks.find(item => item.id === receipt.taskId); if (owned && !taskVisible(data, owned)) return false;
    const legacy = receipt.body.match(/时间：(.+) — (.+)/), receiptStart = validCommunicationMoment(receipt.start || legacy?.[1] || ''), receiptEnd = validCommunicationMoment(receipt.end || legacy?.[2] || '');
    if (receiptStart === undefined || receiptEnd === undefined) return false;
    if (receipt.taskId === task.id && receipt.signature === communicationDraftSignature(draft)) return false;
    return start < receiptEnd && end > receiptStart;
  });
}
export function buildCommunicationReview(data: AppData, task: CommunicationTask, draft: Draft, kind: CommunicationKind): { review?: CommunicationReview; error?: string } {
  const valid = canSubmitCommunication(data, task, draft, kind); if (!valid.ok) return { error: valid.error };
  return { review: { taskId: task.id, kind, draft: clone(draft), signature: communicationDraftSignature(draft), space: data.settings.space, actor: '我', conflictSignature: communicationFingerprint(kind === '日程' ? visibleCalendarConflicts(data, task, draft).map(receipt => [receipt.id, receipt.body]) : []) } };
}
export function communicationReceiptBody(task: CommunicationTask, draft: Draft, kind: CommunicationKind): string {
  return `${kind !== '日程' ? `账号：${draft.account}\n` : ''}${kind !== '消息' ? `主题：${draft.subject}\n` : ''}${draft.body}\n附件：${formatDraftAttachments(task, draft) || '无'}${draft.cc ? '\n抄送：' + draft.cc : ''}${kind === '日程' ? `\n时间：${draft.start} — ${draft.end}\n日历：${draft.calendar}` : ''}`;
}
export function submitCommunication(data: AppData, review: CommunicationReview, currentDraft: Draft, receiptId: string, date: string): { data: AppData; receipt?: CommunicationReceipt; existing?: boolean; error?: string } {
  const task = data.tasks.find(item => item.id === review.taskId) as CommunicationTask | undefined;
  if (!task || data.settings.space !== review.space || review.actor !== '我') return { data, error: '任务或当前空间已变化，请重新核对。' };
  if (review.signature !== communicationDraftSignature(review.draft) || review.signature !== communicationDraftSignature(currentDraft)) return { data, error: '正文或附件在核对后发生变化，请重新确认。' };
  const valid = canSubmitCommunication(data, task, review.draft, review.kind); if (!valid.ok) return { data, error: valid.error };
  const conflicts = communicationFingerprint(review.kind === '日程' ? visibleCalendarConflicts(data, task, review.draft).map(receipt => [receipt.id, receipt.body]) : []);
  if (conflicts !== review.conflictSignature) return { data, error: '当前时段安排已更新，请重新核对冲突。' };
  const target = review.kind === '日程' ? `${review.draft.target} · ${review.draft.calendar}` : review.draft.target, body = communicationReceiptBody(task, review.draft, review.kind);
  const existing = (data.receipts as CommunicationReceipt[]).find(receipt => receipt.taskId === task.id && receipt.kind === review.kind && (receipt.space || PERSONAL) === review.space && (!receipt.actor || receipt.actor === review.actor) && (receipt.signature === review.signature || !receipt.signature && receipt.target === target && receipt.body === body && communicationFingerprint(receipt.artifactRefs || []) === communicationFingerprint(review.draft.artifactRefs || [])));
  if (existing) return { data, receipt: existing, existing: true };
  const receipt: CommunicationReceipt = { id: receiptId, taskId: task.id, kind: review.kind, target, body, date, space: review.space, actor: review.actor, signature: review.signature, draftSnapshot: clone(review.draft), artifactRefs: clone(review.draft.artifactRefs || []), start: review.draft.start, end: review.draft.end, calendar: review.draft.calendar };
  return { data: { ...data, receipts: [...data.receipts, receipt], tasks: data.tasks.map(item => item.id === task.id ? { ...item, drafts: { ...(item as CommunicationTask).drafts, [review.kind]: clone(review.draft) }, activities: [...item.activities, `${date} · 已记录${review.kind}模拟回执，绑定明确成果版本`] } : item) }, receipt };
}
