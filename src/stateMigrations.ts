import type { AppData } from './store';
import { makeSourceReference } from './sourceAccess';

/** Recall is an independent saved snapshot, not a timestamp in a conversation. */
export function migrateStoredData(data: AppData): AppData {
  const retention = { ...data.settings.retention };
  let changed = false;
  const memories = data.memories.map(memory => {
    if (!memory.tags.includes('Recall') || memory.sourceSession || memory.sourceTime === undefined) return memory;
    changed = true;
    retention['recall-source:' + memory.id] ||= JSON.stringify({ savedTime: memory.sourceTime, body: memory.body, migrated: true });
    return { ...memory, sourceTime: undefined };
  });
  const next = { ...data, memories, settings: { ...data.settings, retention } };
  const tasks = data.tasks.map(task => {
    if (task.sourceSession || task.sourceMemoryId) return task;
    const savedId = task.activities.map(activity => activity.match(/^来自已保存片段 (\S+)$/)?.[1]).find(Boolean);
    const memory = memories.find(item => item.id === savedId && item.tags.includes('Recall'));
    if (!memory) return task;
    changed = true;
    return { ...task, sourceMemoryId: memory.id, sources: [...(task.sources || []), makeSourceReference(next, { kind: 'memory', id: memory.id })] };
  });
  return changed ? { ...next, tasks } : data;
}
