import type { AppData, Session, SourceReference, Task, Transcript } from './store';
import { findSourceTask, makeSourceReference, PERSONAL_SPACE, provenanceAvailable, sessionVisible, sourceAvailable, sourceTurn, taskSourceAvailable, taskVisible } from './sourceAccess';
import { normalizeMoment } from './dateLogic';

export type TaskSuggestionDraft = { title: string; ownerId: string; due: string; priority: Task['priority'] };
export type TaskSuggestion = TaskSuggestionDraft & {
  id: string; sourceId: string; sourceTime: string; speaker: string; text: string; sources: SourceReference[];
  dueHint: string; state: 'pending' | 'ignored' | 'created'; edited?: boolean; taskId?: string; taskNeedsReview?: boolean;
};
export type TaskSuggestionOwner = { id: string; name: string; label: string; personId?: string };
export type TaskSuggestionRead = { items: TaskSuggestion[]; staleCount: number; generated: boolean };
export type TaskSuggestionResult = { data: AppData; taskId?: string; existing?: boolean; error?: string };
type StoredSuggestions = { version: 1; sessionId: string; items: TaskSuggestion[] };

export const taskSuggestionsKey = (sessionId: string) => `task-suggestions:${PERSONAL_SPACE}:${sessionId}`;
const canUse = (data: AppData, sessionId: string) => data.settings.space === PERSONAL_SPACE && sessionVisible(data, sessionId);
const anonymous = (name: string) => !name.trim() || /未知|待确认|未确认|匿名|说话人|候选|unknown|anonymous/i.test(name);
const hash = (value: unknown) => { let n = 2166136261; const text = JSON.stringify(value); for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619); return (n >>> 0).toString(36); };
const action = /准备|核实|查询|整理|提交|交付|发送|联系|安排|跟进|完成|更新|验证|补充|给一版|做.{0,10}(?:PPT|文档|报告|清单|方案)/i;
const negated = /(?:不要|不用|不需要|无需|暂不|取消|不必|不再).{0,8}(?:准备|核实|查询|整理|提交|交付|发送|联系|安排|跟进|完成|更新|验证|补充|做)/;
function parseSnapshot(data: AppData, sessionId: string): StoredSuggestions | undefined {
  try {
    const value = JSON.parse(data.settings.retention[taskSuggestionsKey(sessionId)] || 'null');
    if (value?.version !== 1 || value.sessionId !== sessionId || !Array.isArray(value.items)) return undefined;
    return { version: 1, sessionId, items: value.items.filter((row: TaskSuggestion) => row && typeof row.id === 'string' && typeof row.sourceId === 'string' && typeof row.text === 'string' && typeof row.title === 'string' && typeof row.ownerId === 'string' && typeof row.due === 'string' && ['高', '中', '低'].includes(row.priority) && ['pending', 'ignored', 'created'].includes(row.state) && Array.isArray(row.sources) && row.sources.every(ref => ref && ref.kind === 'session' && typeof ref.id === 'string' && typeof ref.sourceId === 'string')) };
  } catch { return undefined; }
}
const put = (data: AppData, sessionId: string, items: TaskSuggestion[]): AppData => ({ ...data, settings: { ...data.settings, retention: { ...data.settings.retention, [taskSuggestionsKey(sessionId)]: JSON.stringify({ version: 1, sessionId, items } satisfies StoredSuggestions) } } });

/** Name confirmation is separate from voice consent; legacy checked voice cards stay compatible. */
export function taskSuggestionOwners(data: AppData): TaskSuggestionOwner[] {
  if (data.settings.space !== PERSONAL_SPACE) return [];
  const names = data.people.filter(person => !anonymous(person.name) && person.name !== data.settings.name && (data.settings.toggles[`person-name-confirmed:${person.id}`] === true || person.voice || ['本次手动确认', '已核对身份'].includes(person.role) || data.sessions.some(session => sessionVisible(data, session.id) && session.transcript.some(turn => turn.personId === person.id && data.settings.toggles[`speaker-confirmed:${session.id}:${turn.id}`] === true))));
  return [{ id: 'me', name: '我', label: `我 · ${data.settings.name}` }, ...names.map(person => ({ id: `person:${person.id}`, personId: person.id, name: person.name, label: `${person.name} · ${person.role || person.company || '已核对联系人'}${names.filter(other => other.name === person.name).length > 1 ? ` · ${person.id}` : ''}` }))];
}

export function taskSuggestionAvailable(data: AppData, sessionId: string, value: TaskSuggestion): boolean {
  return canUse(data, sessionId) && value.sources.length > 0 && provenanceAvailable(data, value.sources) && value.sources.every(ref => ref.kind === 'session' && ref.id === sessionId && ref.sourceId === value.sourceId && sourceAvailable(data, { sourceSession: ref.id, sourceId: ref.sourceId }, { publicOnly: true }));
}

