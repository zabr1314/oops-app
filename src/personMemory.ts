import type { AppData, Route, SourceReference, Transcript } from './store';
import type { PersonalScenario } from './personalAssistant';
import { makeSourceReference, PERSONAL_SPACE, provenanceAvailable, sourceTurn } from './sourceAccess';

export const PERSON_MEMORY_STATE_KEY = 'person-memory-v1';
export const PERSON_MEMORY_KINDS = ['fact', 'preference', 'background', 'commitment'] as const;
export type PersonMemoryKind = typeof PERSON_MEMORY_KINDS[number];
export type PersonMemory = {
  id: string; personId: string; kind: PersonMemoryKind; text: string; origin: 'manual' | 'quote';
  status: 'pending' | 'confirmed' | 'rejected' | 'disabled'; scenario: PersonalScenario;
  sources: SourceReference[]; originSources?: SourceReference[]; updatedAt: string; fingerprint: string;
  dedupeKey: string; sourceKey?: string; stale?: boolean; deleted?: boolean;
};
type State = { version: 1; items: PersonMemory[] };
type SourceSelection = { sessionId: string; sourceId: string } | SourceReference;
type SaveValues = { id?: string; personId: string; kind: PersonMemoryKind; text: string; scenario?: PersonalScenario; source?: SourceSelection; now?: Date };
export type PersonMemoryResult = { data: AppData; id?: string; error?: string };
const scenarios = ['通用', '会议', '汇报', '写作', '研究'];
const privateView = (data: AppData) => data.settings.space === PERSONAL_SPACE && !data.settings.toggles.loggedOut;
const anonymous = (name: string) => !name.trim() || /未知|待确认|未确认|匿名|说话人|unknown|anonymous/i.test(name);
const validPerson = (data: AppData, id: string) => typeof id === 'string' && id.length > 0 && id.length <= 120 ? data.people.find(person => person.id === id && !anonymous(person.name)) : undefined;
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()]/g, '');
const scenarioOf = (value?: string): PersonalScenario => scenarios.includes(value || '') ? value as PersonalScenario : '通用';
const hash = (value: unknown) => { const text = JSON.stringify(value); let n = 2166136261; for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619); return (n >>> 0).toString(36); };
const fingerprint = (item: Omit<PersonMemory, 'fingerprint'> | PersonMemory) => hash([item.id, item.personId, item.kind, item.text, item.origin, item.status, item.scenario, item.sources, item.originSources, !!item.stale, !!item.deleted]);
const keyOf = (personId: string, text: string) => 'person-expression-' + hash([personId, normalize(text)]);
const sourceKeyOf = (personId: string, ref: SourceReference) => 'person-source-' + hash([personId, ref.id, ref.sourceId?.replace(/^evidence-/, '')]);
const nowOf = (now = new Date()) => Number.isFinite(now.getTime()) ? now.toISOString() : undefined;

function quoteCurrent(data: AppData, personId: string, ref: SourceReference): boolean {
  if (ref.kind !== 'session' || !ref.sourceId || !ref.fingerprint || !provenanceAvailable(data, [ref])) return false;
  const session = data.sessions.find(value => value.id === ref.id);
  const turn = sourceTurn(data, { sourceSession: ref.id, sourceId: ref.sourceId });
  if (!session || !turn || session.archived || session.status === '待开始' || (session as typeof session & { deleted?: boolean }).deleted) return false;
  if ((turn as Transcript & { deleted?: boolean; discarded?: boolean }).deleted || (turn as Transcript & { discarded?: boolean }).discarded) return false;
  if (turn.personId !== personId || data.settings.toggles[`speaker-confirmed:${session.id}:${turn.id}`] !== true) return false;
  const saved = session.savedEvidence?.some(value => value.id === turn.id);
  return !!saved || !session.storage || !['expired', 'cleared'].includes(session.storage.transcriptState);
}

