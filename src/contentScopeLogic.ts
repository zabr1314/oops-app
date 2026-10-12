import type { AppData } from './store';

const PERSONAL = '我的空间';
const LEGACY_TEAM = 'Oops 产品团队';
const bindingKey = /^(?:session|memory|person|project|material|task)-space:/;

/** Existing ranges remain reachable; choosing one never creates a team or permission. */
export function contentScopes(data: AppData): string[] {
  const names = new Set<string>([PERSONAL, LEGACY_TEAM]);
  const add = (value: unknown) => { if (typeof value === 'string' && value.trim()) names.add(value); };
  try {
    const saved: unknown = JSON.parse(data.settings.retention.spaces || 'null');
    if (Array.isArray(saved)) saved.forEach(row => {
      if (row && typeof row === 'object' && 'name' in row) add(row.name);
    });
  } catch { /* Object bindings below keep legacy content reachable. */ }
  add(data.settings.space);
  Object.entries(data.settings.retention).forEach(([key, value]) => { if (bindingKey.test(key)) add(value); });
  return [...names];
}

/** Reject unrecognized names instead of implicitly joining/creating a workspace. */
export function selectContentScope(data: AppData, space: string): AppData {
  if (space === data.settings.space || !contentScopes(data).includes(space)) return data;
  return { ...data, settings: { ...data.settings, space } };
}