function existingTask(data: AppData, sessionId: string, sourceId: string): Task | undefined {
  const linked = findSourceTask(data, { sourceSession: sessionId, sourceId });
  // Cancelled/rejected work also remains an explicit history entry, rather than being silently recreated.
  return linked && taskVisible(data, linked) ? linked : data.tasks.find(task => task.sourceSession === sessionId && sourceTurn(data, task)?.id === sourceId && taskVisible(data, task));
}

export function readTaskSuggestions(data: AppData, sessionId: string): TaskSuggestionRead {
  if (!canUse(data, sessionId)) return { items: [], staleCount: 0, generated: false };
  const stored = parseSnapshot(data, sessionId);
  const valid = (stored?.items || []).filter(value => taskSuggestionAvailable(data, sessionId, value));
  const items = valid.map(value => {
    const task = existingTask(data, sessionId, value.sourceId);
    if (task) return { ...value, state: 'created' as const, taskId: task.id, taskNeedsReview: !!task.sourceNeedsReview || !taskSourceAvailable(data, task) };
    return value.state === 'created' ? { ...value, state: 'pending' as const, taskId: undefined, taskNeedsReview: undefined } : value;
  });
  return { items, staleCount: (stored?.items.length || 0) - valid.length, generated: !!stored };
}

export function taskSuggestionPendingCount(data: AppData, sessionId: string): number {
  return readTaskSuggestions(data, sessionId).items.filter(value => value.state === 'pending').length;
}

function proposedOwner(data: AppData, session: Session, turn: Transcript): string {
  const choices = taskSuggestionOwners(data);
  const named = choices.filter(choice => choice.id !== 'me' && new RegExp(`(?:请|麻烦|由)?${choice.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:来|负责|准备|核实|整理|提交|跟进|完成|处理)`).test(turn.text));
  if (named.length === 1) return named[0].id;
  if (named.length > 1) return '';
  if (/(?:我来|由我|我负责|我会|我准备|我核实|我整理|我跟进)/.test(turn.text)) {
    if (turn.speaker === '我' || turn.speaker === data.settings.name) return 'me';
    if (turn.personId && data.settings.toggles[`speaker-confirmed:${session.id}:${turn.id}`] === true) return choices.find(choice => choice.personId === turn.personId)?.id || '';
  }
  return '';
}

function proposedDeadline(text: string): { due: string; dueHint: string } {
  const exact = text.match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?[ T]*\d{1,2}[:：]\d{2}/)?.[0].replace('：', ':');
  const normalized = exact ? normalizeMoment(exact) : undefined;
  if (normalized) return { due: normalized, dueHint: exact || '' };
  const hint = text.match(/(?:周[一二三四五六日天]|今天|明天|后天|本周|下周|月底|\d{1,2}月\d{1,2}日)(?:[^，。；！？\n]{0,14}?)(?:前|截止|完成|点(?:半|\d{1,2}分)?)/)?.[0] || '';
  return { due: '', dueHint: hint ? `${hint} · 日期待核对` : '原话未提供明确期限' };
}

function generate(data: AppData, session: Session): TaskSuggestion[] {
  if (!canUse(data, session.id)) return [];
  return session.transcript.filter(turn => !turn.private && turn.text.trim() && sourceAvailable(data, { sourceSession: session.id, sourceId: turn.id }, { publicOnly: true })).flatMap(turn => {
    const clause = turn.text.split(/[。！？；，,\n]/).map(value => value.trim()).find(value => action.test(value) && !negated.test(value));
    if (!clause) return [];
    const source = makeSourceReference(data, { kind: 'session', id: session.id, sourceId: turn.id, sourceTime: turn.time });
    const deadline = proposedDeadline(turn.text);
    const title = clause.replace(/^(?:我来|我会|我负责|请|麻烦|我们要|需要)\s*/, '').replace(/\d{4}[-/年].*$/, '').trim().slice(0, 70) || clause.slice(0, 70);
    return [{ id: `task-suggestion-${session.id}-${turn.id}-${hash(source)}`, sourceId: turn.id, sourceTime: turn.time, speaker: turn.speaker, text: turn.text, sources: [source], title, ownerId: proposedOwner(data, session, turn), ...deadline, priority: /紧急|优先|尽快|立即|务必/.test(turn.text) ? '高' as const : /有空|不急|可选|以后再/.test(turn.text) ? '低' as const : '中' as const, state: 'pending' as const }];
  });
}

/** Regenerating suggestions preserves explicit edits/ignores only for unchanged raw evidence. */
export function refreshTaskSuggestions(data: AppData, sessionId: string): AppData {
  const session = data.sessions.find(value => value.id === sessionId);
  if (!session || !canUse(data, sessionId)) return data;
  const previous = parseSnapshot(data, sessionId)?.items || [];
  const items = generate(data, session).map(value => {
    const old = previous.find(candidate => candidate.id === value.id && taskSuggestionAvailable(data, sessionId, candidate));
    return old ? { ...value, state: old.state, taskId: old.taskId, edited: old.edited, ...(old.edited ? { title: old.title, ownerId: old.ownerId, due: old.due, priority: old.priority } : {}) } : value;
  });
  return put(data, sessionId, items);
}

