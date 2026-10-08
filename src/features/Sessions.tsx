import { useEffect, useRef, useState, type RefObject } from 'react';
import { useOops, type AppData, type Route, type Session, type Transcript, type Memory, type Task } from '../store';
import { Avatar, Badge, Button, Card, Check, Chips, Empty, Field, Icon, Notice, Row, Search, SectionTitle, SelectField, Sheet, Source, Tabs, Toggle } from '../ui';
import { useViewState } from '../viewState';
import { sharedMemoryEligible } from '../memoryAccess';
import { findSourceTask, invalidateSessionSources, makeSourceReference, provenanceAvailable, sourceAvailable, taskSourceAvailable, taskVisible } from '../sourceAccess';
import { buildReviewItems, finishSessionReviewRound, openActionDraft, restoreSessionRevision, reviewDraftSourceMode, sessionNeedsReview, setSessionShared, type ReviewDraft, type SessionReviewItem } from '../sessionLogic';
import { confirmPersonSpeakers } from './MemorySettings';
import './Sessions.css';

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const clock = (n: number) => `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const seconds = (s: string) => s.split(':').reduce((n, x) => n * 60 + Number(x || 0), 0);
const dateLabel = () => new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
const flag = (data: AppData, key: string) => data.settings.toggles[key] === true;
const canViewSession = (data: AppData, session: Session) => data.settings.space === '我的空间' || (flag(data, `shared-${session.id}`) && (data.settings.retention[`session-space:${session.id}`] || 'Oops 产品团队') === data.settings.space);
const materialKey = (sessionId: string, title: string) => `material-shared:${sessionId}:${title}`;
type SourcedMaterial = Memory & { sourceId?: string; needsReview?: boolean };
type RecordMark = { id: string; time: string; sourceId?: string; sourceTime?: string; note?: string };
const materialEligible = (data: AppData, session: Session, title: string) => {
  const current = data.sessions.find(s => s.id === session.id);
  if (!current || !current.attachments.includes(title)) return false;
  const space = data.settings.space === '我的空间' ? data.settings.retention[`session-space:${session.id}`] || 'Oops 产品团队' : data.settings.space;
  const scoped = { ...data, settings: { ...data.settings, space } };
  return data.memories.filter(m => m.sourceSession === current.id && m.title === title).every(item => sharedMemoryEligible(data, item) && provenanceAvailable(scoped, item.sources));
};
const canShareMaterial = (data: AppData, session: Session, title: string) => flag(data, `shared-${session.id}`) && flag(data, materialKey(session.id, title)) && materialEligible(data, session, title) && !data.memories.some(m => m.sourceSession === session.id && m.title === title && m.visibility === '私有') && (data.settings.space === '我的空间' || (data.settings.retention[`material-space:${session.id}:${title}`] || data.settings.retention[`session-space:${session.id}`] || 'Oops 产品团队') === data.settings.space);
const agendaKeywords = (topic: string) => [...new Set([...(topic.match(/[A-Za-z][A-Za-z0-9-]+/g) || []).map(x => x.toLowerCase()), ...(topic.match(/[一-鿿]+/g) || []).flatMap(word => Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2)))])].filter(x => !['讨论', '关于', '确认', '安排', '议题', '流程', '方案', '我们', '今天', '进行'].includes(x));

type ReviewableTask = Task & { relatedSessionId?: string; sourceId?: string; needsReview?: boolean; generationToken?: string };
const patchSession = (data: AppData, id: string, change: Partial<Session>): AppData => ({ ...data, sessions: data.sessions.map(s => s.id === id ? { ...s, ...change } : s) });
const putFlag = (data: AppData, key: string, value: boolean): AppData => ({ ...data, settings: { ...data.settings, toggles: { ...data.settings.toggles, [key]: value } } });
const untitled = (kind: Session['kind']) => `${kind} · ${dateLabel()}`;
const unknownSpeaker = (name: string) => /待确认|说话人|未知/.test(name);
const visibleTask = (data: AppData, task: Task, publicOnly = false) => {
  const t = task as ReviewableTask;
  const scoped = publicOnly && data.settings.space === '我的空间' ? { ...data, settings: { ...data.settings, space: data.settings.retention[`session-space:${t.sourceSession || t.relatedSessionId}`] || 'Oops 产品团队' } } : data;
  return taskVisible(scoped, task);
};
const readList = (value?: string): string[] => { try { const rows = JSON.parse(value || '[]'); return Array.isArray(rows) ? rows.filter(x => typeof x === 'string') : []; } catch { return []; } };
const digest = (session: Session, publicOnly = false) => session.transcript.filter(t => !publicOnly || !t.private).slice(-5).map(t => `${t.speaker}：${t.text}`).filter(Boolean);
const turnLabel = (turn: Transcript, session?: Session) => turn.time || `片段${Math.max(0, session?.transcript.findIndex(t => t.id === turn.id) ?? 0) + 1} · 时间未提供`;
const sourceMatch = (item: { sourceId?: string; sourceTime?: string }, turn: Transcript) => item.sourceId !== undefined ? item.sourceId === turn.id : !!item.sourceTime && item.sourceTime === turn.time;
const sessionTasks = (data: AppData, session: Session, publicOnly = false) => data.tasks.filter(task => (task.sourceSession === session.id || (task as ReviewableTask).relatedSessionId === session.id) && visibleTask(data, task, publicOnly));
type ReviewItem = SessionReviewItem;
function reviewItems(data: AppData, session: Session): ReviewItem[] {
  try { const items = JSON.parse(data.settings.retention[`session-review-items:${session.id}`] || '[]'); return Array.isArray(items) ? items.filter(x => x && typeof x.id === 'string' && typeof x.text === 'string' && ['conclusion', 'question'].includes(x.kind)) : []; } catch { return []; }
}
function sharedReviewEligible(data: AppData, session: Session, item: ReviewItem) {
  return item.confirmed && !flag(data, `review-${session.id}`) && (item.sourceId === undefined || !!item.sourceId && session.transcript.some(turn => turn.id === item.sourceId && !turn.private));
}
function confirmedReview(data: AppData, session: Session, publicOnly = false): ReviewItem[] {
  const items = reviewItems(data, session);
  if (publicOnly) return items.filter(item => item.shared && sharedReviewEligible(data, session, item) && flag(data, `shared-${session.id}`));
  if (items.length) return items.filter(item => item.confirmed);
  return [ ...readList(data.settings.retention[`session-conclusions:${session.id}`]).map((text, i) => ({ id: `legacy-c-${i}`, text, kind: 'conclusion' as const, confirmed: true, shared: false })), ...readList(data.settings.retention[`session-questions:${session.id}`]).map((text, i) => ({ id: `legacy-q-${i}`, text, kind: 'question' as const, confirmed: true, shared: false })) ];
}
function reviewQueue(data: AppData, session: Session) {
  const items: { id: string; kind: 'identity' | 'task' | 'memory' | 'source'; title: string; body: string; route: Route }[] = [];
  if (flag(data, `review-${session.id}`)) items.push({ id: `source-${session.id}`, kind: 'source', title: '来源变化，核对本次结论', body: '旧结论与相关输出保持待复核；不扩大原保存范围。', route: { view: 'session-review-edit', id: session.id } });
  session.transcript.filter(t => unknownSpeaker(t.speaker)).filter((t, i, all) => all.findIndex(x => x.speaker === t.speaker) === i).forEach(t => items.push({ id: `identity-${t.id}`, kind: 'identity', title: `核对${t.speaker}`, body: t.text, route: { view: 'session-identity', id: session.id, mode: t.id } }));
  sessionTasks(data, session).filter(t => t.status === '待承接' || t.needsReview || t.sourceNeedsReview).forEach(t => items.push({ id: `task-${t.id}`, kind: 'task', title: t.title, body: (t as ReviewableTask).needsReview ? '来源有变化，先重新核对要求。' : '核对要求后决定承接，助手授权另行选择。', route: { view: 'task-detail', id: t.id } }));
  data.memories.filter(m => !m.deleted && !m.confirmed && m.sourceSession === session.id && !m.tags.includes('修订历史')).forEach(m => items.push({ id: `memory-${m.id}`, kind: 'memory', title: m.title, body: m.body, route: { view: 'memory-candidate', id: m.id } }));
  return items;
}
const DEMO = [
  ['我', '这次先把首版的记录、资料返回和任务确认跑通。'],
  ['王宁', '演示预算先按十万元安排，超出需要重新确认。'],
  ['说话人 D', '把查到的资料放在当前议题旁边，大家需要时再打开。'],
  ['Alex', '这三项演示费用加起来是十三万元，需要再核对预算。'],
  ['王宁', '请先准备第三季度KPI复盘框架，再做六页PPT，缺数据先问我。'],
  ['我', '先查蓝色椅子B-108的库存资料，再确认今天有没有出入库。'],
];
const DAILY_DEMO = [['我', '下午要问同事素材准备到哪一步。'], ['未知来访者', '资料链接稍后发你，先留下刚才的想法。'], ['我', '留成私人便签，不用替我发送消息。']];
const IDEA_DEMO = [['我', '桌面伙伴用一个抬头或轻轻闪烁，反馈它正在听。'], ['我', '关键是日常陪伴，不需要不停说话。'], ['我', '先整理一分钟口播提纲，再找朋友验证是否理解。']];

/** Mount once in the shared shell, so changing bottom tabs does not stop sample input. */
export function useSessionRecorder() {
  const { data, update } = useOops();
  const active = data.sessions.find(s => s.id === data.activeSessionId);
  const recallStarted = data.settings.retention['recall-window-start'];
  useEffect(() => {
    if ((!active || active.status !== '进行中') && !recallStarted) return;
    const interval = window.setInterval(() => update(current => {
      const start = Number(current.settings.retention['recall-window-start']);
      if (start && Date.now() - start >= 300000 && !current.recallCleared) {
        const retention = { ...current.settings.retention };
        delete retention['recall-window-start'];
        current = { ...current, recallCleared: true, settings: { ...current.settings, retention } };
      }
      const s = current.sessions.find(x => x.id === current.activeSessionId);
      if (!s || s.status !== '进行中') return current;
      const elapsed = seconds(s.duration) + 1;
      const script = s.kind === '日常' ? DAILY_DEMO : s.kind === '灵感' ? IDEA_DEMO : s.kind === '练习' ? [['我', '我的结论是先把主流程跑通，依据是用户需要能连续完成记录、复盘和任务确认。']] : DEMO;
      const index = Number(current.settings.retention[`sample-index:${s.id}`]) || s.transcript.filter(t => t.id.startsWith('sample-')).length;
      let transcript = s.transcript;
      let attachments = s.attachments;
      let tasks = current.tasks;
      if (index < script.length && elapsed % 4 === 0) {
        const line: Transcript = { id: `sample-${s.id}-${index}`, speaker: script[index][0], time: clock(elapsed), text: script[index][1] };
        transcript = [...transcript, line];
        if (s.kind === '会议' && index === 2 && !attachments.includes('会中资料卡 · 返回方式')) attachments = [...attachments, '会中资料卡 · 返回方式'];
        if (s.kind === '会议' && index === 5 && !attachments.includes('B-108 库存资料 · 示例')) attachments = [...attachments, 'B-108 库存资料 · 示例'];
        if (s.kind === '会议' && index === 4) tasks = [...tasks, { id: uid('TASK'), title: '准备第三季度KPI复盘', description: line.text, owner: '我', requester: '王宁', due: '', priority: '中', status: '待承接', aiStatus: '未启动', relatedSessionId: s.id, sourceSession: s.id, sourceId: line.id, sourceTime: line.time, activities: ['示例讨论形成待承接建议'], results: [], version: 1 }];
      }
      return { ...patchSession(current, s.id, { transcript, attachments, participants: [...new Set([...s.participants, ...transcript.map(t => t.speaker)])], duration: elapsed >= 3600 ? clock(elapsed) : clock(elapsed).slice(3) }), tasks, settings: { ...current.settings, retention: { ...current.settings.retention, [`sample-index:${s.id}`]: String(transcript === s.transcript ? index : index + 1) } } };
    }), 1000);
    return () => window.clearInterval(interval);
  }, [active?.id, active?.status, recallStarted, update]);
}

export function sessionTitle(route: Route): string {
  const titles: Record<string, string> = { sessions: '会话', 'session-mode': '开始一段记录', 'session-create': '创建记录', 'session-import': '导入内容', 'session-import-preview': '检查导入', 'session-material-import': '添加本次资料', 'session-review': '逐项核对', 'session-review-edit': '编辑本次结果', 'session-detail': '会话', 'session-transcript': '会话', 'session-edit': '修订片段', 'session-identity': '确认说话人', 'session-source': '资料详情', 'session-agenda': '议程', 'session-map': '讨论结构', 'session-display': '大屏预览', 'session-reminders': '会议提醒', 'session-share': '共享范围', 'session-export': '导出预览', 'session-recall': 'Recall · 最近5分钟', 'session-recall-save': '保存所选片段', 'session-growth': '表达练习', 'session-inspiration': '灵感与联系草稿', 'session-history': '问已有记录', 'session-revisions': '修订历史' };
  return titles[route.view] || '会话';
}

export default function Sessions() {
  const { data, route, navigate, back } = useOops();
  if (route.view === 'sessions') return <SessionList />;
  if (route.view === 'session-mode') return <QuickStart />;
  if (route.view === 'session-create') return route.id && data.settings.space !== '我的空间' ? <Empty title="在个人空间编辑准备" body="共同视角不读取个人准备草稿。" action="返回" onAction={back} /> : <CreateSession key={route.id || route.mode || 'new'} />;
  if (route.view.startsWith('session-import')) return <ImportSession />;
  if (route.view.startsWith('session-recall')) return <Recall />;
  if (route.view === 'session-history') return <HistoryQuestion />;
  const session = data.sessions.find(s => s.id === route.id);
  if (session && data.settings.space !== '我的空间' && (!canViewSession(data, session) || ['session-edit', 'session-identity', 'session-growth', 'session-inspiration', 'session-revisions', 'session-review', 'session-review-edit', 'session-material-import'].includes(route.view))) return <Empty title="这项内容属于个人空间" body="当前空间仅显示明确共享的会话与非敏感内容。" action="返回" onAction={back} />;
  if (!session) return <Empty title="还没有这段记录" body="从会话列表选择一段，或开始新的记录。" action="所有会话" onAction={() => navigate({ view: 'sessions' })} />;
  if (route.view === 'session-edit') return <EditTranscript key={`${route.id}-${route.mode}`} session={session} />;
  if (route.view === 'session-identity') return <Identity key={`${route.id}-${route.mode}`} session={session} />;
  if (route.view === 'session-source') return <Material session={session} />;
  if (['session-share', 'session-export'].includes(route.view)) return <Sharing session={session} />;
  if (['session-agenda', 'session-map', 'session-display', 'session-reminders'].includes(route.view)) return <MeetingTools session={session} />;
  if (route.view === 'session-growth') return <Practice session={session} />;
  if (route.view === 'session-inspiration') return <CreativeSummary session={session} />;
  if (route.view === 'session-revisions') return <RevisionHistory session={session} />;
  if (route.view === 'session-material-import') return <ImportMaterial session={session} />;
  if (route.view === 'session-review') return <ReviewQueue session={session} />;
  if (route.view === 'session-review-edit') return <ReviewEditor session={session} />;
  return <SessionExperience session={session} />;
}

function useReadingPosition(root: RefObject<HTMLDivElement | null>, key: string, anchor?: string) {
  const [saved, setSaved] = useViewState<number>(key, 0);
  useEffect(() => {
    const element = root.current;
    const scroll = element?.closest<HTMLElement>('.mobile-scroll');
    if (!element || !scroll) return;
    let frame = 0, timer: ReturnType<typeof setTimeout> | undefined;
    frame = requestAnimationFrame(() => {
      const target = anchor ? Array.from(element.querySelectorAll<HTMLElement>('[data-turn-id]')).find(node => node.dataset.turnId === anchor) : undefined;
      scroll.scrollTop = target ? Math.max(0, scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 80) : saved;
    });
    const remember = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => setSaved(scroll.scrollTop), 120); };
    scroll.addEventListener('scroll', remember, { passive: true });
    return () => { cancelAnimationFrame(frame); if (timer) clearTimeout(timer); setSaved(scroll.scrollTop); scroll.removeEventListener('scroll', remember); };
  }, [key, anchor]);
}

function sessionDateValue(session: Session) {
  const today = new Date();
  const relative = session.date.includes('昨天') ? -1 : session.date.includes('今天') ? 0 : undefined;
  const parts = session.date.match(/(?:(\d{4})[年/.-])?(\d{1,2})[月/.-](\d{1,2})/);
  const time = session.date.match(/(\d{1,2}):(\d{2})/);
  return new Date(parts?.[1] ? Number(parts[1]) : today.getFullYear(), relative !== undefined ? today.getMonth() : parts ? Number(parts[2]) - 1 : today.getMonth(), relative !== undefined ? today.getDate() + relative : parts ? Number(parts[3]) : today.getDate(), Number(time?.[1] || 0), Number(time?.[2] || 0)).getTime();
}
function sessionDay(session: Session) {
  const date = new Date(sessionDateValue(session)), today = new Date();
  const delta = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86400000);
  return delta === 0 ? '今天' : delta === 1 ? '昨天' : `${date.getMonth() + 1}月${date.getDate()}日`;
}
const needsSessionReview = (data: AppData, session: Session) => sessionNeedsReview(data, session, data.settings.space === '我的空间' ? reviewQueue(data, session).length : 0);

function SessionList() {
  const { data, update, navigate, toast, route } = useOops();
  const root = useRef<HTMLDivElement>(null);
  const visibleProjects = data.projects.filter(p => data.settings.space === '我的空间' || (data.settings.retention[`project-space:${p.id}`] || 'Oops 产品团队') === data.settings.space);
  const projectContext = visibleProjects.some(p => p.name === route.mode) ? route.mode! : 'all';
  const [filters, setFilters] = useViewState(`session-list:${data.settings.space}:${projectContext}`, { query: '', project: projectContext === 'all' ? '全部项目' : projectContext, kind: '全部', status: '全部', archive: '未归档' });
  const [filterOpen, setFilterOpen] = useState(false), [selected, setSelected] = useState<Session | null>(null), [recycleOpen, setRecycleOpen] = useState(false);
  useReadingPosition(root, `session-list-scroll:${data.settings.space}:${projectContext}`);
  const change = (key: keyof typeof filters, value: string) => setFilters(current => ({ ...current, [key]: value }));
  const clear = () => setFilters({ query: '', project: '全部项目', kind: '全部', status: '全部', archive: '未归档' });
  const deleted = Object.entries(data.settings.retention).filter(([key]) => key.startsWith('deleted-session:')).flatMap(([, value]) => { try { return [JSON.parse(value) as Session]; } catch { return []; } });
  const rows = data.sessions.filter(s => canViewSession(data, s) && (filters.project === '全部项目' || s.project === filters.project) && (filters.archive === '全部记录' || filters.archive === '已归档' ? filters.archive === '全部记录' || s.archived : !s.archived) && (filters.kind === '全部' || s.kind === filters.kind) && (filters.status === '全部' || filters.status === '待核对' ? filters.status === '全部' || needsSessionReview(data, s) : s.status === filters.status) && `${s.title} ${s.project} ${s.transcript.filter(t => data.settings.space === '我的空间' || !t.private).map(t => t.text).join(' ')}`.toLowerCase().includes(filters.query.trim().toLowerCase())).sort((a, b) => sessionDateValue(b) - sessionDateValue(a));
  const groups = new Map<string, Session[]>();
  for (const s of rows) {
    const group = s.id === data.activeSessionId && ['进行中', '暂停'].includes(s.status) ? '正在记录' : needsSessionReview(data, s) ? '待核对' : s.status === '待开始' ? '计划记录' : sessionDay(s);
    groups.set(group, [...groups.get(group) || [], s]);
  }
  const ordered = [...['正在记录', '待核对', '计划记录'].filter(k => groups.has(k)), ...Array.from(groups.keys()).filter(k => !['正在记录', '待核对', '计划记录'].includes(k))];
  const filterCount = Number(filters.project !== '全部项目') + Number(filters.kind !== '全部') + Number(filters.status !== '全部') + Number(filters.archive !== '未归档');
  return <div className="stack sessions-feature" ref={root}>
    <Button icon="microphone" onClick={() => navigate({ view: 'session-mode' })}>开始记录</Button>
    <div className="session-list-search"><Search value={filters.query} onChange={v => change('query', v)} placeholder="搜索记录或原话" /><button className="session-filter-button" onClick={() => setFilterOpen(true)} aria-label="筛选记录"><Icon name="sliders-horizontal" size={20} />{filterCount > 0 && <b>{filterCount}</b>}</button></div>
    <div className="session-list-secondary"><button onClick={() => navigate({ view: 'session-import' })}><Icon name="upload-simple" size={17} />导入已有记录</button><span>{rows.length}段记录{filterCount ? ' · 已筛选' : ''}</span></div>
    {filterCount > 0 && <div className="session-filter-summary"><span>{[filters.project !== '全部项目' && filters.project, filters.kind !== '全部' && filters.kind, filters.status !== '全部' && filters.status, filters.archive !== '未归档' && filters.archive].filter(Boolean).join(' · ')}</span><button onClick={clear}>清除</button></div>}
    {ordered.map(group => <section className="session-list-group" key={group}><SectionTitle>{group}</SectionTitle>{groups.get(group)!.map(s => {
      const tasks = sessionTasks(data, s), needsReview = needsSessionReview(data, s), personal = data.settings.space === '我的空间';
      const action = needsReview ? '查看并核对' : s.id === data.activeSessionId ? '继续当前记录' : tasks.some(t => !['已完成', '已取消', '已拒绝'].includes(t.status)) ? `${tasks.filter(t => !['已完成', '已取消', '已拒绝'].includes(t.status)).length}项行动跟进中` : s.status === '待开始' ? '准备后开始' : '查看已保存内容';
      return <div className="session-list-item" key={s.id}><Card onClick={() => navigate({ view: s.status === '待开始' ? 'session-create' : 'session-detail', id: s.id })}><div className="session-card-top"><span className="session-kind"><Icon name={s.kind === '会议' ? 'users-three' : s.kind === '灵感' ? 'lightbulb' : 'waveform'} /></span><Badge tone={needsReview ? 'amber' : s.id === data.activeSessionId ? 'purple' : 'gray'}>{s.archived ? '已归档' : needsReview ? '待核对' : s.status === '已结束' && personal ? '已核对' : s.status}</Badge></div><h3>{s.title}</h3><p className="meta">{s.date} · {s.duration || '待开始'} · {s.kind}</p><p className="session-preview">{(personal ? confirmedReview(data, s).find(x => x.kind === 'conclusion')?.text || s.summary[0] : digest(s, true)[0]) || s.agenda[0] || '名称与计划可稍后补充'}</p><div className="session-card-bottom"><span>{s.project || '个人记录'}</span><strong>{action}</strong></div></Card>{personal && <button className="session-more" aria-label={`管理${s.title}`} onClick={() => setSelected(s)}><Icon name="dots-three" /></button>}</div>;
    })}</section>)}
    {!rows.length && <Empty title="没有匹配记录" body="换个关键词，或调整筛选条件。" action="清除筛选" onAction={clear} />}
    <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="筛选记录"><SelectField label="项目" value={filters.project} onChange={v => change('project', v)} options={['全部项目', ...visibleProjects.map(p => p.name)]} /><SelectField label="记录类型" value={filters.kind} onChange={v => change('kind', v)} options={['全部', '会议', '日常', '灵感', '练习', 'Recall']} /><SelectField label="状态" value={filters.status} onChange={v => change('status', v)} options={['全部', '进行中', '暂停', '待开始', '待核对', '已结束']} /><SelectField label="归档" value={filters.archive} onChange={v => change('archive', v)} options={['未归档', '已归档', '全部记录']} /><Button onClick={() => setFilterOpen(false)}>查看筛选结果</Button><Button tone="quiet" onClick={clear}>清除全部条件</Button></Sheet>
    {data.settings.space === '我的空间' && <Row title="会话回收站" subtitle={`${deleted.length}条可恢复记录`} icon="trash" onClick={() => setRecycleOpen(true)} />}
    <Sheet open={recycleOpen} onClose={() => setRecycleOpen(false)} title="已删除的会话">{deleted.length ? deleted.map(item => <Row key={item.id} title={item.title} subtitle="恢复为私人记录，关联输出仍需复核" onClick={() => { update(c => { const retention = { ...c.settings.retention }; delete retention[`deleted-session:${item.id}`]; return invalidateSessionSources({ ...c, sessions: [{ ...item, archived: false, status: item.status === '进行中' ? '暂停' : item.status }, ...c.sessions.filter(x => x.id !== item.id)], settings: { ...c.settings, space: '我的空间', retention, toggles: { ...c.settings.toggles, [`shared-${item.id}`]: false } } }, item.id, undefined, '来源会话恢复，重新核对后使用'); }); setRecycleOpen(false); toast('已恢复私人记录，关联输出保持待复核'); navigate({ view: 'session-detail', id: item.id }); }} />) : <Empty title="回收站是空的" body="删除的记录会保留到本地重置。" />}</Sheet>
    <Sheet open={!!selected} onClose={() => setSelected(null)} title={selected?.title || '管理记录'}>{selected && <><Button tone="secondary" onClick={() => { navigate({ view: 'session-create', id: selected.id }); setSelected(null); }}>编辑名称与准备</Button><Button tone="secondary" onClick={() => { if (!selected.archived && data.activeSessionId === selected.id) { toast('先结束当前记录，再归档'); return; } update(c => patchSession(c, selected.id, { archived: !selected.archived })); toast(selected.archived ? '记录已恢复' : '记录已归档'); setSelected(null); }}>{selected.archived ? '恢复记录' : '归档记录'}</Button><Button tone="danger" onClick={() => { if (data.activeSessionId === selected.id) { toast('先结束当前记录，再删除'); return; } update(c => invalidateSessionSources({ ...c, sessions: c.sessions.filter(s => s.id !== selected.id), settings: { ...c.settings, retention: { ...c.settings.retention, [`deleted-session:${selected.id}`]: JSON.stringify(selected) }, toggles: { ...c.settings.toggles, [`shared-${selected.id}`]: false } } }, selected.id, undefined, '来源记录已删除')); toast('已删除记录，关联输出保留待复核'); setSelected(null); }}>确认删除这段记录</Button></>}</Sheet>
  </div>;
}

function QuickStart() {
  const { data, update, route, navigate, toast, requestEnd } = useOops();
  const kinds: Session['kind'][] = ['会议', '日常', '灵感', '练习'];
  const recent = data.settings.retention['record-last-kind'];
  const [kind, setKind] = useState<Session['kind']>(kinds.includes(route.mode as Session['kind']) ? route.mode as Session['kind'] : kinds.includes(recent as Session['kind']) ? recent as Session['kind'] : '会议');
  const active = data.sessions.find(x => x.id === data.activeSessionId && ['进行中', '暂停'].includes(x.status));
  const activeVisible = !!active && canViewSession(data, active);
  function continueActive() {
    if (!active) return;
    if (data.settings.space !== '我的空间') update(c => ({ ...c, settings: { ...c.settings, space: '我的空间' } }));
    navigate({ view: 'session-detail', id: active.id });
  }
  function start() {
    if (active) { continueActive(); return; }
    const id = uid('session');
    const record: Session = { id, title: untitled(kind), kind, date: dateLabel(), duration: '00:00', status: '进行中', transcript: [], summary: [], agenda: [], participants: ['我'], attachments: [], privateNotes: [], project: '个人记录' };
    update(c => ({ ...c, sessions: [record, ...c.sessions], activeSessionId: id, settings: { ...c.settings, space: '我的空间', toggles: { ...c.settings.toggles, [`shared-${id}`]: false }, retention: { ...c.settings.retention, 'record-last-kind': kind, [`session-${id}`]: '完整保存' } } }));
    toast('本地示例记录已开始，名称与参与者可稍后补充'); navigate({ view: 'session-detail', id });
  }
  return <div className="stack session-quickstart"><div className="session-start-heading"><Icon name="microphone" size={30} /><h2>先把这一刻留下</h2><p>名称、项目和参与者，之后再补。</p></div>{active && <Card className="session-active-card"><Badge>{activeVisible ? active.status : '活动记录'}</Badge><h3>{activeVisible ? active.title : '另一个空间已有活动记录'}</h3><p className="meta">{activeVisible ? `${active.duration} · 同时保留一段活动记录` : '回到我的空间后，可继续或结束这段记录。'}</p><Button icon="arrow-right" onClick={continueActive}>{activeVisible ? '继续当前记录' : '回到当前记录'}</Button>{activeVisible && data.settings.space === '我的空间' && <Button tone="secondary" onClick={() => { update(c => ({ ...c, settings: { ...c.settings, retention: { ...c.settings.retention, 'record-next-kind': kind } } })); requestEnd(active.id); }}>结束后新建</Button>}</Card>}<SectionTitle>这次用来做什么？</SectionTitle><div className="session-kind-grid">{kinds.map(k => <button key={k} type="button" className={kind === k ? 'selected' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}><Icon name={{会议:'users-three',日常:'chat-circle',灵感:'lightbulb',练习:'sparkle',Recall:'clock-counter-clockwise'}[k]} size={24} /><strong>{k}</strong><small>{{会议:'留下讨论与行动',日常:'随手记住沟通',灵感:'接住零散想法',练习:'练习清楚表达',Recall:''}[k]}</small></button>)}</div><div className="session-start-scope"><span><Icon name="waveform" size={16} />本地示例输入</span><span><Icon name="lock-key" size={16} />保存到我的空间</span></div><Button disabled={!!active} icon="play" onClick={start}>现在开始</Button><p className="meta">预设内容演示，不打开麦克风。默认只有“我”，其他声音出现后再核对。</p><Row title="完整会议准备" subtitle="可选名称、项目、成员与议程" icon="list-checks" onClick={() => navigate({ view: 'session-create', mode: kind })} /><Row title="找回最近5分钟" subtitle="短期暂存，选择后才长期留下" icon="clock-counter-clockwise" onClick={() => navigate({ view: 'session-recall' })} /><Row title="导入已有内容" subtitle="粘贴文字或选择本地文件" icon="upload-simple" onClick={() => navigate({ view: 'session-import' })} /></div>;
}

function CreateSession() {
  const { data, update, route, navigate, toast, requestEnd } = useOops();
  const existing = data.sessions.find(s => s.id === route.id);
  const savedScope = data.settings.retention[`session-${existing?.id}`];
  const [draft, setDraft] = useViewState(`session-prepare:${route.id || 'new'}:${route.id ? '' : route.mode || '会议'}:${data.settings.space}`, { title: existing?.title || '', kind: existing?.kind || (route.mode as Session['kind']) || '会议', project: existing?.project || '个人记录', members: existing?.participants || ['我'], agenda: existing?.agenda.join('\n') || '', allowShare: existing ? flag(data, `shared-${existing.id}`) : false, scope: savedScope === '结束后选择片段' ? '手动选择片段' : ['完整保存', '手动选择片段', '仅保存非敏感片段'].includes(savedScope || '') ? savedScope : '完整保存' });
  const { title, kind, project, members, agenda, allowShare, scope } = draft;
  const setTitle = (title: string) => setDraft(d => ({ ...d, title })), setKind = (kind: Session['kind']) => setDraft(d => ({ ...d, kind })), setProject = (project: string) => setDraft(d => ({ ...d, project })), setAgenda = (agenda: string) => setDraft(d => ({ ...d, agenda })), setAllowShare = (allowShare: boolean) => setDraft(d => ({ ...d, allowShare })), setScope = (scope: string) => setDraft(d => ({ ...d, scope }));
  const setMembers = (value: string[] | ((members: string[]) => string[])) => setDraft(d => ({ ...d, members: typeof value === 'function' ? value(d.members) : value }));
  const [error, setError] = useState('');
  const visiblePeople = data.people.filter(p => data.settings.space === '我的空间' || p.shared && (data.settings.retention[`person-space:${p.id}`] || 'Oops 产品团队') === data.settings.space);
  const visibleProjects = data.projects.filter(p => data.settings.space === '我的空间' || (data.settings.retention[`project-space:${p.id}`] || 'Oops 产品团队') === data.settings.space);
  const active = data.sessions.find(x => x.id === data.activeSessionId && ['进行中', '暂停'].includes(x.status));
  const activeVisible = !!active && canViewSession(data, active);
  function continueActive() {
    if (!active) return;
    if (data.settings.space !== '我的空间') update(c => ({ ...c, settings: { ...c.settings, space: '我的空间' } }));
    navigate({ view: 'session-detail', id: active.id });
  }
  const busy = !!active && active.id !== existing?.id;
  function save(start: boolean) {
    if (kind === 'Recall') { navigate({ view: 'session-recall' }); return; }
    if (start && busy) { setError('先继续或结束当前记录，再开始新的记录'); return; }
    const reuse = existing && !(start && existing.status === '已结束');
    const id = reuse ? existing.id : uid('session');
    const name = title.trim() || untitled(kind);
    const record: Session = { id, title: start && existing?.status === '已结束' ? `${name} · 后续` : name, kind, project: project || '个人记录', date: reuse ? existing.date : dateLabel(), duration: reuse ? existing.duration || '00:00' : '00:00', status: start ? '进行中' : existing?.status || '待开始', participants: members.length ? members : ['我'], agenda: agenda.split('\n').map(x => x.trim()).filter(Boolean), transcript: reuse ? existing.transcript : [], attachments: reuse ? existing.attachments : [], summary: reuse ? existing.summary : [], privateNotes: reuse ? existing.privateNotes : [], ...(reuse ? { archived: start ? false : existing.archived } : {}) };
    update(c => {
      const saved = { ...c, sessions: reuse ? c.sessions.map(x => x.id === id ? { ...x, title: record.title, kind: record.kind, project: record.project, participants: record.participants, agenda: record.agenda, status: start ? '进行中' as const : x.status, archived: start ? false : x.archived } : x) : [record, ...c.sessions], activeSessionId: start ? id : c.activeSessionId };
      const shared = setSessionShared(saved, id, allowShare);
      return { ...shared, settings: { ...shared.settings, space: allowShare ? shared.settings.space : '我的空间', retention: { ...shared.settings.retention, 'record-last-kind': kind, [`session-${id}`]: scope, [`session-space:${id}`]: reuse ? shared.settings.retention[`session-space:${id}`] || 'Oops 产品团队' : c.settings.space === '我的空间' ? 'Oops 产品团队' : c.settings.space } } };
    });
    toast(start ? '本地示例记录已开始' : '可选准备已保存'); navigate({ view: start ? 'session-detail' : 'sessions', id: start ? id : undefined });
  }
  return <form id="oops-session-prepare-form" className="stack session-prepare" onSubmit={e => { e.preventDefault(); save(true); }}><Notice>本地示例输入 · {allowShare ? '共同纪要可供所选项目查看' : '保存到我的空间'}。以下准备均可稍后补充。</Notice>{busy && <Card className="session-active-card"><Badge>{activeVisible ? active.status : '活动记录'}</Badge><h3>{activeVisible ? '已有一段活动记录' : '另一个空间已有活动记录'}</h3><p>{activeVisible ? active.title : '回到我的空间后，可继续或结束这段记录。'}</p><Button tone="secondary" onClick={continueActive}>{activeVisible ? '继续当前记录' : '回到当前记录'}</Button>{activeVisible && data.settings.space === '我的空间' && <Button tone="quiet" onClick={() => { update(c => ({ ...c, settings: { ...c.settings, retention: { ...c.settings.retention, 'record-next-kind': kind } } })); requestEnd(active.id); }}>结束后再新建</Button>}</Card>}<Field label="记录名称（可选）" value={title} onChange={setTitle} placeholder="留空会使用类型与当前时间命名" /><SelectField label="记录方式" value={kind} options={['会议', '日常', '灵感', '练习', 'Recall']} onChange={v => setKind(v as Session['kind'])} /><SelectField label="关联项目（可选）" value={project} options={['个人记录', ...visibleProjects.map(p => p.name)]} onChange={setProject} /><Card><SectionTitle>计划参与者（可选）</SectionTitle><p className="meta">选择成员不代表已经识别声音；也可以记录后再核对。</p>{['我', ...visiblePeople.map(p => p.name)].filter((x, i, a) => a.indexOf(x) === i).map(name => <Check key={name} label={name} value={members.includes(name)} onChange={checked => setMembers(a => checked ? [...a, name] : a.filter(x => x !== name))} />)}<Field label="临时参与者" value={members.filter(x => !['我', ...visiblePeople.map(p => p.name)].includes(x)).join('、')} onChange={v => setMembers(a => [...a.filter(x => ['我', ...visiblePeople.map(p => p.name)].includes(x)), ...v.split(/[、,，]/).map(x => x.trim()).filter(Boolean)])} placeholder="可稍后填写，用顿号分隔" /></Card><Field label={kind === '会议' ? '议程与目标（可选）' : '想留下什么（可选）'} value={agenda} onChange={setAgenda} multiline hint="每行一个主题；空白也可以开始。" /><SelectField label="结束后的保留方式" value={scope} options={['完整保存', '手动选择片段', '仅保存非敏感片段']} onChange={setScope} /><Toggle label="允许项目内查看共同纪要" value={allowShare} onChange={setAllowShare} hint="默认私有；私人便签、敏感片段与未选资料不会共享。" />{error && <p className="error-text" role="alert">{error}</p>}<Button tone="secondary" onClick={() => save(false)}>保存准备，稍后开始</Button></form>;
}

export function parseImportedTranscript(content: string, prefix = 'import'): Transcript[] {
  return content.split('\n').map(line => line.trim()).filter(Boolean).map((line, index) => {
    const supplied = line.match(/^((?:\d{2}:)?\d{2}:\d{2})\s+/);
    const validTime = supplied && supplied[1].split(':').slice(-2).every(part => Number(part) < 60) ? supplied[1] : '';
    const rest = validTime ? line.slice(supplied![0].length) : line;
    const speaker = rest.match(/^([^：:]{1,18})[：:]\s*(.*)$/);
    return { id: `${prefix}-${index + 1}`, speaker: speaker?.[1] || '导入文本', time: validTime, text: speaker?.[2] || rest };
  });
}

function ImportSession() {
  const { data, update, navigate, toast } = useOops();
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useViewState(`session-import-draft:${data.settings.space}`, { title: '', content: '', kind: '会议' as Session['kind'] });
  const [file, setFile] = useState<{ name: string; size: string; type: string } | null>(null), [preview, setPreview] = useState(false), [error, setError] = useState('');
  const lines = parseImportedTranscript(draft.content);
  async function readFile(f?: File) {
    if (!f) return;
    setFile({ name: f.name, size: `${(f.size / 1024).toFixed(1)} KB`, type: f.type || '未知格式' });
    let content = draft.content;
    if (f.type.startsWith('text/') || /\.(txt|md)$/i.test(f.name)) content = await f.text();
    else if (!f.type.startsWith('audio/')) setError('只解析TXT/Markdown；其他文件保留文件信息');
    setDraft(current => ({ ...current, title: current.title || f.name.replace(/\.[^.]+$/, ''), content })); setPreview(false);
  }
  function create() {
    if (!draft.title.trim()) { setError('填写记录名称'); return; }
    if (!lines.length && !file) { setError('粘贴文字或选择文件'); return; }
    const id = uid('session');
    const record: Session = { id, title: draft.title.trim(), kind: draft.kind, project: '个人记录', date: dateLabel(), duration: '时长未提供', status: '已结束', participants: [...new Set(lines.map(l => l.speaker))], transcript: lines, attachments: file ? [file.name] : [], privateNotes: [], agenda: [], summary: [] };
    update(c => ({ ...c, sessions: [record, ...c.sessions], settings: { ...c.settings, space: '我的空间', toggles: { ...c.settings.toggles, [`shared-${id}`]: false } } }));
    setDraft({ title: '', content: '', kind: '会议' }); toast('已建立私人记录，未补造音频时间'); navigate({ view: 'session-detail', id, mode: '概览' });
  }
  return <div className="stack"><Field label="记录名称" value={draft.title} onChange={title => setDraft(current => ({ ...current, title }))} placeholder="给导入内容起个名字" /><SelectField label="内容类型" value={draft.kind} options={['会议', '日常', '灵感', '练习']} onChange={kind => setDraft(current => ({ ...current, kind: kind as Session['kind'] }))} /><Field label="粘贴文字" value={draft.content} onChange={content => { setDraft(current => ({ ...current, content })); setPreview(false); }} multiline placeholder="可粘贴原文。已有时间请保留，例如 00:01:20 王宁：先确认预算…" /><input type="file" ref={fileRef} hidden accept="audio/*,.txt,.md" onChange={e => void readFile(e.target.files?.[0])} /><Button tone="secondary" icon="paperclip" onClick={() => fileRef.current?.click()}>选择文本或音频</Button>{file && <Card><strong>{file.name}</strong><p className="meta">{file.size} · {file.type}</p>{file.type.startsWith('audio/') && <Notice>只保存文件信息，音频转写未接通。</Notice>}</Card>}<p className="meta">未提供时间的文字按片段编号引用，不推算录音时长。</p>{error && <p className="error-text">{error}</p>}<Button onClick={() => { if (!draft.content.trim() && !file) { setError('先添加内容'); return; } setPreview(true); setError(''); }}>预览导入</Button>{preview && <><SectionTitle>预览 · {lines.length}段</SectionTitle>{lines.length ? lines.map((t, i) => <TranscriptCard key={t.id} item={t} label={t.time || `片段${i + 1} · 时间未提供`} />) : <Empty title="文件尚无转写" body="建立资料记录后，可继续补充文字。" />}<Button onClick={create}>确认建立私人记录</Button></>}</div>;
}

function ImportMaterial({ session: s }: { session: Session }) {
  const { update, navigate, toast } = useOops();
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useViewState(`material-import:${s.id}:我的空间`, { title: '', body: '', sourceId: '' });
  const [file, setFile] = useState<{ name: string; size: string } | null>(null), [error, setError] = useState('');
  const source = s.transcript.find(t => t.id === draft.sourceId);
  const label = (t: Transcript) => `${turnLabel(t, s)} ${t.speaker} · ${t.id}`;
  async function read(f?: File) {
    if (!f) return;
    setFile({ name: f.name, size: `${(f.size / 1024).toFixed(1)} KB` });
    const parsed = f.type.startsWith('text/') || /\.(txt|md)$/i.test(f.name) ? await f.text() : '';
    setDraft(current => ({ ...current, title: current.title || f.name, body: parsed || current.body }));
  }
  function save() {
    if (!draft.title.trim() || !draft.body.trim() && !file) { setError('填写资料名称，并添加文字或文件'); return; }
    if (draft.sourceId && !source) { setError('引用的原话已移除，请重新核对'); return; }
    const title = draft.title.trim(), id = uid('MAT');
    update(current => {
      const session = current.sessions.find(item => item.id === s.id);
      const origin = session?.transcript.find(t => t.id === draft.sourceId);
      if (!session || draft.sourceId && !origin) return current;
      const memory: Memory = { id, title, body: draft.body.trim() || `${file!.name} · ${file!.size}\n仅文件信息，尚未解析正文。`, category: '收藏', tags: ['资料', '手工添加'], visibility: '私有', updated: dateLabel(), confirmed: true, sourceSession: s.id, ...(origin ? { sourceId: origin.id, sourceTime: origin.time || undefined } : {}) };
      return { ...patchSession(current, s.id, { attachments: [...new Set([...session.attachments, title])] }), memories: [memory, ...current.memories] };
    });
    setDraft({ title: '', body: '', sourceId: '' }); toast('资料已加到本次会话，保持私人'); navigate({ view: 'session-detail', id: s.id, mode: '资料' });
  }
  return <div className="stack"><p className="meta">添加到「{s.title}」</p><Field label="资料名称" value={draft.title} onChange={title => setDraft(current => ({ ...current, title }))} /><Field label="资料文字" value={draft.body} onChange={body => setDraft(current => ({ ...current, body }))} multiline /><SelectField label="关联原话（可选）" value={source ? label(source) : '手工添加，无原话出处'} options={['手工添加，无原话出处', ...s.transcript.map(label)]} onChange={value => setDraft(current => ({ ...current, sourceId: s.transcript.find(t => label(t) === value)?.id || '' }))} /><input type="file" ref={fileRef} hidden accept=".txt,.md,.pdf,.xlsx,.xls,audio/*" onChange={e => void read(e.target.files?.[0])} /><Button tone="secondary" icon="paperclip" onClick={() => fileRef.current?.click()}>选择本地资料</Button>{file && <Card><strong>{file.name}</strong><p className="meta">{file.size} · 文本以外仅保留文件信息</p></Card>}{error && <p className="error-text">{error}</p>}<Button onClick={save}>加到本次资料</Button><Button tone="quiet" onClick={() => navigate({ view: 'session-detail', id: s.id, mode: '资料' })}>取消</Button></div>;
}

function TranscriptCard({ item, active = false, onClick, label }: { item: Transcript; active?: boolean; onClick?: () => void; label?: string }) {
  return <Card className={`session-transcript ${active ? 'highlighted' : ''}`} onClick={onClick}><div className="session-speaker"><Avatar name={item.speaker} /><strong>{item.speaker}</strong><span>{label || item.time || '时间未提供'}</span>{item.private && <Badge tone="gray">私有</Badge>}</div><p>{item.text}</p></Card>;
}

type SessionReaderState = { tab: string; query: string; speaker: string; view: string; note: string };
export const sessionReaderKey = (sessionId: string, space: string) => `session-reader:${sessionId}:${space}`;
const readerInitial = (active: boolean): SessionReaderState => ({ tab: active ? '现场' : '概览', query: '', speaker: '全部', view: '我的视角', note: '' });
export const normalizeSessionTab = (tab: string, active: boolean) => tab === '现场' && !active ? '概览' : tab === '概览' && active ? '现场' : ({ 转写: '原文', 任务: '行动', 复盘: active ? '现场' : '概览' } as Record<string, string>)[tab] || tab;
export function SessionTabBar() {
  const { data, route } = useOops();
  const session = data.sessions.find(item => item.id === route.id);
  const active = !!session && session.id === data.activeSessionId && ['进行中', '暂停'].includes(session.status);
  const [reader, setReader] = useViewState(sessionReaderKey(route.id || '', data.settings.space), readerInitial(active));
  if (!session || !canViewSession(data, session) || !['session-detail', 'session-transcript'].includes(route.view)) return null;
  return <Tabs items={[active ? '现场' : '概览', '原文', '资料', '行动']} value={normalizeSessionTab(reader.tab, active)} onChange={tab => setReader(current => ({ ...current, tab }))} />;
}

function SessionExperience({ session: s }: { session: Session }) {
  const { data, update, route, navigate, toast, requestEnd } = useOops();
  const root = useRef<HTMLDivElement>(null);
  const active = s.id === data.activeSessionId && ['进行中', '暂停'].includes(s.status);
  const team = data.settings.space !== '我的空间';
  const [reader, setReader] = useViewState(sessionReaderKey(s.id, data.settings.space), readerInitial(active));
  const [draft, setDraft] = useViewState(`session-task-draft:${s.id}:${data.settings.space}`, { title: '', body: '', due: '', sourceId: '', another: false });
  const [lookup, setLookup] = useViewState(`session-research:${s.id}:${data.settings.space}`, { query: '', sourceId: '', topic: '' });
  const [selectedId, setSelectedId] = useState(''), [toolsOpen, setToolsOpen] = useState(false), [noteOpen, setNoteOpen] = useState(false), [researchOpen, setResearchOpen] = useState(false), [taskOpen, setTaskOpen] = useState(false), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState('1倍速'), [playId, setPlayId] = useState('');
  const [, setReviewReturn] = useViewState(`session-review-return:${s.id}:我的空间`, '');
  const shared = team || reader.view === '共享纪要';
  const currentTranscript = s.transcript.filter(t => !shared || !t.private);
  const transcript = currentTranscript.filter(t => (reader.speaker === '全部' || t.speaker === reader.speaker) && `${t.text}${t.speaker}`.includes(reader.query));
  const modeTabs: Record<string, string> = { 转写: '原文', 原文: '原文', 任务: '行动', 行动: '行动', 复盘: '概览', 概览: '概览', 资料: '资料', 现场: active ? '现场' : '概览' };
  const tab = normalizeSessionTab(reader.tab, active);
  const routeSource = route.mode && !modeTabs[route.mode] ? currentTranscript.find(t => t.id === route.mode || !!t.time && t.time === route.mode) : undefined;
  const anchor = routeSource && transcript.some(t => t.id === routeSource.id) ? routeSource.id : undefined;
  useReadingPosition(root, `session-position:${s.id}:${data.settings.space}:${tab}`, anchor);
  useEffect(() => {
    const desired = route.view === 'session-transcript' ? '原文' : modeTabs[route.mode || ''];
    if (desired || routeSource) setReader(current => ({ ...current, tab: routeSource ? '原文' : desired!, ...(routeSource ? { query: '', speaker: '全部' } : {}) }));
  }, [route.view, route.mode, s.id]);
  useEffect(() => { setReviewReturn(''); }, [s.id, route.view]);
  const attachments = s.attachments.filter(name => !shared || canShareMaterial(data, s, name));
  const tasks = sessionTasks(data, s, shared), pending = tasks.filter(t => t.status === '待承接');
  const unknown = [...new Set(currentTranscript.filter(t => unknownSpeaker(t.speaker)).map(t => t.speaker))];
  const selected = currentTranscript.find(t => t.id === selectedId);
  const foundTask = selected ? findSourceTask(data, { sourceSession: s.id, sourceId: selected.id }) : undefined;
  const selectedTask = foundTask && visibleTask(data, foundTask, shared) ? foundTask : undefined;
  const selectedMemory = selected ? data.memories.find(m => !m.deleted && m.sourceSession === s.id && !m.tags.includes('修订历史') && !m.tags.includes('资料') && sourceMatch(m, selected)) : undefined;
  const chosenSource = currentTranscript.find(t => t.id === draft.sourceId);
  const label = (t: Transcript) => `${turnLabel(t, s)} ${t.speaker} · ${t.id}`;
  const open = (view: string, mode?: string) => navigate({ view, id: s.id, mode });
  function switchTab(value: string) { setPlaying(false); setReader(current => ({ ...current, tab: value })); }
  function openTask(source?: Transcript, another = false) {
    setSelectedId(''); setDraft(previous => openActionDraft(previous, source, another)); setTaskOpen(true);
  }
  function showResearch(source?: Transcript) {
    setSelectedId(''); setLookup(current => ({ ...current, sourceId: source?.id || '', topic: source ? '' : s.kind === '会议' ? s.agenda[Number(data.settings.retention[`agenda-${s.id}`] || 0)] || '' : '' })); setResearchOpen(true);
  }
  function createTask() {
    if (!draft.title.trim() || !draft.body.trim()) { toast('填写行动名称和具体要求'); return; }
    if (draft.sourceId && !chosenSource) { toast('所选来源已变化，请重新选择'); return; }
    const found = chosenSource && findSourceTask(data, { sourceSession: s.id, sourceId: chosenSource.id });
    const existing = found && visibleTask(data, found, shared) ? found : undefined;
    if (existing && !draft.another) { setTaskOpen(false); toast('这段原话已有行动，可直接查看'); navigate({ view: 'task-detail', id: existing.id }); return; }
    const id = uid('TASK');
    const task: Task = { id, title: draft.title.trim(), description: draft.body.trim(), owner: '我', requester: '我', due: draft.due, priority: '中', status: '待承接', aiStatus: '未启动', relatedSessionId: s.id, ...(chosenSource ? { sourceSession: s.id, sourceId: chosenSource.id, sourceTime: chosenSource.time || undefined } : {}), activities: [chosenSource ? `从${turnLabel(chosenSource, s)}手工整理，尚未承接或授权助手` : `手工关联会话「${s.title}」，没有原话出处`], results: [], version: 1 };
    update(current => ({ ...current, tasks: [task, ...current.tasks], settings: { ...current.settings, retention: { ...current.settings.retention, [`task-space:${id}`]: current.settings.space } } }));
    setDraft({ title: '', body: '', due: '', sourceId: '', another: false }); setTaskOpen(false); switchTab('行动'); toast('行动草稿已留在本次会话');
  }
  function candidate(source: Transcript, another = false) {
    const existing = data.memories.find(m => !m.deleted && m.sourceSession === s.id && !m.tags.includes('修订历史') && !m.tags.includes('资料') && sourceMatch(m, source));
    if (existing && !another) { navigate({ view: existing.confirmed ? 'memory-detail' : 'memory-candidate', id: existing.id }); return; }
    const memory: Memory = { id: uid('MEM'), title: `${source.speaker} · ${source.text.slice(0, 22)}`, body: source.text, category: s.kind === '灵感' ? '灵感' : '记忆', tags: ['待确认', '复盘候选', s.project], visibility: '私有', updated: dateLabel(), confirmed: false, sourceSession: s.id, sourceId: source.id, sourceTime: source.time || undefined };
    update(current => ({ ...current, memories: [memory, ...current.memories] })); setSelectedId(''); toast('已留为私人候选，确认后才长期记住');
  }
  function research() {
    if (!lookup.query.trim()) return;
    const source = currentTranscript.find(t => t.id === lookup.sourceId);
    if (lookup.sourceId && !source) { toast('查询所关联的原话已变化，请重新选择'); return; }
    const stock = /库存|椅子|B-108/i.test(lookup.query);
    const base = stock ? 'B-108 库存资料 · 示例' : `${lookup.query.slice(0, 18)} · 本地资料`;
    const count = s.attachments.filter(name => name === base || name.startsWith(`${base}（`)).length;
    const title = count ? `${base}（${count + 1}）` : base;
    const project = data.projects.find(p => p.name === s.project && (!shared || (data.settings.retention[`project-space:${p.id}`] || 'Oops 产品团队') === (team ? data.settings.space : data.settings.retention[`session-space:${s.id}`] || 'Oops 产品团队')));
    const body = stock ? '演示库存表：蓝色B-108，在库24，预留6，可用18。资料日期10月7日18:00；今天的出入库仍需人工确认。' : `本地可用资料：${attachments.join('、') || '暂无资料'}。${project?.description || '尚无更多获准资料，可手动添加文字。'}`;
    const memory: Memory = { id: uid('MAT'), title, body, category: '收藏', tags: ['资料', '会中检索', source ? '关联原话' : '手工查询'], visibility: '私有', updated: dateLabel(), confirmed: true, sourceSession: s.id, ...(source ? { sourceId: source.id, sourceTime: source.time || undefined } : {}) };
    update(current => ({ ...patchSession(current, s.id, { attachments: [...new Set([...s.attachments, title])] }), memories: [memory, ...current.memories], settings: { ...current.settings, retention: { ...current.settings.retention, [`material-query:${s.id}:${title}`]: JSON.stringify({ question: lookup.query, sourceId: source?.id, topic: lookup.topic, created: dateLabel() }), [`material-focus:${s.id}`]: title } } }));
    setResearchOpen(false); setLookup({ query: '', sourceId: '', topic: '' }); switchTab(active ? '现场' : '资料'); toast('资料已返回本次会话，保持私人');
  }
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setPlayId(id => { const index = currentTranscript.findIndex(t => t.id === id); if (index >= currentTranscript.length - 1) { setPlaying(false); return id; } return currentTranscript[index + 1]?.id || ''; }), speed === '2倍速' ? 600 : 1200);
    return () => clearInterval(timer);
  }, [playing, speed, currentTranscript.map(t => t.id).join('|')]);
  const focus = data.settings.retention[`material-focus:${s.id}`];
  const focusMemory = data.memories.find(m => m.title === focus && m.sourceSession === s.id && !m.deleted);
  const focusSource = focusMemory?.sourceId ? currentTranscript.find(t => t.id === focusMemory.sourceId) : undefined;
  const budgetConflict = budgetState(data, s, shared).pending;
  const kindTitle = s.kind === '会议' ? '本次讨论' : s.kind === '日常' ? '刚才聊到的事' : s.kind === '灵感' ? '这次的核心想法' : '这段表达';
  return <div className="stack sessions-feature" ref={root}>
    <div className="session-heading"><div><h2>{s.title}</h2><p className="meta">{s.kind} · {s.project} · {s.duration || '待开始'}</p></div><button className="session-filter-button" aria-label="本次会话工具" onClick={() => setToolsOpen(true)}><Icon name="dots-three" /></button></div>
    <div className="session-stage"><Badge tone={active ? 'purple' : flag(data, `review-${s.id}`) ? 'amber' : 'gray'}>{active ? s.status : s.status === '待开始' ? '待开始' : flag(data, `review-${s.id}`) ? '来源待复核' : needsSessionReview(data, s) && !shared ? '已保存 · 待核对' : '已保存'}</Badge>{shared && <span><Icon name="users" size={14} />共同视角</span>}</div>
    {tab === '现场' && <>
      <div className="session-recording"><span className={s.status === '进行中' ? 'recording-dot' : 'recording-dot paused'} /><div><strong>{s.status === '进行中' ? '正在记录本地示例' : '记录已暂停'}</strong><small>预设文字 · 麦克风未开启</small></div></div>
      <div className="session-live-summary"><button onClick={() => unknown.length && !shared ? open('session-identity') : switchTab('原文')}><Icon name="user-circle" size={18} /><strong>{unknown.length ? `${unknown.length}个身份待核对` : `${new Set(currentTranscript.map(t => t.speaker)).size || 1}个发言标签`}</strong></button><button onClick={() => switchTab('行动')}><Icon name="check-square" size={18} /><strong>{pending.length ? `${pending.length}项行动草稿` : '本次行动'}</strong></button></div>
      {s.kind === '会议' && <Row title={s.agenda[Number(data.settings.retention[`agenda-${s.id}`] || 0)] || '本次议程'} subtitle={s.agenda.length ? '查看进度与时间' : '没有预设议题，也可以继续记录'} icon="list-checks" onClick={() => open('session-agenda')} />}
      {s.kind !== '会议' && !shared && <Card className="session-kind-focus"><Badge tone="gray">{s.kind}</Badge><h3>{s.kind === '灵感' ? '先留下想法，再整理表达' : s.kind === '练习' ? '先说一遍，再回看结构' : '记住这次聊天中要跟进的事'}</h3><Button tone="secondary" icon={s.kind === '练习' ? 'sparkle' : 'lightbulb'} onClick={() => open(s.kind === '练习' ? 'session-growth' : 'session-inspiration')}>{s.kind === '灵感' ? '整理核心观点与提纲' : s.kind === '练习' ? '进入私人表达练习' : '整理便签与联系草稿'}</Button></Card>}
      {budgetConflict && <Row title="预算提醒待核对" subtitle="原话金额与当前基准需要核对" icon="bell" badge="待确认" onClick={() => open('session-reminders')} />}
      <SectionTitle action="完整原文" onAction={() => switchTab('原文')}>{kindTitle}</SectionTitle>
      {currentTranscript.length ? currentTranscript.slice(-3).map(t => <div data-turn-id={t.id} key={t.id}><TranscriptCard item={t} label={turnLabel(t, s)} onClick={() => setSelectedId(t.id)} /></div>) : <Empty title="等待第一段内容" body="示例每4秒追加一段文字。" />}
      {focus && attachments.includes(focus) && <Card className="session-returned-material"><Badge tone="gray">资料已返回</Badge><h3>{focus}</h3><p className="meta">{focusSource ? `对应${turnLabel(focusSource, s)}的讨论` : '手工查询，未指定原话出处'}</p><Button tone="quiet" onClick={() => open('session-source', focus)}>查看资料与依据</Button>{focusSource && <Source title="查看关联原话" time={turnLabel(focusSource, s)} onClick={() => open('session-transcript', focusSource.id)} />}</Card>}
      {!shared && <div className="action-grid"><Button tone="secondary" icon="magnifying-glass" onClick={() => showResearch()}>查本地资料</Button><Button tone="secondary" icon="note-pencil" onClick={() => setNoteOpen(true)}>私人便签{s.privateNotes.length ? ` · ${s.privateNotes.length}` : ''}</Button></div>}
    </>}
    {tab === '概览' && <ReviewPanel session={s} shared={shared} tasks={tasks} onTask={openTask} onOriginal={() => switchTab('原文')} />}
    {tab === '原文' && <>
      <Search value={reader.query} onChange={query => setReader(current => ({ ...current, query }))} placeholder="搜索这次原文" /><Chips items={['全部', ...new Set(currentTranscript.map(t => t.speaker))]} value={reader.speaker} onChange={speaker => setReader(current => ({ ...current, speaker }))} />
      {route.view === 'session-transcript' && route.mode && !modeTabs[route.mode] && !routeSource && <Notice tone="warning">这个来源片段已移除或不可见，不会定位到其他原话。</Notice>}
      <div className="session-playback"><Button tone="secondary" disabled={!currentTranscript.length} icon={playing ? 'pause' : 'play'} onClick={() => { setPlayId(currentTranscript[0]?.id || ''); setPlaying(value => !value); }}>{playing ? '暂停示例回看' : '示例时间轴'}</Button><button onClick={() => setSpeed(speed === '1倍速' ? '2倍速' : '1倍速')}>{speed}</button></div><p className="meta">仅模拟片段高亮，不播放音频。无时间文字按片段编号引用。</p>
      {transcript.length ? transcript.map(t => <div key={t.id} data-turn-id={t.id}><TranscriptCard item={t} label={turnLabel(t, s)} active={routeSource?.id === t.id || playId === t.id} onClick={() => { setPlaying(false); setSelectedId(t.id); }} /></div>) : <Empty title="没有匹配片段" body="换个关键词或说话人。" />}
    </>}
    {tab === '资料' && <>
      <SectionTitle>本次资料 · {attachments.length}</SectionTitle>{attachments.length ? attachments.map(name => <Row key={name} title={name} subtitle="查看正文、出处与数据时间" onClick={() => open('session-source', name)} />) : <Empty title={shared ? '还没有获准共享的资料' : '本次还没有资料'} body={shared ? '由本人逐份核对共享范围。' : '添加到这次会话，之后可继续引用。'} />}
      {!shared && <div className="action-grid"><Button tone="secondary" icon="plus" onClick={() => open('session-material-import')}>添加本次资料</Button><Button tone="secondary" icon="magnifying-glass" onClick={() => showResearch()}>查本地资料</Button></div>}
    </>}
    {tab === '行动' && <>
      {(['待承接', '执行中', '待验收', '已完成', '其他'] as const).map(group => { const list = tasks.filter(t => group === '待承接' ? t.status === '待承接' : group === '执行中' ? ['已承接', '进行中', '待转交'].includes(t.status) : group === '待验收' ? t.status === '待验收' : group === '已完成' ? t.status === '已完成' : ['已拒绝', '已取消'].includes(t.status)); return list.length ? <section className="session-list-group" key={group}><SectionTitle>{group}</SectionTitle>{list.map(t => <Card key={t.id} onClick={() => navigate({ view: 'task-detail', id: t.id })}><div className="session-task-top"><h3>{t.title}</h3><Badge tone={t.needsReview ? 'amber' : 'gray'}>{t.needsReview ? '需复核' : t.status}</Badge></div><p className="meta">{t.owner} · {t.due ? t.due.replace('T', ' ') : '期限未定'}</p><p className="meta">{t.sourceSession ? '保留原话出处' : '手工关联，无原话出处'} · 助手{t.aiStatus}</p></Card>)}</section> : null; })}
      {!tasks.length && <Empty title="这次还没有行动" body="从原话整理，或手工写下下一步；承接与助手授权分别确认。" />}
      <Button icon="plus" onClick={() => openTask()}>手工整理本次行动</Button><Button tone="quiet" onClick={() => navigate({ view: 'tasks' })}>查看全部任务</Button>
    </>}
    {active && <Button tone="quiet" onClick={() => requestEnd(s.id)}>结束当前记录</Button>}
    {s.status === '待开始' && <Button onClick={() => open('session-create')}>准备并开始</Button>}
    <Sheet open={!!selected} onClose={() => setSelectedId('')} title="这段原话">{selected && <><TranscriptCard item={selected} label={turnLabel(selected, s)} />{selectedTask && visibleTask(data, selectedTask, shared) && <Row title="查看已关联行动" subtitle={selectedTask.title} icon="check-square" onClick={() => navigate({ view: 'task-detail', id: selectedTask.id })} />}{!shared && selectedMemory && <Row title="查看已留下的记忆" subtitle={selectedMemory.title} icon="bookmark-simple" onClick={() => navigate({ view: selectedMemory.confirmed ? 'memory-detail' : 'memory-candidate', id: selectedMemory.id })} />}<Button tone="secondary" onClick={() => openTask(selected, !!selectedTask)}>{selectedTask ? '明确另建一个行动' : '从这段整理行动'}</Button>{!shared && <><Button tone="secondary" onClick={() => candidate(selected, !!selectedMemory)}>{selectedMemory ? '另留一条候选记忆' : '留下私人候选记忆'}</Button><Button tone="secondary" onClick={() => showResearch(selected)}>围绕这段查资料</Button><Row title="核对显示姓名" subtitle="只处理所选片段，不猜测声音身份" icon="user-circle" onClick={() => open('session-identity', selected.id)} /><Row title="修订文字或敏感范围" icon="pencil-simple" onClick={() => open('session-edit', selected.id)} /></>}</>}</Sheet>
    <Sheet open={toolsOpen} onClose={() => setToolsOpen(false)} title="本次会话工具">{!team && <Button tone="secondary" icon={shared ? 'lock-key' : 'users'} onClick={() => { setReader(current => ({ ...current, view: shared ? '我的视角' : '共享纪要' })); setToolsOpen(false); }}>{shared ? '回到我的完整视角' : '预览共同纪要范围'}</Button>}{s.kind === '会议' && <><Row title="议程与时间" onClick={() => open('session-agenda')} />{budgetConflict && <Row title="本次预算提醒" icon="bell" onClick={() => open('session-reminders')} />}<Row title="讨论结构" onClick={() => open('session-map')} /><Row title="大屏预览" icon="monitor" onClick={() => open('session-display')} /></>}{!shared && <><Row title="身份核对" subtitle={`${unknown.length}个匿名标签`} icon="user-circle" onClick={() => open('session-identity')} /><Row title={s.kind === '练习' ? '本次表达练习' : '私人表达练习'} icon="sparkle" onClick={() => open('session-growth')} />{s.kind !== '会议' && <Row title={s.kind === '灵感' ? '灵感与口播提纲' : '便签与联系草稿'} icon="lightbulb" onClick={() => open('session-inspiration')} />}<Row title="私人便签" icon="note-pencil" onClick={() => { setToolsOpen(false); setNoteOpen(true); }} /><Row title="名称与准备" icon="pencil-simple" onClick={() => open('session-create')} /><Row title="修订历史" onClick={() => open('session-revisions')} /></>}<Row title="共享范围" icon="share-network" onClick={() => open('session-share')} /><Row title="导出当前结果" icon="export" onClick={() => open('session-export')} /><Row title="开始后续记录" icon="microphone" onClick={() => navigate({ view: 'session-mode', mode: s.kind })} /></Sheet>
    <Sheet open={noteOpen && !shared} onClose={() => setNoteOpen(false)} title="我的私人便签"><Field label="想留给自己" value={reader.note} onChange={note => setReader(current => ({ ...current, note }))} multiline /><Button disabled={!reader.note.trim()} onClick={() => { update(current => { const actual = current.sessions.find(item => item.id === s.id); return actual ? patchSession(current, s.id, { privateNotes: [...actual.privateNotes, reader.note.trim()] }) : current; }); setReader(current => ({ ...current, note: '' })); toast('已保存私人便签'); }}>保存便签</Button>{s.privateNotes.map((text, i) => <Card key={i}><p className="session-preserve">{text}</p></Card>)}</Sheet>
    <Sheet open={researchOpen} onClose={() => setResearchOpen(false)} title="查本地资料"><Field label="想找什么" value={lookup.query} onChange={query => setLookup(current => ({ ...current, query }))} placeholder="例如：蓝色B-108库存" />{lookup.sourceId ? <Card><Badge tone="gray">发起查询时的原话</Badge><p>{currentTranscript.find(t => t.id === lookup.sourceId)?.text || '来源已变化，请重新选择'}</p><p className="meta">{currentTranscript.find(t => t.id === lookup.sourceId) ? turnLabel(currentTranscript.find(t => t.id === lookup.sourceId)!, s) : '不可引用'}</p></Card> : <p className="meta">{lookup.topic ? `关联议题：${lookup.topic} · 未指定原话` : '手工查询，未指定原话出处'}</p>}<SelectField label="关联原话" value={currentTranscript.find(t => t.id === lookup.sourceId) ? label(currentTranscript.find(t => t.id === lookup.sourceId)!) : '手工查询，无原话出处'} options={['手工查询，无原话出处', ...currentTranscript.map(label)]} onChange={value => setLookup(current => ({ ...current, sourceId: currentTranscript.find(t => label(t) === value)?.id || '' }))} /><Notice>仅查询本地示例，未联网；不会自动发送。</Notice><Button onClick={research} disabled={!lookup.query.trim()}>查找并返回本次资料</Button></Sheet>
    <Sheet open={taskOpen} onClose={() => setTaskOpen(false)} title="整理本次行动"><SelectField label="原话出处" value={chosenSource ? label(chosenSource) : '手工整理，无原话出处'} options={['手工整理，无原话出处', ...currentTranscript.map(label)]} onChange={value => { const source = currentTranscript.find(t => label(t) === value); setDraft(current => ({ ...current, sourceId: source?.id || '', body: source?.text || current.body, another: false })); }} />{chosenSource && <TranscriptCard item={chosenSource} label={turnLabel(chosenSource, s)} />}<Field label="行动名称" value={draft.title} onChange={title => setDraft(current => ({ ...current, title }))} /><Field label="具体要求" value={draft.body} onChange={body => setDraft(current => ({ ...current, body }))} multiline /><Field label="建议期限（可选）" value={draft.due} onChange={due => setDraft(current => ({ ...current, due }))} type="datetime-local" /><p className="meta">属于本次会话 · 尚未承接 · 助手未启动。关闭后保留草稿；另写一项可在下方清空。</p><Button onClick={createTask}>{draft.another ? '确认另建一项行动' : '保存到本次行动'}</Button><Button tone="quiet" onClick={() => setDraft(previous => openActionDraft(previous, undefined, true))}>清空草稿，另写一项</Button></Sheet>
  </div>;
}

function ReviewPanel({ session: s, shared, tasks, onTask, onOriginal }: { session: Session; shared: boolean; tasks: Task[]; onTask: (source?: Transcript) => void; onOriginal: () => void }) {
  const { data, navigate } = useOops();
  const items = confirmedReview(data, s, shared), conclusions = items.filter(item => item.kind === 'conclusion'), questions = items.filter(item => item.kind === 'question');
  const changed = flag(data, `review-${s.id}`), queue = shared ? [] : reviewQueue(data, s);
  const lines = s.transcript.filter(t => !shared || !t.private);
  let marks: RecordMark[] = []; try { const parsed = JSON.parse(data.settings.retention[`record-marks:${s.id}`] || '[]'); if (Array.isArray(parsed)) marks = parsed.filter(x => x && typeof x.id === 'string'); } catch { /* Invalid metadata is not rendered. */ }
  const taskLabel = (task: Task) => `${task.owner} · ${task.due ? task.due.replace('T', ' ') : '期限待定'} · ${task.needsReview ? '待复核' : task.status}`;
  return <div className="stack session-overview">
    <Card className="session-result-card"><div className="session-task-top"><Badge tone={changed ? 'amber' : 'gray'}>{shared ? '共同可见结果' : changed ? '来源变化 · 需复核' : queue.length ? `仍有${queue.length}项待核对` : data.settings.retention[`session-review-completed:${s.id}`] ? '本次已核对' : data.settings.retention[`session-reviewed:${s.id}`] ? '已有人工确认' : '已保存 · 待整理'}</Badge>{!shared && <button className="text-action" onClick={() => navigate({ view: 'session-review-edit', id: s.id })}>编辑</button>}</div><h3>{shared ? '获准共享的结论' : changed ? '需要重新核对的旧结论' : '本次确认的结论'}</h3>{conclusions.length ? conclusions.map(item => <p className="session-result-line" key={item.id}>{item.text}</p>) : <p className="meta">{shared ? '尚未逐项共享已确认结论。下面仅显示当前非敏感原话摘录。' : '还没有人工确认的结论，可以先查看原文，再按需要整理。'}</p>}{!shared && !conclusions.length && s.summary.length > 0 && <details className="session-details"><summary>已有整理 · 尚待核对</summary>{s.summary.map((text, i) => <p key={i}>{text}</p>)}</details>}</Card>
    <SectionTitle>{s.kind === '灵感' ? '验证下一步' : s.kind === '练习' ? '下次练习与行动' : '下一步行动'}</SectionTitle>{tasks.length ? tasks.map(task => <Row key={task.id} title={task.title} subtitle={taskLabel(task)} icon="check-square" badge={task.needsReview ? '待复核' : task.status} onClick={() => navigate({ view: 'task-detail', id: task.id })} />) : <p className="meta">本次还没有关联行动。</p>}
    <SectionTitle>尚未决定的问题</SectionTitle>{questions.length ? questions.map(item => <p className="session-result-line" key={item.id}>{item.text}</p>) : <p className="meta">{shared ? '没有获准共享的未决问题。' : '尚未记录未决问题。'}</p>}
    {!shared && <><Card className="session-review-entry"><div><h3>{queue.length ? `${queue.length}项可以逐项核对` : '本次核对'}</h3><p className="meta">身份、行动、记忆与来源分别处理，也可以稍后再说。</p></div><Button onClick={() => navigate({ view: 'session-review', id: s.id })}>{queue.length ? '开始 / 继续核对' : '查看核对状态'}</Button></Card>{s.kind !== '会议' && <Row title={s.kind === '练习' ? '回看与改写这段表达' : s.kind === '灵感' ? '整理核心观点与口播提纲' : '整理需要记住的事与联系草稿'} icon={s.kind === '练习' ? 'sparkle' : 'lightbulb'} onClick={() => navigate({ view: s.kind === '练习' ? 'session-growth' : 'session-inspiration', id: s.id })} />}</>}
    <details className="session-details"><summary>{shared ? '非敏感原话摘录' : '重点与原话依据'}</summary>{!shared && marks.map(mark => { const source = mark.sourceId ? lines.find(t => t.id === mark.sourceId) : mark.sourceTime ? lines.find(t => t.time === mark.sourceTime) : undefined; return <Card key={mark.id}><Badge tone="gray">{mark.time}</Badge><p>{mark.note || '已标记重点'}</p>{source ? <Source title="查看标记来源" time={turnLabel(source, s)} onClick={() => navigate({ view: 'session-transcript', id: s.id, mode: source.id })} /> : <p className="meta">{mark.sourceId || mark.sourceTime ? '来源片段已移除，待核对' : '时间标记，未绑定原话'}</p>}</Card>; })}{lines.slice(-5).map(line => <Card key={line.id}><p className="meta">{turnLabel(line, s)} · {line.speaker}</p><p>{line.text}</p><Source title="定位这段原话" time={turnLabel(line, s)} onClick={() => navigate({ view: 'session-transcript', id: s.id, mode: line.id })} /></Card>)}<Button tone="quiet" onClick={onOriginal}>查看完整原文</Button></details>
    <div className="action-grid">{!shared && <Button tone="secondary" onClick={() => onTask()}>手工整理行动</Button>}<Button tone="secondary" icon="export" onClick={() => navigate({ view: 'session-export', id: s.id })}>导出预览</Button></div>
  </div>;
}

function ReviewEditor({ session: s }: { session: Session }) {
  const { data, update, navigate, toast } = useOops();
  const items = confirmedReview(data, s);
  const [draft, setDraft] = useViewState<ReviewDraft>(`session-conclusion-draft:${s.id}:${data.settings.space}`, { conclusions: items.filter(x => x.kind === 'conclusion').map(x => x.text).join('\n') || (flag(data, `review-${s.id}`) ? readList(data.settings.retention[`session-conclusions:${s.id}`]).join('\n') : ''), questions: items.filter(x => x.kind === 'question').map(x => x.text).join('\n'), sourceId: '', sourceMode: 'preserve' });
  const [returnTo] = useViewState(`session-review-return:${s.id}:我的空间`, '');
  const label = (t: Transcript) => `${turnLabel(t, s)} ${t.speaker} · ${t.id}`;
  const source = s.transcript.find(t => t.id === draft.sourceId);
  const sourceMode = reviewDraftSourceMode(draft);
  function save() {
    const result = buildReviewItems(s, items, draft, kind => uid(kind === 'conclusion' ? 'CON' : 'QUE'));
    if (result.error || !result.items) { toast(result.error || '请核对本次结果'); return; }
    const { conclusions, questions, items: next } = result;
    update(current => ({ ...patchSession(current, s.id, { summary: conclusions }), settings: { ...current.settings, toggles: { ...current.settings.toggles, [`review-${s.id}`]: false }, retention: { ...current.settings.retention, [`session-conclusions:${s.id}`]: JSON.stringify(conclusions), [`session-questions:${s.id}`]: JSON.stringify(questions), [`session-review-items:${s.id}`]: JSON.stringify(next), [`session-reviewed:${s.id}`]: dateLabel() } } }));
    toast('已保存人工确认结果，保持私人'); navigate({ view: returnTo === 'queue' ? 'session-review' : 'session-detail', id: s.id, mode: returnTo === 'queue' ? undefined : '概览' });
  }
  return <div className="stack"><Notice>{flag(data, `review-${s.id}`) ? '来源已变化，请重新核对；保存不会恢复旧资料或助手授权。' : '由你填写并确认，不会自动生成会议结论。'}</Notice>{!draft.conclusions && s.summary.length > 0 && <Button tone="secondary" onClick={() => setDraft(current => ({ ...current, conclusions: s.summary.join('\n') }))}>将已有整理带入草稿</Button>}<Field label="我确认的结论" value={draft.conclusions} onChange={conclusions => setDraft(current => ({ ...current, conclusions }))} multiline hint="每行一条，保存前请按实际保留内容核对。" /><Field label="尚未决定的问题" value={draft.questions} onChange={questions => setDraft(current => ({ ...current, questions }))} multiline /><SelectField label="本次结果的原话出处" value={sourceMode === 'preserve' ? '保留未改条目的已有出处' : sourceMode === 'clear' ? '人工整理，无单段出处' : source ? label(source) : '已选出处已移除，请重新选择'} options={['保留未改条目的已有出处', '人工整理，无单段出处', ...s.transcript.map(label)]} onChange={value => { const turn = s.transcript.find(t => label(t) === value); setDraft(current => ({ ...current, sourceId: turn?.id || '', sourceMode: turn ? 'selected' : value === '人工整理，无单段出处' ? 'clear' : 'preserve' })); }} /><p className="meta">保留出处时，新增或改写的条目按人工整理保存；选择一段原话会用于本次全部条目。</p>{sourceMode === 'selected' && source && <TranscriptCard item={source} label={turnLabel(source, s)} />}<Button onClick={save}>确认并保存私人结果</Button><Button tone="quiet" onClick={() => navigate({ view: returnTo === 'queue' ? 'session-review' : 'session-detail', id: s.id, mode: returnTo === 'queue' ? undefined : '概览' })}>稍后再整理</Button></div>;
}

function ReviewQueue({ session: s }: { session: Session }) {
  const { data, update, navigate, toast } = useOops();
  const [progress, setProgress] = useViewState(`session-review-progress:${s.id}:${data.settings.space}`, { deferred: [] as string[], current: '' });
  const [, setReturn] = useViewState(`session-review-return:${s.id}:我的空间`, '');
  const all = reviewQueue(data, s), queue = all.filter(item => !progress.deferred.includes(item.id));
  const current = queue.find(item => item.id === progress.current) || queue[0];
  const deferred = all.filter(item => progress.deferred.includes(item.id));
  function defer() { if (!current) return; setProgress(p => ({ deferred: [...new Set([...p.deferred, current.id])], current: '' })); toast('本项留待之后处理'); }
  function finish() {
    update(d => { const actual = d.sessions.find(session => session.id === s.id); return actual ? finishSessionReviewRound(d, s.id, reviewQueue(d, actual).length, dateLabel()) : d; }); setReturn(''); toast(all.length ? '本轮核对结束，未处理项继续保留' : '本次已核对'); navigate({ view: 'session-detail', id: s.id, mode: '概览' });
  }
  const memory = current?.kind === 'memory' ? data.memories.find(m => `memory-${m.id}` === current.id) : undefined;
  const source = memory?.sourceId ? s.transcript.find(t => t.id === memory.sourceId) : memory?.sourceTime ? s.transcript.find(t => t.time === memory.sourceTime) : undefined;
  return <div className="stack"><div className="session-queue-heading"><Badge>{queue.length}项可处理 · {deferred.length}项稍后</Badge><h2>一次核对一件事</h2><p className="meta">身份、记忆、工作承接分别确认；不要求全部完成。</p></div>{current ? <Card className="session-queue-item"><Badge tone={current.kind === 'source' ? 'amber' : 'gray'}>{{ identity: '显示姓名', task: '本次行动', memory: '候选记忆', source: '来源复核' }[current.kind]}</Badge><h3>{current.title}</h3><p className="session-preserve">{current.body}</p>{source && <Source title="核对原话" time={turnLabel(source, s)} onClick={() => navigate({ view: 'session-transcript', id: s.id, mode: source.id })} />}<Button onClick={() => { setReturn('queue'); setProgress(p => ({ ...p, current: current.id })); navigate(current.route); }}>去核对这项</Button>{memory && <><Button tone="secondary" disabled={!sourceAvailable(data, memory)} onClick={() => { update(d => ({ ...d, memories: d.memories.map(m => m.id === memory.id && sourceAvailable(d, m) ? { ...m, confirmed: true, needsReview: false, visibility: '私有', tags: m.tags.filter(t => !['待确认', '待复核'].includes(t)) } : m) })); setProgress(p => ({ ...p, current: '' })); toast('已确认私人记忆，未加入共享'); }}>确认记住，仅本人可见</Button><Button tone="quiet" onClick={() => { update(d => ({ ...d, memories: d.memories.map(m => m.id === memory.id ? { ...m, deleted: true, visibility: '私有' } : m) })); setProgress(p => ({ ...p, current: '' })); toast('候选已移入记忆回收站'); }}>这次不记住</Button></>}<Button tone="quiet" onClick={defer}>{current.kind === 'identity' ? '保持匿名，本轮稍后处理' : '稍后再说'}</Button></Card> : <Empty title={deferred.length ? '其余项目已留待稍后' : '当前没有待核对项'} body="可以结束本轮，也可以继续编辑结论。" />}{deferred.length > 0 && <Button tone="secondary" onClick={() => setProgress({ deferred: [], current: '' })}>重新查看稍后项目</Button>}<Row title="编辑结论与未决问题" subtitle="私人结果，不自动加入共同纪要" icon="note-pencil" onClick={() => { setReturn('queue'); navigate({ view: 'session-review-edit', id: s.id }); }} /><Button onClick={finish}>结束本轮核对</Button></div>;
}

function EditTranscript({ session: s }: { session: Session }) {
  const { data, route, update, navigate, toast } = useOops();
  const item = s.transcript.find(t => t.id === route.mode || !!t.time && t.time === route.mode) || (!route.mode ? s.transcript[0] : undefined);
  const [draft, setDraft] = useViewState(`session-edit:${s.id}:${item?.id}:${data.settings.space}`, { text: item?.text || '', sensitive: !!item?.private });
  const [returnTo] = useViewState(`session-review-return:${s.id}:我的空间`, '');
  const [remove, setRemove] = useState(false), [error, setError] = useState('');
  if (!item) return <Empty title="来源片段已移除" body="不会改用其他原话；请返回核对当前内容。" action="返回原文" onAction={() => navigate({ view: 'session-transcript', id: s.id })} />;
  function save(deleting = false) {
    if (!draft.text.trim() && !deleting) { setError('片段文字不能为空'); return; }
    const changed = deleting || draft.text.trim() !== item!.text.trim() || draft.sensitive !== !!item!.private;
    const history: Memory = { id: uid('REV'), title: `${s.title} · ${turnLabel(item!, s)}修订`, body: `原文：${item!.text}\n${deleting ? '本次：片段已删除' : `修订：${draft.text.trim()}`}\n原说话人：${item!.speaker}\n原敏感：${!!item!.private}\n可见范围：${draft.sensitive ? '私有' : '可用于共同纪要'}`, revision: { original: { ...item! }, action: deleting ? 'delete' : 'edit' }, category: '收藏', tags: ['修订历史', item!.id], visibility: '私有', updated: dateLabel(), confirmed: true, sourceSession: s.id, sourceId: item!.id, sourceTime: item!.time || undefined };
    update(current => {
      const actual = current.sessions.find(session => session.id === s.id);
      if (!actual?.transcript.some(t => t.id === item!.id)) return current;
      const invalidated = changed ? invalidateSessionSources(current, s.id, [item!.id], deleting ? '原话片段已删除' : '原话文字或敏感范围已修订') : current;
      return { ...patchSession(invalidated, s.id, { transcript: deleting ? actual.transcript.filter(t => t.id !== item!.id) : actual.transcript.map(t => t.id === item!.id ? { ...t, text: draft.text.trim(), private: draft.sensitive } : t) }), memories: [history, ...invalidated.memories] };
    });
    toast(changed ? '已保留原文，关联输出与旧结论需复核' : '已保存'); navigate({ view: returnTo === 'queue' ? 'session-review' : 'session-transcript', id: s.id, mode: returnTo === 'queue' || deleting ? undefined : item!.id });
  }
  return <div className="stack"><TranscriptCard item={item} label={turnLabel(item, s)} /><Field label="修订文字" value={draft.text} onChange={text => setDraft(current => ({ ...current, text }))} multiline /><Toggle label="敏感内容，仅本人可见" value={draft.sensitive} onChange={sensitive => setDraft(current => ({ ...current, sensitive }))} hint="共同纪要、大屏与共享导出将隐藏这段。" /><Source title="核对这段显示姓名" time={turnLabel(item, s)} onClick={() => navigate({ view: 'session-identity', id: s.id, mode: item.id })} />{error && <p className="error-text">{error}</p>}<Button onClick={() => save()}>保存修订</Button><Button tone="secondary" onClick={() => navigate({ view: 'session-transcript', id: s.id, mode: item.id })}>返回原文，保留草稿</Button><Button tone="danger" onClick={() => setRemove(true)}>删除这个片段</Button><Sheet open={remove} onClose={() => setRemove(false)} title="删除这个片段？"><p>原文留在私人历史；关联行动与资料需复核，旧助手授权撤回。</p><Button tone="danger" onClick={() => save(true)}>确认删除</Button></Sheet><Row title="查看修订历史" subtitle={`${data.memories.filter(m => m.sourceSession === s.id && m.tags.includes('修订历史')).length}个版本`} onClick={() => navigate({ view: 'session-revisions', id: s.id })} /></div>;
}

function Identity({ session: s }: { session: Session }) {
  const { data, update, route, navigate, toast } = useOops();
  const item = s.transcript.find(t => t.id === route.mode || !!t.time && t.time === route.mode) || (!route.mode ? s.transcript.find(t => unknownSpeaker(t.speaker)) : undefined);
  const [draft, setDraft] = useViewState<{ name: string; scope: string; voice: boolean; targetPersonId?: string }>(`session-identity:${s.id}:${item?.id}:${data.settings.space}`, { name: item && !unknownSpeaker(item.speaker) ? item.speaker : '', scope: '仅这个片段', voice: false, targetPersonId: item?.personId });
  const [returnTo] = useViewState(`session-review-return:${s.id}:我的空间`, '');
  const [, setProgress] = useViewState(`session-review-progress:${s.id}:我的空间`, { deferred: [] as string[], current: '' });
  const people = data.people.filter(person => !unknownSpeaker(person.name));
  const personLabel = (person: AppData['people'][number]) => `${person.name} · ${person.company || person.role || '已有的人物'}${people.filter(other => other.name === person.name).length > 1 ? ` · 人物卡${people.indexOf(person) + 1}` : ''}`;
  const selectedPerson = people.find(person => person.id === draft.targetPersonId);
  if (!item) return <Empty title={route.mode ? '这个片段已移除' : '没有匿名身份需要核对'} body="在原文选择具体发言后，可分别核对姓名与声音许可。" action="查看原文" onAction={() => navigate({ view: 'session-transcript', id: s.id })} />;
  function finish() { navigate({ view: returnTo === 'queue' ? 'session-review' : 'session-transcript', id: s.id, mode: returnTo === 'queue' ? undefined : item!.id }); }
  function confirm() {
    const name = draft.name.trim(); if (!name) { toast('填写显示姓名，或选择保持匿名'); return; }
    const match = (t: Transcript) => draft.scope === '本次同一匿名标签' && unknownSpeaker(item!.speaker) ? t.speaker === item!.speaker : t.id === item!.id;
    const selection = { targetPersonId: draft.targetPersonId, sessionId: s.id, turnIds: s.transcript.filter(match).map(turn => turn.id), name, voiceConsent: draft.voice, plannedPersonId: uid('person') };
    const checked = confirmPersonSpeakers(data, selection);
    if (checked.error) { toast(checked.error); return; }
    update(current => confirmPersonSpeakers(current, selection).data);
    toast('已确认显示姓名，声音许可与任务归属分别处理'); finish();
  }
  return <div className="stack"><Badge tone="gray">手动核对，不猜测声音身份</Badge><TranscriptCard item={item} label={turnLabel(item, s)} /><SectionTitle>这段发言是谁？</SectionTitle><SelectField label="已有的人物卡（可选）" value={selectedPerson ? personLabel(selectedPerson) : '填写姓名或新增人物'} options={['填写姓名或新增人物', ...people.map(personLabel)]} onChange={value => { const person = people.find(candidate => personLabel(candidate) === value); setDraft(current => ({ ...current, targetPersonId: person?.id, name: person?.name || current.name })); }} /><Field label="本次显示姓名" value={draft.name} onChange={name => setDraft(current => ({ ...current, name, targetPersonId: undefined }))} placeholder="未确认时可保持匿名" /><SelectField label="应用范围" value={draft.scope} options={unknownSpeaker(item.speaker) ? ['仅这个片段', '本次同一匿名标签'] : ['仅这个片段']} onChange={scope => setDraft(current => ({ ...current, scope }))} /><Toggle label="另行允许个人声音身份示例" value={draft.voice} onChange={voice => setDraft(current => ({ ...current, voice }))} hint="姓名确认与许可独立，这里不采集声纹。" /><Button disabled={!draft.name.trim()} onClick={confirm}>确认本次显示姓名</Button><Button tone="secondary" onClick={() => { if (returnTo === 'queue') setProgress(current => ({ deferred: [...new Set([...current.deferred, `identity-${item.id}`])], current: '' })); toast('保留匿名，未写入姓名确认'); finish(); }}>本次保持匿名</Button></div>;
}

function Material({ session: s }: { session: Session }) {
  const { data, route, update, navigate, toast } = useOops();
  const title = route.mode || s.attachments[0];
  const saved = data.memories.find(m => m.sourceSession === s.id && m.title === title && !m.deleted && !m.tags.includes('修订历史'));
  if (!title || !s.attachments.includes(title)) return <Empty title="资料已从本次移除" body="旧目录不再提供正文，请返回当前资料列表。" action="本次资料" onAction={() => navigate({ view: 'session-detail', id: s.id, mode: '资料' })} />;
  if (data.settings.space !== '我的空间' && !canShareMaterial(data, s, title)) return <Empty title="这份资料不可共同查看" body="需要有效来源及逐份共享，私人或待复核内容不会显示。" action="返回资料" onAction={() => navigate({ view: 'session-detail', id: s.id, mode: '资料' })} />;
  const stock = /B-108|库存/.test(title), fileOnly = /\.(pdf|xlsx?|mp3|wav|m4a|aac|ogg)$/i.test(title);
  const body = saved?.body || (stock ? data.tasks.find(t => t.id === 'TASK-032' && visibleTask(data, t))?.results.join('\n') || '演示库存：在库24，预留6，可用18。更新时间10月7日18:00；当前出入库仍需核对。' : fileOnly ? '已关联文件信息。音频、PDF或表格正文未解析，可另行添加资料文字。' : '本地资料卡，需核对正文与数据时间。');
  const source = saved?.sourceId !== undefined ? s.transcript.find(t => t.id === saved.sourceId) : saved?.sourceTime ? s.transcript.find(t => t.time === saved.sourceTime) : undefined;
  let context: { question?: string; topic?: string; created?: string } = {}; try { context = JSON.parse(data.settings.retention[`material-query:${s.id}:${title}`] || '{}'); } catch { /* Ignore malformed metadata. */ }
  function bringBack() {
    update(d => ({ ...d, settings: { ...d.settings, retention: { ...d.settings.retention, [`material-focus:${s.id}`]: title } } }));
    navigate({ view: source ? 'session-transcript' : 'session-detail', id: s.id, mode: source?.id || (s.id === data.activeSessionId ? '现场' : '资料') }); toast(source ? '已回到资料关联的原话' : '已回到本次资料，未指定原话出处');
  }
  return <div className="stack"><Badge tone={saved?.needsReview ? 'amber' : 'gray'}>{saved?.needsReview ? '旧资料 · 来源待复核' : '本地资料'}</Badge><h2 className="title">{title}</h2>{context.question && <p className="meta">查询：{context.question}{context.created && ` · ${context.created}`}</p>}<Card><p className="session-preserve">{body}</p></Card>{stock && <p className="meta">演示数据更新于10月7日18:00，未查询实时库存。</p>}{source ? <Source title="实际关联原话" time={turnLabel(source, s)} onClick={() => navigate({ view: 'session-transcript', id: s.id, mode: source.id })} /> : <p className="meta">{saved?.sourceId !== undefined || saved?.sourceTime ? '原话来源已移除，不能重新共享。' : context.topic ? `关联议题：${context.topic} · 无单段原话出处` : '手工添加或查询，无单段原话出处。'}</p>}<Button onClick={bringBack}>{source ? '带回对应讨论片段' : '回到本次资料'}</Button>{saved ? <Button tone="secondary" onClick={() => navigate({ view: 'memory-detail', id: saved.id })}>查看已收藏资料</Button> : data.settings.space === '我的空间' && <Button tone="secondary" onClick={() => { const m: Memory = { id: uid('MEM'), title, body, category: '收藏', tags: ['资料'], visibility: '私有', updated: dateLabel(), confirmed: true, sourceSession: s.id, ...(source ? { sourceId: source.id, sourceTime: source.time || undefined } : {}) }; update(d => ({ ...d, memories: [m, ...d.memories] })); navigate({ view: 'memory-detail', id: m.id }); }}>收藏资料与当前范围</Button>}<Button tone="quiet" onClick={() => navigate({ view: 'session-display', id: s.id, mode: title })}>查看共享大屏预览</Button></div>;
}

function chineseNumber(text: string) {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const digit: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0, section = 0, number = 0;
  for (const char of text) {
    if (char in digit) number = digit[char];
    else if (char === '万') { total += (section + number || 1) * 10000; section = 0; number = 0; }
    else { const unit = ({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[char]; if (unit) { section += (number || 1) * unit; number = 0; } }
  }
  return total + section + number;
}
export function budgetEvidence(session: Session, publicOnly = false) {
  return session.transcript.filter(t => (!publicOnly || !t.private) && /预算|费用|金额|支出|成本/.test(t.text)).flatMap(turn => Array.from(turn.text.matchAll(/(\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万]+)\s*(万元|万|元)/g)).map(match => ({ sourceId: turn.id, time: turn.time, speaker: turn.speaker, text: turn.text, amount: chineseNumber(match[1]) * (match[2] === '元' ? 1 : 10000) }))).filter(item => item.amount > 0 && Number.isFinite(item.amount));
}
function budgetState(data: AppData, session: Session, publicOnly = false) {
  const project = data.projects.find(p => p.name === session.project && (!publicOnly || (data.settings.retention[`project-space:${p.id}`] || 'Oops 产品团队') === (data.settings.space === '我的空间' ? data.settings.retention[`session-space:${session.id}`] || 'Oops 产品团队' : data.settings.space)));
  const evidence = budgetEvidence(session, publicOnly), signature = evidence.map(item => `${item.sourceId}:${item.amount}`).join('|');
  const conflict = evidence.length > 0 && (project ? evidence.some(item => item.amount !== project.budget) : new Set(evidence.map(item => item.amount)).size > 1);
  return { project, evidence, signature, pending: conflict && (!flag(data, `budget-resolved-${session.id}`) || data.settings.retention[`budget-evidence:${session.id}`] !== signature) };
}

function MeetingTools({ session: s }: { session: Session }) {
  const { data, update, route, navigate, toast } = useOops();
  const [agenda, setAgenda] = useViewState(`session-agenda-draft:${s.id}:${data.settings.space}`, s.agenda.join('\n'));
  const [index, setIndex] = useState(Number(data.settings.retention[`agenda-${s.id}`] || 0));
  const [plan, setPlan] = useViewState(`session-plan-draft:${s.id}:${data.settings.space}`, data.settings.retention[`session-plan:${s.id}`] || '45');
  const { project, evidence, signature, pending } = budgetState(data, s, data.settings.space !== '我的空间');
  const [budget, setBudget] = useViewState(`session-budget-draft:${s.id}:${data.settings.space}`, data.settings.retention[`budget-discussed:${s.id}`] || '');
  const [updateProject, setUpdateProject] = useState(false);
  const planned = Number(data.settings.retention[`session-plan:${s.id}`] || 45) * 60, elapsed = Number.isFinite(seconds(s.duration)) ? seconds(s.duration) : 0, remaining = planned - elapsed;
  const topic = s.agenda[index] || '', recent = s.transcript.filter(t => data.settings.space === '我的空间' || !t.private).slice(-3), keywords = agendaKeywords(topic), matched = keywords.filter(k => recent.some(t => t.text.toLowerCase().includes(k))), showRule = topic && keywords.length > 0 && recent.length > 0 && !flag(data, `topic-dismissed:${s.id}:${index}`);
  function selectTopic(i: number) { setIndex(i); update(d => ({ ...d, settings: { ...d.settings, retention: { ...d.settings.retention, [`agenda-${s.id}`]: String(i) } } })); }
  function amount() { const value = Number(budget); if (!Number.isFinite(value) || value <= 0) { toast('填写本次已核对的正数金额'); return undefined; } return value; }
  const backMode = s.id === data.activeSessionId ? '现场' : '概览';
  if (route.view === 'session-reminders') return <div className="stack">{evidence.length ? <><Card className={pending ? 'session-warning' : ''}><Badge tone={pending ? 'amber' : 'gray'}>{pending ? '本次金额待核对' : '本次金额记录'}</Badge><h3>{project ? `当前项目基准 ${project.budget.toLocaleString()}元` : '未设置项目预算基准'}</h3><p className="meta">仅提取明确预算／费用文字中的金额，不自动调整项目。</p></Card>{evidence.map((item, i) => <Card key={`${item.sourceId}-${i}`}><strong>{item.amount.toLocaleString()}元</strong><p>{item.text}</p><Source title="查看金额原话" time={item.time || '时间未提供'} onClick={() => navigate({ view: 'session-transcript', id: s.id, mode: item.sourceId })} /></Card>)}{data.settings.space === '我的空间' && <><Field label="本次核对后的金额（元）" value={budget} onChange={setBudget} type="number" /><Button onClick={() => { const value = amount(); if (!value) return; update(d => ({ ...putFlag(d, `budget-resolved-${s.id}`, true), settings: { ...d.settings, toggles: { ...d.settings.toggles, [`budget-resolved-${s.id}`]: true }, retention: { ...d.settings.retention, [`budget-discussed:${s.id}`]: String(value), [`budget-evidence:${s.id}`]: signature } } })); toast('已记录本次核对金额，项目基准未改变'); }}>确认本次金额</Button>{project && <Button tone="secondary" onClick={() => { if (amount()) setUpdateProject(true); }}>另行更新项目预算基准</Button>}<Button tone="quiet" onClick={() => { update(d => ({ ...putFlag(d, `budget-resolved-${s.id}`, true), settings: { ...d.settings, toggles: { ...d.settings.toggles, [`budget-resolved-${s.id}`]: true }, retention: { ...d.settings.retention, [`budget-evidence:${s.id}`]: signature } } })); toast('已忽略本轮金额提示'); }}>忽略本轮提醒</Button></>}</> : <Empty title="本次没有金额提醒依据" body="未在当前可见原话找到明确预算或费用金额。" />}<Button tone="quiet" onClick={() => navigate({ view: 'session-detail', id: s.id, mode: backMode })}>返回本次记录</Button><Sheet open={updateProject && !!project} onClose={() => setUpdateProject(false)} title="更新项目预算基准？"><p>{project?.name}：从 {project?.budget.toLocaleString()} 元改为 {Number(budget).toLocaleString()} 元。</p><p className="meta">这是项目设置变更，与本次核对金额分别保存。</p><Button onClick={() => { const value = amount(); if (!value || !project) return; update(d => ({ ...d, projects: d.projects.map(p => p.id === project.id ? { ...p, budget: value } : p) })); setUpdateProject(false); toast('项目预算基准已明确更新'); }}>确认更新项目基准</Button></Sheet></div>;
  if (route.view === 'session-map' || route.view === 'session-display') return <div className="stack"><Badge tone="gray">{route.view === 'session-display' ? '本机大屏共享预览' : '议题与资料结构'}</Badge><div className="session-map"><div className="map-center">{s.title}</div>{s.agenda.map((a, i) => <button className="map-branch" key={i} onClick={() => navigate({ view: 'session-agenda', id: s.id })}><span>{i + 1}</span>{a}</button>)}{s.attachments.filter(name => route.view === 'session-map' && data.settings.space === '我的空间' || canShareMaterial(data, s, name)).map(name => <button key={name} className="map-material" onClick={() => navigate({ view: 'session-source', id: s.id, mode: name })}><Icon name="file-text" size={16} />{name}</button>)}</div>{route.view === 'session-display' && <Notice>只列明确共享且仍有效的资料，不含私人便签、敏感片段或未共享结论。</Notice>}<Button tone="secondary" onClick={() => navigate({ view: 'session-share', id: s.id })}>核对共享范围</Button><Button onClick={() => navigate({ view: 'session-detail', id: s.id, mode: backMode })}>返回本次记录</Button></div>;
  if (s.kind !== '会议') return <Empty title="这类记录不使用会议议程" body="回到本次记录查看便签、灵感或表达练习。" action="返回本次记录" onAction={() => navigate({ view: 'session-detail', id: s.id, mode: backMode })} />;
  return <div className="stack"><Card className={`session-timer ${remaining < 0 ? 'session-warning' : ''}`}><SectionTitle>{remaining < 0 ? '已超时' : s.status === '已结束' ? '结束时剩余' : '计划剩余'}</SectionTitle><strong className="session-timer-clock">{clock(Math.abs(remaining))}</strong><p className="meta">计划{planned / 60}分钟 · 已记录{clock(elapsed)}{s.status === '暂停' ? ' · 暂停不计时' : ''}</p></Card><SectionTitle>当前议程</SectionTitle>{s.agenda.map((a, i) => <button className={`session-agenda-row ${index === i ? 'current' : ''}`} key={i} onClick={() => selectTopic(i)}><span>{i < index ? <Icon name="check" size={17} /> : i + 1}</span><strong>{a}</strong><Badge tone={index === i ? 'purple' : 'gray'}>{i < index ? '已讨论' : index === i ? '当前' : '待讨论'}</Badge></button>)}{!s.agenda.length && <p className="meta">没有预设议题，可以在下方补充。</p>}{showRule && <Card><Badge tone="gray">本地关键词提示</Badge><p>{matched.length ? `最近3段提到了：${matched.join('、')}` : '最近3段没有命中当前议题词语，请自行判断是否需要回到议题。'}</p><p className="meta">不判断语义或给讨论评分。</p><Source title="核对最近原话" time={recent.at(-1)?.time || '时间未提供'} onClick={() => navigate({ view: 'session-transcript', id: s.id, mode: recent.at(-1)?.id })} /><Button tone="quiet" onClick={() => { update(d => putFlag(d, `topic-dismissed:${s.id}:${index}`, true)); toast('已忽略本议题提示'); }}>忽略本议题提示</Button></Card>}<Button disabled={!s.agenda.length || index >= s.agenda.length - 1} onClick={() => selectTopic(index + 1)}>推进到下一议题</Button>{data.settings.space === '我的空间' && <details className="session-details"><summary>编辑议程与计划时长</summary><Field label="计划时长（分钟）" value={plan} onChange={setPlan} type="number" /><Field label="本次议程" value={agenda} onChange={setAgenda} multiline /><Button tone="secondary" onClick={() => { const minutes = Number(plan); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) { toast('计划时长填写1—1440的整数分钟'); return; } const next = agenda.split('\n').map(x => x.trim()).filter(Boolean), current = Math.min(index, Math.max(0, next.length - 1)); setIndex(current); update(d => ({ ...patchSession(d, s.id, { agenda: next }), settings: { ...d.settings, retention: { ...d.settings.retention, [`agenda-${s.id}`]: String(current), [`session-plan:${s.id}`]: String(minutes) } } })); toast('议程与计划已保存'); }}>保存本次设置</Button></details>}<Button tone="quiet" onClick={() => navigate({ view: 'session-detail', id: s.id, mode: backMode })}>返回本次记录</Button></div>;
}

export function buildSessionExport(data: AppData, sessionId: string, format: string, includePrivate = false): string {
  const session = data.sessions.find(s => s.id === sessionId);
  if (!session || !canViewSession(data, session)) return '当前空间无法查看这段记录。';
  const personal = data.settings.space === '我的空间', common = !personal || format === '共同纪要';
  const space = data.settings.retention[`session-space:${session.id}`] || 'Oops 产品团队';
  const scoped = common ? { ...data, settings: { ...data.settings, space } } : data;
  if (common && !canViewSession(scoped, session)) return '此会话尚未共享或共享已撤销，不能共同导出。';
  const review = confirmedReview(scoped, session, common), changed = flag(data, `review-${session.id}`);
  const conclusions = review.filter(item => item.kind === 'conclusion'), questions = review.filter(item => item.kind === 'question');
  const transcripts = session.transcript.filter(turn => !turn.private || !common && includePrivate);
  const tasks = sessionTasks(scoped, session, common);
  const materials = session.attachments.filter(title => !common || canShareMaterial(scoped, session, title));
  const text = [session.title, `${session.date} · ${session.kind} · ${session.duration || '时长未提供'}`, common ? '共同纪要 · 获准共享内容与非敏感原话' : format === '转写原文' ? '个人原文导出' : '个人复盘'];
  if (format !== '转写原文') {
    text.push('', changed && !common ? '旧结论（来源变化，待重新核对）：' : '人工确认结论：', ...conclusions.map(item => `· ${item.text}`));
    if (!conclusions.length) text.push(common ? '尚未逐项共享人工确认结论。' : '尚未人工确认。');
    text.push('', changed && !common ? '旧未决问题（待重新核对）：' : '未决问题：', ...questions.map(item => `· ${item.text}`));
    if (!questions.length) text.push('暂无记录。');
    text.push('', '本次行动：', ...tasks.map(task => `· ${task.title}｜${task.owner}｜${task.due ? task.due.replace('T', ' ') : '期限未定'}｜工作：${task.status}｜助手：${task.aiStatus}${task.needsReview || !taskSourceAvailable(data, task) ? '｜来源待复核' : ''}${task.sourceSession ? '｜有原话出处' : '｜手工关联，无原话出处'}`));
    if (!tasks.length) text.push('暂无当前范围可见的行动。');
  }
  text.push('', format === '转写原文' ? '当前保留原文：' : common ? '非敏感原话摘录（不是自动会议总结）：' : '原话依据摘录：', ...(format === '转写原文' ? transcripts : transcripts.slice(-5)).map(turn => `${turnLabel(turn, session)} ${turn.speaker}：${turn.text}`));
  if (!common && includePrivate && session.privateNotes.length) text.push('', '本人私人便签：', ...session.privateNotes);
  if (materials.length) text.push('', '附加资料目录（不含文件正文）：', ...materials.map(title => `· ${title}${!common && data.memories.some(m => m.sourceSession === session.id && m.title === title && m.needsReview) ? '（来源待复核）' : ''}`));
  text.push('', '本地示例导出 · ASR、模型、设备与外部发送未接通');
  return text.join('\n');
}

function Sharing({ session: s }: { session: Session }) {
  const { data, route, update, navigate, toast } = useOops();
  const team = data.settings.space !== '我的空间';
  const [draft, setDraft] = useViewState(`session-sharing:${s.id}:${data.settings.space}`, { shared: flag(data, `shared-${s.id}`), recipient: data.settings.retention[`share-recipient-${s.id}`] || '', materials: s.attachments.filter(name => canShareMaterial(data, s, name)), items: reviewItems(data, s).filter(item => item.shared).map(item => item.id) });
  const [privateText, setPrivateText] = useState(false), [format, setFormat] = useViewState(`session-export-format:${s.id}:${data.settings.space}`, team ? '共同纪要' : '个人复盘');
  const common = team || format === '共同纪要';
  const exportText = buildSessionExport(data, s.id, format, !common && privateText);
  const items = reviewItems(data, s), sharedList = s.attachments.filter(name => canShareMaterial(data, s, name));
  function download() {
    const text = buildSessionExport(data, s.id, format, !common && privateText);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), a = document.createElement('a'); a.href = url; a.download = `${s.title}-${common ? '共同纪要' : '个人结果'}.txt`; a.click(); URL.revokeObjectURL(url); toast('已下载当前预览文本');
  }
  function saveScope() {
    if (draft.shared && !draft.recipient.trim()) { toast('填写本地共享对象或范围'); return; }
    update(current => {
      const actual = current.sessions.find(session => session.id === s.id); if (!actual) return current;
      const space = current.settings.retention[`session-space:${s.id}`] || 'Oops 产品团队';
      const prospective = setSessionShared(current, s.id, draft.shared);
      const selected = draft.shared ? draft.materials.filter(name => actual.attachments.includes(name) && materialEligible(prospective, actual, name)) : [];
      const toggles = { ...prospective.settings.toggles }, retention = { ...prospective.settings.retention, [`share-recipient-${s.id}`]: draft.recipient.trim(), [`session-space:${s.id}`]: space, [`session-materials:${s.id}`]: JSON.stringify(selected), [`session-review-items:${s.id}`]: JSON.stringify(reviewItems(prospective, actual).map(item => ({ ...item, shared: draft.shared && draft.items.includes(item.id) && sharedReviewEligible(prospective, actual, item) }))) };
      actual.attachments.forEach(name => { toggles[materialKey(s.id, name)] = selected.includes(name); retention[`material-space:${s.id}:${name}`] = space; });
      const memories = prospective.memories.map(m => {
        if (m.sourceSession !== s.id || !actual.attachments.includes(m.title) || m.tags.includes('修订历史')) return m;
        const visible = selected.includes(m.title) && sharedMemoryEligible(prospective, m);
        if (visible) retention[`memory-space:${m.id}`] = space;
        return { ...m, visibility: visible ? '项目共享' as const : '私有' as const };
      });
      return { ...prospective, memories, settings: { ...prospective.settings, toggles, retention } };
    });
    toast(draft.shared ? '已保存逐项共享范围；未选结论和资料保持私人' : '已撤回本次共享，旧派生内容保留待复核');
  }
  function revoke() {
    update(current => setSessionShared(current, s.id, false)); setDraft(current => ({ ...current, shared: false, materials: [], items: [] })); toast('本次本地共享已撤销，旧输出需复核');
  }
  if (route.view === 'session-export') return <div className="stack"><SelectField label="导出格式" value={format} options={team ? ['共同纪要', '转写原文'] : ['个人复盘', '共同纪要', '转写原文']} onChange={setFormat} />{!common && <Toggle label="加入本人便签与敏感原文" value={privateText} onChange={setPrivateText} hint="只影响个人本地导出，不能加入共同纪要。" />}{common && <Notice>已确认结论须逐项获准共享；其余内容准确标为非敏感原话摘录。</Notice>}<Card><p className="session-preserve">{exportText}</p></Card><Button icon="download-simple" onClick={download}>下载当前文本</Button><Button tone="secondary" onClick={() => void navigator.clipboard?.writeText(buildSessionExport(data, s.id, format, !common && privateText)).then(() => toast('已复制当前预览')).catch(() => toast('请使用下载保存'))}>复制当前文本</Button><Button tone="quiet" onClick={() => navigate({ view: 'session-share', id: s.id })}>管理共享范围</Button></div>;
  if (team) return <div className="stack"><Card><Badge>当前团队可见</Badge><h3>获准纪要与{sharedList.length}份资料</h3><p className="meta">共享对象：{data.settings.retention[`share-recipient-${s.id}`] || '项目成员'}</p></Card>{sharedList.map(name => <Row key={name} title={name} onClick={() => navigate({ view: 'session-source', id: s.id, mode: name })} />)}<Button onClick={() => navigate({ view: 'session-export', id: s.id })}>预览当前可导出内容</Button><Button tone="secondary" onClick={() => { update(d => ({ ...d, settings: { ...d.settings, space: '我的空间' } })); toast('已切换个人空间'); }}>在个人空间管理范围</Button></div>;
  return <div className="stack"><Toggle label="允许项目内查看共同纪要" value={draft.shared} onChange={shared => setDraft(current => ({ ...current, shared }))} /><Field label="本地共享对象 / 范围" value={draft.recipient} onChange={recipient => setDraft(current => ({ ...current, recipient }))} placeholder="例如：Oops产品团队" /><Card><SectionTitle>非敏感原话摘录</SectionTitle>{digest(s, true).map((line, i) => <p className="session-summary-line" key={i}>{line}</p>)}<p className="meta">不代表自动总结；隐藏{s.transcript.filter(t => t.private).length}段敏感内容和所有私人便签。</p></Card><SectionTitle>逐项共享已核对结果</SectionTitle>{items.length ? items.map(item => <Card key={item.id}><Check label={`${item.kind === 'conclusion' ? '结论' : '未决问题'}：${item.text}`} value={draft.items.includes(item.id) && sharedReviewEligible(data, s, item)} onChange={value => { if (!sharedReviewEligible(data, s, item)) { toast('来源敏感、缺失或待复核，不能共享这项'); return; } setDraft(current => ({ ...current, items: value ? [...new Set([...current.items, item.id])] : current.items.filter(id => id !== item.id) })); }} />{!sharedReviewEligible(data, s, item) && <p className="meta">需要先核对有效、非敏感来源。</p>}</Card>) : <p className="meta">先在本次结果中人工确认，再逐项选择共享。</p>}<SectionTitle>附加资料</SectionTitle>{s.attachments.length ? s.attachments.map(name => <Card key={name}><Check label={name} value={draft.materials.includes(name) && materialEligible(data, s, name)} onChange={value => { if (!materialEligible(data, s, name)) { toast('资料来源缺失、敏感或待复核，保持私人'); return; } setDraft(current => ({ ...current, materials: value ? [...new Set([...current.materials, name])] : current.materials.filter(x => x !== name) })); }} />{!materialEligible(data, s, name) && <p className="meta">当前不能共享；来源和正文仍需核对。</p>}</Card>) : <p className="meta">本次还没有附加资料。</p>}<Button onClick={saveScope}>保存明确选择的范围</Button><Button tone="danger" disabled={!flag(data, `shared-${s.id}`)} onClick={revoke}>撤销此会话共享</Button><p className="meta">仅改变本地示例访问范围；已经下载的副本无法收回。</p><Button tone="secondary" onClick={() => navigate({ view: 'session-export', id: s.id })}>查看当前导出预览</Button></div>;
}

const recallSamples = [ { id: 'r1', speaker: '我', time: '10:14:05', text: '把会中检索结果放回相关议题旁边。' }, { id: 'r2', speaker: '未知同事', time: '10:16:10', text: '先做一个资料卡，减少反复打断。' }, { id: 'r3', speaker: '我', time: '10:17:30', text: '下次找两位同事试用这个交互。' } ];
function Recall() {
  const { data, update, navigate, toast } = useOops();
  const [query, setQuery] = useState(''), [chosen, setChosen] = useState<string[]>([]), [title, setTitle] = useState('会中资料卡如何返回结果'), [saveOpen, setSaveOpen] = useState(false), [clearOpen, setClearOpen] = useState(false);
  const start = Number(data.settings.retention['recall-window-start'] || 0);
  const windowNumber = Number(data.settings.retention['recall-window-number'] || 1);
  const samples = windowNumber === 1 ? recallSamples : ['先把今天最急的事写成一个可以验证的目标。', '这条建议先保持私人，分享前再确认范围。', '下次试用后再决定是否放进正式议程。'].map((text, i) => ({ id: `window-${windowNumber}-${i}`, speaker: i === 1 ? '同事（示例）' : '我（示例）', time: new Date(start + (i + 1) * 4000).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }), text }));
  const visibleSamples = windowNumber === 1 ? samples : samples.filter((_, i) => Date.now() - start >= (i + 1) * 4000);
  const [expires, setExpires] = useState(start ? Math.max(0, 300 - Math.floor((Date.now() - start) / 1000)) : 300);
  useEffect(() => { if (!start && !data.recallCleared) update(c => ({ ...c, settings: { ...c.settings, retention: { ...c.settings.retention, 'recall-window-start': String(Date.now()) } } })); }, [start, data.recallCleared, update]);
  const dead = data.recallCleared || expires <= 0;
  useEffect(() => { if (dead) return; const timer = window.setInterval(() => setExpires(Math.max(0, 300 - Math.floor((Date.now() - (start || Date.now())) / 1000))), 1000); return () => window.clearInterval(timer); }, [dead, start]);
  const rows = dead ? [] : visibleSamples.filter(t => `${t.speaker}${t.text}`.includes(query));
  function save(asTask: boolean) {
    if (dead || !chosen.length) { setSaveOpen(false); toast('未保存片段已清空或过期'); return; }
    if (!title.trim()) { toast('填写保存标题'); return; }
    const selected = visibleSamples.filter(t => chosen.includes(t.id));
    if (!selected.length) { toast('所选片段不在当前窗口中'); return; }
    const mid = uid('MEM'), tid = uid('TASK');
    const memory: Memory = { id: mid, title: title.trim(), body: selected.map(t => `${t.time} ${t.speaker}：${t.text}`).join('\n'), category: '灵感', tags: ['Recall', '待验证'], visibility: '私有', updated: dateLabel(), confirmed: true };
    update(c => {
      const withMemory = { ...c, memories: [memory, ...c.memories] };
      const task: Task = { id: tid, title: `验证：${title.trim()}`, description: memory.body, owner: '我', requester: '我', due: '', priority: '中', status: '待承接', aiStatus: '未启动', sourceMemoryId: mid, sources: [makeSourceReference(withMemory, { kind: 'memory', id: mid })], activities: [`来自独立保存的Recall片段 ${mid}`], results: [], version: 1 };
      return { ...withMemory, tasks: asTask ? [task, ...c.tasks] : c.tasks, settings: { ...c.settings, space: '我的空间', retention: { ...c.settings.retention, [`recall-source:${mid}`]: JSON.stringify({ windowNumber, selectedItems: selected, saveDate: dateLabel() }), ...(asTask ? { [`task-space:${tid}`]: '我的空间' } : {}) } } };
    }); setSaveOpen(false); setChosen([]); toast(asTask ? '独立待办草稿已创建，助手未启动' : '所选文字已独立保存，发言事实仍需核对'); navigate({ view: asTask ? 'task-detail' : 'memory-detail', id: asTask ? tid : mid });
  }
  return <div className="stack"><div className="session-recall-hero"><Icon name="clock-counter-clockwise" size={32} /><h2>找回刚才那句</h2><p>{windowNumber === 1 ? '最近5分钟 · 预设示例窗口' : `新窗口 ${windowNumber} · 每4秒追加一句示例`}</p><Badge tone={dead ? 'gray' : 'purple'}>{dead ? '未保存缓存已失效' : `${Math.ceil(expires / 60)}分钟内可选择保存`}</Badge></div><Search value={query} onChange={setQuery} placeholder="刚才提到了什么？" />{rows.length ? rows.map(t => <div className="session-recall-choice" key={t.id}><Check label={`${t.time} ${t.speaker}`} value={chosen.includes(t.id)} onChange={v => setChosen(a => v ? [...a, t.id] : a.filter(id => id !== t.id))} /><p>{t.text}</p></div>) : <Empty title={dead ? '这段未保存内容已经移出' : '没有匹配片段'} body={dead ? '已保存的长期记忆仍可查看。' : '换一个关键词试试。'} />}
    {dead && <Button icon="play" onClick={() => { setChosen([]); setQuery(''); setSaveOpen(false); setExpires(300); update(c => ({ ...c, recallCleared: false, settings: { ...c.settings, retention: { ...c.settings.retention, 'recall-window-start': String(Date.now()), 'recall-window-number': String(windowNumber + 1) } } })); toast('新的示例窗口已开始，旧未保存片段不会恢复'); }}>开启新的5分钟示例窗口</Button>}<Button disabled={dead || !chosen.length} onClick={() => setSaveOpen(true)}>保存所选 {chosen.length} 段</Button><Button tone="secondary" onClick={() => navigate({ view: 'session-create', mode: '会议' })}>从现在开始完整会议记录</Button><Button tone="danger" disabled={dead} onClick={() => setClearOpen(true)}>停止并清空未保存缓存</Button><Button tone="quiet" onClick={() => navigate({ view: 'memory' })}>查看已保存记忆</Button><Notice>当前是预设片段，未打开麦克风。未保存内容到期不可找回。</Notice>
    <Sheet open={saveOpen} onClose={() => setSaveOpen(false)} title="只留下有用的片段"><Field label="保存标题" value={title} onChange={setTitle} /><p className="meta">仅自己可见 · 保留原文、时间与未知身份</p>{visibleSamples.filter(t => chosen.includes(t.id)).map(t => <p key={t.id}>{t.text}</p>)}<Button onClick={() => save(false)}>保存为长期记忆</Button><Button tone="secondary" onClick={() => save(true)}>保存来源并转独立待办草稿</Button></Sheet><Sheet open={clearOpen} onClose={() => setClearOpen(false)} title="清空未保存的片段？"><p>已保存记忆和完整会议不受影响。</p><Button tone="danger" onClick={() => { update(c => { const retention = { ...c.settings.retention }; delete retention['recall-window-start']; return { ...c, recallCleared: true, settings: { ...c.settings, retention } }; }); setChosen([]); setClearOpen(false); setSaveOpen(false); toast('未保存缓存已清空'); }}>确认清空</Button></Sheet></div>;
}

function CreativeSummary({ session: s }: { session: Session }) {
  const { data, update, navigate, toast } = useOops();
  const idea = s.kind === '灵感';
  const [core, setCore] = useViewState(`session-creative-core:${s.id}:${data.settings.space}`, s.transcript.map(t => t.text).join('\n')), [body, setBody] = useViewState(`session-creative-body:${s.id}:${data.settings.space}`, '');
  function prepare() {
    if (!core.trim()) { toast('先写下核心想法'); return; }
    setBody(idea ? `开场：${s.title}。\n核心观点：${core.split('\n')[0]}\n例子：${core.split('\n')[1] || '用一个具体场景说明。'}\n结尾：先验证一版，再决定下一步。` : `你好，想跟进一下${s.title}。\n我们刚才提到：${core.split('\n')[0]}\n方便告诉我目前进度和还缺的资料吗？谢谢。`);
  }
  function save(asTask = false) {
    if (!body.trim()) { toast('先整理或填写草稿内容'); return; }
    const mid = uid('MEM'), tid = uid('TASK');
    const m: Memory = { id: mid, title: `${s.title} · ${idea ? '口播提纲' : '联系草稿'}`, body, category: idea ? '灵感' : '记忆', visibility: '私有', tags: [s.kind, '私人草稿'], confirmed: true, updated: '今天', sourceSession: s.id, sources: [makeSourceReference(data, { kind: 'session', id: s.id })] };
    const task: Task = { id: tid, title: idea ? `制作：${s.title}` : `跟进：${s.title}`, description: body, owner: '我', requester: '我', due: '', priority: '中', status: '待承接', aiStatus: '未启动', relatedSessionId: s.id, sourceSession: s.id, sources: [makeSourceReference(data, { kind: 'session', id: s.id })], activities: [`从私人草稿${mid}创建建议`], results: [], version: 1 };
    update(c => ({ ...c, memories: [m, ...c.memories], tasks: asTask ? [task, ...c.tasks] : c.tasks, settings: { ...c.settings, retention: { ...c.settings.retention, ...(asTask ? { [`task-space:${tid}`]: '我的空间' } : {}) } } }));
    toast(asTask ? '独立待办草稿已建立' : '已保存私人草稿'); navigate({ view: asTask ? 'task-detail' : 'memory-detail', id: asTask ? tid : mid });
  }
  return <div className="stack"><Field label={idea ? '核心想法' : '需要跟进的内容'} value={core} onChange={setCore} multiline /><Button onClick={prepare}>{idea ? '整理一分钟口播提纲' : '准备联系草稿'}</Button>{body && <><Field label={idea ? '口播提纲' : '联系草稿'} value={body} onChange={setBody} multiline /><Notice>本地结构示例，未生成视频或发送消息。</Notice><Button onClick={() => save()}>保存私人草稿</Button><Button tone="secondary" onClick={() => save(true)}>形成独立待办建议</Button><Button tone="quiet" onClick={() => void navigator.clipboard?.writeText(body).then(() => toast('草稿已复制')).catch(() => toast('可先保存为私人草稿'))}>复制草稿</Button></>}<Source title={s.title} time="本次原话与人工草稿" onClick={() => navigate({ view: 'session-transcript', id: s.id })} /></div>;
}

function Practice({ session: s }: { session: Session }) {
  const { data, update, navigate, toast } = useOops();
  const [original, setOriginal] = useViewState(`session-practice-original:${s.id}:${data.settings.space}`, s.transcript.find(t => t.speaker === '我')?.text || ''), [rewrite, setRewrite] = useViewState(`session-practice-rewrite:${s.id}:${data.settings.space}`, ''), [goal, setGoal] = useViewState(`session-practice-goal:${s.id}:${data.settings.space}`, '先说结论，再说明依据与下一步'), [feedback, setFeedback] = useViewState(`session-practice-feedback:${s.id}:${data.settings.space}`, '');
  const [language, setLanguage] = useViewState(`session-practice-language:${s.id}:${data.settings.space}`, '中文'), [tone, setTone] = useViewState(`session-practice-tone:${s.id}:${data.settings.space}`, '平实清楚'), [emotion, setEmotion] = useViewState(`session-practice-emotion:${s.id}:${data.settings.space}`, '平稳陈述');
  const [draftSettings, setDraftSettings] = useViewState(`session-practice-settings:${s.id}:${data.settings.space}`, { language: '中文', tone: '平实清楚', emotion: '平稳陈述' });
  const emotionTips: Record<string, string> = { 平稳陈述: '示例建议：用一句结论开场，把依据和下一步分开。', 略显急切: '示例建议：给对方留一个停顿，再说明期限与优先级。', 表达不确定: '示例建议：区分已知事实与还需验证的假设。', 希望得到支持: '示例建议：具体说出需要谁帮助、希望得到什么。' };
  const toneTips: Record<string, string> = { 平实清楚: '先说结论，保持信息完整。', 温和协作: '说明共同目标，再邀请对方补充。', 简洁直接: '保留一条结论、一条依据和一个明确动作。' };
  function analyze() {
    if (!original.trim()) { toast('先填写一段原话'); return; }
    const opening = tone === '温和协作' ? '我建议我们先确认' : tone === '简洁直接' ? '结论' : '我的结论';
    const chinese = `${opening}：${original.trim().replace(/[。！？].*$/, '')}。\n依据：补上一个事实或例子。\n下一步：明确负责人、期限与检查方式。`;
    const english = `Conclusion: Let's agree on one clear outcome first.\nEvidence: Add one fact or example.\nNext step: Confirm the owner, deadline, and how to review it.`;
    setRewrite(language === 'English' ? english : language === '中英对照' ? `中文草稿\n${chinese}\n\nEnglish structure example\n${english}` : chinese);
    setDraftSettings({ language, tone, emotion });
    setFeedback(`原话${original.trim().length}字。${toneTips[tone]} ${emotionTips[emotion]}`);
    toast('已整理本地结构草稿，可继续修改');
  }
  function save() {
    if (!original.trim() || !rewrite.trim()) { toast('先整理或填写改写草稿'); return; }
    const m: Memory = { id: uid('MEM'), title: `${s.title} · 表达练习`, body: `目标：${goal}\n输出：${draftSettings.language} · 语气偏好：${draftSettings.tone}\n反馈情境（手动选择）：${draftSettings.emotion}\n原话：${original}\n改写草稿：${rewrite}\n反馈示例：${feedback || `${toneTips[tone]} ${emotionTips[emotion]}`}\n本地结构示例，未做真实情绪识别或翻译。`, category: '目标', tags: ['成长', '表达', draftSettings.language, '反馈示例'], visibility: '私有', updated: '今天', confirmed: true, sourceSession: s.id, ...(s.transcript.find(t => t.speaker === '我') ? { sourceId: s.transcript.find(t => t.speaker === '我')!.id, sourceTime: s.transcript.find(t => t.speaker === '我')!.time || undefined } : {}) };
    update(c => ({ ...c, memories: [m, ...c.memories] })); toast('可编辑练习草稿已保存为私人目标'); navigate({ view: 'memory-detail', id: m.id });
  }
  return <div className="stack"><Field label="想练习的原话" value={original} onChange={setOriginal} multiline /><Field label="本次成长目标" value={goal} onChange={setGoal} /><SelectField label="输出语言" value={language} onChange={setLanguage} options={['中文', '中英对照', 'English']} /><SelectField label="希望的语气" value={tone} onChange={setTone} options={['平实清楚', '温和协作', '简洁直接']} /><Card className="session-feedback"><Badge tone="gray">语气与情绪反馈示例</Badge><SelectField label="选择练习情境" value={emotion} onChange={setEmotion} options={['平稳陈述', '略显急切', '表达不确定', '希望得到支持']} /><p>{toneTips[tone]}</p><p>{emotionTips[emotion]}</p><p className="meta">情境由你选择，未分析声音、识别情绪或推断他人心理。</p></Card><Button icon="sparkle" onClick={analyze}>{rewrite ? '按当前选择重新整理草稿' : '整理表达结构'}</Button>{rewrite && <><Card><Badge tone="gray">本地结构示例</Badge><p className="meta">本稿：{draftSettings.language} · {draftSettings.tone} · {draftSettings.emotion}</p><p>{feedback}</p>{draftSettings.language !== '中文' && <p className="meta">英文部分是结构示例，请按原意编辑；未调用翻译服务。</p>}</Card><Field label="可编辑的改写草稿" value={rewrite} onChange={setRewrite} multiline /><Button onClick={save}>保存草稿与成长目标</Button><Button tone="secondary" onClick={() => { setFeedback('这条建议不适合我；后续先保留原来的表达方式。'); toast('个人反馈已保留在本次练习'); }}>这条建议不适合我</Button></>}<Notice>练习与反馈仅本人可见。当前偏好：{data.settings.tone}</Notice></div>;
}