export function personMemoryCurrent(data: AppData, item: PersonMemory): boolean {
  if (!privateView(data) || !validPerson(data, item.personId) || item.stale || item.deleted || !item.text) return false;
  if (item.origin === 'manual') return item.sources.length === 0;
  if (!item.sources.length || !item.sources.every(ref => quoteCurrent(data, item.personId, ref))) return false;
  return (item.originSources || []).every(ref => {
    const session = data.sessions.find(value => value.id === ref.id);
    if (!session || !ref.sourceId || data.settings.toggles[`speaker-confirmed:${ref.id}:${ref.sourceId}`] !== true) return false;
    const original = session.transcript.find(value => value.id === ref.sourceId);
    if (!original) return !!session.storage && (session.storage.mode === 'daily' || ['expired', 'cleared'].includes(session.storage.transcriptState));
    return original.personId === item.personId && !(original as Transcript & { deleted?: boolean }).deleted && makeSourceReference(data, ref).fingerprint === ref.fingerprint;
  });
}

/** Only a private, current projection is readable; stale copied text is redacted before display or use. */
export function readPersonMemories(data: AppData, personId?: string): PersonMemory[] {
  if (!privateView(data)) return [];
  const raw = data.settings.retention[PERSON_MEMORY_STATE_KEY];
  if (!raw || raw.length > 300_000) return [];
  let state: State;
  try { state = JSON.parse(raw); } catch { return []; }
  if (!state || state.version !== 1 || !Array.isArray(state.items)) return [];
  const seen = new Set<string>();
  return state.items.slice(0, 240).flatMap(value => {
    if (!value || typeof value.id !== 'string' || value.id.length > 120 || seen.has(value.id) || typeof value.personId !== 'string' ||
      !PERSON_MEMORY_KINDS.includes(value.kind) || !['manual', 'quote'].includes(value.origin) || !['pending', 'confirmed', 'rejected', 'disabled'].includes(value.status) ||
      typeof value.text !== 'string' || value.text.length > 280 || !Array.isArray(value.sources) || !scenarios.includes(value.scenario) ||
      value.originSources !== undefined && !Array.isArray(value.originSources)) return [];
    seen.add(value.id);
    const item: PersonMemory = { ...value, sources: value.sources.slice(0, 2).map(ref => ({ ...ref })),
      ...(value.originSources ? { originSources: value.originSources.slice(0, 2).filter(ref => ref && ref.kind === 'session' && typeof ref.id === 'string' && typeof ref.sourceId === 'string').map(ref => ({ ...ref })) } : {}), scenario: scenarioOf(value.scenario),
      dedupeKey: value.dedupeKey || keyOf(value.personId, value.text),
      sourceKey: value.sourceKey || (value.sources[0] ? sourceKeyOf(value.personId, value.sources[0]) : undefined) };
    const current = item.fingerprint === fingerprint(item) && personMemoryCurrent(data, item);
    const safe = item.deleted ? { ...item, text: '', sources: [], originSources: [] } : current ? item : { ...item, stale: true, text: '', sources: [], originSources: [] };
    safe.fingerprint = fingerprint(safe);
    return !personId || safe.personId === personId ? [safe] : [];
  });
}

function write(data: AppData, items: PersonMemory[]): AppData {
  return { ...data, settings: { ...data.settings, retention: { ...data.settings.retention, [PERSON_MEMORY_STATE_KEY]: JSON.stringify({ version: 1, items }) } } };
}

export function reconcilePersonMemories(data: AppData): AppData {
  if (!data.settings.retention[PERSON_MEMORY_STATE_KEY]) return data;
  const view = { ...data, settings: { ...data.settings, space: PERSONAL_SPACE, toggles: { ...data.settings.toggles, loggedOut: false } } };
  const items = readPersonMemories(view), serialized = JSON.stringify({ version: 1, items });
  return serialized === data.settings.retention[PERSON_MEMORY_STATE_KEY] ? data : write(data, items);
}

