import type { AppData, Route, Session, Task, Transcript } from './store';
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

export type IdentityClue = { session: Session; turn: Transcript; exactPerson: boolean };
function clueDateValue(clue: IdentityClue, reference = new Date()) {
  const date = clue.session.date;
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(reference);
  const part = (type: string) => Number(parts.find(value => value.type === type)?.value || 0);
  let year = part('year'), month = part('month'), day = part('day');
  const full = date.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})(?:日)?/);
  const short = date.match(/(?:^|\s)(\d{1,2})[月/-](\d{1,2})(?:日)?/);
  if (full) { year = Number(full[1]); month = Number(full[2]); day = Number(full[3]); }
  else if (short) { month = Number(short[1]); day = Number(short[2]); }
  else if (/今天|今日|昨天|昨日|前天/.test(date)) day -= /前天/.test(date) ? 2 : /昨天|昨日/.test(date) ? 1 : 0;
  else return undefined;
  if (month < 1 || month > 12 || (full || short) && (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())) return undefined;
  const clock = date.match(/(\d{1,2}):(\d{2})/);
  const hour = Number(clock?.[1] || 0), minute = Number(clock?.[2] || 0);
  if (hour > 23 || minute > 59) return undefined;
  const offset = clue.turn.time.split(':').reduce((total, value) => total * 60 + (Number(value) || 0), 0);
  return Date.UTC(year, month - 1, day, hour - 8, minute) + offset * 1000;
}
function recentIdentityClues(clues: IdentityClue[], reference?: Date) {
  return [...clues].sort((a, b) => (clueDateValue(b, reference) ?? -Infinity) - (clueDateValue(a, reference) ?? -Infinity));
}
/** A person's card may show only its explicit ID bindings, never the anonymous pool. */
export function personIdentityClues(data: AppData, personId: string, reference?: Date): IdentityClue[] {
  if (!data.people.some(person => person.id === personId)) return [];
  return recentIdentityClues(unknownConversationClues(data, personId).filter(clue => clue.exactPerson), reference);
}
/** Unbound passages are offered separately and require an explicit person selection. */
export function unboundIdentityClues(data: AppData, reference?: Date): IdentityClue[] {
  return recentIdentityClues(unknownConversationClues(data).filter(clue => !clue.turn.personId), reference);
}
export function identityClueTopics(clue: IdentityClue): string[] {
  const words = ['资料', '预算', '会议', '任务', '设计', '库存', 'PPT', '用户', '方案', '项目', '数据', '时间', '期限', '进度', '体验', '目标', '协作', '同步', '复盘', '指标', '产品', '研发', '计划', '日程'];
  return words.filter(word => clue.turn.text.toLowerCase().includes(word.toLowerCase())).sort((a, b) => clue.turn.text.toLowerCase().indexOf(a.toLowerCase()) - clue.turn.text.toLowerCase().indexOf(b.toLowerCase())).slice(0, 3);
}
export function identityClueRoute(clue: IdentityClue, personId?: string, create = false): Route {
  return { view: 'memory-unknown', ...(personId ? { id: personId } : {}), mode: JSON.stringify({ sessionId: clue.session.id, turnId: clue.turn.id, create }) };
}
/** Share/deep links cannot preselect another person's bound or now unavailable passage. */
export function identityClueSelection(data: AppData, personId: string | undefined, mode: string | undefined) {
  try {
    const value: unknown = JSON.parse(mode || '');
    if (!value || typeof value !== 'object') return undefined;
    const input = value as { sessionId?: unknown; turnId?: unknown; create?: unknown };
    if (typeof input.sessionId !== 'string' || typeof input.turnId !== 'string') return undefined;
    const clues = personId ? [...personIdentityClues(data, personId), ...unboundIdentityClues(data)] : unboundIdentityClues(data);
    const clue = clues.find(item => item.session.id === input.sessionId && item.turn.id === input.turnId);
    return clue ? { ...clue, create: input.create === true } : undefined;
  } catch { return undefined; }
}

export function preferenceDraft(values: { role: string; focus: string; description: string; avoid: string }) {
  const description = values.description.trim();
  const tone = /步骤|分步|一步/.test(description) ? '逐步说明操作' : /探索|一起讨论|提问/.test(description) ? '先一起探索，再给建议' : '先结论，再给依据';
  const length = /简短|精简|一句|两句|少说/.test(description) ? '简短' : /详细|展开|充分/.test(description) ? '详细' : '适中';
  return { tone, length, customTone: description, focus: values.focus.trim(), avoid: values.avoid.trim(), role: values.role.trim() };
}
