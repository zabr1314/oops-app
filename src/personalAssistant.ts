import type { AppData, Memory, SourceReference, Transcript } from './store';
import { understandingEvidence } from './memoryPeoplePresentation';
import { makeSourceReference, PERSONAL_SPACE, provenanceAvailable, sourceAvailable, sourceTurn } from './sourceAccess';

export const PERSONAL_ASSISTANT_STATE_KEY = 'personal-assistant-v1';
export const PERSONAL_SCENARIOS = ['通用', '会议', '汇报', '写作', '研究'] as const;
export type PersonalScenario = typeof PERSONAL_SCENARIOS[number];
export type PersonalHabitStatus = 'pending' | 'confirmed' | 'corrected' | 'rejected' | 'disabled';
export type PersonalHabitCandidate = {
  id: string; key: string; text: string; scenario: PersonalScenario; status: PersonalHabitStatus;
  reason: 'explicit' | 'repeated'; sources: SourceReference[]; fingerprint: string;
  createdAt: string; updatedAt: string; stale?: boolean; originSources?: SourceReference[];
  expressionKey?: string; sourceKeys?: string[];
};
export type PersonalAssistantState = {
  version: 1; personalizationEnabled: boolean; learningEnabled: boolean;
  candidates: PersonalHabitCandidate[]; rejectedKeys: string[];
};
export type PersonalContextEntry = {
  id: string; kind: 'identity' | 'preference' | 'background' | 'goal' | 'habit'; text: string;
  sources: SourceReference[]; fingerprint: string;
};
export type PersonalContextSnapshot = {
  version: 1; audience: 'personal'; enabled: boolean; scenario: PersonalScenario;
  query: string; maxChars: number; space: string; entries: PersonalContextEntry[];
  excludedIds: string[];
  sources: SourceReference[]; fingerprint: string; charCount: number;
  identity?: { name: string; role: string; context: string };
  preferences?: { tone: string; answerLength: string; focus: string; avoid: string; context: string };
};
type ContextOptions = { scenario?: PersonalScenario; query?: string; space?: string; maxChars?: number; excludeIds?: string[] };
type ReviewOptions = {
  action: 'confirm' | 'correct' | 'reject' | 'disable'; text?: string; scenario?: PersonalScenario;
  expectedFingerprint?: string; now?: Date;
};

const MAX_CANDIDATES = 60;
const MAX_REJECTED = 1000;
const MAX_ENTRY = 600;
const personal = (data: AppData) => data.settings.space === PERSONAL_SPACE && !data.settings.toggles.loggedOut;
const clean = (value: unknown, limit = 280) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const scenarioOf = (value: unknown): PersonalScenario => PERSONAL_SCENARIOS.includes(value as PersonalScenario) ? value as PersonalScenario : '通用';
const stamp = (now = new Date()) => Number.isFinite(now.getTime()) ? now.toISOString() : undefined;
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()]/g, '');
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value); let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
const emptyState = (): PersonalAssistantState => ({ version: 1, personalizationEnabled: true, learningEnabled: false, candidates: [], rejectedKeys: [] });
const refKey = (ref: SourceReference) => JSON.stringify([ref.kind, ref.id, ref.sourceId, ref.sourceTime, ref.profileScope, ref.fingerprint]);
const uniqueRefs = (refs: SourceReference[]) => [...new Map(refs.map(ref => [refKey(ref), { ...ref }])).values()];
const habitFingerprint = (value: Pick<PersonalHabitCandidate, 'key' | 'text' | 'scenario' | 'sources' | 'originSources'>) => fingerprint([value.key, value.text, value.scenario, value.sources, value.originSources]);
const canonicalSourceKey = (ref: SourceReference) => 'source-' + fingerprint([ref.id, ref.sourceId?.replace(/^evidence-/, '')]);
const expressionKey = (text: string) => 'expression-' + fingerprint(explicitHabit(text)?.body || normalize(text));

