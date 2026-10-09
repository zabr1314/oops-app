import type { AppData, Person } from './store';

export const SELF_VOICE_ID = 'voice:self';
export type VoiceSample = { id: string; label: string; phrase: string; duration: number; quality: '清晰' | '较弱' | '噪声'; created: string; subjectId?: string };
export type VoiceMatch = { id: string; sampleId: string; scenario: '匹配' | '低置信度' | '识别失败'; confidence: number; status: '已匹配' | '待确认' | '识别失败' | '已纠正' | '保持匿名'; proposedSubjectId?: string; confirmedSubjectId?: string; previousSubjectId?: string; created: string; reason: string };
type VoiceResult = { data: AppData; error?: string };
const PERSONAL = '我的空间';
function list<T>(data: AppData, key: string): T[] { try { const rows = JSON.parse(data.settings.retention[key] || '[]'); return Array.isArray(rows) ? rows : []; } catch { return []; } }
export function voiceSamples(data: AppData): VoiceSample[] { return list<VoiceSample>(data, 'voice-id-samples').filter(sample => sample && typeof sample.id === 'string' && typeof sample.label === 'string'); }
export function voiceMatches(data: AppData): VoiceMatch[] { return list<VoiceMatch>(data, 'voice-id-matches').filter(match => match && typeof match.id === 'string' && typeof match.sampleId === 'string'); }
function save(data: AppData, samples: VoiceSample[], matches = voiceMatches(data)): AppData { return { ...data, settings: { ...data.settings, retention: { ...data.settings.retention, 'voice-id-samples': JSON.stringify(samples), 'voice-id-matches': JSON.stringify(matches) } } }; }
export function voiceContactConfirmed(data: AppData, person: Person): boolean { return !/未知|待确认|未确认|匿名|说话人|unknown|anonymous/i.test(person.name) && !!person.name.trim() && (data.settings.toggles['person-name-confirmed:' + person.id] === true || person.voice || ['本次手动确认', '已核对身份'].includes(person.role)); }
export function voiceSubjects(data: AppData) { return [{ id: SELF_VOICE_ID, name: data.settings.name || '我', label: '本人 · ' + (data.settings.name || '我') }, ...data.people.filter(person => voiceContactConfirmed(data, person)).map(person => ({ id: person.id, name: person.name, label: `${person.name} · ${person.company || person.role || '联系人'} · ${person.id}` }))]; }
export function voiceSubjectAllowed(data: AppData, subjectId?: string): boolean { if (!subjectId) return false; if (subjectId === SELF_VOICE_ID) return data.settings.toggles.voice === true; const person = data.people.find(item => item.id === subjectId); return !!person && voiceContactConfirmed(data, person) && person.voice; }
export function voiceSubjectName(data: AppData, subjectId?: string) { return voiceSubjects(data).find(subject => subject.id === subjectId)?.name || (subjectId ? '身份已移除或待核对' : '尚未关联'); }
export function currentVoiceMatch(data: AppData, match: VoiceMatch): VoiceMatch {
  const subjectId = match.confirmedSubjectId || match.proposedSubjectId;
  if (!subjectId || voiceSamples(data).some(sample => sample.id === match.sampleId && sample.subjectId === subjectId) && voiceSubjectAllowed(data, subjectId)) return match;
  return { ...match, status: '待确认', confidence: 0, proposedSubjectId: undefined, confirmedSubjectId: undefined, reason: '声音关联或许可已变化，请重新核对' };
}
export function revokeContactVoice(data: AppData, personId: string): VoiceResult {
  const person = data.people.find(item => item.id === personId);
  if (data.settings.space !== PERSONAL || !person) return { data, error: '这项声音许可当前不可管理' };
  return { data: { ...data, people: data.people.map(item => item.id === personId ? { ...item, voice: false } : item), settings: { ...data.settings, toggles: { ...data.settings.toggles, ['voiceShare:' + personId]: false, ['person-name-confirmed:' + personId]: voiceContactConfirmed(data, person) } } } };
}
export function addVoiceSample(data: AppData, sample: VoiceSample): VoiceResult {
  if (data.settings.space !== PERSONAL) return { data, error: '请在个人空间管理声音样本' };
  if (!sample.label.trim() || !sample.id || !['清晰', '较弱', '噪声'].includes(sample.quality)) return { data, error: '填写样本名称并核对采集状态' };
  if (voiceSamples(data).some(item => item.id === sample.id)) return { data, error: '这段样本已保存' };
  return { data: save(data, [{ ...sample, label: sample.label.trim(), subjectId: undefined }, ...voiceSamples(data)]) };
}
export function bindVoiceSample(data: AppData, sampleId: string, subjectId: string, grantContactVoice = false): VoiceResult {
  const sample = voiceSamples(data).find(item => item.id === sampleId);
  if (data.settings.space !== PERSONAL || !sample) return { data, error: '这段声音样本当前不可管理' };
  if (!voiceSubjects(data).some(subject => subject.id === subjectId)) return { data, error: '先确认联系人姓名，再选择明确的身份' };
  if (subjectId === SELF_VOICE_ID && !data.settings.toggles.voice) return { data, error: '先完成本人的声音登记' };
  const person = data.people.find(item => item.id === subjectId);
  if (person && !person.voice && !grantContactVoice) return { data, error: '姓名确认不等于声音许可，请单独允许个人识别示例' };
  const permitted = person && grantContactVoice ? { ...data, people: data.people.map(item => item.id === person.id ? { ...item, voice: true } : item) } : data;
  const changed = sample.subjectId !== subjectId;
  const matches = voiceMatches(data).map(match => changed && match.sampleId === sampleId ? { ...match, status: '待确认' as const, confidence: 0, proposedSubjectId: undefined, confirmedSubjectId: undefined, reason: '样本关联已修改，请重新核对识别结果' } : match);
  return { data: save(permitted, voiceSamples(data).map(item => item.id === sampleId ? { ...item, subjectId } : item), matches) };
}
export function unbindVoiceSample(data: AppData, sampleId: string, remove = false): VoiceResult {
  if (data.settings.space !== PERSONAL || !voiceSamples(data).some(sample => sample.id === sampleId)) return { data, error: '这段声音样本当前不可管理' };
  const samples = remove ? voiceSamples(data).filter(sample => sample.id !== sampleId) : voiceSamples(data).map(sample => sample.id === sampleId ? { ...sample, subjectId: undefined } : sample);
  const matches = remove ? voiceMatches(data).filter(match => match.sampleId !== sampleId) : voiceMatches(data).map(match => match.sampleId === sampleId ? { ...match, status: '待确认' as const, confidence: 0, confirmedSubjectId: undefined, proposedSubjectId: undefined, reason: '样本与身份已解绑，保持待确认' } : match);
  return { data: save(data, samples, matches) };
}
export function runVoiceMatch(data: AppData, sampleId: string, scenario: VoiceMatch['scenario'], id: string, created: string): VoiceResult & { match?: VoiceMatch } {
  const sample = voiceSamples(data).find(item => item.id === sampleId);
  if (data.settings.space !== PERSONAL || !sample) return { data, error: '先选择一段当前声音样本' };
  if (!['匹配', '低置信度', '识别失败'].includes(scenario)) return { data, error: '请选择有效的识别场景' };
  const failed = scenario === '识别失败', allowed = voiceSubjectAllowed(data, sample.subjectId), matched = !failed && allowed && scenario === '匹配';
  const match: VoiceMatch = { id, sampleId, scenario, confidence: failed ? 0 : matched ? 94 : allowed ? 52 : 0, status: failed ? '识别失败' : matched ? '已匹配' : '待确认', proposedSubjectId: !failed && allowed ? sample.subjectId : undefined, confirmedSubjectId: matched ? sample.subjectId : undefined, created, reason: failed ? '片段中的噪声较多，没有可核对的匹配结果' : matched ? '匹配到已允许的声音关联，请核对是否准确' : allowed ? '候选相近，暂不确认人物；可重新采集或人工核对' : '尚无有效声音关联，或个人声音许可已关闭' };
  return { data: save(data, voiceSamples(data), [match, ...voiceMatches(data)]), match };
}
export function resolveVoiceMatch(data: AppData, matchId: string, subjectId: string | undefined, grantContactVoice = false): VoiceResult {
  const match = voiceMatches(data).find(item => item.id === matchId);
  if (data.settings.space !== PERSONAL || !match) return { data, error: '这条识别结果已不可核对' };
  if (!subjectId) return { data: save(data, voiceSamples(data), voiceMatches(data).map(item => item.id === matchId ? { ...item, status: '保持匿名', confirmedSubjectId: undefined, proposedSubjectId: undefined, reason: '已选择保持匿名；未确认姓名或声音关联' } : item)) };
  const binding = bindVoiceSample(data, match.sampleId, subjectId, grantContactVoice);
  if (binding.error) return binding;
  return { data: save(binding.data, voiceSamples(binding.data), voiceMatches(binding.data).map(item => item.id === matchId ? { ...item, status: subjectId === match.proposedSubjectId ? '已匹配' : '已纠正', confidence: 100, previousSubjectId: subjectId === match.proposedSubjectId ? undefined : match.confirmedSubjectId || match.proposedSubjectId, confirmedSubjectId: subjectId, proposedSubjectId: subjectId, reason: subjectId === match.proposedSubjectId ? '已人工核对这段声音与身份' : '已人工纠正声音关联；后续识别使用新的身份对应' } : item)) };
}
