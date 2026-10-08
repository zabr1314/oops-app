/** Task dates are local wall-clock times, stored as YYYY-MM-DDTHH:mm. */
export function parseLocalMoment(value?: string, now: number | Date = Date.now()): number | undefined {
  if (!value?.trim() || value.trim() === '无固定期限') return undefined;
  const match = value.trim().match(/^(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})(?:日)?[ T]*(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const year = Number(match[1] || new Date(now).getFullYear());
  const [month, day, hour, minute] = match.slice(2).map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  if (year < 2020 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) return undefined;
  return date.getTime();
}

export function formatLocalMoment(value: number | Date): string {
  const date = new Date(value), pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function normalizeMoment(value: string, now: number | Date = Date.now()): string | undefined {
  const parsed = parseLocalMoment(value, now);
  return parsed === undefined ? undefined : formatLocalMoment(parsed);
}
