import type { AppData, Memory, Session, Transcript } from './store';
import { invalidateSessionSources } from './sourceAccess';

export type SessionReviewItem = { id: string; kind: 'conclusion' | 'question'; text: string; confirmed: boolean; shared: boolean; sourceId?: string };
export type ReviewSourceMode = 'preserve' | 'clear' | 'selected';
export type ReviewDraft = { conclusions: string; questions: string; sourceId: string; sourceMode?: ReviewSourceMode };
export type SessionActionDraft = { title: string; body: string; due: string; sourceId: string; another: boolean };

/** Every entry point must revoke the same downstream execution and sharing scope. */
export function setSessionShared(data: AppData, sessionId: string, shared: boolean): AppData {
  const session = data.sessions.find(item => item.id === sessionId);
  if (!session) return data;
  const base = !shared && data.settings.toggles[`shared-${sessionId}`]
    ? invalidateSessionSources(data, sessionId, undefined, '会话共享已撤回') : data;
  const toggles = { ...base.settings.toggles, [`shared-${sessionId}`]: shared };
  const retention = { ...base.settings.retention };
  if (!shared) {
    session.attachments.forEach(title => { toggles[`material-shared:${sessionId}:${title}`] = false; });
    retention[`session-materials:${sessionId}`] = '[]';
    try {
      const items: unknown = JSON.parse(retention[`session-review-items:${sessionId}`] || '[]');
      if (Array.isArray(items)) retention[`session-review-items:${sessionId}`] = JSON.stringify(items.map(item => item && typeof item === 'object' ? { ...item, shared: false } : item));
    } catch { retention[`session-review-items:${sessionId}`] = '[]'; }
  }
  return { ...base, settings: { ...base.settings, toggles, retention } };
}

export function sessionNeedsReview(data: AppData, session: Session, pendingCount: number): boolean {
  return session.status === '已结束' && (pendingCount > 0 || data.settings.toggles[`review-${session.id}`] === true || !data.settings.retention[`session-review-completed:${session.id}`] && !data.settings.retention[`session-reviewed:${session.id}`]);
}

export function finishSessionReviewRound(data: AppData, sessionId: string, pendingCount: number, endedAt: string): AppData {
  const retention = { ...data.settings.retention, [`session-review-round-ended:${sessionId}`]: endedAt };
  if (pendingCount > 0) delete retention[`session-review-completed:${sessionId}`];
  else retention[`session-review-completed:${sessionId}`] = endedAt;
  return { ...data, settings: { ...data.settings, retention } };
}

export function reviewDraftSourceMode(draft: ReviewDraft): ReviewSourceMode {
  return draft.sourceMode || (draft.sourceId ? 'selected' : 'preserve');
}

export function buildReviewItems(session: Session, previous: SessionReviewItem[], draft: ReviewDraft, makeId: (kind: SessionReviewItem['kind'], index: number) => string) {
  const conclusions = draft.conclusions.split('\n').map(text => text.trim()).filter(Boolean);
  const questions = draft.questions.split('\n').map(text => text.trim()).filter(Boolean);
  const mode = reviewDraftSourceMode(draft);
  if (!conclusions.length && !questions.length) return { error: '写下一条结论或一个未决问题' };
  if (mode === 'selected' && !session.transcript.some(turn => turn.id === draft.sourceId)) return { error: '所选来源已变化，请重新选择或改为人工整理' };
  const make = (text: string, kind: SessionReviewItem['kind'], index: number): SessionReviewItem => {
    // Reordering or rewriting a line cannot inherit another line's citation.
    const matches = previous.filter(item => item.kind === kind && item.text.trim() === text);
    const sourceId = mode === 'selected' ? draft.sourceId : mode === 'preserve' && matches.length === 1 ? matches[0].sourceId : undefined;
    return { id: makeId(kind, index), kind, text, confirmed: true, shared: false, ...(sourceId !== undefined ? { sourceId } : {}) };
  };
  const items = [...conclusions.map((text, index) => make(text, 'conclusion', index)), ...questions.map((text, index) => make(text, 'question', index))];
  if (items.some(item => item.sourceId !== undefined && !session.transcript.some(turn => turn.id === item.sourceId))) return { error: '旧引用已移除，请选择当前原话或明确改为人工整理' };
  return { items, conclusions, questions };
}

export function openActionDraft(previous: SessionActionDraft, source?: Transcript, reset = false): SessionActionDraft {
  if (!reset && (previous.title.trim() || previous.body.trim() || previous.due || previous.sourceId)) return previous;
  return { title: source?.text.slice(0, 28) || '', body: source?.text || '', due: '', sourceId: source?.id || '', another: reset && !!source };
}

/** New histories are structured; this fallback reads the complete old multiline body. */
export function readRevisionOriginal(memory: Memory, session: Session, fallbackId: string): Transcript | undefined {
  if (memory.revision) return { ...memory.revision.original };
  const match = memory.body.match(/^原文：([\s\S]*?)\n(?:修订：|本次：片段已删除(?:\n|$))/);
  if (!match || !match[1].trim()) return undefined;
  const declared = memory.sourceId !== undefined ? memory.sourceId : memory.tags.find(tag => session.transcript.some(turn => turn.id === tag));
  const timed = memory.sourceTime ? session.transcript.filter(turn => turn.time === memory.sourceTime) : [];
  const existing = declared !== undefined ? session.transcript.find(turn => turn.id === declared) : timed.length === 1 ? timed[0] : undefined;
  const id = existing?.id || declared || fallbackId;
  return { id, text: match[1], speaker: memory.body.match(/^原说话人：(.*)$/m)?.[1] || '匿名', time: memory.sourceTime || '', private: memory.body.match(/^原敏感：(true|false)$/m)?.[1] === 'true' };
}

export function restoreSessionRevision(data: AppData, sessionId: string, memoryId: string, fallbackId: string): { data: AppData; turnId?: string; error?: string } {
  const session = data.sessions.find(item => item.id === sessionId);
  const memory = data.memories.find(item => item.id === memoryId && item.sourceSession === sessionId && item.tags.includes('修订历史') && !item.deleted);
  if (!session || !memory) return { data, error: '这条历史已经移除，请返回当前记录' };
  const original = readRevisionOriginal(memory, session, fallbackId);
  if (!original?.id || !original.text.trim()) return { data, error: '这条旧历史无法完整读取，请先核对原文' };
  const existing = session.transcript.find(turn => turn.id === original.id);
  const invalidated = invalidateSessionSources(data, sessionId, [original.id], '原话历史版本恢复，原成果仍需复核');
  const transcript = existing ? session.transcript.map(turn => turn.id === original.id ? { ...turn, text: original.text } : turn) : [...session.transcript, { ...original, private: true }];
  return { data: { ...invalidated, sessions: invalidated.sessions.map(item => item.id === sessionId ? { ...item, transcript } : item) }, turnId: original.id };
}
