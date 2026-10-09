import type { AppData, Session, Transcript } from './store';
import { sessionVisible } from './sourceAccess';
import type { SaveScope } from './recordingLogic';

export type ListeningConfig = {
  wakeWord: string;
  minSeconds: number;
  silenceSeconds: number;
  startMode: 'confirm' | 'automatic';
  endMode: 'confirm' | 'automatic';
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  saveScope: SaveScope;
  shared: boolean;
};
export type ListeningSignal = {
  id: string;
  kind: 'conversation' | 'uncertain' | 'noise' | 'wake';
  seconds: number;
  confidence: number;
  turns: Pick<Transcript, 'speaker' | 'text' | 'private'>[];
  wakeText?: string;
};
export type ListeningJudgment = 'valid' | 'uncertain' | 'noise' | 'wake' | 'wake-missed';
export const listeningConfigKey = (space: string) => 'listening-config:' + space;
export const defaultListeningConfig: ListeningConfig = {
  wakeWord: '你好 Oops', minSeconds: 18, silenceSeconds: 120,
  startMode: 'confirm', endMode: 'confirm', quietEnabled: false,
  quietStart: '22:00', quietEnd: '08:00', saveScope: '完整保存', shared: false,
};

export function validateListeningConfig(config: ListeningConfig): string {
  if (!config.wakeWord.trim() || config.wakeWord.trim().length > 30) return '唤醒词需要 1–30 个字。';
  if (!Number.isFinite(config.minSeconds) || config.minSeconds < 5 || config.minSeconds > 120) return '最小有效对话时长需要在 5–120 秒之间。';
  if (!Number.isFinite(config.silenceSeconds) || config.silenceSeconds < 30 || config.silenceSeconds > 1800) return '静默结束时长需要在 30–1800 秒之间。';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.quietStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.quietEnd)) return '安静时段请填写 HH:mm，例如 22:00。';
  if (config.quietEnabled && config.quietStart === config.quietEnd) return '安静时段的开始和结束时间不能相同。';
  return '';
}

export function readListeningConfig(data: AppData): ListeningConfig {
  try {
    const value = JSON.parse(data.settings.retention[listeningConfigKey(data.settings.space)] || '{}');
    const candidate = { ...defaultListeningConfig, ...value } as ListeningConfig;
    if (!['confirm', 'automatic'].includes(candidate.startMode) || !['confirm', 'automatic'].includes(candidate.endMode)) return { ...defaultListeningConfig };
    if (!['完整保存', '仅保存非敏感片段', '手动选择片段'].includes(candidate.saveScope)) return { ...defaultListeningConfig };
    return validateListeningConfig(candidate) ? { ...defaultListeningConfig } : candidate;
  } catch { return { ...defaultListeningConfig }; }
}

export function inListeningQuietHours(config: ListeningConfig, date: Date = new Date()): boolean {
  if (!config.quietEnabled) return false;
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  const minute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const current = minute(hhmm), start = minute(config.quietStart), end = minute(config.quietEnd);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function judgeListeningSignal(signal: ListeningSignal, config: ListeningConfig): ListeningJudgment {
  if (signal.kind === 'wake') {
    const compact = (value: string) => value.toLowerCase().replace(/\s+/g, '');
    return compact(signal.wakeText || '').includes(compact(config.wakeWord)) ? 'wake' : 'wake-missed';
  }
  if (signal.kind === 'noise' || !signal.turns.some(turn => turn.text.trim())) return 'noise';
  if (signal.kind === 'uncertain' || signal.confidence < 0.8 || signal.seconds < config.minSeconds) return 'uncertain';
  return 'valid';
}

type StartResult = { data: AppData; sessionId?: string; error?: string };
export function startListeningSession(data: AppData, signal: ListeningSignal, options: {
  sessionId: string; config: ListeningConfig; confirmed?: boolean; allowQuietOnce?: boolean; date?: Date;
}): StartResult {
  const config = options.config;
  if (data.settings.toggles.recordingAllowed === false) return { data, error: '声音记录已关闭，请先在隐私设置中允许。' };
  if (data.sessions.some(s => ['进行中', '暂停'].includes(s.status))) return { data, error: '已有一段活动记录，请继续或结束后再开始。' };
  if (data.sessions.some(s => s.id === options.sessionId) || data.settings.retention['listening-accepted:' + signal.id]) return { data, error: '这段示例已经处理过，请体验新的声音。' };
  if (validateListeningConfig(config)) return { data, error: validateListeningConfig(config) };
  if (inListeningQuietHours(config, options.date) && !options.allowQuietOnce) return { data, error: '现在处于安静时段，可以明确选择本次手动开始。' };
  if (data.settings.space !== '我的空间' && !config.shared) return { data, error: '先确认允许当前项目查看共同纪要，或到我的空间开始。' };
  const judgment = judgeListeningSignal(signal, config);
  if (judgment === 'noise' || judgment === 'wake-missed') return { data, error: '这段声音没有形成有效对话，不创建记录。' };
  if ((judgment === 'uncertain' || judgment === 'wake' || config.startMode === 'confirm') && !options.confirmed) return { data, error: '请先确认这段声音是否需要记录。' };
  const date = options.date || new Date();
  const textTurns = signal.turns.filter(t => t.text.trim());
  const transcript: Transcript[] = textTurns.map((t, index) => ({ ...t, id: `listen-${options.sessionId}-${index}`, time: `00:00:${String(index * 6).padStart(2, '0')}` }));
  const duration = judgment === 'wake' ? 0 : signal.seconds;
  const session: Session = {
    id: options.sessionId, title: `智能聆听 · ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })}`,
    kind: '会议', date: date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' }),
    duration: `${String(Math.floor(duration / 60)).padStart(2, '0')}:${String(duration % 60).padStart(2, '0')}`,
    status: '进行中', transcript, summary: [], agenda: ['确认本次讨论目标'],
    participants: [...new Set(['我', ...transcript.map(t => t.speaker)])], attachments: [], privateNotes: [], project: '个人记录',
  };
  return { sessionId: session.id, data: { ...data, sessions: [session, ...data.sessions], activeSessionId: session.id,
    settings: { ...data.settings, toggles: { ...data.settings.toggles, ['shared-' + session.id]: data.settings.space !== '我的空间' && config.shared },
      retention: { ...data.settings.retention, ['session-' + session.id]: config.saveScope,
        ['session-space:' + session.id]: data.settings.space,
        ['listening-source:' + session.id]: JSON.stringify({ signalId: signal.id, kind: signal.kind, confidence: signal.confidence, source: '本地示例声音文本', startedAt: date.toISOString() }),
        ['listening-accepted:' + signal.id]: session.id,
      } },
  } };
}

/** An end suggestion is never allowed to bypass the existing save-range dialog. */
export function listeningEndEligible(data: AppData, sessionId: string): boolean {
  const session = data.sessions.find(s => s.id === sessionId);
  return !!session && !session.archived && data.activeSessionId === sessionId && ['进行中', '暂停'].includes(session.status) && sessionVisible(data, sessionId);
}

export function listeningArchivePreview(data: AppData, sessionId: string): { title: string; turns: number; scope: string; memory: boolean; space: string } | undefined {
  const session = data.sessions.find(s => s.id === sessionId);
  if (!session || !sessionVisible(data, sessionId)) return undefined;
  return { title: session.title, turns: session.transcript.length, scope: data.settings.retention['session-' + session.id] || '完整保存', memory: data.settings.toggles.memory !== false, space: data.settings.retention['session-space:' + session.id] || '我的空间' };
}
