import type { AppData } from './store';
import { makeSourceReference } from './sourceAccess';
import { normalizeMoment } from './dateLogic';

/** Recall is an independent saved snapshot, not a timestamp in a conversation. */
export function migrateStoredData(data: AppData): AppData {
  const retention = { ...data.settings.retention };
  let changed = false;
  const sessions=data.sessions.map(session=>({...session,transcript:session.transcript.map(turn=>{
    if(turn.personId||!data.settings.toggles[`speaker-confirmed:${session.id}:${turn.id}`])return turn;
    const matches=data.people.filter(person=>person.name===turn.speaker);
    if(matches.length!==1)return turn;
    changed=true;return {...turn,personId:matches[0].id};
  })}));
  const memories = data.memories.map(memory => {
    if (!memory.tags.includes('Recall') || memory.sourceSession || memory.sourceTime === undefined) return memory;
    changed = true;
    retention['recall-source:' + memory.id] ||= JSON.stringify({ savedTime: memory.sourceTime, body: memory.body, migrated: true });
    return { ...memory, sourceTime: undefined };
  });
  const next = { ...data, sessions, memories, settings: { ...data.settings, retention } };
  const tasks = data.tasks.map(task => {
    let updated = task;
    if(task.completion&&task.status!=='已完成'){
      changed=true;updated={...updated,completion:undefined,completionHistory:[...(task.completionHistory||[]),task.completion]};
    }
    const due=normalizeMoment(task.due),follow=task.nextFollowUp?normalizeMoment(task.nextFollowUp):undefined;
    if(due&&due!==task.due||follow&&follow!==task.nextFollowUp){changed=true;updated={...updated,due:due||task.due,nextFollowUp:follow||task.nextFollowUp};}
    if(task.inquiries?.some(item=>item.nextFollowUp&&normalizeMoment(item.nextFollowUp)&&normalizeMoment(item.nextFollowUp)!==item.nextFollowUp)){
      changed=true;updated={...updated,inquiries:task.inquiries.map(item=>({...item,nextFollowUp:item.nextFollowUp?normalizeMoment(item.nextFollowUp)||item.nextFollowUp:item.nextFollowUp}))};
    }
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
