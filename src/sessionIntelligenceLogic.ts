import type { AppData, Route, Session, SourceReference, Transcript } from './store';
import type { SessionReviewItem } from './sessionLogic';
import { findSourceTask, makeSourceReference, PERSONAL_SPACE, provenanceAvailable, sessionVisible, sourceAvailable, sourceTurn, taskSourceAvailable, taskVisible } from './sourceAccess';
import { taskBelongsToMe } from './taskWorkflow';

export type IntelligenceKind = 'understanding' | 'decisions' | 'notices' | 'personal';
export type IntelligenceState = 'pending' | 'accepted' | 'rejected' | 'handled' | 'ignored' | 'deferred';
export type IntelligenceItem = {
  id: string; kind: string; title: string; text: string; sources: SourceReference[];
  state: IntelligenceState; edited?: boolean; evidence?: { label: string; text: string }[];
  action?: Route; actionLabel?: string; note?: string; basis?: string;
};
export type IntelligenceSnapshot = { version: 1; sessionId: string; kind: IntelligenceKind; items: IntelligenceItem[]; basis?: string };
export type IntelligenceRead = { items: IntelligenceItem[]; staleCount: number; generated: boolean };
export type IntelligenceResult = { data: AppData; error?: string };
export type PersonalContext = { name: string; role: string; focus: string };
export type NoticePlan = { meetingMinutes: number; topicMinutes: number; topicStartedSeconds: number; topicIndex: number };

export const intelligenceKey = (kind: IntelligenceKind, sessionId: string) => `intelligence:${kind}:${PERSONAL_SPACE}:${sessionId}`;
const planKey = (sessionId: string) => `intelligence:notice-plan:${PERSONAL_SPACE}:${sessionId}`;
const contextKey = (sessionId: string) => `intelligence:personal-context:${PERSONAL_SPACE}:${sessionId}`;
const canUse = (data: AppData, sessionId: string) => data.settings.space === PERSONAL_SPACE && sessionVisible(data, sessionId);
const readJSON = <T>(text: string | undefined, fallback: T): T => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
const hash = (value: unknown) => { let n = 2166136261; const text = JSON.stringify(value); for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619); return (n >>> 0).toString(36); };
const put = (data: AppData, key: string, value: unknown): AppData => ({ ...data, settings: { ...data.settings, retention: { ...data.settings.retention, [key]: JSON.stringify(value) } } });
const trim = (text: string, length = 200) => text.length > length ? `${text.slice(0, length)}…` : text;
const durationSeconds = (value: string) => /^\d+(?::\d+){1,2}$/.test(value) ? value.split(':').reduce((n, part) => n * 60 + Number(part), 0) : 0;
const refs = (data: AppData, session: Session, turns: Transcript[]) => turns.map(turn => makeSourceReference(data, { kind: 'session', id: session.id, sourceId: turn.id, sourceTime: turn.time }));
const safeTurns = (data: AppData, session: Session) => canUse(data, session.id) ? session.transcript.filter(turn => !turn.private && turn.text.trim() && sourceAvailable(data, { sourceSession: session.id, sourceId: turn.id }, { publicOnly: true })) : [];
const words = (text: string) => [...new Set([...(text.match(/[A-Za-z][A-Za-z0-9-]+/g) || []).map(x => x.toLowerCase()), ...(text.match(/[一-鿿]+/g) || []).flatMap(word => Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2)))])].filter(word => !['讨论', '关于', '确认', '我们', '今天', '议题', '进行', '这个', '什么', '需要'].includes(word));
const mentions = (text: string, topic: string) => words(topic).some(word => text.toLowerCase().includes(word));
const item = (session: Session, kind: string, title: string, text: string, sources: SourceReference[], extra: Partial<IntelligenceItem> = {}): IntelligenceItem => ({ id: `intel-${session.id}-${kind}-${hash([text, sources])}`, kind, title, text, sources, state: 'pending', ...extra });

