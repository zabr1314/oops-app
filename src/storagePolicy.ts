import type { AppData, Session, SessionStorage, Transcript } from './store';
import { invalidateSessionSources, makeSourceReference } from './sourceAccess';
import { reconcilePersonalAssistantState } from './personalAssistant';

export const DAILY_WINDOW_MS = 300000;
const DAY_MS = 86400000;
export const retentionDays = (value: unknown): 7|30|90 => value === 7 || value === '7' ? 7 : value === 90 || value === '90' ? 90 : 30;
export function newStoragePolicy(data: AppData, mode: 'daily'|'meeting', confirmed = false, now = Date.now()): SessionStorage {
  return { version: 1, mode, cloudSaveConfirmed: mode === 'meeting' && confirmed,
    audioRetentionDays: retentionDays(data.settings.retention['meeting-audio-days']),
    transcriptRetentionDays: retentionDays(data.settings.retention['meeting-transcript-days']), archiveStartedAt: now,
    audioState: mode === 'daily' ? 'temporary' : 'available', transcriptState: mode === 'daily' ? 'temporary' : 'available' };
}
export const isTemporaryDaily = (session: Session) => session.storage?.mode === 'daily';
export const sessionEvidence = (session: Session) => session.savedEvidence || [];
export function availableSessionTurns(session: Session): Transcript[] {
  const ids = new Set(session.transcript.map(t => t.id));
  return [...session.transcript, ...sessionEvidence(session).filter(t => !ids.has(t.id))];
}

/** A deliberately saved quote is independent of the temporary/full transcript. */
export function pinSessionEvidence(data: AppData, sessionId: string, turn: Transcript): { data: AppData; source: Transcript } {
  const source: Transcript = { ...turn, id: turn.id.startsWith('evidence-') ? turn.id : 'evidence-' + turn.id,
    text: turn.text.slice(0, 140), receivedAt: undefined };
  return { source, data: { ...data, sessions: data.sessions.map(s => s.id === sessionId ? { ...s,
    savedEvidence: [...sessionEvidence(s).filter(t => t.id !== source.id), source] } : s) } };
}

function clearSessionMirrors(data: AppData, id: string): AppData {
  const retention = { ...data.settings.retention };
  // These derived caches can contain full turns, old revisions or query context.
  const independent = ['session-space:', 'record-end:', 'session-review-items:', 'session-conclusions:', 'session-questions:', 'session-reviewed:', 'sample-index:', 'device-startup-owner:'];
  const exactId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const owns = new RegExp(`(?:^|:|-)${exactId}(?=:|$)`);
  for (const key of Object.keys(retention)) if (owns.test(key) && !independent.some(prefix => key.startsWith(prefix))) delete retention[key];
  const toggles = { ...data.settings.toggles, ['shared-' + id]: false };
  return { ...data, memories: data.memories.map(m => m.sourceSession === id && (m.revision || m.tags.includes('修订历史')) ? {
    ...m, body: '完整原文已按保存策略清除，仅保留修订发生的记录。', revision: undefined, needsReview: true,
  } : m), messages: data.messages.filter(m => m.sourceSession !== id && !m.sources?.some(r => r.kind === 'session' && r.id === id)),
    settings: { ...data.settings, retention, toggles } };
}

/** Daily full text never survives stop/reload; only private, bounded candidates do. */
export function finishDailySession(data: AppData, id: string, notes: string[] = [], now = Date.now()): AppData {
  data = applyStorageDeadlines(data, now);
  const original = data.sessions.find(s => s.id === id);
  if (!original || !isTemporaryDaily(original) || original.status === '已结束') return data;
  let next = data;
  if (data.settings.toggles.memory !== false) {
    for (const turn of original.transcript.filter(t => !t.id.startsWith('evidence-')).slice(-3)) {
      const memoryId = `MEM-daily-${id}-${turn.id}`;
      if (next.memories.some(m => m.id === memoryId)) continue;
      const pinned = pinSessionEvidence(next, id, turn); next = pinned.data;
      next = { ...next, memories: [...next.memories, { id: memoryId, title: `日常重点 · ${turn.text.slice(0, 18)}`,
        body: turn.text.slice(0, 140), category: '记忆', tags: ['待确认', '日常候选'], visibility: '私有', confirmed: false,
        updated: new Date(now).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }), sourceSession: id,
        sourceId: pinned.source.id, sourceTime: pinned.source.time }] };
    }
  }
  const evidence = sessionEvidence(next.sessions.find(s => s.id === id)!);
  const removed = original.transcript.filter(t => !evidence.some(e => e.id === t.id)).map(t => t.id);
  if (removed.length) next = invalidateSessionSources(next, id, removed, '日常临时全文已清除，仅保留独立短证据', true);
  next = clearSessionMirrors(next, id);
  return { ...next, activeSessionId: next.activeSessionId === id ? undefined : next.activeSessionId,
    sessions: next.sessions.map(s => s.id === id ? { ...s, status: '已结束', transcript: evidence,
      summary: [], privateNotes: notes, storage: { ...s.storage!, audioState: 'cleared', transcriptState: 'cleared' } } : s) };
}

