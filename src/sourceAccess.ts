import type { AppData, AssistantMessage, Memory, SourcePointer, SourceReference, Task, TaskArtifact, TaskMaterial, Transcript } from './store';
import { taskAttentionReason } from './taskAttention';

export const PERSONAL_SPACE = '我的空间';
const TEAM_SPACE = 'Oops 产品团队';
type SourceOptions = { publicOnly?: boolean; requireShared?: boolean; space?: string };
const reviewTags = ['待复核', '待确认', '修订历史'];

export function sessionVisible(data: AppData, id: string, space = data.settings.space): boolean {
  return data.sessions.some(s => s.id === id) && (space === PERSONAL_SPACE || data.settings.toggles['shared-' + id] === true && (data.settings.retention['session-space:' + id] || TEAM_SPACE) === space);
}

/** An explicitly declared ID must never silently resolve to a different turn. */
export function sourceTurn(data: AppData, pointer: SourcePointer): Transcript | undefined {
  const session = data.sessions.find(s => s.id === pointer.sourceSession);
  if (!session) return undefined;
  if (pointer.sourceId !== undefined) return pointer.sourceId ? session.transcript.find(t => t.id === pointer.sourceId) : undefined;
  const matches = pointer.sourceTime ? session.transcript.filter(t => t.time === pointer.sourceTime) : [];
  return matches.length === 1 ? matches[0] : undefined;
}

export function sourceAvailable(data: AppData, pointer: SourcePointer, options: SourceOptions = {}): boolean {
  if (!pointer.sourceSession) return pointer.sourceId === undefined && !pointer.sourceTime;
  const session = data.sessions.find(s => s.id === pointer.sourceSession);
  if (!session) return false;
  if (options.requireShared && !sessionVisible(data, session.id, options.space || data.settings.space)) return false;
  const turns = pointer.sourceId !== undefined
    ? session.transcript.filter(t => !!pointer.sourceId && t.id === pointer.sourceId)
    : pointer.sourceTime ? session.transcript.filter(t => t.time === pointer.sourceTime) : session.transcript;
  if (pointer.sourceId !== undefined && turns.length !== 1 || pointer.sourceId === undefined && pointer.sourceTime && turns.length !== 1) return false;
  // A legacy whole-session citation cannot prove it excluded a private passage.
  return !options.publicOnly || turns.length > 0 && turns.every(t => !t.private);
}

export function taskNeedsAttention(task: Task): boolean {
  return taskAttentionReason(task) !== null;
}

function visibleTask(data: AppData, task: Task, seen: Set<string>): boolean {
  if (data.settings.space === PERSONAL_SPACE) return true;
  if (seen.has('task:' + task.id)) return false;
  const next = new Set(seen).add('task:' + task.id);
  if (task.needsReview || task.sourceNeedsReview) return false;
  const scope = data.settings.retention['task-space:' + task.id];
  if (scope !== undefined && scope !== data.settings.space) return false;
  if (task.sourceSession) {
    if (!sourceAvailable(data, task, { publicOnly: true, requireShared: true })) return false;
  } else {
    if (task.sourceId !== undefined || task.sourceTime || scope !== data.settings.space) return false;
    if (task.relatedSessionId && !sessionVisible(data, task.relatedSessionId)) return false;
  }
  return (task.sources || []).every(ref => referenceAvailable(data, ref, next)) && materialReferencesAvailable(data, task, next);
}

export function taskVisible(data: AppData, task: Task): boolean { return visibleTask(data, task, new Set()); }

