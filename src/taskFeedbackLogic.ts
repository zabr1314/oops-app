import type { AppData, Task, TaskArtifact } from './store';
import { parseLocalMoment } from './dateLogic';
import { taskSourceAvailable, taskVisible } from './sourceAccess';
import { taskBelongsToMe, taskClosed, taskFollowedByMe, taskInquiries, taskIsMyAttention, taskOutputMode, taskRequestedByMe } from './taskWorkflow';

export type TaskTimeFilter = '全部时间' | '今天' | '本周' | '具体日期';
export type TaskHelpFilter = '全部任务' | '可让Oops帮忙' | '助手工作';
export type TaskListFilters = { time: TaskTimeFilter; date: string; status: string; relation: string; help: TaskHelpFilter; attention: boolean; priority: string };
export const TASK_OUTPUT_CHOICES = [
  { value: '资料整理', label: '资料要点' }, { value: '回复草稿', label: '跟进文字' },
  { value: '行动清单', label: '行动步骤' }, { value: '文档', label: '文档正文' },
  { value: '文档与PPT', label: '文档正文与汇报提纲' },
];
const pad = (part: number) => String(part).padStart(2, '0');
export function taskLocalDate(now: number | Date = Date.now()): string {
  const date = new Date(now); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function taskDateStart(value: string): number | undefined {
  const match = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number), date = new Date(year, month - 1, day);
  return year >= 2020 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : undefined;
}
export function taskTimeWindow(time: TaskTimeFilter, selectedDate: string, now: number | Date = Date.now()): { start: number; end: number } | undefined {
  if (time === '全部时间') return undefined;
  const day = time === '具体日期' ? taskDateStart(selectedDate) : taskDateStart(taskLocalDate(now));
  if (day === undefined) return undefined;
  const start = new Date(day); if (time === '本周') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const end = new Date(start); end.setDate(end.getDate() + (time === '本周' ? 7 : 1));
  return { start: start.getTime(), end: end.getTime() };
}
export function initialTaskListFilters(mode?: string, now: number | Date = Date.now()): TaskListFilters {
  return { time: '全部时间', date: taskLocalDate(now), status: '未结束', relation: mode === '待我处理' || mode?.startsWith('project:') ? '全部关系' : '我负责', help: mode === '助手工作' ? '助手工作' : '全部任务', attention: mode === '待我处理', priority: '全部优先级' };
}
export function taskScheduleMoment(data: AppData, task: Task, now: number | Date = Date.now()): number | undefined {
  const questionDates = taskInquiries(task).filter(inquiry => inquiry.status !== '已解决')
    .map(inquiry => parseLocalMoment(inquiry.nextFollowUp || task.nextFollowUp, now))
    .filter((moment): moment is number => moment !== undefined);
  if (questionDates.length) return Math.min(...questionDates);
  const value = taskBelongsToMe(data, task) ? task.due : task.transferRequest?.nextFollowUp || task.nextFollowUp || task.due;
  return parseLocalMoment(value, now);
}
export function taskHelpSummary(data: AppData, task: Task): { possible: boolean; label: string; route: string; prepare: string; missing: string[]; personal: string } {
  const prepare = ({ '资料整理': '整理已选资料的要点', '回复草稿': '起草可修改的跟进文字', '行动清单': '拆成可检查的行动步骤', '文档': '整理文档正文草稿', '文档与PPT': '整理正文与汇报提纲' } as Record<string, string>)[taskOutputMode(task)] || '整理任务要求与下一步';
  const missing = taskInquiries(task).filter(item => item.status !== '已解决').map(item => item.question);
  const base = { prepare, missing, personal: '你仍需核对事实、对外沟通并记录实际结果' };
  if (!taskVisible(data, task)) return { ...base, possible: false, label: '当前空间不可用', route: 'task-detail' };
  if (taskClosed(task)) return { ...base, possible: false, label: '查看已保存结果', route: 'task-result' };
  if (!taskBelongsToMe(data, task)) return { ...base, possible: false, label: '由负责人决定准备范围', route: 'task-ask' };
  if (task.status === '待转交') return { ...base, possible: false, label: '先查看转交回应', route: 'task-transfer-response' };
  if (!taskSourceAvailable(data, task)) return { ...base, missing: ['来源与资料待核对', ...missing], possible: true, label: '核对来源后让Oops帮忙', route: 'task-edit' };
  if (task.status === '待承接') return { ...base, possible: true, label: '承接后让Oops帮忙', route: 'task-accept' };
  if (task.aiStatus === '准备中') return { ...base, possible: true, label: '查看Oops准备进度', route: 'task-progress' };
  return { ...base, possible: true, label: '让Oops帮我准备', route: 'task-plan' };
}
export function taskMatchesList(data: AppData, task: Task, filters: TaskListFilters, query = '', now: number | Date = Date.now()): boolean {
  if (!taskVisible(data, task)) return false;
  if (filters.relation === '我负责' && !taskBelongsToMe(data, task) || filters.relation === '我提出' && !taskRequestedByMe(data, task) || filters.relation === '我跟进' && !taskFollowedByMe(data, task)) return false;
  if (filters.attention && !taskIsMyAttention(data, task, now)) return false;
  if (filters.status === '未结束' && taskClosed(task) || filters.status === '已结束' && !taskClosed(task)) return false;
  if (filters.status === '来源待核对' && taskSourceAvailable(data, task)) return false;
  if (filters.status === '待核对成果' && !(task.needsReview || task.status === '待验收')) return false;
  if (filters.status === '进行中' && !['已承接', '进行中'].includes(task.status)) return false;
  if (!['全部状态', '未结束', '已结束', '来源待核对', '待核对成果', '进行中'].includes(filters.status) && task.status !== filters.status) return false;
  if (filters.help === '可让Oops帮忙' && !taskHelpSummary(data, task).possible || filters.help === '助手工作' && task.aiStatus === '未启动') return false;
  if (filters.priority !== '全部优先级' && task.priority !== filters.priority.replace('优先级', '')) return false;
  if (filters.time !== '全部时间') {
    const window = taskTimeWindow(filters.time, filters.date, now), moment = taskScheduleMoment(data, task, now);
    if (!window || moment === undefined || moment < window.start || moment >= window.end) return false;
  }
  return `${task.title} ${task.description} ${task.requester} ${task.owner}`.toLowerCase().includes(query.trim().toLowerCase());
}
export function taskDateGroup(data: AppData, task: Task, now: number | Date = Date.now()): string {
  if (taskClosed(task)) return '已结束';
  const moment = taskScheduleMoment(data, task, now), today = taskTimeWindow('今天', '', now)!;
  if (moment === undefined) return '无固定期限';
  if (moment < today.start) return '此前到期';
  if (moment < today.end) return '今天';
  return '之后';
}
export function taskArtifactMode(ids: string[]): string { return 'artifacts:' + ids.map(encodeURIComponent).join(','); }
export function taskArtifactEntry(all: TaskArtifact[], mode?: string): { ids?: string[]; missing: boolean } {
  if (!mode) return { missing: false };
  if (all.some(artifact => artifact.id === mode)) return { ids: [mode], missing: false };
  if (!mode.startsWith('artifacts:')) return { ids: [], missing: true };
  let ids: string[]; try { ids = mode.slice(10).split(',').filter(Boolean).map(decodeURIComponent); } catch { return { ids: [], missing: true }; }
  const unique = [...new Set(ids)], present = unique.filter(id => all.some(artifact => artifact.id === id));
  return { ids: present, missing: present.length !== unique.length };
}
