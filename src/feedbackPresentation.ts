import type { AppData, Session, Task } from './store';
import { sessionVisible, taskVisible } from './sourceAccess';
import { taskBelongsToMe, taskClosed } from './taskWorkflow';

const anonymous = (name: string) => /未知|待确认|未确认|匿名|说话人|unknown|anonymous/i.test(name) || !name.trim();

/** The home status uses the current recording, never a recent finished session. */
export function activeHomeRecording(data: AppData): Session | undefined {
  return data.sessions.find(session => session.id === data.activeSessionId && !session.archived && ['进行中', '暂停'].includes(session.status) && sessionVisible(data, session.id));
}

export function homeDeviceSummary(data: AppData): string {
  const connected = Object.entries(data.settings.devices).filter(([, value]) => value).map(([name]) => {
    const offline = data.settings.retention[`device-status:${name}`] === '离线';
    const battery = data.settings.retention[`device-battery:${name}`];
    return `${name} · ${offline ? '示例离线' : '示例已连接'}${battery ? ` · ${battery}` : ''}`;
  });
  return connected.length ? connected[0] + (connected.length > 1 ? ` · 另有${connected.length - 1}台` : '') : '当前使用 App 示例 · 连接录音豆或桌面伙伴';
}

export function recordingPeople(data: AppData, session: Session) {
  const turns = session.transcript.filter(turn => data.settings.space === '我的空间' || !turn.private);
  const known = new Map<string, string>();
  const unknown = new Set<string>();
  for (const turn of turns) {
    if (turn.speaker === '我' && !turn.personId) { known.set('self', '我'); continue; }
    const person = turn.personId ? data.people.find(item => item.id === turn.personId) : undefined;
    const checked = data.settings.toggles[`speaker-confirmed:${session.id}:${turn.id}`] === true;
    if (person && checked && !anonymous(person.name)) known.set(person.id, person.name);
    else unknown.add(turn.personId || turn.speaker || turn.id);
  }
  return { names: [...known.values()], unknown: unknown.size, count: known.size + unknown.size };
}

export function homeAssistantWork(data: AppData): Task[] {
  const order: Record<Task['aiStatus'], number> = { '准备中': 0, '失败': 1, '待授权': 2, '草稿完成': 3, '已暂停': 4, '已停止': 5, '未启动': 6 };
  return data.tasks.filter(task => taskVisible(data, task) && taskBelongsToMe(data, task) && !taskClosed(task) && task.aiStatus !== '未启动')
    .sort((a, b) => order[a.aiStatus] - order[b.aiStatus]);
}

export function assistantStage(task: Task): string {
  if (task.sourceNeedsReview) return '来源变化，等待重新核对';
  if (task.needsReview && task.aiStatus === '草稿完成') return '草稿已准备，等你核对';
  return ({ '准备中': '正在按已确认要求准备', '待授权': '等待你允许本次准备', '草稿完成': '已有草稿，查看后继续推进', '已暂停': '已暂停，可继续或调整要求', '已停止': '已停止，保留已有内容', '失败': '准备中断，需要补充或重试', '未启动': '尚未开始准备' } as const)[task.aiStatus];
}

export function unknownConversationClues(data: AppData, personId?: string) {
  if (data.settings.space !== '我的空间') return [];
  return data.sessions.filter(session => sessionVisible(data, session.id) && !session.archived && session.status !== '待开始')
    .flatMap(session => session.transcript.filter(turn =>
      (personId && turn.personId === personId || anonymous(turn.speaker) && !turn.personId) &&
      data.settings.toggles[`speaker-confirmed:${session.id}:${turn.id}`] !== true
    ).map(turn => ({ session, turn, exactPerson: !!personId && turn.personId === personId })));
}

export function preferenceDraft(values: { role: string; focus: string; description: string; avoid: string }) {
  const description = values.description.trim();
  const tone = /步骤|分步|一步/.test(description) ? '逐步说明操作' : /探索|一起讨论|提问/.test(description) ? '先一起探索，再给建议' : '先结论，再给依据';
  const length = /简短|精简|一句|两句|少说/.test(description) ? '简短' : /详细|展开|充分/.test(description) ? '详细' : '适中';
  return { tone, length, customTone: description, focus: values.focus.trim(), avoid: values.avoid.trim(), role: values.role.trim() };
}