function fingerprint(value: unknown): string {
  const text = JSON.stringify(value); let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

export function selectedTaskMaterials(task: Task): TaskMaterial[] {
  const ids = task.scope?.materialIds;
  return ids === undefined ? task.materialRefs || [] : (task.materialRefs || []).filter(material => ids.includes(material.id));
}

export function generationConfigurationFingerprint(task: Task): string {
  const scope = task.scope;
  const mode = task.outputMode === '完整框架与PPT' ? '文档与PPT' : task.outputMode === '仅提纲' ? '文档' : task.outputMode;
  return fingerprint([task.title, task.description, task.owner, task.due, task.version, task.workKind, task.criteria, mode, task.sourceSession, task.sourceId, task.sourceTime, scope ? [scope.sources, scope.destination, scope.space, scope.materialIds === undefined ? null : [...scope.materialIds].sort(), scope.includeSource !== false] : null]);
}

export function generationMaterialFingerprint(materials: TaskMaterial[]): string {
  return fingerprint(materials.map(material => [material.id, material.title, material.body, material.note, material.memoryId, material.sourceSession, material.sourceId, material.sourceTime]));
}

function referenceFingerprint(data: AppData, ref: SourceReference): string | undefined {
  if (ref.kind === 'profile') return ref.id === 'my-profile' ? fingerprint([data.settings.name, data.settings.role, data.settings.retention.roleContext, data.settings.tone, data.settings.retention.answerLength, data.settings.retention.focus, ref.profileScope || 'identity']) : undefined;
  if (ref.kind === 'session') {
    const s = data.sessions.find(x => x.id === ref.id);
    if (!s) return undefined;
    const pointer = { sourceSession: ref.id, sourceId: ref.sourceId, sourceTime: ref.sourceTime };
    const turn = sourceTurn(data, pointer);
    return turn ? fingerprint([turn.id, turn.time, turn.speaker, turn.text, !!turn.private]) : ref.sourceId !== undefined || ref.sourceTime ? undefined : fingerprint([s.title, s.transcript]);
  }
  if (ref.kind === 'task') { const t = data.tasks.find(x => x.id === ref.id); return t ? fingerprint([t.title, t.description, t.status, t.aiStatus, t.version, t.results, t.needsReview, t.artifacts]) : undefined; }
  if (ref.kind === 'memory') { const m = data.memories.find(x => x.id === ref.id); return m ? fingerprint([m.title, m.body, m.confirmed, m.tags, m.sourceSession, m.sourceId, m.sourceTime]) : undefined; }
  const p = data.projects.find(x => x.id === ref.id); return p ? fingerprint([p.name, p.description, p.budget, p.rule]) : undefined;
}

export function makeSourceReference(data: AppData, ref: SourceReference): SourceReference {
  return { ...ref, fingerprint: referenceFingerprint(data, ref) };
}

function referenceAvailable(data: AppData, ref: SourceReference, seen: Set<string>): boolean {
  const personal = data.settings.space === PERSONAL_SPACE;
  if (ref.fingerprint !== undefined && ref.fingerprint !== referenceFingerprint(data, ref)) return false;
  if (ref.kind === 'profile') return ref.id === 'my-profile' && (personal || ref.profileScope !== 'preferences' && data.settings.toggles.publicIdentity === true);
  if (ref.kind === 'session') return sourceAvailable(data, { sourceSession: ref.id, ...(ref.sourceId !== undefined ? { sourceId: ref.sourceId } : {}), sourceTime: ref.sourceTime }, { publicOnly: !personal, requireShared: !personal });
  if (ref.kind === 'task') {
    const task = data.tasks.find(t => t.id === ref.id);
    return !!task && !task.sourceNeedsReview && (ref.version === undefined || ref.version === task.version) && (personal ? taskSourceAvailable(data, task, seen) : visibleTask(data, task, seen));
  }
  if (ref.kind === 'memory') {
    const memory = data.memories.find(m => m.id === ref.id);
    if (!memory || memory.deleted || !memory.confirmed || memory.needsReview || memory.tags.some(tag => reviewTags.includes(tag)) || seen.has('memory:' + ref.id)) return false;
    if (!personal && (memory.visibility !== '项目共享' || (data.settings.retention['memory-space:' + memory.id] || TEAM_SPACE) !== data.settings.space)) return false;
    if (!sourceAvailable(data, memory, { publicOnly: !personal, requireShared: !personal })) return false;
    if ((memory.tags.includes('资料') || memory.tags.includes('会中检索')) && memory.sourceSession && !data.sessions.find(s => s.id === memory.sourceSession)?.attachments.includes(memory.title)) return false;
    const next = new Set(seen).add('memory:' + ref.id);
    return (memory.sources || []).every(source => referenceAvailable(data, source, next));
  }
  return data.projects.some(p => p.id === ref.id && (personal || (data.settings.retention['project-space:' + p.id] || TEAM_SPACE) === data.settings.space));
}

export function provenanceAvailable(data: AppData, sources: SourceReference[] = []): boolean {
  return sources.every(ref => referenceAvailable(data, ref, new Set()));
}

export function taskSourceAvailable(data: AppData, task: Task, seen = new Set<string>(), selectedOnly = false): boolean {
  const publicOnly = data.settings.space !== PERSONAL_SPACE;
  if (task.sourceNeedsReview || !sourceAvailable(data, task, { publicOnly, requireShared: publicOnly })) return false;
  if (seen.has('task:' + task.id)) return false;
  const next = new Set(seen).add('task:' + task.id);
  if (!(task.sources || []).every(ref => referenceAvailable(data, ref, next))) return false;
  return materialReferencesAvailable(data, selectedOnly ? { ...task, materialRefs: selectedTaskMaterials(task) } : task, next);
}

function materialReferencesAvailable(data: AppData, task: Task, seen: Set<string>): boolean {
  const personal = data.settings.space === PERSONAL_SPACE;
  return (task.materialRefs || []).every(material => {
    if (material.needsReview) return false;
    if ((material.sourceId !== undefined || material.sourceTime) && !sourceAvailable(data, material, { publicOnly: !personal, requireShared: !personal })) return false;
    if (material.sourceSession && !materialVisible(data, material.sourceSession, material.title, seen)) return false;
    if (!material.memoryId) return true;
    const memory = data.memories.find(m => m.id === material.memoryId);
    return !!memory && memory.title === material.title && !memory.deleted && memory.confirmed && !memory.needsReview && !memory.tags.some(tag => reviewTags.includes(tag)) && referenceAvailable(data, { kind: 'memory', id: memory.id }, seen);
  });
}

export function generationCanComplete(data: AppData, task: Task & { scope?: { sources: string; destination: string }; generationSources?: SourceReference[] }, token: string): boolean {
  if (!token || task.generationToken !== token || task.aiStatus !== '准备中' || !task.authorized || !task.scope?.sources.trim() || !task.scope.destination.trim() || !['已承接', '进行中', '待验收'].includes(task.status)) return false;
  const ids = task.scope.materialIds;
  if (ids?.some(id => !task.materialRefs?.some(material => material.id === id))) return false;
  if (!taskSourceAvailable(data, task, new Set(), true) || !provenanceAvailable(data, task.generationSources)) return false;
  const snapshot = task.generationSnapshot;
  if (!snapshot) return true; // Old callers can validate source availability; completion still requires a snapshot.
  return snapshot.token === token && snapshot.version === task.version && snapshot.fingerprint === generationConfigurationFingerprint(task) && snapshot.materialFingerprint === generationMaterialFingerprint(selectedTaskMaterials(task)) && Number.isFinite(snapshot.cost) && snapshot.cost > 0 && (task.budget ?? 40) - (task.used ?? 0) >= snapshot.cost && provenanceAvailable(data, snapshot.sourceRefs);
}

export function messageAvailable(data: AppData, message: AssistantMessage): boolean {
  if (message.invalidated) return false;
  if (!provenanceAvailable(data, message.sources)) return false;
  if (!message.sources?.length && message.sourceSession) return sourceAvailable(data, { sourceSession: message.sourceSession }, { publicOnly: data.settings.space !== PERSONAL_SPACE, requireShared: data.settings.space !== PERSONAL_SPACE });
  // Legacy team answers without provenance cannot be certified as still readable.
  return data.settings.space === PERSONAL_SPACE || message.role === 'user' || !!message.sources;
}

export function materialVisible(data: AppData, sessionId: string, title: string, seen = new Set<string>()): boolean {
  const session = data.sessions.find(s => s.id === sessionId);
  if (!session?.attachments.includes(title) || !sessionVisible(data, sessionId)) return false;
  if (data.settings.space === PERSONAL_SPACE) return true;
  if (!data.settings.toggles[`material-shared:${sessionId}:${title}`] || (data.settings.retention[`material-space:${sessionId}:${title}`] || data.settings.retention['session-space:' + sessionId] || TEAM_SPACE) !== data.settings.space) return false;
  const memories = data.memories.filter(m => m.sourceSession === sessionId && m.title === title);
  return memories.every(m => !m.deleted && m.confirmed && !m.needsReview && !m.tags.some(tag => reviewTags.includes(tag)) && m.visibility === '项目共享' && sourceAvailable(data, m, { publicOnly: true, requireShared: true }) && referenceAvailable(data, { kind: 'memory', id: m.id }, seen));
}

export function findSourceTask(data: AppData, pointer: SourcePointer): Task | undefined {
  if (!pointer.sourceSession || pointer.sourceId === undefined && !pointer.sourceTime) return undefined;
  const turn = sourceTurn(data, pointer);
  if (!turn) return undefined;
  return data.tasks.find(t => !['已拒绝', '已取消'].includes(t.status) && t.sourceSession === pointer.sourceSession && (t.sourceId !== undefined ? t.sourceId === turn.id : !!sourceTurn(data, t) && t.sourceTime === turn.time));
}

/** Invalidate derivations only; callers own the actual edit/delete/share mutation. */
export function invalidateSessionSources(data: AppData, sessionId: string, sourceIds?: string[], reason = '来源已变化'): AppData {
  const ids = sourceIds === undefined ? undefined : new Set(sourceIds);
  if (ids?.size === 0) return data;
  const session = data.sessions.find(s => s.id === sessionId);
  const affectedTimes = new Set(session?.transcript.filter(t => ids?.has(t.id)).map(t => t.time));
  const missingIds = !!ids && [...ids].some(id => !session?.transcript.some(t => t.id === id));
  function affected(pointer: SourcePointer): boolean {
    if (pointer.sourceSession !== sessionId) return false;
    if (!ids) return true;
    if (pointer.sourceId !== undefined) return !!pointer.sourceId && ids.has(pointer.sourceId);
    if (pointer.sourceTime) return affectedTimes.has(pointer.sourceTime) || missingIds && !session?.transcript.some(t => t.time === pointer.sourceTime);
    return true;
  }
  const taskIds = new Set<string>(), memoryIds = new Set<string>();
  const fromReferences = (refs?: SourceReference[]) => (refs || []).some(ref => ref.kind === 'session' ? affected({ sourceSession: ref.id, sourceId: ref.sourceId, sourceTime: ref.sourceTime }) : ref.kind === 'task' ? taskIds.has(ref.id) : ref.kind === 'memory' && memoryIds.has(ref.id));
  const artifactAffected = (artifact: TaskArtifact, task: Task) => affected({ sourceSession: artifact.sourceSession || task.sourceSession, ...(artifact.sourceId !== undefined ? { sourceId: artifact.sourceId } : task.sourceId !== undefined ? { sourceId: task.sourceId } : {}), sourceTime: artifact.sourceTime || task.sourceTime }) || fromReferences(artifact.sources);
  const retainedArtifacts = (task: Task): TaskArtifact[] | undefined => task.artifacts?.length ? task.artifacts : task.results.length ? [{ id: `seed-${task.id}`, kind: task.id === 'TASK-032' ? '资料' : '文档', title: task.id === 'TASK-032' ? '蓝色椅子库存摘录' : `${task.title} · 已有内容`, version: task.version, body: [...task.results], created: '已有成果', sourceSession: task.sourceSession, sourceId: task.sourceId, sourceTime: task.sourceTime, sources: task.sources }] : task.artifacts;
  let changed = true;
  while (changed) {
    changed = false;
    data.memories.forEach(memory => { if (!memoryIds.has(memory.id) && (affected(memory) || fromReferences(memory.sources))) { memoryIds.add(memory.id); changed = true; } });
    data.tasks.forEach(task => {
      if (!taskIds.has(task.id) && (affected(task) || fromReferences(task.sources) || !!task.sourceMemoryId && memoryIds.has(task.sourceMemoryId) || task.materialRefs?.some(material => affected(material) || !!material.memoryId && memoryIds.has(material.memoryId)) || task.artifacts?.some(artifact => artifactAffected(artifact, task)))) { taskIds.add(task.id); changed = true; }
    });
  }
  const retention = { ...data.settings.retention, ['session-review-invalidated:' + sessionId]: reason };
  delete retention['session-reviewed:' + sessionId];
  taskIds.forEach(id => { retention['task-space:' + id] = PERSONAL_SPACE; });
  const activitiesAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return { ...data,
    tasks: data.tasks.map(task => taskIds.has(task.id) ? { ...task, authorized: false, generationToken: undefined, generationSnapshot: undefined, generationSources: undefined, sourceNeedsReview: true, needsReview: true, version: task.version + 1, aiStatus: task.aiStatus === '未启动' ? '未启动' : '待授权', artifacts: retainedArtifacts(task)?.map(a => affected(task) || fromReferences(task.sources) || artifactAffected(a, task) || !task.artifacts?.length ? { ...a, needsReview: true, sourceNeedsReview: true, reviewHistory: a.reviewedAt ? [...(a.reviewHistory || []), { version: a.version, reviewedAt: a.reviewedAt }] : a.reviewHistory, reviewedAt: undefined } : a), materialRefs: task.materialRefs?.map(m => affected(m) || !!m.memoryId && memoryIds.has(m.memoryId) ? { ...m, needsReview: true } : m), activities: [...task.activities, `${activitiesAt} · ${reason}；旧成果保留待复核，助手授权撤回`] } : task),
    memories: data.memories.map(memory => memoryIds.has(memory.id) ? { ...memory, confirmed: false, needsReview: true, visibility: '私有', tags: [...new Set([...memory.tags, '待复核'])] } : memory),
    messages: data.messages.map(message => message.role === 'assistant' && (message.sourceSession === sessionId && !message.sources?.length || fromReferences(message.sources)) ? { ...message, invalidated: true, text: '这条回答的来源已变化，请重新核对后提问。' } : message),
    settings: { ...data.settings, retention, toggles: { ...data.settings.toggles, ['review-' + sessionId]: true } },
  };
}
