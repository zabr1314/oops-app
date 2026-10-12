import type { AppData, Route, Session, Transcript } from './store';
import { PERSONAL_SPACE, sessionVisible, sourceAvailable, taskVisible } from './sourceAccess';
import { readSessionIntelligence, refreshSessionIntelligence, type IntelligenceItem } from './sessionIntelligenceLogic';
import { readTaskSuggestions, refreshTaskSuggestions, type TaskSuggestion } from './taskSuggestionsLogic';

export type SessionChapter = { id: string; topic: string; state: '已讨论' | '当前' | '待讨论' | '其他'; turns: Transcript[] };
export type SessionFinding = { id: string; kind: '决定' | '行动' | '提醒'; text: string; route: Route };
export type SessionCheck = { label: string; count: number; route: Route };
export type SessionChapterPoint = { id: string; label: string; text: string; sourceId: string; sourceTime: string; route: Route };

/** Uses the prototype's existing local extraction, without confirming, executing or sharing its candidates. */
export function prepareSessionCandidates(data: AppData, sessionId: string): AppData {
  if (data.settings.space !== PERSONAL_SPACE || !sessionVisible(data, sessionId)) return data;
  return refreshSessionIntelligence(refreshTaskSuggestions(data, sessionId), sessionId);
}

const keywords = (topic: string) => [...new Set([...(topic.match(/[A-Za-z][A-Za-z0-9-]+/g) || []).map(word => word.toLowerCase()), ...(topic.match(/[一-鿿]+/g) || []).flatMap(word => Array.from({ length: Math.max(0, word.length - 1) }, (_, index) => word.slice(index, index + 2)))])].filter(word => !['讨论', '关于', '确认', '安排', '议题', '我们', '今天', '进行'].includes(word));

/** Chapters are a navigation aid, not a claim that a topic or its decisions have been completed. */
export function sessionChapters(data: AppData, session: Session, shared = false): SessionChapter[] {
  if (!sessionVisible(data, session.id)) return [];
  const turns = session.transcript.filter(turn => !shared || !turn.private);
  const raw = Number(data.settings.retention[`agenda-${session.id}`]);
  const index = Number.isFinite(raw) ? Math.max(0, Math.min(session.agenda.length - 1, Math.floor(raw))) : 0;
  if (!session.agenda.length) return turns.length ? [{ id: 'conversation', topic: session.kind === '灵感' ? '这次的想法' : session.kind === '练习' ? '这段表达' : '本次记录', state: '当前', turns }] : [];
  const chapters: SessionChapter[] = session.agenda.map((topic, position) => ({ id: `agenda-${position}`, topic, state: position < index ? '已讨论' : position === index ? '当前' : '待讨论', turns: [] }));
  const other: SessionChapter = { id: 'other', topic: '其他讨论', state: '其他', turns: [] };
  for (const turn of turns) {
    const scores = session.agenda.map(topic => keywords(topic).filter(word => turn.text.toLowerCase().includes(word)).length);
    const score = Math.max(...scores);
    (score > 0 ? chapters[scores.indexOf(score)] : other).turns.push(turn);
  }
  return [...chapters, ...(other.turns.length ? [other] : [])];
}

const normalizedExcerpt = (text: string) => text.replace(/\s+/g, '').trim();

/** Legacy summaries have no provenance. Only an exact current quote can select an excerpt. */
function summaryMatchesTurn(summary: string, turn: Transcript): boolean {
  const text = summary.trim().replace(/^原话摘录\s*·\s*/, '');
  const quote = normalizedExcerpt(turn.text);
  if (!quote) return false;
  const labels = [`${turn.speaker}：`, `${turn.speaker}:`, ...(turn.time ? [`${turn.time} ${turn.speaker}：`, `${turn.time} ${turn.speaker}:`] : [])];
  return normalizedExcerpt(text) === quote || labels.some(label => text.startsWith(label) && normalizedExcerpt(text.slice(label.length)) === quote);
}

function chapterExcerpts(data: AppData, session: Session, chapter: SessionChapter, personal: boolean, excluded = new Set<string>()): SessionChapterPoint[] {
  const turns = chapter.turns.filter(turn => !excluded.has(turn.id) && turn.text.trim() && !turn.private && sourceAvailable(data, { sourceSession: session.id, sourceId: turn.id }, { publicOnly: true }));
  // Private legacy summaries must not influence the shared view, even when their quotes are public.
  const selected = personal ? turns.filter(turn => session.summary.some(summary => summaryMatchesTurn(summary, turn))) : [];
  const excerpts = [...selected, ...turns.slice(-2)].filter((turn, index, all) => all.findIndex(value => value.id === turn.id) === index).slice(0, 2);
  return excerpts.map(turn => ({ id: `excerpt:${turn.id}`, label: '原话摘录', text: turn.text.length > 180 ? `${turn.text.slice(0, 180)}…` : turn.text, sourceId: turn.id, sourceTime: turn.time, route: { view: 'session-transcript', id: session.id, mode: turn.id } }));
}

