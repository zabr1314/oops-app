import type { Task, TaskInquiry } from './store';

export const taskClosed = (task: Task) => ['已完成', '已取消', '已拒绝'].includes(task.status);
export function taskInquiries(task: Task): TaskInquiry[] {
  return task.inquiries || (task.questions || []).map((question, index) => ({ id: `legacy-question:${task.id}:${index}`, question, status: '待回答' as const }));
}
function reached(value: string | undefined, now: number): boolean {
  if (!value || value === '无固定期限') return false;
  const parsed = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(parsed) && parsed <= now;
}
export function taskAttentionReason(task: Task, now: number | Date = Date.now()): string | null {
  const at = now instanceof Date ? now.getTime() : now;
  if (taskClosed(task)) return null;
  if (task.sourceNeedsReview) return '核对变化后的来源';
  if (task.status === '待承接') return '核对并承接';
  if (task.status === '待转交') return reached(task.transferRequest?.nextFollowUp || task.nextFollowUp, at) ? '跟进转交回应' : null;
  if (task.aiStatus === '失败' || task.failure) return '补充资料后继续';
  const inquiries = taskInquiries(task);
  if (inquiries.some(inquiry => inquiry.status === '已回答')) return '核对收到的答复';
  if (inquiries.some(inquiry => inquiry.status === '待回答' && reached(inquiry.nextFollowUp || task.nextFollowUp, at))) return '跟进待回答问题';
  if (task.needsReview) return '核对助手草稿';
  if (task.status === '待验收') return '检查本次交付';
  if (reached(task.nextFollowUp, at)) return '到时间跟进这项工作';
  if (reached(task.due, at)) return '期限已到，核对进度';
  return null;
}