function refValid(data: AppData, ref: SourceReference): boolean {
  if (!ref || typeof ref.id !== 'string' || ref.id.length > 160 || (ref.sourceId?.length || 0) > 160 || (ref.sourceTime?.length || 0) > 100) return false;
  if (!ref.fingerprint || !provenanceAvailable(data, [ref])) return false;
  if (ref.kind === 'session') {
    const session = data.sessions.find(value => value.id === ref.id);
    const turn = sourceTurn(data, { sourceSession: ref.id, sourceId: ref.sourceId, sourceTime: ref.sourceTime });
    if (!session || !turn || session.archived || session.status === '待开始') return false;
    if ((session as typeof session & { deleted?: boolean; discarded?: boolean }).deleted || (session as typeof session & { discarded?: boolean }).discarded) return false;
    if ((turn as Transcript & { deleted?: boolean; discarded?: boolean }).deleted || (turn as Transcript & { discarded?: boolean }).discarded) return false;
    const saved = session.savedEvidence?.some(value => value.id === turn.id);
    if (!saved && session.storage && ['expired', 'cleared'].includes(session.storage.transcriptState)) return false;
  }
  return true;
}

function ownTurn(data: AppData, sessionId: string, turn: Transcript): boolean {
  // A name, voice match, or pronoun inside the text cannot establish who spoke.
  if (data.settings.toggles[`speaker-confirmed:${sessionId}:${turn.id}`] !== true) return false;
  if (turn.personId) {
    const selfId = data.settings.retention['personal-self-person-id'];
    return !!selfId && turn.personId === selfId && data.people.some(value => value.id === selfId && value.name === data.settings.name);
  }
  return turn.speaker === '我';
}

function sourceIsCurrent(data: AppData, candidate: PersonalHabitCandidate): boolean {
  const current = candidate.sources.length > 0 && candidate.sources.every(ref => {
    if (ref.kind !== 'session' || !refValid(data, ref)) return false;
    const turn = sourceTurn(data, { sourceSession: ref.id, sourceId: ref.sourceId, sourceTime: ref.sourceTime });
    return !!turn && ownTurn(data, ref.id, turn);
  });
  if (!current) return false;
  return (candidate.originSources || []).every(ref => {
    const session = data.sessions.find(value => value.id === ref.id);
    if (!session || !ref.sourceId || data.settings.toggles[`speaker-confirmed:${ref.id}:${ref.sourceId}`] !== true) return false;
    const original = session.transcript.find(value => value.id === ref.sourceId);
    // A deliberate original edit must invalidate the independently retained copy too.
    if (original) return !(original as Transcript & { deleted?: boolean; discarded?: boolean }).deleted &&
      !(original as Transcript & { discarded?: boolean }).discarded && ownTurn(data, ref.id, original) && makeSourceReference(data, ref).fingerprint === ref.fingerprint;
    return !!session.storage && (session.storage.mode === 'daily' || ['expired', 'cleared'].includes(session.storage.transcriptState));
  });
}

/** Reads a private projection. Invalidated evidence never returns its old quotation or candidate text. */
export function readPersonalAssistantState(data: AppData): PersonalAssistantState {
  if (!personal(data)) return { ...emptyState(), personalizationEnabled: false };
  const raw = data.settings.retention[PERSONAL_ASSISTANT_STATE_KEY];
  if (!raw || raw.length > 240_000) return emptyState();
  let parsed: Partial<PersonalAssistantState>;
  try { parsed = JSON.parse(raw); } catch { return emptyState(); }
  if (!parsed || parsed.version !== 1) return emptyState();
  const state: PersonalAssistantState = {
    version: 1, personalizationEnabled: parsed.personalizationEnabled !== false,
    learningEnabled: parsed.learningEnabled === true,
    rejectedKeys: Array.isArray(parsed.rejectedKeys) ? [...new Set(parsed.rejectedKeys.filter(key => typeof key === 'string' && /^[a-z0-9-]{1,80}$/.test(key)))].slice(0, MAX_REJECTED) : [],
    candidates: [],
  };
  const ids = new Set<string>();
  for (const value of Array.isArray(parsed.candidates) ? parsed.candidates.slice(0, MAX_CANDIDATES) : []) {
    if (!value || !clean(value.id, 80) || ids.has(value.id) || !/^[a-z0-9-]{1,80}$/.test(value.key || '') ||
      !['pending', 'confirmed', 'corrected', 'rejected', 'disabled'].includes(value.status) || !Array.isArray(value.sources)) continue;
    const sources = value.sources.slice(0, 4).filter(ref => ref && ref.kind === 'session' && typeof ref.id === 'string' && typeof ref.sourceId === 'string');
    const item: PersonalHabitCandidate = { id: clean(value.id, 80), key: value.key, text: clean(value.text), scenario: scenarioOf(value.scenario),
      status: value.status, reason: value.reason === 'repeated' ? 'repeated' : 'explicit', sources,
      fingerprint: clean(value.fingerprint, 80), createdAt: clean(value.createdAt, 40), updatedAt: clean(value.updatedAt, 40),
      expressionKey: typeof value.expressionKey === 'string' && /^[a-z0-9-]{1,80}$/.test(value.expressionKey) ? value.expressionKey : expressionKey(clean(value.text)),
      sourceKeys: [...new Set([...(Array.isArray(value.sourceKeys) ? value.sourceKeys.filter(key => typeof key === 'string' && /^[a-z0-9-]{1,80}$/.test(key)) : []), ...sources.map(canonicalSourceKey)])].slice(0, 8),
      ...(Array.isArray(value.originSources) ? { originSources: value.originSources.slice(0, 4).filter(ref => ref && ref.kind === 'session' && typeof ref.sourceId === 'string') } : {}) };
    ids.add(item.id);
    const invalid = !item.text || item.fingerprint !== habitFingerprint(item) || !sourceIsCurrent(data, item);
    state.candidates.push(invalid ? { ...item, text: '', sources: [], originSources: [], stale: true } : item);
  }
  return state;
}