function chapterHighlights(data: AppData, session: Session, chapter: SessionChapter, decisions: IntelligenceItem[], actions: TaskSuggestion[], personal: boolean): SessionChapterPoint[] {
  const turns = chapter.turns.filter(turn => turn.text.trim() && !turn.private && sourceAvailable(data, { sourceSession: session.id, sourceId: turn.id }, { publicOnly: true }));
  const byId = new Map(turns.map(turn => [turn.id, turn]));
  const point = (id: string, label: string, text: string, turn: Transcript): SessionChapterPoint => ({ id, label, text, sourceId: turn.id, sourceTime: turn.time, route: { view: 'session-transcript', id: session.id, mode: turn.id } });
  const candidates: SessionChapterPoint[] = [];
  for (const value of decisions) {
    const ref = value.sources.find(source => source.kind === 'session' && source.id === session.id && source.sourceId && byId.has(source.sourceId));
    const turn = ref?.sourceId ? byId.get(ref.sourceId) : undefined;
    if (turn) candidates.push(point(value.id, value.state === 'accepted' ? '已确认结论' : '结论候选', value.text, turn));
  }
  for (const value of actions) {
    const turn = byId.get(value.sourceId);
    if (turn) candidates.push(point(value.id, '行动草稿', value.title, turn));
  }
  if (candidates.length) return candidates.slice(0, 2);
  // Plain facts and ideas are still useful. Quote current evidence instead of inventing a summary.
  return chapterExcerpts(data, session, chapter, personal);
}

/** An ephemeral preview lets the list show candidates before opening a separate analysis page. */
export function readSessionPresentation(data: AppData, session: Session, shared = false) {
  // A screen may still hold its previous object after an edit; derive from the current store.
  session = data.sessions.find(value => value.id === session.id) || session;
  const allowed = sessionVisible(data, session.id);
  const personal = allowed && !shared && data.settings.space === PERSONAL_SPACE;
  const prepared = personal ? prepareSessionCandidates(data, session.id) : data;
  const understanding = personal ? readSessionIntelligence(prepared, session.id, 'understanding').items : [];
  const decisions: IntelligenceItem[] = personal ? readSessionIntelligence(prepared, session.id, 'decisions').items.filter(value => value.state !== 'rejected') : [];
  const notices = personal ? readSessionIntelligence(prepared, session.id, 'notices').items.filter(value => value.state === 'pending') : [];
  const actions: TaskSuggestion[] = personal ? readTaskSuggestions(prepared, session.id).items.filter(value => value.state === 'pending') : [];
  const chapters = allowed ? sessionChapters(data, session, shared || !personal) : [];
  const topic = understanding.find(value => value.kind === 'topic')?.text || chapters.find(value => value.state === '当前')?.topic || (allowed ? session.title : '');
  const decisionPending = decisions.filter(value => value.state === 'pending');
  const tasks = personal ? data.tasks.filter(task => (task.sourceSession === session.id || task.relatedSessionId === session.id) && taskVisible(data, task)) : [];
  const identities = personal ? [...new Set(session.transcript.filter(turn => /待确认|说话人|未知/.test(turn.speaker)).map(turn => turn.speaker))].length : 0;
  const memories = personal ? data.memories.filter(memory => !memory.deleted && !memory.confirmed && memory.sourceSession === session.id && !memory.tags.includes('修订历史')).length : 0;
  const checks: SessionCheck[] = personal ? [
    { label: '行动草稿', count: actions.length, route: { view: 'session-task-suggestions', id: session.id } },
    { label: '决定候选', count: decisionPending.length, route: { view: 'session-decisions', id: session.id } },
    { label: '提醒', count: notices.length, route: { view: 'session-notices', id: session.id } },
    { label: '来源', count: Number(data.settings.toggles[`review-${session.id}`] === true), route: { view: 'session-review-edit', id: session.id } },
    { label: '身份', count: identities, route: { view: 'session-identity', id: session.id } },
    { label: '已有任务', count: tasks.filter(task => task.status === '待承接' || task.needsReview || task.sourceNeedsReview).length, route: { view: 'session-detail', id: session.id, mode: '行动' } },
    { label: '记忆', count: memories, route: { view: 'session-review', id: session.id } },
  ].filter(value => value.count > 0) : [];
  const findings: SessionFinding[] = [
    ...(notices.length ? [{ id: notices[0].id, kind: '提醒' as const, text: notices[0].title, route: { view: 'session-notices', id: session.id, mode: notices[0].id } }] : []),
    ...(decisionPending.length ? [{ id: decisionPending[0].id, kind: '决定' as const, text: decisionPending[0].text, route: { view: 'session-decisions', id: session.id, mode: decisionPending[0].id } }] : []),
    ...(actions.length ? [{ id: actions[0].id, kind: '行动' as const, text: actions[0].title, route: { view: 'session-task-suggestions', id: session.id, mode: actions[0].id } }] : []),
  ];
  const chapterPoints = Object.fromEntries(chapters.map(chapter => [chapter.id, chapterHighlights(data, session, chapter, decisions, actions, personal)]));
  // Overview also surfaces ordinary discussion when a nearby task or decision already has its own card.
  const candidateSourceIds = new Set([...decisions.flatMap(value => value.sources.filter(ref => ref.kind === 'session' && ref.id === session.id && ref.sourceId).map(ref => ref.sourceId!)), ...actions.map(value => value.sourceId)]);
  const excerptsByChapter = chapters.map(chapter => chapterExcerpts(data, session, chapter, personal, candidateSourceIds));
  const excerptPoints = [...excerptsByChapter.flatMap(points => points.slice(0, 1)), ...excerptsByChapter.flatMap(points => points.slice(1))].slice(0, 2);
  const currentChapter = chapters.find(chapter => chapter.state === '当前');
  return { topic, chapters, chapterPoints, excerptPoints, topicPoints: currentChapter ? chapterPoints[currentChapter.id] || [] : [], understanding, decisions, notices, actions, checks, findings, pendingCount: checks.reduce((count, value) => count + value.count, 0) };
}
