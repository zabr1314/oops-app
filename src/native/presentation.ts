type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : '';
const rows = (value: unknown): RecordValue[] => Array.isArray(value) ? value.filter(object) : [];
export function nativeSourceFocus(turns: { id: string; time: string }[], target?: string): string | undefined {
  if (!target) return undefined;
  const exact = turns.find(turn => turn.id === target);
  if (exact) return exact.id;
  const timed = turns.filter(turn => turn.time === target);
  return timed.length === 1 ? timed[0].id : undefined;
}
export function nativeMinutesSections(response: unknown): { title: string; lines: string[] }[] {
  if (!object(response) || response.status !== 'ready' || !object(response.minutes)) return [];
  const m = response.minutes;
  return [
    { title: text(m.theme) || '会议概览', lines: [text(m.overview)].filter(Boolean) },
    { title: '待办', lines: rows(m.actions).map(row => [text(row.owner) || '负责人待确认', text(row.task), text(row.due)].filter(Boolean).join(' · ')) },
    { title: '决定', lines: rows(m.decisions).map(row => text(row.text)).filter(Boolean) },
    { title: '还没定的事', lines: rows(m.undecided).map(row => [text(row.topic), text(row.views)].filter(Boolean).join('：')) },
    { title: '讨论要点', lines: rows(m.topics).map(row => [text(row.topic), Array.isArray(row.points) ? row.points.filter(value => typeof value === 'string').join('；') : text(row.points)].filter(Boolean).join('：')) },
    { title: '待确认问题', lines: rows(m.open_questions).map(row => text(row.question)).filter(Boolean) },
    { title: '后续跟进', lines: rows(m.follow_ups).map(row => [text(row.title), text(row.start)].filter(Boolean).join(' · ')) },
  ].filter(section => section.lines.length > 0);
}