function publicEvidenceAvailable(data: AppData, sources: SourceReference[], seen = new Set<string>()): boolean {
  return sources.every(ref => {
    if (ref.kind === 'session') return sourceAvailable(data, { sourceSession: ref.id, sourceId: ref.sourceId, sourceTime: ref.sourceTime }, { publicOnly: true });
    if (ref.kind !== 'memory' && ref.kind !== 'task') return true;
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return false;
    const linked = ref.kind === 'memory' ? data.memories.find(value => value.id === ref.id) : data.tasks.find(value => value.id === ref.id);
    return !!linked && sourceAvailable(data, linked, { publicOnly: true }) && publicEvidenceAvailable(data, linked.sources || [], new Set(seen).add(key));
  });
}

function snapshot(data: AppData, sessionId: string, kind: IntelligenceKind): IntelligenceSnapshot | undefined {
  const value = readJSON<Partial<IntelligenceSnapshot> | null>(data.settings.retention[intelligenceKey(kind, sessionId)], null);
  if (!value || value.version !== 1 || value.sessionId !== sessionId || value.kind !== kind || !Array.isArray(value.items)) return undefined;
  const states = ['pending', 'accepted', 'rejected', 'handled', 'ignored', 'deferred'];
  return { version: 1, sessionId, kind, basis: value.basis, items: value.items.filter(x => x && typeof x.id === 'string' && typeof x.text === 'string' && typeof x.title === 'string' && typeof x.kind === 'string' && Array.isArray(x.sources) && states.includes(x.state)) };
}

/** A stored fingerprint is checked, never replaced by the latest raw passage on read. */
export function intelligenceItemAvailable(data: AppData, sessionId: string, value: IntelligenceItem): boolean {
  const session = data.sessions.find(row => row.id === sessionId);
  return canUse(data, sessionId) && provenanceAvailable(data, value.sources) && publicEvidenceAvailable(data, value.sources) && (value.kind !== 'my-focus' && value.kind !== 'my-todo' && value.kind !== 'my-insight' || value.note === hash(readPersonalContext(data, sessionId))) && (value.basis === undefined || !!session && value.basis === (value.kind === 'my-todo' ? personalTodoBasis(data, session, value.action) : noticeBasis(data, session)));
}

export function readSessionIntelligence(data: AppData, sessionId: string, kind: IntelligenceKind): IntelligenceRead {
  if (!canUse(data, sessionId)) return { items: [], staleCount: 0, generated: false };
  const stored = snapshot(data, sessionId, kind);
  const available = (stored?.items || []).filter(value => intelligenceItemAvailable(data, sessionId, value));
  const items = kind === 'decisions' ? available.map(value => value.state === 'accepted' && !decisionStillConfirmed(data, sessionId, value) ? { ...value, state: 'pending' as const } : value) : available;
  const session = data.sessions.find(value => value.id === sessionId);
  return { items, staleCount: (stored?.items.length || 0) - items.length, generated: !!stored && (kind !== 'personal' || !!session && stored.basis === personalBasis(data, session)) };
}

export function intelligencePendingCount(data: AppData, sessionId: string, kind: IntelligenceKind): number {
  return readSessionIntelligence(data, sessionId, kind).items.filter(value => value.state === 'pending').length;
}

export function readPersonalContext(data: AppData, sessionId: string): PersonalContext {
  const value = readJSON<Partial<PersonalContext>>(data.settings.retention[contextKey(sessionId)], {});
  return { name: data.settings.name || '我', role: typeof value.role === 'string' ? value.role : data.settings.role, focus: typeof value.focus === 'string' ? value.focus : data.settings.retention.focus || data.settings.retention.roleContext || '先把本次需要我跟进的事做好' };
}

export function savePersonalContext(data: AppData, sessionId: string, context: { role: string; focus: string }): IntelligenceResult {
  if (!canUse(data, sessionId)) return { data, error: '请在我的空间修改本次关注点' };
  if (!context.role.trim() || !context.focus.trim()) return { data, error: '请填写本次角色和关注目标' };
  const next = put(data, contextKey(sessionId), { role: context.role.trim(), focus: context.focus.trim() });
  return { data: refreshSessionIntelligence(next, sessionId, 'personal') };
}