export function savePersonMemory(data: AppData, values: SaveValues, expectedFingerprint?: string): PersonMemoryResult {
  const at = nowOf(values.now), text = typeof values.text === 'string' ? values.text.trim() : '';
  if (!privateView(data) || !validPerson(data, values.personId)) return { data, error: '请在我的空间选择已核对的明确人物。' };
  if (!at || !text || text.length > 280 || !PERSON_MEMORY_KINDS.includes(values.kind) || values.scenario !== undefined && !scenarios.includes(values.scenario)) return { data, error: '请填写1–280字的具体内容并选择有效类别与场景。' };
  const items = readPersonMemories(data), original = values.id ? items.find(item => item.id === values.id) : undefined;
  if (values.id && (!original || original.personId !== values.personId || original.deleted || original.stale || expectedFingerprint !== original.fingerprint)) return { data, error: '这条记录已变化或不可用，请重新读取。' };
  let sources: SourceReference[] = [];
  if (values.source) {
    const selected = 'sessionId' in values.source ? { kind: 'session' as const, id: values.source.sessionId, sourceId: values.source.sourceId } : values.source;
    const ref = makeSourceReference(data, selected);
    if (!quoteCurrent(data, values.personId, ref)) return { data, error: '请选择明确核对为此人物、当前有效的原话。' };
    sources = [ref];
  } else if (original?.origin === 'quote') sources = original.sources.map(ref => ({ ...ref }));
  const origin = sources.length ? 'quote' as const : 'manual' as const;
  if (items.length >= 240 && !original) return { data, error: '本机人物记忆已达本阶段上限。' };
  const id = original?.id || 'PERSON-MEM-' + hash([values.personId, values.kind, text, at]);
  const item = { id, personId: values.personId, kind: values.kind, text, origin, status: 'pending' as const,
    scenario: values.scenario === undefined ? original?.scenario || '通用' : scenarioOf(values.scenario), sources, originSources: original?.originSources, updatedAt: at,
    dedupeKey: original?.dedupeKey || keyOf(values.personId, text), sourceKey: original?.sourceKey || (sources[0] ? sourceKeyOf(values.personId, sources[0]) : undefined) };
  return { id, data: write(data, original ? items.map(value => value.id === id ? { ...item, fingerprint: fingerprint(item) } : value) : [...items, { ...item, fingerprint: fingerprint(item) }]) };
}