function RevisionHistory({ session: s }: { session: Session }) {
  const { data, update, navigate, toast } = useOops();
  const versions = data.memories.filter(m => m.sourceSession === s.id && m.tags.includes('修订历史'));
  function restore(memory: Memory) {
    const fallbackId = uid('restored');
    const result = restoreSessionRevision(data, s.id, memory.id, fallbackId);
    if (result.error || !result.turnId) { toast(result.error || '请先核对这条历史'); return; }
    update(current => restoreSessionRevision(current, s.id, memory.id, fallbackId).data);
    toast('已恢复完整原文，范围与助手授权不会自动恢复'); navigate({ view: 'session-transcript', id: s.id, mode: result.turnId });
  }
  return <div className="stack">{versions.length ? versions.map(memory => <Card key={memory.id}><h3>{memory.title}</h3><p className="session-preserve">{memory.body}</p><Button tone="quiet" onClick={() => restore(memory)}>恢复此版本原文，保留复核状态</Button></Card>) : <Empty title="还没有修订历史" body="修订和删除前的原文会私人保留在这里。" />}</div>;
}

function HistoryQuestion() {
  const { data, navigate } = useOops();
  const [question, setQuestion] = useState(''), [submitted, setSubmitted] = useState('');
  const matches = submitted ? data.sessions.filter(s => canViewSession(data, s)).flatMap(s => s.transcript.filter(t => (data.settings.space === '我的空间' || !t.private) && ( submitted.split(/[\s，。？?]/).some(k => k.length > 1 && t.text.includes(k)) || /任务|KPI|复盘/i.test(submitted) && /KPI|复盘/.test(t.text))).map(t => ({ s, t }))) : [];
  return <div className="stack"><Field label="问已有记录" value={question} onChange={setQuestion} multiline placeholder="比如：KPI复盘是谁提出的？" /><Button disabled={!question.trim()} onClick={() => setSubmitted(question.trim())}>查找本地记录</Button>{submitted && <><Notice>仅使用本地可查看的记录，结果保留出处。</Notice>{matches.length ? matches.map(({ s, t }) => <Card key={`${s.id}-${t.id}`}><p>{t.text}</p><Source title={s.title} time={t.time} onClick={() => navigate({ view: 'session-transcript', id: s.id, mode: t.id })} /></Card>) : <Empty title="没有找到可引用的内容" body="换一个具体关键词，不编造没有的答案。" />}</>}</div>;
}