function validateDraft(data: AppData, draft: TaskSuggestionDraft, requireOwner = false): { draft?: TaskSuggestionDraft; error?: string } {
  if (!draft.title.trim()) return { error: '请填写任务标题' };
  if (!['高', '中', '低'].includes(draft.priority)) return { error: '请选择优先级' };
  if (requireOwner && !draft.ownerId) return { error: '请先确认明确的负责人，可保留候选稍后核对' };
  if (draft.ownerId && !taskSuggestionOwners(data).some(owner => owner.id === draft.ownerId)) return { error: '负责人身份已变化，请重新选择已核对的人物' };
  const due = draft.due.trim() && draft.due.trim() !== '无固定期限' ? normalizeMoment(draft.due.trim()) : '';
  if (draft.due.trim() && draft.due.trim() !== '无固定期限' && !due) return { error: '期限请填写有效日期时间，如2026-10-10 17:00，或留空' };
  return { draft: { title: draft.title.trim(), ownerId: draft.ownerId, due: due || '', priority: draft.priority } };
}

export function saveTaskSuggestionDraft(data: AppData, sessionId: string, id: string, draft: TaskSuggestionDraft): TaskSuggestionResult {
  const stored = parseSnapshot(data, sessionId), value = stored?.items.find(row => row.id === id);
  if (!value || !taskSuggestionAvailable(data, sessionId, value)) return { data, error: '来源已变化，请重新识别并核对' };
  if (existingTask(data, sessionId, value.sourceId)) return { data, error: '这段原话已有任务，请直接核对现有任务' };
  const checked = validateDraft(data, draft);
  if (checked.error) return { data, error: checked.error };
  return { data: put(data, sessionId, stored!.items.map(row => row.id === id ? { ...row, ...checked.draft!, edited: true, state: 'pending' } : row)) };
}

export function setTaskSuggestionIgnored(data: AppData, sessionId: string, id: string, ignored = true): TaskSuggestionResult {
  const stored = parseSnapshot(data, sessionId), value = stored?.items.find(row => row.id === id);
  if (!value || !taskSuggestionAvailable(data, sessionId, value)) return { data, error: '来源已变化，请重新识别并核对' };
  if (existingTask(data, sessionId, value.sourceId)) return { data, error: '这段原话已建立任务，可在任务页处理' };
  return { data: put(data, sessionId, stored!.items.map(row => row.id === id ? { ...row, state: ignored ? 'ignored' : 'pending' } : row)) };
}

export function createTaskFromSuggestion(data: AppData, sessionId: string, id: string, draft: TaskSuggestionDraft, options: { taskId?: string; created?: string } = {}): TaskSuggestionResult {
  const session = data.sessions.find(row => row.id === sessionId), stored = parseSnapshot(data, sessionId), value = stored?.items.find(row => row.id === id);
  if (!session || !value || !taskSuggestionAvailable(data, sessionId, value)) return { data, error: '来源已变化，请重新识别并核对' };
  const found = existingTask(data, sessionId, value.sourceId);
  if (found) return { data, taskId: found.id, existing: true };
  if (value.state === 'ignored') return { data, error: '这项建议已忽略，先重新打开再建立任务' };
  const checked = validateDraft(data, draft, true);
  if (checked.error) return { data, error: checked.error };
  const fields = checked.draft!, owner = taskSuggestionOwners(data).find(choice => choice.id === fields.ownerId)!;
  const taskId = options.taskId || `TASK-SUG-${hash([sessionId, value.sourceId])}`;
  if (data.tasks.some(task => task.id === taskId)) return { data, error: '任务编号已存在，请重新核对' };
  const original = sourceTurn(data, { sourceSession: sessionId, sourceId: value.sourceId })!;
  const knownSpeaker = original.speaker === '我' || original.speaker === data.settings.name ? '我' : original.personId && data.settings.toggles[`speaker-confirmed:${sessionId}:${original.id}`] === true && !anonymous(original.speaker) ? original.speaker : '待确认';
  const task: Task = { id: taskId, title: fields.title, description: original.text, owner: owner.name, requester: knownSpeaker, due: fields.due, priority: fields.priority, status: '待承接', aiStatus: '未启动', workKind: /PPT|文档|报告|框架|方案|交付/.test(fields.title) ? '交付' : '行动', origin: '会话建议', relatedSessionId: sessionId, sourceSession: sessionId, sourceId: original.id, sourceTime: original.time || undefined, sources: value.sources, results: [], activities: [`${options.created || '本次核对'} · 本人核对会话建议并建立待承接任务；未开启助手`], authorized: false, version: 1 };
  const updated = stored!.items.map(row => row.id === id ? { ...row, ...fields, edited: true, state: 'created' as const, taskId } : row);
  const next = put({ ...data, tasks: [task, ...data.tasks], settings: { ...data.settings, retention: { ...data.settings.retention, [`task-space:${taskId}`]: PERSONAL_SPACE, [`task-follow:${taskId}`]: '我', ...(owner.personId ? { [`task-owner-person:${taskId}`]: owner.personId } : {}) } } }, sessionId, updated);
  return { data: next, taskId };
}
