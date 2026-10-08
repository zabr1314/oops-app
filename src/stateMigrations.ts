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
    let updated = task;
    if (!task.sourceSession && !task.sourceMemoryId) {
      const savedId = task.activities.map(activity => activity.match(/^来自已保存片段 (\S+)$/)?.[1]).find(Boolean);
      const memory = memories.find(item => item.id === savedId && item.tags.includes('Recall'));
      if (memory) {
        changed = true;
        updated = { ...updated, sourceMemoryId: memory.id, sources: [...(task.sources || []), makeSourceReference(next, { kind: 'memory', id: memory.id })] };
      }
    }
    if (updated.inquiries === undefined && updated.questions?.length) {
      changed = true;
      updated = { ...updated, inquiries: updated.questions.map((question, index) => ({ id: `${task.id}-legacy-question-${index}`, question, status: '待回答' as const, target: task.requester, nextFollowUp: '' })) };
    }
    if (updated.aiStatus === '准备中') {
      changed = true;
      updated = { ...updated, aiStatus: '已停止', authorized: false, generationToken: undefined, generationSnapshot: undefined, activities: [...updated.activities, '页面重新打开，未完成的本地准备已停止；已有成果保留'] };
    }
    return updated;
  });
  return changed ? { ...next, tasks } : data;
}
