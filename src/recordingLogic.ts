import type { AppData, Transcript } from './store';

export type SaveScope = '完整保存' | '仅保存非敏感片段' | '手动选择片段';
export function preferredSaveScope(data: AppData, sessionId: string): SaveScope {
  const preference = data.settings.retention['session-' + sessionId];
  if (preference === '结束后选择片段' || preference === '手动选择片段') return '手动选择片段';
  return preference === '仅保存非敏感片段' ? preference : '完整保存';
}
export function retainedTranscript(transcript: Transcript[], scope: SaveScope, ids: string[]): Transcript[] {
  const selected = new Set(ids);
  return transcript.filter(turn => scope === '完整保存' || (scope === '仅保存非敏感片段' ? !turn.private : selected.has(turn.id)));
}