/** Sanitize persisted private state even while a team scope is being viewed; never erase valid private candidates. */
export function reconcilePersonalAssistantState(data: AppData): AppData {
  if (!data.settings.retention[PERSONAL_ASSISTANT_STATE_KEY]) return data;
  const privateView = { ...data, settings: { ...data.settings, space: PERSONAL_SPACE,
    toggles: { ...data.settings.toggles, loggedOut: false } } };
  const state = readPersonalAssistantState(privateView), value = JSON.stringify(state);
  if (value === data.settings.retention[PERSONAL_ASSISTANT_STATE_KEY]) return data;
  return { ...data, settings: { ...data.settings, retention: { ...data.settings.retention, [PERSONAL_ASSISTANT_STATE_KEY]: value } } };
}

function writeState(data: AppData, state: PersonalAssistantState): AppData {
  if (!personal(data)) return data;
  return { ...data, settings: { ...data.settings, retention: { ...data.settings.retention, [PERSONAL_ASSISTANT_STATE_KEY]: JSON.stringify(state) } } };
}

export function setPersonalizationEnabled(data: AppData, enabled: boolean): AppData {
  if (!personal(data)) return data;
  return writeState(data, { ...readPersonalAssistantState(data), personalizationEnabled: enabled });
}

export function setPersonalLearning(data: AppData, enabled: boolean): AppData {
  if (!personal(data)) return data;
  return writeState(data, { ...readPersonalAssistantState(data), learningEnabled: enabled });
}

/** Optional explicit limits for legacy memories and profile fields; 通用 means every private scenario. */
export function setPersonalContextScope(data: AppData, kind: 'identity' | 'preferences' | 'memory', scenarios: PersonalScenario[], id?: string): AppData {
  if (!personal(data) || kind === 'memory' && (!id || !data.memories.some(memory => memory.id === id))) return data;
  const chosen = [...new Set(scenarios.filter(value => PERSONAL_SCENARIOS.includes(value)))];
  return { ...data, settings: { ...data.settings, retention: { ...data.settings.retention,
    ['personal-scope:' + kind + (id ? ':' + id : '')]: JSON.stringify(chosen) } } };
}

function scopeMatches(data: AppData, kind: 'identity' | 'preferences' | 'memory', scenario: PersonalScenario, context = '', query = '', id?: string): boolean {
  const raw = data.settings.retention['personal-scope:' + kind + (id ? ':' + id : '')];
  if (raw !== undefined) {
    try { const scopes: unknown = JSON.parse(raw); return Array.isArray(scopes) && (scopes.includes('通用') || scopes.includes(scenario)); }
    catch { return false; }
  }
  const aliases: Record<Exclude<PersonalScenario, '通用'>, string[]> = { 会议: ['会议', '会中', '开会'], 汇报: ['汇报', '报告', 'PPT', '演示'], 写作: ['写作', '文案', '撰写'], 研究: ['研究', '调研', '查资料'] };
  const named = (Object.keys(aliases) as Exclude<PersonalScenario, '通用'>[]).filter(key => aliases[key].some(word => context.toLowerCase().includes(word.toLowerCase())));
  // Old contexts such as “Oops 首版” describe a project, not a prohibition on every scenario.
  return !named.length || named.includes(scenario as Exclude<PersonalScenario, '通用'>) || !!query && named.some(key => aliases[key].some(word => query.toLowerCase().includes(word.toLowerCase())));
}