export function collectPersonMemoryCandidates(data: AppData, personId: string, scenario: PersonalScenario = '通用'): AppData {
  if (!privateView(data) || !validPerson(data, personId)) return data;
  let next = data;
  for (const session of data.sessions) for (const turn of session.transcript) {
    if (turn.personId !== personId || data.settings.toggles[`speaker-confirmed:${session.id}:${turn.id}`] !== true) continue;
    const preference = /^(?:请记住[，,:：]?\s*)?我(?:偏好|更喜欢|喜欢|不喜欢|希望|不希望|习惯)/.test(turn.text);
    const background = /^我(?:现在|目前)?(?:负责|的工作是|在[^，。]{1,30}(?:工作|任职))/.test(turn.text);
    const commitment = /^我(?:会|来|将在|答应|保证|周[一二三四五六日天]|明天|下周|月底|本周)/.test(turn.text);
    if ((!preference && !background && !commitment) || turn.text.length > 280 || /[“”「」『』"]/.test(turn.text)) continue;
    const ref = makeSourceReference(next, { kind: 'session', id: session.id, sourceId: turn.id, sourceTime: turn.time });
    if (!quoteCurrent(next, personId, ref)) continue;
    const existing = readPersonMemories(next);
    if (existing.some(item => item.personId === personId && (item.dedupeKey === keyOf(personId, turn.text) || item.sourceKey === sourceKeyOf(personId, ref) || normalize(item.text) === normalize(turn.text)))) continue;
    const saved = savePersonMemory(next, { personId, kind: preference ? 'preference' : commitment ? 'commitment' : 'background', text: turn.text, source: ref, scenario });
    next = saved.data;
  }
  return next;
}

export function reviewPersonMemory(data: AppData, id: string, action: 'confirm' | 'correct' | 'reject' | 'disable', text?: string, expectedFingerprint?: string, scenario?: PersonalScenario): PersonMemoryResult {
  if (!privateView(data)) return { data, error: '人物记忆仅在我的空间管理。' };
  if (!['confirm', 'correct', 'reject', 'disable'].includes(action) || scenario !== undefined && !scenarios.includes(scenario)) return { data, error: '请选择有效的核对动作和场景。' };
  const items = readPersonMemories(data), item = items.find(value => value.id === id);
  if (!item || item.deleted || expectedFingerprint !== undefined && expectedFingerprint !== item.fingerprint) return { data, error: '记录已变化，请重新读取。' };
  if (['confirm', 'correct'].includes(action) && (!personMemoryCurrent(data, item) || ['rejected', 'disabled'].includes(item.status))) return { data, error: '人物或原话已变化，已停用记录不会自动恢复。' };
  const body = text === undefined ? item.text : text.trim();
  if (['confirm', 'correct'].includes(action) && (!body || body.length > 280)) return { data, error: '请填写1–280字的明确内容。' };
  let next = data, sources = item.sources, origins = item.originSources;
  if (['confirm', 'correct'].includes(action) && item.origin === 'quote') {
    const ref = sources[0], turn = sourceTurn(data, { sourceSession: ref.id, sourceId: ref.sourceId });
    if (!turn || turn.text.length > 140) return { data, error: '完整原话超过140字，请用手动记录写下明确内容；不会截断原意。' };
    const evidenceId = turn.id.startsWith('evidence-') ? turn.id : 'evidence-' + turn.id;
    origins = origins || (turn.id.startsWith('evidence-') ? [] : [{ ...ref }]);
    next = { ...data, sessions: data.sessions.map(session => session.id === ref.id ? { ...session, savedEvidence: [...(session.savedEvidence || []).filter(value => value.id !== evidenceId), { ...turn, id: evidenceId, receivedAt: undefined }] } : session),
      settings: { ...data.settings, toggles: { ...data.settings.toggles, [`speaker-confirmed:${ref.id}:${evidenceId}`]: true } } };
    sources = [makeSourceReference(next, { kind: 'session', id: ref.id, sourceId: evidenceId, sourceTime: turn.time })];
  }
  const status = action === 'reject' ? 'rejected' : action === 'disable' ? 'disabled' : 'confirmed';
  const changed = { ...item, text: body, status, scenario: scenario === undefined ? item.scenario : scenarioOf(scenario), sources, originSources: origins, updatedAt: new Date().toISOString() } as PersonMemory;
  changed.fingerprint = fingerprint(changed);
  return { id, data: write(next, items.map(value => value.id === id ? changed : value)) };
}

export function deletePersonMemory(data: AppData, id: string, expectedFingerprint?: string): PersonMemoryResult {
  if (!privateView(data)) return { data, error: '人物记忆仅在我的空间管理。' };
  const items = readPersonMemories(data), item = items.find(value => value.id === id);
  if (!item || expectedFingerprint !== undefined && expectedFingerprint !== item.fingerprint) return { data, error: '这条记录已变化或不存在，请重新读取。' };
  const removed: PersonMemory = { ...item, status: 'disabled', deleted: true, text: '', sources: [], originSources: [], updatedAt: new Date().toISOString() };
  removed.fingerprint = fingerprint(removed);
  return { id, data: write(data, items.map(value => value.id === id ? removed : value)) };
}

export function buildPersonContext(data: AppData, personId: string, scenario: PersonalScenario = '通用', excludeIds: string[] = []) {
  const person = privateView(data) ? validPerson(data, personId) : undefined;
  const items = person ? readPersonMemories(data, personId).filter(item => item.status === 'confirmed' && personMemoryCurrent(data, item) && (item.scenario === '通用' || item.scenario === scenario) && !excludeIds.includes(item.id)).slice(0, 8) : [];
  const entries = items.map(item => ({ id: item.id, kind: ('person_' + item.kind) as 'person_fact' | 'person_preference' | 'person_background' | 'person_commitment', text: item.text,
    sources: [makeSourceReference(data, { kind: 'person_memory', id: item.id, personId }), ...item.sources.map(ref => ({ ...ref }))], fingerprint: item.fingerprint, origin: item.origin }));
  return { personId, personLabel: person?.name.slice(0, 80), entries, fingerprint: hash([personId, person?.name, scenario, entries]) };
}

export function personMemorySourceRoute(item: PersonMemory): Route {
  const ref = item.sources[0];
  return ref ? { view: 'session-transcript', id: ref.id, mode: ref.sourceId || ref.sourceTime } : { view: 'memory-person', id: item.personId };
}