/** Only explicitly versioned new policies expire. Legacy meetings remain untouched. */
export function applyStorageDeadlines(data: AppData, now = Date.now()): AppData {
  let next = data;
  for (const original of data.sessions) {
    const policy = original.storage;
    if (!policy || policy.version !== 1) continue;
    let session = next.sessions.find(s => s.id === original.id)!;
    if (policy.mode === 'daily') {
      if (session.status === '已结束') continue;
      const elapsed = session.duration.split(':').reduce((sum, part) => sum * 60 + Number(part || 0), 0);
      const transcript = session.transcript.filter(t => {
        if (t.id.startsWith('evidence-')) return true;
        const at = t.receivedAt ?? policy.archiveStartedAt + t.time.split(':').reduce((sum, part) => sum * 60 + Number(part || 0), 0) * 1000;
        return now - at < DAILY_WINDOW_MS && elapsed - t.time.split(':').reduce((sum, part) => sum * 60 + Number(part || 0), 0) < 300;
      });
      const removed = session.transcript.filter(t => !transcript.includes(t)).map(t => t.id);
      if (removed.length) {
        next = invalidateSessionSources(next, session.id, removed, '日常五分钟缓冲已到期', true);
        next = clearSessionMirrors(next, session.id);
        next = { ...next, sessions: next.sessions.map(s => s.id === session.id ? { ...s, transcript } : s) };
      }
      continue;
    }
    const audioExpired = now >= policy.archiveStartedAt + policy.audioRetentionDays * DAY_MS;
    const textExpired = now >= policy.archiveStartedAt + policy.transcriptRetentionDays * DAY_MS;
    if ((!audioExpired || policy.audioState === 'expired') && (!textExpired || policy.transcriptState === 'expired')) continue;
    if (textExpired && session.storage?.transcriptState !== 'expired') {
      const evidence = sessionEvidence(session);
      const removed = session.transcript.filter(t => !evidence.some(e => e.id === t.id)).map(t => t.id);
      if (removed.length) next = invalidateSessionSources(next, session.id, removed, '会议全文到期，短证据独立保留', true);
      next = clearSessionMirrors(next, session.id);
    }
    session = next.sessions.find(s => s.id === original.id)!;
    next = { ...next, sessions: next.sessions.map(s => s.id === session.id ? { ...s,
      transcript: textExpired ? sessionEvidence(s) : s.transcript,
      summary: textExpired ? s.summary.filter(text => !text.startsWith('原话摘录 ·')) : s.summary,
      storage: { ...s.storage!, audioState: audioExpired ? 'expired' : s.storage!.audioState,
        transcriptState: textExpired ? 'expired' : s.storage!.transcriptState } } : s) };
  }
  return pruneDeletedArchives(next, now);
}

/** A recycle-bin copy follows the same policy; restoring cannot reset its clock. */
function pruneDeletedArchives(data: AppData, now: number): AppData {
  let next = data;
  for (const [key, value] of Object.entries(data.settings.retention)) {
    if (!key.startsWith('deleted-session:')) continue;
    try {
      const deleted = JSON.parse(value) as Session;
      if (!deleted.storage || !Array.isArray(deleted.transcript)) continue;
      const isolated: AppData = { ...data, sessions: [deleted], activeSessionId: undefined,
        tasks: [], memories: [], messages: [], settings: { ...data.settings, retention: {} } };
      const clean = deleted.storage.mode === 'daily' ? archiveSafeData(isolated, now) : applyStorageDeadlines(isolated, now);
      const serialized = JSON.stringify(clean.sessions[0]);
      if (serialized !== value) next = { ...next, settings: { ...next.settings, retention: { ...next.settings.retention, [key]: serialized } } };
    } catch { /* An unrelated malformed legacy recycle item is not rewritten. */ }
  }
  return next;
}

/** Editing/deleting a retained quote also updates its independent evidence copy. */
export function reconcileSavedEvidence(previous: AppData, next: AppData): AppData {
  return { ...next, sessions: next.sessions.map(session => {
    const old = previous.sessions.find(s => s.id === session.id);
    if (!old?.savedEvidence?.length || old.transcript === session.transcript) return session;
    const rawIds = new Set(old.transcript.map(t => t.id));
    return { ...session, savedEvidence: sessionEvidence(session).flatMap(evidence => {
      if (!rawIds.has(evidence.id)) return [evidence];
      const current = session.transcript.find(t => t.id === evidence.id);
      return current ? [{ ...current, text: current.text.slice(0, 140) }] : [];
    }) };
  }) };
}