export function readNoticePlan(data: AppData, session: Session): NoticePlan {
  const value = readJSON<Partial<NoticePlan>>(data.settings.retention[planKey(session.id)], {});
  const index = Math.max(0, Math.min(session.agenda.length - 1, Number(data.settings.retention[`agenda-${session.id}`]) || 0));
  const meeting = Number(data.settings.retention[`session-plan:${session.id}`]) || 45;
  return { meetingMinutes: meeting, topicMinutes: Number(value.topicMinutes) > 0 ? Number(value.topicMinutes) : Math.max(5, Math.round(meeting / Math.max(1, session.agenda.length))), topicStartedSeconds: value.topicIndex === index ? Math.max(0, Number(value.topicStartedSeconds) || 0) : index === 0 && value.topicIndex === undefined ? 0 : durationSeconds(session.duration), topicIndex: index };
}

/** Call just after committing an agenda-index change; refresh also records a missing origin. */
export function beginIntelligenceTopic(data: AppData, sessionId: string): AppData {
  const session = data.sessions.find(value => value.id === sessionId);
  if (!session || !canUse(data, sessionId)) return data;
  const plan = readNoticePlan(data, session);
  return put(data, planKey(sessionId), { ...plan, topicStartedSeconds: durationSeconds(session.duration) });
}

function noticeBasis(data: AppData, session: Session): string {
  return hash([session.agenda, readNoticePlan(data, session), session.status, reviewItems(data, session).filter(value => value.kind === 'conclusion' && value.confirmed).map(value => [value.id, value.text, value.sourceId])]);
}

function personalTaskBasis(data: AppData, taskId: string): unknown {
  const task = data.tasks.find(value => value.id === taskId);
  return task ? [task.id, task.owner, task.status, task.sourceSession, task.relatedSessionId, task.sourceId, task.sourceTime, task.version, task.needsReview, task.sourceNeedsReview, taskSourceAvailable(data, task), makeSourceReference(data, { kind: 'task', id: task.id, version: task.version }).fingerprint] : undefined;
}

