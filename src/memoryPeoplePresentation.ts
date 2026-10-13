import type { AppData, Memory, Route, Session, Transcript } from './store';
import { PERSONAL_SPACE, provenanceAvailable, sessionVisible, sourceAvailable } from './sourceAccess';

const TEAM_SPACE = 'Oops 产品团队';
const anonymous = (name: string) => !name.trim() || /未知|待确认|未确认|匿名|说话人|候选|unknown|anonymous/i.test(name);
const contentWords = ['用户访谈', '资料卡', '截止时间', '供应链', '可售', '现货', '预留', 'KPI', 'PPT', '预算', '库存', '复盘', '资料', '设计', '研发', '交付', '体验', '招聘', '合同', '成本', '营销', '沟通', '表达', '指标', '方案', '目标'];

export type PersonContentTopic = { label: string; session: Session; turn: Transcript; route: Route };

/** Labels quote current, explicitly attributed content; they are not inferred interests. */
export function personContentTopics(data: AppData, personId: string, sessionOrder: string[] = []): PersonContentTopic[] {
  const person = data.people.find(value => value.id === personId);
  const personal = data.settings.space === PERSONAL_SPACE;
  if (!person || anonymous(person.name) || !personal && (!person.shared || (data.settings.retention['person-space:' + person.id] || TEAM_SPACE) !== data.settings.space)) return [];
  const sessions = [...data.sessions].sort((a, b) => {
    const rank = (id: string) => { const index = sessionOrder.indexOf(id); return index < 0 ? Infinity : index; };
    return rank(a.id) - rank(b.id);
  });
  const topics: PersonContentTopic[] = [];
  for (const session of sessions) {
    if (session.archived || session.status === '待开始' || !sessionVisible(data, session.id)) continue;
    for (const turn of session.transcript) {
      if (turn.personId !== person.id || data.settings.toggles[`speaker-confirmed:${session.id}:${turn.id}`] !== true || !sourceAvailable(data, { sourceSession: session.id, sourceId: turn.id }, { publicOnly: !personal, requireShared: !personal })) continue;
      const text = turn.text.toLowerCase();
      const matches = contentWords.filter(word => text.includes(word.toLowerCase()));
      const words = matches.filter(word => !matches.some(longer => longer.length > word.length && longer.toLowerCase().includes(word.toLowerCase())))
        .sort((a, b) => text.indexOf(a.toLowerCase()) - text.indexOf(b.toLowerCase()));
      for (const label of words) if (!topics.some(topic => topic.label.toLowerCase() === label.toLowerCase())) topics.push({ label, session, turn, route: { view: 'session-transcript', id: session.id, mode: turn.id } });
    }
  }
  return topics.slice(0, 6);
}

/** Only stored absolute timestamps are displayed as exact profile update times. */
export function profileUpdatedAt(data: AppData, kind: 'identity' | 'preferences'): string | undefined {
  const value = data.settings.retention[`${kind}-updated-at`];
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
}

export function profileUpdateLabel(data: AppData, kind: 'identity' | 'preferences'): string {
  const value = profileUpdatedAt(data, kind);
  return value ? '更新于 ' + new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(value)) : '更新时间未记录';
}

/** Personal understanding uses confirmed current evidence, never a personality inference. */
export function understandingEvidence(data: AppData): { backgrounds: Memory[]; goals: Memory[] } {
  if (data.settings.space !== PERSONAL_SPACE) return { backgrounds: [], goals: [] };
  const eligible = data.memories.filter(memory => !memory.deleted && memory.confirmed && !memory.needsReview && !memory.tags.some(tag => ['修订历史', '待复核', '待确认', '已停用'].includes(tag)) && sourceAvailable(data, memory) && provenanceAvailable(data, memory.sources));
  return {
    backgrounds: eligible.filter(memory => memory.category !== '目标' && memory.tags.some(tag => ['身份', '偏好', '沟通习惯', '角色背景'].includes(tag))),
    goals: eligible.filter(memory => memory.category === '目标'),
  };
}