/** User-confirmed memory and explicitly created tasks retain only their selected quote. */
export function pinExplicitDerivations(previous: AppData, next: AppData): AppData {
  let result = next;
  function pin(pointer: { sourceSession?: string; sourceId?: string; sourceTime?: string }) {
    const session = result.sessions.find(s => s.id === pointer.sourceSession);
    if (!session?.storage || pointer.sourceId?.startsWith('evidence-')) return undefined;
    const turn = pointer.sourceId ? session.transcript.find(t => t.id === pointer.sourceId) : session.transcript.find(t => t.time === pointer.sourceTime);
    if (!turn) return undefined;
    const pinned = pinSessionEvidence(result, session.id, turn); result = pinned.data;
    return { sourceSession: session.id, sourceId: pinned.source.id, sourceTime: pinned.source.time,
      sources: [makeSourceReference(result, { kind: 'session', id: session.id, sourceId: pinned.source.id, sourceTime: pinned.source.time })] };
  }
  const memories = result.memories.map(memory => {
    if (!memory.confirmed || memory.tags.includes('修订历史') || memory.tags.includes('资料') || previous.memories.find(m => m.id === memory.id)?.confirmed) return memory;
    const evidence = pin(memory); return evidence ? { ...memory, ...evidence, sources: [...(memory.sources || []).filter(ref => !(ref.kind === 'session' && ref.id === memory.sourceSession && ref.sourceId === memory.sourceId)), ...evidence.sources] } : memory;
  });
  const tasks = result.tasks.map(task => {
    if (previous.tasks.some(t => t.id === task.id)) return task;
    const evidence = pin(task); return evidence ? { ...task, ...evidence, sources: [...(task.sources || []).filter(ref => !(ref.kind === 'session' && ref.id === task.sourceSession && ref.sourceId === task.sourceId)), ...evidence.sources] } : task;
  });
  for (const [key, serialized] of Object.entries(result.settings.retention)) {
    if (!key.startsWith('session-review-items:') || previous.settings.retention[key] === serialized) continue;
    try {
      const id = key.slice('session-review-items:'.length);
      const items = JSON.parse(serialized) as { confirmed?: boolean; sourceId?: string; [key: string]: unknown }[];
      if (!Array.isArray(items)) continue;
      const retained = items.map(item => { const evidence = item.confirmed && item.sourceId ? pin({ sourceSession: id, sourceId: item.sourceId }) : undefined; return evidence ? { ...item, sourceId: evidence.sourceId } : item; });
      result = { ...result, settings: { ...result.settings, retention: { ...result.settings.retention, [key]: JSON.stringify(retained) } } };
    } catch { /* Invalid legacy review data is handled by the existing review editor. */ }
  }
  return { ...result, memories, tasks };
}

/** The public demo has no microphone; its temporary sample text is memory-only too. */
export function archiveSafeData(data: AppData, now = Date.now()): AppData {
  let safe = applyStorageDeadlines(data, now);
  for (const session of safe.sessions) if (isTemporaryDaily(session)) {
    const removed = session.transcript.filter(t => !sessionEvidence(session).some(e => e.id === t.id)).map(t => t.id);
    if (removed.length) safe = invalidateSessionSources(safe, session.id, removed, '临时记录不写入浏览器存档', true);
    safe = clearSessionMirrors(safe, session.id);
    safe = { ...safe, activeSessionId: safe.activeSessionId === session.id ? undefined : safe.activeSessionId,
      sessions: safe.sessions.map(s => s.id === session.id ? { ...s, status: '已结束', transcript: sessionEvidence(s), summary: [],
        storage: { ...s.storage!, audioState: 'cleared', transcriptState: 'cleared' } } : s) };
  }
  return reconcilePersonalAssistantState(safe);
}

export function switchDailyToMeeting(data: AppData, id: string, nextId: string, confirmed: boolean,
  includeBuffer: boolean, audioDays: unknown, transcriptDays: unknown, now = Date.now()): { data: AppData; error?: string } {
  const previous = data.sessions.find(s => s.id === id);
  if (!previous || !isTemporaryDaily(previous) || data.activeSessionId !== id || !['进行中', '暂停'].includes(previous.status)) return { data, error: '当前没有可切换的日常记录' };
  if (!confirmed) return { data, error: '请明确选择会议云端保存' };
  if (!nextId || data.sessions.some(s => s.id === nextId)) return { data, error: '这次切换已经处理，请返回当前记录' };
  data = applyStorageDeadlines(data, now);
  const buffer = data.sessions.find(s => s.id === id)!.transcript;
  const closed = finishDailySession(data, id, previous.privateNotes, now);
  const transcript = includeBuffer ? buffer.filter(t => !t.id.startsWith('evidence-')).map(t => ({ ...t, id: `${nextId}-buffer-${t.id}`, time: '00:00:00', receivedAt: now })) : [];
  const meeting: Session = { ...previous, id: nextId, kind: '会议', title: `会议 · ${previous.title}`, status: previous.status,
    duration: '00:00', transcript, savedEvidence: [], summary: [], attachments: [], privateNotes: [],
    storage: { ...newStoragePolicy(data, 'meeting', true, now), audioRetentionDays: retentionDays(audioDays), transcriptRetentionDays: retentionDays(transcriptDays) } };
  return { data: { ...closed, sessions: [meeting, ...closed.sessions], activeSessionId: nextId,
    settings: { ...closed.settings, space: '我的空间', toggles: { ...closed.settings.toggles, ['shared-' + nextId]: false },
      retention: { ...closed.settings.retention, ['session-' + nextId]: '完整保存', ['meeting-buffer-included:' + nextId]: String(includeBuffer) } } } };
}