function personalBasis(data: AppData, session: Session): string {
  return hash([readPersonalContext(data, session.id), makeSourceReference(data, { kind: 'profile', id: 'my-profile', profileScope: 'preferences' }).fingerprint, data.tasks.filter(task => task.sourceSession === session.id || task.relatedSessionId === session.id).map(task => personalTaskBasis(data, task.id)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
}

function personalTodoBasis(data: AppData, session: Session, action?: Route): string {
  return action?.view === 'task-detail' && action.id ? hash(personalTaskBasis(data, action.id)) : personalBasis(data, session);
}

export function saveNoticePlan(data: AppData, sessionId: string, values: { meetingMinutes: number; topicMinutes: number; restartTopic?: boolean }): IntelligenceResult {
  const session = data.sessions.find(value => value.id === sessionId);
  if (!session || !canUse(data, sessionId)) return { data, error: '当前记录不可操作' };
  if (!Number.isFinite(values.meetingMinutes) || !Number.isFinite(values.topicMinutes) || values.meetingMinutes < 1 || values.meetingMinutes > 480 || values.topicMinutes < 1 || values.topicMinutes > 240) return { data, error: '会议时长请填1–480分钟，议题时长请填1–240分钟' };
  const previous = readNoticePlan(data, session);
  let next = put(data, planKey(sessionId), { ...previous, topicMinutes: values.topicMinutes, topicStartedSeconds: values.restartTopic ? durationSeconds(session.duration) : previous.topicStartedSeconds });
  next = { ...next, settings: { ...next.settings, retention: { ...next.settings.retention, [`session-plan:${sessionId}`]: String(values.meetingMinutes) } } };
  return { data: refreshSessionIntelligence(next, sessionId, 'notices') };
}

function understanding(data: AppData, session: Session): IntelligenceItem[] {
  const turns = safeTurns(data, session);
  if (!turns.length) return [];
  const current = session.agenda[readNoticePlan(data, session).topicIndex];
  const topicTurns = current ? turns.filter(turn => mentions(turn.text, current)) : [];
  const topic = topicTurns.length ? topicTurns : turns.slice(-2);
  const event = turns.filter(turn => /准备|查|发|安排|跟进|做|提交|发布/.test(turn.text)).slice(-3);
  const intent = turns.filter(turn => /目标|希望|为了|重点|关键|先|需要/.test(turn.text)).slice(-2);
  const project = data.projects.find(value => value.name === session.project);
  const contextSources = [...refs(data, session, turns.slice(0, 1)), ...(project ? [makeSourceReference(data, { kind: 'project', id: project.id })] : [])];
  const lines = (values: Transcript[]) => values.map(turn => `${turn.speaker}：${trim(turn.text, 100)}`).join('\n');
  return [
    item(session, 'topic', '当前议题', current || session.title, refs(data, session, topic)),
    item(session, 'people', '讨论中的人物', [...new Set(turns.map(turn => turn.speaker))].map(name => /未知|待确认|说话人/.test(name) ? `${name} · 姓名待核对` : name).join('、'), refs(data, session, turns)),
    item(session, 'event', '正在推进的事', lines(event.length ? event : turns.slice(-1)), refs(data, session, event.length ? event : turns.slice(-1))),
    item(session, 'intent', '表达的意图', lines(intent.length ? intent : turns.slice(0, 1)), refs(data, session, intent.length ? intent : turns.slice(0, 1))),
    item(session, 'context', '关联上下文', project ? `${project.name}\n${project.description}\n${project.rule}` : `${session.title}\n${trim(turns[0].text)}`, contextSources),
  ];
}

function decisions(data: AppData, session: Session): IntelligenceItem[] {
  return safeTurns(data, session).filter(turn => /决定|确定|就按|先按|建议|可以|先做|先把|关键|重点|结论|放在|不需要/.test(turn.text)).slice(-8).map(turn => {
    const kind = /决定|确定|就按|先按/.test(turn.text) ? 'decision' : /关键|重点|结论/.test(turn.text) ? 'conclusion' : 'proposal';
    return item(session, kind, kind === 'decision' ? '决定建议' : kind === 'proposal' ? '方案建议' : '结论建议', turn.text, refs(data, session, [turn]));
  });
}

function budgetAmount(text: string): number | undefined {
  const match = text.match(/(?:预算|费用|成本|总计|合计|加起来)[^。；\n]{0,18}?([\d.]+|[一二三四五六七八九十]+)\s*(万|元)/);
  if (!match) return undefined;
  const chinese: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  let amount = Number(match[1]);
  if (!Number.isFinite(amount)) { const parts = match[1].split('十'); amount = parts.length > 1 ? (parts[0] ? chinese[parts[0]] : 1) * 10 + (parts[1] ? chinese[parts[1]] : 0) : chinese[match[1]]; }
  return Number.isFinite(amount) ? amount * (match[2] === '万' ? 10000 : 1) : undefined;
}

function notices(data: AppData, session: Session): IntelligenceItem[] {
  const turns = safeTurns(data, session), output: IntelligenceItem[] = [];
  if (!turns.length) return output;
  const plan = readNoticePlan(data, session), elapsed = durationSeconds(session.duration), active = ['进行中', '暂停'].includes(session.status);
  const currentTopic = session.agenda[plan.topicIndex], latest = turns.slice(-2), liveSources = refs(data, session, latest);
  const agendaAction = { view: 'session-agenda', id: session.id };
  const basis = noticeBasis(data, session);
  const add = (kind: string, title: string, text: string, sources: SourceReference[], evidence: IntelligenceItem['evidence'], action: Route = agendaAction, actionLabel = '查看议程') => output.push(item(session, kind, title, text, sources, { evidence, action, actionLabel, basis, ...(['meeting-ending', 'topic-overtime', 'undiscussed'].includes(kind) ? { id: `intel-${session.id}-${kind}-${hash([kind, plan, session.agenda, kind === 'undiscussed' ? text : ''])}` } : {}) }));
  if (active && currentTopic && latest.length === 2 && latest.every(turn => !mentions(turn.text, currentTopic))) add('off-topic', '讨论可能偏离当前议题', `当前议题是「${currentTopic}」`, liveSources, [{ label: '当前议题', text: currentTopic }, { label: '最近讨论', text: latest.map(turn => turn.text).join('\n') }]);
  if (active && elapsed >= Math.max(0, plan.meetingMinutes * 60 - 300)) add('meeting-ending', elapsed >= plan.meetingMinutes * 60 ? '会议已到计划结束时间' : '会议即将到计划结束时间', `已记录${Math.floor(elapsed / 60)}分钟，计划${plan.meetingMinutes}分钟`, liveSources, [{ label: '计划时长', text: `${plan.meetingMinutes}分钟` }, { label: '已记录', text: session.duration }]);
  if (active && currentTopic && elapsed - plan.topicStartedSeconds >= plan.topicMinutes * 60) add('topic-overtime', '当前议题已超出分配时间', `「${currentTopic}」已用${Math.floor((elapsed - plan.topicStartedSeconds) / 60)}分钟`, liveSources, [{ label: '本议题计划', text: `${plan.topicMinutes}分钟` }, { label: '本轮起点', text: `${Math.floor(plan.topicStartedSeconds / 60)}分${plan.topicStartedSeconds % 60}秒` }]);
  const unmentioned = session.agenda.filter(topic => !turns.some(turn => mentions(turn.text, topic)));
  if (unmentioned.length && (session.status === '已结束' || active && elapsed >= plan.meetingMinutes * 60 - 300)) add('undiscussed', '还有议题没有讨论依据', unmentioned.join('、'), liveSources, [{ label: '待回看议题', text: unmentioned.join('\n') }, { label: '当前记录', text: `${turns.length}段可用原话，暂未匹配上述议题` }]);
  const project = data.projects.find(value => value.name === session.project);
  if (project) {
    const projectRef = makeSourceReference(data, { kind: 'project', id: project.id });
    for (const turn of turns) {
      const amount = budgetAmount(turn.text);
      if (amount !== undefined && project.budget > 0 && amount > project.budget) add('budget-conflict', '当前费用可能超出预算', `讨论金额${amount.toLocaleString()}元，项目预算${project.budget.toLocaleString()}元`, [...refs(data, session, [turn]), projectRef], [{ label: '当前讨论', text: turn.text }, { label: '项目预算', text: `${project.name} · ${project.budget.toLocaleString()}元` }], { view: 'session-reminders', id: session.id }, '核对预算');
      if (/逐项确认|先确认|批准|审批/.test(project.rule) && /直接|不用确认|无需确认|自动/.test(turn.text) && /发送|发布|对外|付款|执行/.test(turn.text)) add('rule-conflict', '当前提议与项目规则需核对', '对外操作的确认要求可能不同', [...refs(data, session, [turn]), projectRef], [{ label: '当前提议', text: turn.text }, { label: '项目规则', text: project.rule }], { view: 'session-decisions', id: session.id }, '核对决定');
    }
  }
  const memories = data.memories.filter(memory => !memory.deleted && memory.confirmed && !memory.needsReview && memory.sourceSession !== session.id && /决定|结论|规则/.test(`${memory.title}${memory.tags.join(' ')}`)).filter(memory => { const source = makeSourceReference(data, { kind: 'memory', id: memory.id }); return provenanceAvailable(data, [source]) && publicEvidenceAvailable(data, [source]); });
  for (const turn of turns.filter(turn => /改为|改成|取消|不再|换成|重新/.test(turn.text))) {
    const previous = memories.find(memory => words(memory.title).some(word => turn.text.includes(word)) || words(memory.body).filter(word => turn.text.includes(word)).length >= 2);
    if (previous) add('history-conflict', '当前讨论可能改变历史决定', '请对照原决定再确认本次变更', [...refs(data, session, [turn]), makeSourceReference(data, { kind: 'memory', id: previous.id })], [{ label: '当前讨论', text: turn.text }, { label: '历史决定', text: `${previous.title}\n${previous.body}` }], { view: 'session-decisions', id: session.id }, '核对决定');
  }
  const accepted = reviewItems(data, session).filter(value => value.kind === 'conclusion' && value.confirmed);
  for (const turn of turns.filter(turn => /[？?]|待确认|还没确定|没有结论|尚未决定/.test(turn.text))) {
    if (accepted.some(value => value.sourceId === turn.id)) continue;
    const task = findSourceTask(data, { sourceSession: session.id, sourceId: turn.id });
    const availableTask = task && taskVisible(data, task) && taskSourceAvailable(data, task) ? task : undefined;
    add('unresolved', '这项问题还没有确认结论', trim(turn.text, 120), refs(data, session, [turn]), [{ label: '待确认的问题', text: turn.text }, { label: '核对结果', text: '本次结果中尚无关联此段原话的已确认结论' }], availableTask ? { view: 'task-detail', id: availableTask.id } : { view: 'session-review-edit', id: session.id, mode: turn.id }, availableTask ? '跟进相关任务' : '补充结论');
  }
  return output;
}

function personal(data: AppData, session: Session): IntelligenceItem[] {
  const turns = safeTurns(data, session);
  if (!turns.length) return [];
  const context = readPersonalContext(data, session.id), profile = makeSourceReference(data, { kind: 'profile', id: 'my-profile', profileScope: 'preferences' });
  const ownTurns = turns.filter(turn => turn.speaker === '我' || turn.speaker === context.name);
  const relevant = turns.filter(turn => mentions(turn.text, context.focus));
  const chosen = (relevant.length ? relevant : ownTurns.length ? ownTurns : turns).slice(-2);
  const sourceRefs = [...refs(data, session, chosen), profile];
  const note = hash(context);
  const tasks = data.tasks.filter(task => taskBelongsToMe(data, task) && (task.sourceSession === session.id || task.relatedSessionId === session.id) && !['已完成', '已取消', '已拒绝'].includes(task.status) && taskVisible(data, task) && taskSourceAvailable(data, task));
  const result = [item(session, 'my-focus', '我的重点', `以${context.role}的视角，关注${context.focus}\n${trim(chosen[0].text, 120)}`, sourceRefs, { note }), item(session, 'my-insight', '我的观察', `值得我再确认：${trim(chosen[chosen.length - 1].text, 140)}\n下一次可先检查是否推进了「${context.focus}」。`, sourceRefs, { note })];
  if (tasks.length) for (const task of tasks.slice(0, 5)) result.splice(result.length - 1, 0, item(session, 'my-todo', '我的待办', task.title, [...(task.sourceId || task.sourceTime ? [makeSourceReference(data, { kind: 'session', id: task.sourceSession || session.id, sourceId: task.sourceId, sourceTime: task.sourceTime })] : sourceRefs), makeSourceReference(data, { kind: 'task', id: task.id, version: task.version }), profile], { note, action: { view: 'task-detail', id: task.id }, actionLabel: '查看待办', basis: personalTodoBasis(data, session, { view: 'task-detail', id: task.id }) }));
  else result.splice(1, 0, item(session, 'my-todo', '我的下一步', `我来核对：${trim(chosen[0].text, 100)}`, sourceRefs, { note, action: { view: 'session-detail', id: session.id, mode: '行动' }, actionLabel: '整理为行动', basis: personalTodoBasis(data, session) }));
  return result;
}

/** Explicit refresh reconciles current evidence with existing user edits and processing states. */
export function refreshSessionIntelligence(data: AppData, sessionId: string, kind?: IntelligenceKind): AppData {
  const session = data.sessions.find(value => value.id === sessionId);
  if (!session || !canUse(data, sessionId)) return data;
  let next = data;
  for (const currentKind of kind ? [kind] : ['understanding', 'decisions', 'notices', 'personal'] as IntelligenceKind[]) {
    const previous = snapshot(next, sessionId, currentKind)?.items || [];
    if (currentKind === 'notices') {
      const savedPlan = readJSON<Partial<NoticePlan>>(next.settings.retention[planKey(sessionId)], {});
      const currentPlan = readNoticePlan(next, session);
      if (savedPlan.topicIndex !== currentPlan.topicIndex) next = put(next, planKey(sessionId), currentPlan);
    }
    if (currentKind === 'decisions') {
      const oldReview = reviewItems(next, session);
      const rows = oldReview.map(row => {
        if (!row.id.startsWith('intelligence-conclusion:') || !row.confirmed) return row;
        const original = previous.find(value => `intelligence-conclusion:${value.id}` === row.id);
        return original && intelligenceItemAvailable(next, sessionId, original) ? row : { ...row, confirmed: false, shared: false };
      });
      if (rows.some((row, index) => row !== oldReview[index])) next = writeReviewRows(next, session, rows);
    }
    const generated = currentKind === 'understanding' ? understanding(next, session) : currentKind === 'decisions' ? decisions(next, session) : currentKind === 'notices' ? notices(next, session) : personal(next, session);
    const merged = generated.map(value => { const existing = previous.find(old => old.id === value.id && intelligenceItemAvailable(next, sessionId, currentKind === 'notices' ? { ...old, basis: value.basis } : old)); return existing ? { ...value, state: currentKind === 'decisions' && existing.state === 'accepted' && !decisionStillConfirmed(next, sessionId, existing) ? 'pending' : existing.state, edited: existing.edited, ...(existing.edited ? { text: existing.text } : {}) } : value; });
    // Keep corrected summaries while their explicit evidence remains valid, even as new turns arrive.
    if (currentKind === 'understanding' || currentKind === 'personal') for (const old of previous.filter(value => value.edited && intelligenceItemAvailable(next, sessionId, value))) {
      const index = merged.findIndex(value => value.kind === old.kind && (currentKind !== 'personal' || value.action?.id === old.action?.id));
      if (index >= 0) merged[index] = old;
    }
    next = put(next, intelligenceKey(currentKind, sessionId), { version: 1, sessionId, kind: currentKind, items: merged, ...(currentKind === 'personal' ? { basis: personalBasis(next, session) } : {}) } satisfies IntelligenceSnapshot);
  }
  return next;
}

function reviewItems(data: AppData, session: Session): SessionReviewItem[] {
  const stored = readJSON<SessionReviewItem[] | null>(data.settings.retention[`session-review-items:${session.id}`], null);
  if (Array.isArray(stored)) return stored.filter(value => value && typeof value.text === 'string' && typeof value.id === 'string' && ['conclusion', 'question'].includes(value.kind));
  const conclusions = readJSON<string[]>(data.settings.retention[`session-conclusions:${session.id}`], []);
  const questions = readJSON<string[]>(data.settings.retention[`session-questions:${session.id}`], []);
  return [...(Array.isArray(conclusions) ? conclusions : []).map((text, index) => ({ id: `legacy-c-${index}`, kind: 'conclusion' as const, text, confirmed: true, shared: false })), ...(Array.isArray(questions) ? questions : []).map((text, index) => ({ id: `legacy-q-${index}`, kind: 'question' as const, text, confirmed: true, shared: false }))];
}

function decisionStillConfirmed(data: AppData, sessionId: string, value: IntelligenceItem): boolean {
  const session = data.sessions.find(row => row.id === sessionId);
  const sourceId = value.sources.find(ref => ref.kind === 'session' && ref.id === sessionId)?.sourceId;
  return !!session && reviewItems(data, session).some(row => row.id === `intelligence-conclusion:${value.id}` && row.confirmed && row.text === value.text && row.sourceId === sourceId);
}

function writeDecisionReview(data: AppData, session: Session, value: IntelligenceItem, accepted: boolean): AppData {
  const id = `intelligence-conclusion:${value.id}`;
  const previous = reviewItems(data, session);
  const already = previous.find(row => row.id === id);
  if (accepted && already?.text === value.text && already.confirmed) return data;
  const sourceId = value.sources.find(ref => ref.kind === 'session' && ref.id === session.id)?.sourceId;
  const rows = previous.filter(row => row.id !== id).map(row => accepted && sourceId && row.sourceId === sourceId && row.id.startsWith('intelligence-conclusion:') ? { ...row, confirmed: false, shared: false } : row);
  if (accepted) rows.push({ id, kind: 'conclusion', text: value.text, confirmed: true, shared: false, sourceId });
  return writeReviewRows(data, session, rows);
}

function writeReviewRows(data: AppData, session: Session, rows: SessionReviewItem[]): AppData {
  const conclusions = rows.filter(row => row.kind === 'conclusion' && row.confirmed).map(row => row.text);
  return { ...data, sessions: data.sessions.map(current => current.id === session.id ? { ...current, summary: conclusions } : current), settings: { ...data.settings, retention: { ...data.settings.retention, [`session-review-items:${session.id}`]: JSON.stringify(rows), [`session-conclusions:${session.id}`]: JSON.stringify(conclusions), [`session-questions:${session.id}`]: JSON.stringify(rows.filter(row => row.kind === 'question' && row.confirmed).map(row => row.text)) } } };
}

export function updateIntelligenceItem(data: AppData, sessionId: string, kind: IntelligenceKind, id: string, change: { text?: string; state?: IntelligenceState }): IntelligenceResult {
  const session = data.sessions.find(value => value.id === sessionId), stored = snapshot(data, sessionId, kind), value = stored?.items.find(row => row.id === id);
  if (!session || !value || !intelligenceItemAvailable(data, sessionId, value)) return { data, error: '来源已变化，请重新整理并核对' };
  if (change.text !== undefined && !change.text.trim()) return { data, error: '请填写内容' };
  const allowed = kind === 'decisions' ? ['pending', 'accepted', 'rejected'] : kind === 'notices' ? ['pending', 'handled', 'ignored', 'deferred'] : ['pending', 'accepted'];
  if (change.state && !allowed.includes(change.state)) return { data, error: '此页面不支持该处理状态' };
  const edited = change.text !== undefined && change.text.trim() !== value.text;
  const updated: IntelligenceItem = { ...value, ...(change.text !== undefined ? { text: change.text.trim(), edited: value.edited || edited } : {}), state: change.state || (edited && kind === 'decisions' ? 'pending' : value.state) };
  let next = put(data, intelligenceKey(kind, sessionId), { ...stored!, items: stored!.items.map(row => row.id === id ? updated : row) });
  if (kind === 'decisions') next = writeDecisionReview(next, session, updated, updated.state === 'accepted');
  if (kind === 'decisions') next = refreshSessionIntelligence(next, sessionId, 'notices');
  return { data: next };
}

/** Return a current, exact evidence pointer only after validating the whole output. */
export function intelligenceSourceRoute(data: AppData, sessionId: string, value: IntelligenceItem, ref: SourceReference): Route | undefined {
  if (!intelligenceItemAvailable(data, sessionId, value) || !value.sources.some(source => JSON.stringify(source) === JSON.stringify(ref))) return undefined;
  if (ref.kind === 'session') { const turn = sourceTurn(data, { sourceSession: ref.id, sourceId: ref.sourceId, sourceTime: ref.sourceTime }); return turn ? { view: 'session-transcript', id: ref.id, mode: turn.id } : undefined; }
  if (ref.kind === 'memory') return { view: 'memory-detail', id: ref.id };
  if (ref.kind === 'project') return { view: 'memory-project', id: ref.id };
  if (ref.kind === 'task') return { view: 'task-detail', id: ref.id };
  return { view: 'settings-preferences' };
}

export function intelligenceActionRoute(data: AppData, sessionId: string, value: IntelligenceItem): Route | undefined {
  if (!intelligenceItemAvailable(data, sessionId, value) || !value.action) return undefined;
  if (value.action.view.startsWith('task-') && !data.tasks.some(task => task.id === value.action?.id && taskVisible(data, task) && taskSourceAvailable(data, task))) return { view: 'session-detail', id: sessionId, mode: '行动' };
  return value.action;
}