function explicitHabit(text: string): { text: string; body: string; reason: 'explicit' | 'repeated' } | undefined {
  const value = text.trim();
  if (!value || value.length > 280 || /[“”「」『』"]/.test(value)) return undefined;
  const direct = value.match(/^(?:请记住[，,:：]?\s*)?我(?:更喜欢|喜欢|不喜欢|希望|不希望|习惯(?:于)?)([^。！？!?]{2,240})[。！!]?$/);
  if (direct) return { text: value, body: normalize(value.replace(/^请记住[，,:：]?\s*/, '')), reason: 'explicit' };
  const repeated = value.match(/^我(?:通常(?:会)?|一般(?:会)?|每次(?:都)?|总是)([^。！？!?]{2,240})[。！!]?$/);
  return repeated ? { text: value, body: normalize(value), reason: 'repeated' } : undefined;
}

const rejectionKey = (text: string) => 'rejected-' + fingerprint(explicitHabit(text)?.body || normalize(text));

/** Confirmation retains whole short statements, never a clipped phrase whose meaning may have changed. */
function retainHabitEvidence(data: AppData, item: PersonalHabitCandidate): { data: AppData; sources: SourceReference[]; originSources: SourceReference[]; error?: string } {
  const needed = item.reason === 'repeated' ? 2 : 1;
  const selected = item.sources.slice(0, needed), quotes = selected.map(ref => sourceTurn(data, { sourceSession: ref.id, sourceId: ref.sourceId }));
  if (quotes.length < needed || quotes.some(turn => !turn || turn.text.length > 140) || quotes.reduce((count, turn) => count + (turn?.text.length || 0), 0) > 280) {
    return { data, sources: [], originSources: [], error: '完整依据超过短原话限额，请手动记下明确偏好；不会截断原意保存。' };
  }
  let next = data;
  const sources: SourceReference[] = [], originSources: SourceReference[] = [];
  selected.forEach((ref, index) => {
    const turn = quotes[index]!;
    const evidenceId = turn.id.startsWith('evidence-') ? turn.id : 'evidence-' + turn.id;
    const original = item.originSources?.find(value => value.id === ref.id && value.sourceId === turn.id.replace(/^evidence-/, '')) ||
      (!turn.id.startsWith('evidence-') ? ref : undefined);
    if (original) originSources.push({ ...original });
    next = { ...next, sessions: next.sessions.map(session => session.id === ref.id ? { ...session,
      savedEvidence: [...(session.savedEvidence || []).filter(value => value.id !== evidenceId), { ...turn, id: evidenceId, receivedAt: undefined }] } : session),
      settings: { ...next.settings, toggles: { ...next.settings.toggles, [`speaker-confirmed:${ref.id}:${evidenceId}`]: true } } };
    sources.push(makeSourceReference(next, { kind: 'session', id: ref.id, sourceId: evidenceId, sourceTime: turn.time }));
  });
  return { data: next, sources, originSources };
}

/** Local deterministic candidate discovery. Repetition never promotes a candidate without a person's check. */
export function collectPersonalHabitCandidates(data: AppData, options: { scenario?: PersonalScenario; now?: Date } = {}): AppData {
  if (!personal(data)) return data;
  const state = readPersonalAssistantState(data), at = stamp(options.now);
  if (!state.learningEnabled || !state.personalizationEnabled || !at || state.rejectedKeys.length >= MAX_REJECTED) return data;
  const scenario = scenarioOf(options.scenario), groups = new Map<string, { text: string; reason: 'explicit' | 'repeated'; sources: SourceReference[] }>();
  for (const session of data.sessions) {
    for (const turn of session.transcript) {
      if (!ownTurn(data, session.id, turn)) continue;
      const found = explicitHabit(turn.text);
      if (!found) continue;
      const ref = makeSourceReference(data, { kind: 'session', id: session.id, sourceId: turn.id, sourceTime: turn.time });
      if (!refValid(data, ref)) continue;
      const key = 'habit-' + fingerprint([scenario, found.body]);
      const expression = expressionKey(found.text), sourceKey = canonicalSourceKey(ref);
      if (state.rejectedKeys.includes(key) || state.rejectedKeys.includes(rejectionKey(found.text)) || state.candidates.some(value =>
        value.key === key || value.expressionKey === expression || !!value.text && expressionKey(value.text) === expression || value.sourceKeys?.includes(sourceKey) ||
        value.sources.some(source => canonicalSourceKey(source) === sourceKey))) continue;
      const group = groups.get(key) || { text: found.text, reason: found.reason, sources: [] };
      group.sources = uniqueRefs([...group.sources, ref]).slice(0, 4);
      groups.set(key, group);
    }
  }
  const added: PersonalHabitCandidate[] = [];
  for (const [key, group] of groups) {
    if (state.candidates.length + added.length >= MAX_CANDIDATES) break;
    if (group.reason === 'repeated' && group.sources.length < 2) continue;
    const item = { id: key, key, text: group.text, scenario, status: 'pending' as const, reason: group.reason,
      sources: group.sources, expressionKey: expressionKey(group.text), sourceKeys: group.sources.map(canonicalSourceKey), createdAt: at, updatedAt: at };
    added.push({ ...item, fingerprint: habitFingerprint(item) });
  }
  return added.length ? writeState(data, { ...state, candidates: [...state.candidates, ...added] }) : data;
}

export function reviewPersonalHabitCandidate(data: AppData, id: string, options: ReviewOptions): { data: AppData; error?: string } {
  if (!personal(data)) return { data, error: '请在我的空间管理私人偏好。' };
  const state = readPersonalAssistantState(data), item = state.candidates.find(value => value.id === id), at = stamp(options.now);
  if (!item || !at) return { data, error: '这条候选不可用，请重新读取。' };
  if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== item.fingerprint) return { data, error: '候选已变化，请重新核对。' };
  if (options.action === 'confirm' || options.action === 'correct') {
    if (item.stale || !sourceIsCurrent(data, item)) return { data, error: '原话或本人身份已变化，不能沿用这条候选。' };
    if (['rejected', 'disabled'].includes(item.status)) return { data, error: '这条偏好已经停用，不会自动恢复。' };
  }
  const text = options.action === 'correct' ? clean(options.text) : item.text;
  if (options.action === 'correct' && (!text || (options.text || '').trim().length > 280)) return { data, error: '请填写不超过280字的明确偏好。' };
  const scenario = options.scenario === undefined ? item.scenario : scenarioOf(options.scenario);
  const status: PersonalHabitStatus = { confirm: 'confirmed', correct: 'corrected', reject: 'rejected', disable: 'disabled' }[options.action] as PersonalHabitStatus;
  if (!status) return { data, error: '请选择确认、纠正、拒绝或停用。' };
  const retained = options.action === 'confirm' || options.action === 'correct' ? retainHabitEvidence(data, item) : undefined;
  if (retained?.error) return { data, error: retained.error };
  const updated = { ...item, text, scenario, status, updatedAt: at, ...(retained ? { sources: retained.sources, originSources: retained.originSources } : {}) };
  updated.fingerprint = habitFingerprint(updated);
  const rejectedKeys = ['rejected', 'disabled'].includes(status) ? [...new Set([...state.rejectedKeys, item.key, ...(item.text ? [rejectionKey(item.text)] : [])])].slice(0, MAX_REJECTED) : state.rejectedKeys;
  return { data: writeState(retained?.data || data, { ...state, rejectedKeys, candidates: state.candidates.map(value => value.id === id ? updated : value) }) };
}

function memoryRefs(data: AppData, memory: Memory): SourceReference[] {
  const refs = [makeSourceReference(data, { kind: 'memory', id: memory.id }), ...(memory.sources || [])];
  if (memory.sourceSession) {
    const turn = sourceTurn(data, memory);
    if (turn) refs.push(makeSourceReference(data, { kind: 'session', id: memory.sourceSession, sourceId: turn.id, sourceTime: turn.time }));
  }
  return uniqueRefs(refs);
}

/** A bounded, private snapshot for this request. It never grants permission to execute, send, or share. */
export function buildPersonalContext(data: AppData, options: ContextOptions = {}): PersonalContextSnapshot {
  const scenario = scenarioOf(options.scenario), query = clean(options.query, 400), space = options.space || data.settings.space;
  const maxChars = typeof options.maxChars === 'number' && Number.isFinite(options.maxChars) ? Math.max(0, Math.min(6000, Math.floor(options.maxChars))) : 3600;
  const excludedIds = [...new Set((options.excludeIds || []).filter(id => typeof id === 'string' && id.length <= 120))].sort().slice(0, 100);
  const state = readPersonalAssistantState(data), enabled = personal(data) && space === PERSONAL_SPACE && state.personalizationEnabled;
  const result: PersonalContextSnapshot = { version: 1, audience: 'personal', enabled, scenario, query, maxChars, space,
    entries: [], sources: [], fingerprint: '', charCount: 0, excludedIds };
  const finish = () => {
    result.sources = uniqueRefs(result.entries.flatMap(entry => entry.sources));
    result.fingerprint = fingerprint([enabled, scenario, query, maxChars, space, excludedIds, result.entries, result.identity, result.preferences]);
    return result;
  };
  if (!enabled) return finish();
  const preferenceRef = makeSourceReference(data, { kind: 'profile', id: 'my-profile', profileScope: 'preferences' });
  const append = (id: string, kind: PersonalContextEntry['kind'], text: string, refs: SourceReference[], atomic = false) => {
    if (excludedIds.includes(id) || atomic && (text.length > MAX_ENTRY || text.length > maxChars - result.charCount)) return false;
    const body = clean(text, Math.min(MAX_ENTRY, maxChars - result.charCount));
    const sources = uniqueRefs([...refs, preferenceRef]);
    if (!body || result.entries.length >= 16 || !sources.length || sources.length > 8 || !sources.every(ref => refValid(data, ref))) return false;
    result.entries.push({ id, kind, text: body, sources, fingerprint: fingerprint([id, kind, body, sources]) });
    result.charCount += body.length;
    return true;
  };
  const identity = { name: clean(data.settings.name, 60), role: clean(data.settings.role, 120), context: clean(data.settings.retention.roleContext, 200) };
  if ((identity.name || identity.role) && scopeMatches(data, 'identity', scenario, identity.context, query)) {
    if (append('my-profile:identity', 'identity', [identity.name && `称呼：${identity.name}`, identity.role && `角色：${identity.role}`, identity.context && `适用背景：${identity.context}`].filter(Boolean).join('；'),
      [makeSourceReference(data, { kind: 'profile', id: 'my-profile', profileScope: 'identity' })], true)) result.identity = identity;
  }
  const preferences = { tone: clean(data.settings.tone, 120), answerLength: clean(data.settings.retention.answerLength, 60), focus: clean(data.settings.retention.focus, 120), avoid: clean(data.settings.retention.avoid, 120), context: clean(data.settings.retention.preferenceContext, 80) };
  if (scopeMatches(data, 'preferences', scenario, preferences.context, query)) {
    const text = [preferences.tone && `回答方式：${preferences.tone}`, preferences.answerLength && `回答长度：${preferences.answerLength}`, preferences.focus && `关注：${preferences.focus}`, preferences.avoid && `避免：${preferences.avoid}`, preferences.context && `适用场景：${preferences.context}`].filter(Boolean).join('；');
    if (append('my-profile:preferences', 'preference', text, [preferenceRef], true)) result.preferences = preferences;
  }
  const evidence = understandingEvidence(data);
  for (const [kind, memories] of [['background', evidence.backgrounds], ['goal', evidence.goals]] as const) {
    for (const memory of memories) {
      const context = data.settings.retention['memory-context:' + memory.id] || memory.tags.find(tag => tag.startsWith('场景:'))?.slice(3) || '';
      if (!scopeMatches(data, 'memory', scenario, context, query, memory.id) || !sourceAvailable(data, memory) || !provenanceAvailable(data, memory.sources)) continue;
      const refs = memoryRefs(data, memory);
      if (!refs.some(ref => ref.kind === 'memory')) continue;
      const title = memory.title.trim(), body = memory.body.trim();
      const text = body.startsWith(title) ? body : `${title}：${body}`;
      append(memory.id, kind === 'background' && memory.tags.includes('本人确认') && memory.tags.includes('沟通习惯') ? 'habit' : kind, text, refs);
    }
  }
  for (const item of state.candidates) {
    if (!item.stale && ['confirmed', 'corrected'].includes(item.status) && (item.scenario === '通用' || item.scenario === scenario) && sourceIsCurrent(data, item)) append(item.id, 'habit', item.text, item.sources);
  }
  return finish();
}

export function personalContextSources(context: PersonalContextSnapshot): SourceReference[] {
  return context.enabled && context.space === PERSONAL_SPACE ? uniqueRefs(context.sources) : [];
}

export function personalContextCurrent(data: AppData, context: PersonalContextSnapshot): boolean {
  if (context.version !== 1 || context.audience !== 'personal' || context.enabled && !context.sources.every(ref => refValid(data, ref))) return false;
  return buildPersonalContext(data, { scenario: context.scenario, query: context.query, maxChars: context.maxChars, space: context.space, excludeIds: context.excludedIds }).fingerprint === context.fingerprint;
}
