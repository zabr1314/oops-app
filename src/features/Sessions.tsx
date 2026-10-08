import { useEffect, useRef, useState } from 'react';
import { useOops, type AppData, type Route, type Session, type Transcript, type Memory, type Task } from '../store';
import { Avatar, Badge, Button, Card, Check, Chips, Empty, Field, Icon, Notice, Row, Search, SectionTitle, SelectField, Sheet, Source, Tabs, Toggle } from '../ui';
import { taskVisible } from './Home';
import './Sessions.css';

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const clock = (n: number) => `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const seconds = (s: string) => s.split(':').reduce((n, x) => n * 60 + Number(x || 0), 0);
const dateLabel = () => new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
const flag = (data: AppData, key: string) => data.settings.toggles[key] === true;
const canViewSession = (data: AppData, session: Session) => data.settings.space === '我的空间' || (flag(data, `shared-${session.id}`) && (data.settings.retention[`session-space:${session.id}`] || 'Oops 产品团队') === data.settings.space);
const materialKey = (sessionId: string, title: string) => `material-shared:${sessionId}:${title}`;
type SourcedMaterial = Memory & { sourceId?: string; needsReview?: boolean };
const materialEligible = (data: AppData, session: Session, title: string) => {
  const current = data.sessions.find(s => s.id === session.id);
  if (!current) return false;
  return data.memories.filter(m => m.sourceSession === current.id && m.title === title).every(item => {
    const memory = item as SourcedMaterial;
    if (memory.deleted || !memory.confirmed || memory.needsReview || memory.tags.some(tag => ['修订历史', '待复核', '待确认'].includes(tag))) return false;
    const sourceId = memory.sourceId?.trim(), sourceTime = memory.sourceTime?.trim();
    const source = sourceId ? current.transcript.find(t => t.id === sourceId) : sourceTime ? current.transcript.find(t => t.time === sourceTime) : undefined;
    if (sourceId || sourceTime) return !!source && !source.private;
    return !current.transcript.some(t => t.private);
  });
};
const canShareMaterial = (data: AppData, session: Session, title: string) => flag(data, `shared-${session.id}`) && flag(data, materialKey(session.id, title)) && materialEligible(data, session, title) && !data.memories.some(m => m.sourceSession === session.id && m.title === title && m.visibility === '私有') && (data.settings.space === '我的空间' || (data.settings.retention[`material-space:${session.id}:${title}`] || data.settings.retention[`session-space:${session.id}`] || 'Oops 产品团队') === data.settings.space);
const agendaKeywords = (topic: string) => [...new Set([...(topic.match(/[A-Za-z][A-Za-z0-9-]+/g) || []).map(x => x.toLowerCase()), ...(topic.match(/[一-鿿]+/g) || []).flatMap(word => Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2)))])].filter(x => !['讨论', '关于', '确认', '安排', '议题', '流程', '方案', '我们', '今天', '进行'].includes(x));

type ReviewableTask = Task & { needsReview?: boolean; generationToken?: string; artifacts?: { id: string; kind: '文档' | 'PPT' | '资料'; title: string; version: number; body: string[]; created: string; needsReview?: boolean }[] };
const patchSession = (data: AppData, id: string, change: Partial<Session>): AppData => ({ ...data, sessions: data.sessions.map(s => s.id === id ? { ...s, ...change } : s) });
const putFlag = (data: AppData, key: string, value: boolean): AppData => ({ ...data, settings: { ...data.settings, toggles: { ...data.settings.toggles, [key]: value } } });
const untitled = (kind: Session['kind']) => `${kind} · ${dateLabel()}`;
const unknownSpeaker = (name: string) => /待确认|说话人|未知/.test(name);
const visibleTask = (data: AppData, task: Task, publicOnly = false) => {
  const scoped = publicOnly && data.settings.space === '我的空间' ? { ...data, settings: { ...data.settings, space: data.settings.retention[`session-space:${task.sourceSession}`] || 'Oops 产品团队' } } : data;
  return taskVisible(scoped, task) && (scoped.settings.space === '我的空间' || !task.sourceSession || scoped.sessions.find(x => x.id === task.sourceSession)?.transcript.some(t => t.time === task.sourceTime && !t.private));
};
const readList = (value?: string): string[] => { try { const rows = JSON.parse(value || '[]'); return Array.isArray(rows) ? rows.filter(x => typeof x === 'string') : []; } catch { return []; } };
const digest = (session: Session, publicOnly = false) => session.transcript.filter(t => !publicOnly || !t.private).slice(-5).map(t => `${t.speaker}：${t.text}`).filter(Boolean);
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
        if (s.kind === '会议' && index === 4) tasks = [...tasks, { id: uid('TASK'), title: '准备第三季度KPI复盘', description: line.text, owner: '我', requester: '王宁', due: '', priority: '中', status: '待承接', aiStatus: '未启动', sourceSession: s.id, sourceTime: line.time, activities: ['示例讨论形成待承接建议'], results: [], version: 1 }];
      }
      return { ...patchSession(current, s.id, { transcript, attachments, participants: [...new Set([...s.participants, ...transcript.map(t => t.speaker)])], duration: elapsed >= 3600 ? clock(elapsed) : clock(elapsed).slice(3) }), tasks, settings: { ...current.settings, retention: { ...current.settings.retention, [`sample-index:${s.id}`]: String(transcript === s.transcript ? index : index + 1) } } };
    }), 1000);
    return () => window.clearInterval(interval);
  }, [active?.id, active?.status, recallStarted, update]);
}

export function sessionTitle(route: Route): string {
  const titles: Record<string, string> = { sessions: '会话', 'session-mode': '开始一段记录', 'session-create': '创建记录', 'session-import': '导入内容', 'session-import-preview': '检查导入', 'session-detail': '会话', 'session-transcript': '转写', 'session-edit': '修订片段', 'session-identity': '确认说话人', 'session-source': '资料详情', 'session-agenda': '议程', 'session-map': '思维导图', 'session-display': '大屏预览', 'session-reminders': '会议提醒', 'session-share': '共享范围', 'session-export': '导出预览', 'session-recall': 'Recall · 最近5分钟', 'session-recall-save': '保存所选片段', 'session-growth': '表达练习', 'session-inspiration': '灵感与联系草稿', 'session-history': '问已有记录', 'session-revisions': '修订历史' };
  return titles[route.view] || '会话';
}

export default function Sessions() {
  const { data, route, navigate, back } = useOops();
  if (route.view === 'sessions') return <SessionList />;
  if (route.view === 'session-mode') return <QuickStart />;
  if (route.view === 'session-create') return <CreateSession key={route.id || route.mode || 'new'} />;
  if (route.view.startsWith('session-import')) return <ImportSession />;
  if (route.view.startsWith('session-recall')) return <Recall />;
  if (route.view === 'session-history') return <HistoryQuestion />;
  const session = data.sessions.find(s => s.id === route.id);
  if (session && data.settings.space !== '我的空间' && (!canViewSession(data, session) || ['session-edit', 'session-identity', 'session-growth', 'session-inspiration', 'session-revisions'].includes(route.view))) return <Empty title="这项内容属于个人空间" body="当前空间仅显示明确共享的会话与非敏感内容。" action="返回" onAction={back} />;
  if (!session) return <Empty title="还没有这段记录" body="从会话列表选择一段，或开始新的记录。" action="所有会话" onAction={() => navigate({ view: 'sessions' })} />;
  if (route.view === 'session-edit') return <EditTranscript key={`${route.id}-${route.mode}`} session={session} />;
  if (route.view === 'session-identity') return <Identity key={`${route.id}-${route.mode}`} session={session} />;
  if (route.view === 'session-source') return <Material session={session} />;
  if (['session-share', 'session-export'].includes(route.view)) return <Sharing session={session} />;
  if (['session-agenda', 'session-map', 'session-display', 'session-reminders'].includes(route.view)) return <MeetingTools session={session} />;
  if (route.view === 'session-growth') return <Practice session={session} />;
  if (route.view === 'session-inspiration') return <CreativeSummary session={session} />;
  if (route.view === 'session-revisions') return <RevisionHistory session={session} />;
  return <SessionExperience session={session} />;
}

function SessionList() {
  const { data, update, navigate, toast, route } = useOops();
  const [projectFilter, setProjectFilter] = useState(data.projects.some(p => p.name === route.mode) ? route.mode! : '全部项目');
  const [query, setQuery] = useState(''), [kind, setKind] = useState('全部'), [status, setStatus] = useState('全部'), [selected, setSelected] = useState<Session | null>(null);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const deleted = Object.entries(data.settings.retention).filter(([key]) => key.startsWith('deleted-session:')).flatMap(([, value]) => { try { return [JSON.parse(value) as Session]; } catch { return []; } });
  const rows = data.sessions.filter(s => canViewSession(data, s) && (projectFilter === '全部项目' || s.project === projectFilter) && (status === '已归档' ? s.archived : !s.archived) && (kind === '全部' || s.kind === kind) && (['全部', '已归档'].includes(status) || s.status === status) && `${s.title} ${s.project} ${s.transcript.filter(t => data.settings.space === '我的空间' || !t.private).map(t => t.text).join(' ')}`.includes(query.trim()));
  return <div className="stack sessions-feature"><div className="action-grid"><Button icon="microphone" onClick={() => navigate({ view: 'session-mode' })}>开始记录</Button><Button tone="secondary" icon="upload-simple" onClick={() => navigate({ view: 'session-import' })}>导入</Button></div><Search value={query} onChange={setQuery} placeholder="搜索标题、发言或项目" /><SelectField label="项目范围" value={projectFilter} onChange={setProjectFilter} options={['全部项目', ...data.projects.map(p => p.name)]} /><Chips items={['全部', '会议', '日常', '灵感', '练习', 'Recall']} value={kind} onChange={setKind} /><Chips items={['全部', '进行中', '暂停', '待开始', '已结束', '已归档']} value={status} onChange={setStatus} />
    {rows.length ? rows.map(s => <div className="session-list-item" key={s.id}><Card onClick={() => navigate({ view: s.status === '待开始' ? 'session-create' : 'session-detail', id: s.id })}><div className="session-card-top"><span className="session-kind"><Icon name={s.kind === '会议' ? 'users-three' : 'waveform'} /></span><Badge tone={s.status === '进行中' ? 'purple' : 'gray'}>{s.status}</Badge></div><h3>{s.title}</h3><p className="meta">{s.date} · {s.duration || '待开始'} · {s.kind}</p><p className="session-preview">{(data.settings.space === '我的空间' ? s.summary[0] : digest(s, true)[0]) || s.agenda[0] || '点击继续准备这段记录'}</p><div className="session-card-bottom"><span>{s.project || '个人记录'}</span><span>{s.participants.length}位参与者</span></div></Card><button className="session-more" aria-label={`管理${s.title}`} onClick={() => setSelected(s)}><Icon name="dots-three" /></button></div>) : <Empty title="没有找到记录" body="换一个关键词，或清除筛选。" action="清除筛选" onAction={() => { setQuery(''); setKind('全部'); setStatus('全部'); setProjectFilter('全部项目'); }} />}
    {data.settings.space === '我的空间' && <Row title="会话回收站" subtitle={`${deleted.length}条可恢复记录`} icon="trash" onClick={() => setRecycleOpen(true)} />}<Sheet open={recycleOpen} onClose={() => setRecycleOpen(false)} title="已删除的会话">{deleted.length ? deleted.map(item => <Row key={item.id} title={item.title} subtitle="恢复为私人记录，关联输出仍需复核" onClick={() => { update(c => { const retention = { ...c.settings.retention }; delete retention[`deleted-session:${item.id}`]; return { ...c, sessions: [{ ...item, archived: false, status: item.status === '进行中' ? '暂停' : item.status }, ...c.sessions.filter(x => x.id !== item.id)], settings: { ...c.settings, space: '我的空间', retention, toggles: { ...c.settings.toggles, [`shared-${item.id}`]: false } } }; }); setRecycleOpen(false); toast('记录已恢复，共享权限未恢复'); navigate({ view: 'session-detail', id: item.id }); }} />) : <Empty title="回收站是空的" body="删除的记录会在这里保留到本地重置。" />}</Sheet>
    <Sheet open={!!selected} onClose={() => setSelected(null)} title={selected?.title || '管理记录'}>{selected && <><Button tone="secondary" onClick={() => { navigate({ view: 'session-create', id: selected.id }); setSelected(null); }}>编辑名称与准备</Button><Button tone="secondary" onClick={() => { if (!selected.archived && data.activeSessionId === selected.id) { toast('先结束当前记录，再归档'); return; } update(c => patchSession(c, selected.id, { archived: !selected.archived })); toast(selected.archived ? '记录已恢复' : '记录已归档'); setSelected(null); }}>{selected.archived ? '恢复记录' : '归档记录'}</Button><Button tone="danger" onClick={() => { if (data.activeSessionId === selected.id) { toast('先暂停或结束当前记录，再删除'); return; } update(c => ({ ...c, sessions: c.sessions.filter(s => s.id !== selected.id), settings: { ...c.settings, retention: { ...c.settings.retention, [`deleted-session:${selected.id}`]: JSON.stringify(selected) }, toggles: { ...c.settings.toggles, [`shared-${selected.id}`]: false } }, tasks: c.tasks.map(t => t.sourceSession === selected.id ? { ...t, activities: [...t.activities, '来源记录已删除，需复核'], authorized: false } : t), memories: c.memories.map(m => m.sourceSession === selected.id ? { ...m, confirmed: false, visibility: '私有' } : m) })); toast('记录已删除，关联来源标为待复核'); setSelected(null); }}>确认删除这段记录</Button></>}</Sheet></div>;
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
  const [title, setTitle] = useState(existing?.title || ''), [kind, setKind] = useState(existing?.kind || (route.mode as Session['kind']) || '会议');
  const [project, setProject] = useState(existing?.project || '个人记录');
  const [members, setMembers] = useState(existing?.participants || ['我']);
  const [agenda, setAgenda] = useState(existing?.agenda.join('\n') || '');
  const [allowShare, setAllowShare] = useState(existing ? flag(data, `shared-${existing.id}`) : false);
  const [scope, setScope] = useState(data.settings.retention[`session-${existing?.id}`] || '完整保存'), [error, setError] = useState('');
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
    const record: Session = { id, title: start && existing?.status === '已结束' ? `${name} · 后续` : name, kind, project: project || '个人记录', date: reuse ? existing.date : dateLabel(), duration: reuse ? existing.duration || '00:00' : '00:00', status: start ? '进行中' : existing?.status || '待开始', participants: members.length ? members : ['我'], agenda: agenda.split('\n').map(x => x.trim()).filter(Boolean), transcript: reuse ? existing.transcript : [], attachments: reuse ? existing.attachments : [], summary: reuse ? existing.summary : [], privateNotes: reuse ? existing.privateNotes : [] };
    update(c => ({ ...c, sessions: reuse ? c.sessions.map(x => x.id === id ? record : x) : [record, ...c.sessions], activeSessionId: start ? id : c.activeSessionId, settings: { ...c.settings, space: allowShare ? c.settings.space : '我的空间', toggles: { ...c.settings.toggles, [`shared-${id}`]: allowShare }, retention: { ...c.settings.retention, 'record-last-kind': kind, [`session-${id}`]: scope, [`session-space:${id}`]: c.settings.space === '我的空间' ? 'Oops 产品团队' : c.settings.space } } }));
    toast(start ? '本地示例记录已开始' : '可选准备已保存'); navigate({ view: start ? 'session-detail' : 'sessions', id: start ? id : undefined });
  }
  return <form id="oops-session-prepare-form" className="stack session-prepare" onSubmit={e => { e.preventDefault(); save(true); }}><Notice>本地示例输入 · {allowShare ? '共同纪要可供所选项目查看' : '保存到我的空间'}。以下准备均可稍后补充。</Notice>{busy && <Card className="session-active-card"><Badge>{activeVisible ? active.status : '活动记录'}</Badge><h3>{activeVisible ? '已有一段活动记录' : '另一个空间已有活动记录'}</h3><p>{activeVisible ? active.title : '回到我的空间后，可继续或结束这段记录。'}</p><Button tone="secondary" onClick={continueActive}>{activeVisible ? '继续当前记录' : '回到当前记录'}</Button>{activeVisible && data.settings.space === '我的空间' && <Button tone="quiet" onClick={() => { update(c => ({ ...c, settings: { ...c.settings, retention: { ...c.settings.retention, 'record-next-kind': kind } } })); requestEnd(active.id); }}>结束后再新建</Button>}</Card>}<Field label="记录名称（可选）" value={title} onChange={setTitle} placeholder="留空会使用类型与当前时间命名" /><SelectField label="记录方式" value={kind} options={['会议', '日常', '灵感', '练习', 'Recall']} onChange={v => setKind(v as Session['kind'])} /><SelectField label="关联项目（可选）" value={project} options={['个人记录', ...data.projects.map(p => p.name)]} onChange={setProject} /><Card><SectionTitle>计划参与者（可选）</SectionTitle><p className="meta">选择成员不代表已经识别声音；也可以记录后再核对。</p>{['我', ...data.people.map(p => p.name)].filter((x, i, a) => a.indexOf(x) === i).map(name => <Check key={name} label={name} value={members.includes(name)} onChange={checked => setMembers(a => checked ? [...a, name] : a.filter(x => x !== name))} />)}<Field label="临时参与者" value={members.filter(x => !['我', ...data.people.map(p => p.name)].includes(x)).join('、')} onChange={v => setMembers(a => [...a.filter(x => ['我', ...data.people.map(p => p.name)].includes(x)), ...v.split(/[、,，]/).map(x => x.trim()).filter(Boolean)])} placeholder="可稍后填写，用顿号分隔" /></Card><Field label={kind === '会议' ? '议程与目标（可选）' : '想留下什么（可选）'} value={agenda} onChange={setAgenda} multiline hint="每行一个主题；空白也可以开始。" /><SelectField label="结束后的保留方式" value={scope} options={['完整保存', '结束后选择片段']} onChange={setScope} /><Toggle label="允许项目内查看共同纪要" value={allowShare} onChange={setAllowShare} hint="默认私有；私人便签、敏感片段与未选资料不会共享。" />{error && <p className="error-text" role="alert">{error}</p>}<Button tone="secondary" onClick={() => save(false)}>保存准备，稍后开始</Button></form>;
}

function ImportSession() {
  const { data, update, navigate, toast } = useOops();
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(''), [content, setContent] = useState(''), [kind, setKind] = useState<Session['kind']>('会议'), [file, setFile] = useState<{ name: string; size: string; type: string } | null>(null), [preview, setPreview] = useState(false), [error, setError] = useState('');
  const lines: Transcript[] = content.split('\n').filter(x => x.trim()).map((text, i) => {
    const m = text.match(/^(?:(\d{2}:\d{2}:\d{2})\s*)?([^：:]{1,18})[：:]\s*(.*)$/);
    return { id: `import-${i}`, speaker: m?.[2] || '导入文本', time: m?.[1] || clock(i * 30), text: m?.[3] || text.trim() };
  });
  async function readFile(f?: File) {
    if (!f) return;
    setFile({ name: f.name, size: `${(f.size / 1024).toFixed(1)} KB`, type: f.type || '未知格式' });
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
    if (f.type.startsWith('text/') || /\.(txt|md)$/i.test(f.name)) setContent(await f.text());
    else if (!f.type.startsWith('audio/')) setError('此原型只解析TXT/Markdown；其他文件仅保留文件信息');
    setPreview(false);
  }
  function create() {
    if (!title.trim()) { setError('填写导入记录的名称'); return; }
    if (!lines.length && !file) { setError('粘贴文字或选择一个文件'); return; }
    const id = uid('session');
    const s: Session = { id, title: title.trim(), kind, project: data.projects[0]?.name || '个人记录', date: dateLabel(), duration: lines.length ? clock(lines.length * 30).slice(3) : '无转写', status: '已结束', participants: [...new Set(lines.map(l => l.speaker))], transcript: lines, attachments: file ? [file.name] : [], privateNotes: [], agenda: [], summary: lines.slice(0, 4).map(x => x.text) };
    update(c => ({ ...c, sessions: [s, ...c.sessions], settings: { ...c.settings, space: '我的空间' } })); toast('导入记录已创建在我的空间'); navigate({ view: 'session-transcript', id });
  }
  return <div className="stack"><Field label="记录名称" value={title} onChange={setTitle} placeholder="给导入内容起个名字" /><SelectField label="内容类型" value={kind} options={['会议', '日常', '灵感', '练习']} onChange={x => setKind(x as Session['kind'])} /><Field label="粘贴转写文字" value={content} onChange={v => { setContent(v); setPreview(false); }} multiline placeholder="00:01:20 王宁：先确认预算…" /><input type="file" ref={fileRef} hidden accept="audio/*,.txt,.md" onChange={e => void readFile(e.target.files?.[0])} /><Button tone="secondary" icon="paperclip" onClick={() => fileRef.current?.click()}>选择文本或音频文件</Button>{file && <Card><strong>{file.name}</strong><p className="meta">{file.size} · {file.type}</p>{file.type.startsWith('audio/') && <Notice>只读取文件信息。没有自动生成音频转写。</Notice>}</Card>}{error && <p className="error-text">{error}</p>}<Button onClick={() => { if (!content.trim() && !file) { setError('先添加内容'); return; } setPreview(true); setError(''); }}>预览导入内容</Button>{preview && <><SectionTitle>预览 · {lines.length}段文字</SectionTitle>{lines.length ? lines.slice(0, 8).map(t => <TranscriptCard key={t.id} item={t} />) : <Empty title="音频尚无转写" body="可以建立音频资料记录，之后补充文字。" />}<Button onClick={create}>确认创建记录</Button></>}</div>;
}

function TranscriptCard({ item, active = false, onClick }: { item: Transcript; active?: boolean; onClick?: () => void }) {
  return <Card className={`session-transcript ${active ? 'highlighted' : ''}`} onClick={onClick}><div className="session-speaker"><Avatar name={item.speaker} /><strong>{item.speaker}</strong><span>{item.time}</span>{item.private && <Badge tone="gray">私有</Badge>}</div><p>{item.text}</p></Card>;
}

function SessionExperience({ session: s }: { session: Session }) {
  const { data, update, route, navigate, toast, requestEnd } = useOops();
  const [view, setView] = useState(data.settings.retention[`session-view:${s.id}`] || '我的视角'), [query, setQuery] = useState(''), [speaker, setSpeaker] = useState('全部'), [playing, setPlaying] = useState(false), [selectedTime, setSelectedTime] = useState(route.mode || ''), [speed, setSpeed] = useState('1倍速'), [ask, setAsk] = useState(''), [researchOpen, setResearchOpen] = useState(false), [taskOpen, setTaskOpen] = useState(false), [taskTitle, setTaskTitle] = useState(''), [taskBody, setTaskBody] = useState(''), [taskSource, setTaskSource] = useState(''), [due, setDue] = useState(''), [note, setNote] = useState('');
  const team = data.settings.space !== '我的空间';
  const shared = team || view === '共享纪要';
  const budgetConflict = s.transcript.filter(t => !shared || !t.private).some(t => /十万|10万/.test(t.text)) && s.transcript.filter(t => !shared || !t.private).some(t => /十三万|13万/.test(t.text));
  const tab = route.view === 'session-transcript' ? '转写' : ['现场', '转写', '资料', '任务', '复盘'].includes(route.mode || '') ? route.mode! : s.status === '已结束' ? '复盘' : '现场';
  const currentTranscript = s.transcript.filter(t => !shared || !t.private);
  const transcript = currentTranscript.filter(t => (speaker === '全部' || t.speaker === speaker) && `${t.text}${t.speaker}`.includes(query));
  const visibleAttachments = s.attachments.filter(name => !shared || canShareMaterial(data, s, name));
  const tasks = data.tasks.filter(t => t.sourceSession === s.id && visibleTask(data, t, shared));
  const pendingTasks = tasks.filter(t => t.status === '待承接');
  const unknown = [...new Set(currentTranscript.filter(t => unknownSpeaker(t.speaker)).map(t => t.speaker))];
  const agendaIndex = Number(data.settings.retention[`agenda-${s.id}`] || 0);
  const currentAgenda = s.agenda[agendaIndex] || '';
  const chosenSource = currentTranscript.find(t => t.id === taskSource);
  const sourceLabel = (t: Transcript) => `${t.time} ${t.speaker}：${t.text.slice(0, 24)}`;
  const active = s.status === '进行中' || s.status === '暂停';
  const open = (viewName: string, mode?: string) => navigate({ view: viewName, id: s.id, mode });
  useEffect(() => { setSelectedTime(route.mode || ''); }, [route.mode]);
  useEffect(() => {
    if (!playing) return;
    const interval = window.setInterval(() => setSelectedTime(t => {
      const next = currentTranscript.findIndex(x => x.time === t) + 1;
      if (next >= currentTranscript.length) { setPlaying(false); return currentTranscript[0]?.time || ''; }
      return currentTranscript[next]?.time || '';
    }), speed === '2倍速' ? 900 : 1800);
    return () => window.clearInterval(interval);
  }, [playing, speed, currentTranscript.length]);
  function openTask(source?: Transcript) {
    setTaskSource(source?.id || ''); setTaskTitle(source?.text.slice(0, 28) || ''); setTaskBody(source?.text || ''); setDue(''); setTaskOpen(true);
  }
  function research() {
    if (!ask.trim()) return;
    const title = /库存|椅子|B-108/i.test(ask) ? 'B-108 库存资料 · 示例' : `${ask.slice(0, 18)} · 本地资料`;
    const body = /库存|椅子|B-108/i.test(ask) ? '演示库存表：蓝色B-108，在库24，预留6，可用18。资料日期10月6日18:00；今天的出入库仍需人工确认。' : `本地可用资料：${visibleAttachments.join('、') || '项目背景'}。${data.projects.find(p => p.name === s.project)?.description || '尚无更多资料，可在本次资料中添加。'}`;
    const memory: Memory = { id: uid('MAT'), title, body, category: '收藏', tags: ['资料', '会中检索'], visibility: '私有', updated: '今天', confirmed: true, sourceSession: s.id, sourceTime: s.transcript.at(-1)?.time };
    update(c => ({ ...patchSession(c, s.id, { attachments: [...new Set([...s.attachments, title])] }), memories: [memory, ...c.memories] }));
    setResearchOpen(false); setAsk(''); toast('本地资料卡已返回当前会话'); open('session-detail', '现场');
  }
  function newTask() {
    if (!taskTitle.trim() || !taskBody.trim()) { toast('填写待办名称和具体要求'); return; }
    if (taskSource && !chosenSource) { toast('所选来源已变化，请重新核对'); return; }
    const id = uid('TASK');
    const task: Task = { id, title: taskTitle.trim(), description: taskBody.trim(), owner: '我', requester: '我', due, priority: '中', status: '待承接', aiStatus: '未启动', sourceSession: chosenSource ? s.id : undefined, sourceTime: chosenSource?.time, activities: [chosenSource ? `由我从${chosenSource.time}的实际原话整理待办建议，未承接、未授权助手` : '由我手工创建无来源的待办建议，未承接、未授权助手'], results: [], version: 1 };
    update(c => ({ ...c, tasks: [task, ...c.tasks], settings: { ...c.settings, retention: { ...c.settings.retention, [`task-space:${id}`]: c.settings.space } } })); setTaskOpen(false); navigate({ view: 'task-detail', id });
  }
  return <div className="stack sessions-feature"><div className="session-heading"><div><h2>{s.title}</h2><p className="meta">{s.project} · {s.duration || '00:00'} · {s.participants.length}人</p></div><Badge>{s.status}</Badge></div>
    <Tabs items={['现场', '转写', '资料', '任务', '复盘']} value={tab} onChange={t => { setPlaying(false); open(t === '转写' ? 'session-transcript' : 'session-detail', t === '转写' ? undefined : t); }} />
    {!team && <div className="session-view-switch"><button className={!shared ? 'selected' : ''} onClick={() => { setView('我的视角'); update(c => ({ ...c, settings: { ...c.settings, retention: { ...c.settings.retention, [`session-view:${s.id}`]: '我的视角' } } })); }}><Icon name="lock-key" size={16} />我的视角</button><button className={shared ? 'selected' : ''} onClick={() => { setView('共享纪要'); update(c => ({ ...c, settings: { ...c.settings, retention: { ...c.settings.retention, [`session-view:${s.id}`]: '共享纪要' } } })); }}><Icon name="users" size={16} />共享纪要</button></div>}
    {tab === '现场' && <><div className="session-recording"><span className={s.status === '进行中' ? 'recording-dot' : 'recording-dot paused'} /><div><strong>{s.status === '进行中' ? '本地示例输入进行中' : s.status === '暂停' ? '记录已暂停' : s.status === '待开始' ? '记录准备中' : '记录已结束'}</strong><small>预设内容 · 麦克风未开启</small></div></div><div className="session-live-overview"><Row title={unknown.length ? `${unknown.length}位声音身份待核对` : `${new Set(currentTranscript.map(t => t.speaker)).size || 1}位参与者`} subtitle={unknown.length ? unknown.join('、') : '计划成员与实际声音分别核对'} icon="user-circle" onClick={() => open(unknown.length ? 'session-identity' : 'session-transcript')} /><Row title={pendingTasks.length ? `${pendingTasks.length}项待办草稿` : '整理下一步行动'} subtitle="承接与助手授权分别确认" icon="check-square" onClick={() => pendingTasks.length ? open('session-detail', '任务') : openTask()} /><Row title={budgetConflict && !flag(data, `budget-resolved-${s.id}`) ? '1项重要提醒待确认' : '议程与时间提醒'} subtitle={currentAgenda || '尚未设置议题，可在记录后补充'} icon="bell" onClick={() => open(budgetConflict && !flag(data, `budget-resolved-${s.id}`) ? 'session-reminders' : 'session-agenda')} /></div><Row title={currentAgenda || '还没有预设议题'} subtitle="推进当前议题、查看时间与规则提示" icon="tree-structure" onClick={() => open('session-agenda')} />{budgetConflict && !flag(data, `budget-resolved-${s.id}`) && <Card className="session-warning" onClick={() => open('session-reminders')}><Badge tone="amber">待确认</Badge><h3>预算与原设定有出入</h3><p>10万元基准 · 演示条目合计13万元</p></Card>}
      {currentTranscript.slice(-3).map(t => <TranscriptCard key={t.id} item={t} onClick={() => open('session-transcript', t.time)} />)}
      {!currentTranscript.length && <Empty title="正在等第一段内容" body="示例输入每4秒追加一段，不使用真实麦克风。" />}
      {visibleAttachments.slice(-2).map(name => <Card key={name} className="material-card" onClick={() => open('session-source', name)}><div className="session-material-icon"><Icon name="file-text" /><Badge tone="gray">本地资料</Badge></div><h3>{name}</h3><p className="meta">资料回来了，打开查看依据</p></Card>)}
      {!shared && s.kind !== '会议' && <Row title={s.kind === '练习' ? '把这一段说得更清楚' : s.kind === '灵感' ? '整理核心观点与口播提纲' : '整理便签与联系草稿'} subtitle="私人整理，确认后再保存" icon="sparkle" onClick={() => open(s.kind === '练习' ? 'session-growth' : 'session-inspiration')} />}<Button tone="secondary" icon="magnifying-glass" onClick={() => setResearchOpen(true)}>问 Oops / 查本地资料</Button>{!shared && <Card><SectionTitle>我的便签</SectionTitle><Field label="只留给自己" value={note} onChange={setNote} placeholder="刚才需要记住的是…" /><Button tone="quiet" onClick={() => { if (!note.trim()) return; update(c => patchSession(c, s.id, { privateNotes: [...s.privateNotes, note.trim()] })); setNote(''); toast('已保存私人便签'); }}>保存便签</Button>{s.privateNotes.map((n, i) => <p key={i}>{n}</p>)}</Card>}</>}
    {tab === '转写' && <><Search value={query} onChange={setQuery} placeholder="搜索发言或关键词" /><Chips items={['全部', ...new Set(currentTranscript.map(t => t.speaker))]} value={speaker} onChange={setSpeaker} /><div className="session-playback"><Button tone="secondary" disabled={!currentTranscript.length} icon={playing ? 'pause' : 'play'} onClick={() => { if (!selectedTime) setSelectedTime(currentTranscript[0]?.time || ''); setPlaying(v => !v); }}>{playing ? '暂停示例回放' : '回放示例片段'}</Button><button onClick={() => setSpeed(speed === '1倍速' ? '2倍速' : '1倍速')}>{speed}</button></div><p className="meta">只模拟时间轴与高亮，不播放真实音频</p>{transcript.length ? transcript.map(t => <TranscriptCard key={t.id} item={t} active={selectedTime === t.time} onClick={team ? undefined : () => { setPlaying(false); open('session-edit', t.id); }} />) : <Empty title="没有匹配发言" body="换关键词，或选择其他说话人。" />}{!team && <><Button tone="secondary" icon="user-circle" onClick={() => open('session-identity')}>确认未知说话人</Button><Button tone="quiet" onClick={() => open('session-revisions')}>查看修订历史</Button></>}</>}
    {tab === '资料' && <>{visibleAttachments.length ? visibleAttachments.map(name => <Row key={name} title={name} subtitle="查看内容、出处与数据时间" onClick={() => open('session-source', name)} />) : <Empty title={shared ? '还没有共享资料' : '本次还没有资料'} body={shared ? '资料需要逐份加入共享范围。' : '导入文本，或查找本地示例资料。'} />}<Button tone="secondary" icon="plus" onClick={() => setResearchOpen(true)}>添加本地资料卡</Button><Button tone="quiet" onClick={() => navigate({ view: 'session-import' })}>导入新的内容</Button></>}
    {tab === '任务' && <>{tasks.length ? tasks.map(t => <Card key={t.id} onClick={() => navigate({ view: 'task-detail', id: t.id })}><div className="session-task-top"><h3>{t.title}</h3><Badge>{t.status}</Badge></div><p className="meta">{t.owner} · {t.due ? t.due.replace('T', ' ') : '期限待确认'}</p><div className="session-status-pair"><span>工作 · {t.status}</span><span>助手 · {t.aiStatus}</span></div></Card>) : <Empty title="还没有本会待办" body="整理为建议后，再决定是否承接。" />}<Button icon="plus" onClick={() => openTask()}>添加待办建议</Button><Button tone="secondary" onClick={() => navigate({ view: 'tasks' })}>查看全部任务</Button></>}
    {tab === '复盘' && <ReviewPanel session={s} shared={shared} tasks={tasks} onTask={openTask} />}
    <div className="divider" /><div className="action-grid">{active ? <Button tone="quiet" onClick={() => requestEnd(s.id)}>结束当前记录</Button> : s.status === '待开始' ? <Button onClick={() => navigate({ view: 'session-create', id: s.id })}>开始这段记录</Button> : <Button tone="secondary" onClick={() => navigate({ view: 'session-mode', mode: s.kind })}>创建后续记录</Button>}<Button tone="quiet" icon="share-network" onClick={() => open('session-share')}>共享范围</Button></div>
    <Sheet open={researchOpen} onClose={() => setResearchOpen(false)} title="查本地资料"><Field label="想找什么" value={ask} onChange={setAsk} placeholder="例如：蓝色B-108库存" /><Notice>查询本地示例库存与项目资料，未联网。</Notice><Button onClick={research} disabled={!ask.trim()}>查找并返回资料卡</Button></Sheet>
    <Sheet open={taskOpen} onClose={() => setTaskOpen(false)} title="核对待办草稿"><SelectField label="原话来源" value={chosenSource ? sourceLabel(chosenSource) : '手工创建（无来源）'} options={['手工创建（无来源）', ...currentTranscript.map(sourceLabel)]} onChange={value => { const source = currentTranscript.find(t => sourceLabel(t) === value); setTaskSource(source?.id || ''); if (source) { setTaskBody(source.text); if (!taskTitle.trim()) setTaskTitle(source.text.slice(0, 28)); } }} />{chosenSource && <Card><Badge tone="gray">保留的原话</Badge><p>{chosenSource.text}</p><p className="meta">{chosenSource.time} · {chosenSource.speaker}</p></Card>}<Field label="待办名称" value={taskTitle} onChange={setTaskTitle} placeholder="下一步需要验证什么？" /><Field label="具体要求" value={taskBody} onChange={setTaskBody} multiline placeholder="要做什么、交付什么，哪些还需补充？" /><Field label="建议期限（可选）" value={due} onChange={setDue} type="datetime-local" /><Notice>由我整理为待承接建议，负责人可在任务中核对；助手不会自动启动。</Notice><Button onClick={newTask}>保存待办草稿</Button></Sheet></div>;
}

type RecordMark = { id: string; time: string; note?: string; sourceTime?: string; sourceId?: string };
function ReviewPanel({ session: s, shared, tasks, onTask }: { session: Session; shared: boolean; tasks: Task[]; onTask: (source?: Transcript) => void }) {
  const { data, update, navigate, toast } = useOops();
  const [conclusions, setConclusions] = useState(readList(data.settings.retention[`session-conclusions:${s.id}`]).join('\n'));
  const [questions, setQuestions] = useState(readList(data.settings.retention[`session-questions:${s.id}`]).join('\n'));
  const [sourceId, setSourceId] = useState('');
  const lines = s.transcript.filter(t => !shared || !t.private);
  const selected = lines.find(t => t.id === sourceId);
  const unknown = lines.filter(t => unknownSpeaker(t.speaker)).filter((t, i, a) => a.findIndex(x => x.speaker === t.speaker) === i);
  const pending = tasks.filter(t => t.status === '待承接');
  const candidates = data.memories.filter(m => !m.deleted && !m.confirmed && m.sourceSession === s.id && !m.tags.includes('修订历史') && (!shared || m.visibility === '项目共享' && (data.settings.retention[`memory-space:${m.id}`] || 'Oops 产品团队') === data.settings.space));
  let marks: RecordMark[] = [];
  try { const parsed = JSON.parse(data.settings.retention[`record-marks:${s.id}`] || '[]'); if (Array.isArray(parsed)) marks = parsed.filter(x => x && typeof x.id === 'string' && typeof x.time === 'string'); } catch { /* Keep malformed local metadata out of the review. */ }
  function sourceFor(time?: string, id?: string) { return id ? lines.find(t => t.id === id) : time ? lines.find(t => t.time === time) : undefined; }
  const goSource = (source: Transcript) => navigate({ view: 'session-transcript', id: s.id, mode: source.time });
  const sourceLabel = (t: Transcript) => `${t.time} ${t.speaker}：${t.text.slice(0, 24)}`;
  function saveReview() {
    const accepted = conclusions.split('\n').map(x => x.trim()).filter(Boolean), unresolved = questions.split('\n').map(x => x.trim()).filter(Boolean);
    if (!accepted.length && !unresolved.length) { toast('填写至少一条结论或未决问题'); return; }
    update(c => ({ ...patchSession(c, s.id, { summary: accepted.length ? accepted : s.summary }), settings: { ...c.settings, toggles: { ...c.settings.toggles, [`review-${s.id}`]: false }, retention: { ...c.settings.retention, [`session-conclusions:${s.id}`]: JSON.stringify(accepted), [`session-questions:${s.id}`]: JSON.stringify(unresolved), [`session-reviewed:${s.id}`]: dateLabel() } } }));
    toast('已保存你确认的结论与未决问题');
  }
  function makeCandidate() {
    if (!selected) { toast('先选一段实际原话'); return; }
    const memory: Memory = { id: uid('MEM'), title: `${selected.speaker} · ${selected.text.slice(0, 22)}`, body: selected.text, category: '记忆', tags: ['待确认', '复盘候选', s.project], visibility: '私有', updated: dateLabel(), confirmed: false, sourceSession: s.id, sourceTime: selected.time };
    update(c => ({ ...c, memories: [memory, ...c.memories], settings: { ...c.settings, space: '我的空间' } })); toast('原话已放入私人候选，核对后才影响后续建议'); navigate({ view: 'memory-candidate', id: memory.id });
  }
  return <div className="stack session-review"><Card className="session-review-intro"><Badge tone={s.status === '已结束' ? 'gray' : 'purple'}>{s.status === '已结束' ? '记录已保存' : '持续整理中'}</Badge><h3>{shared ? '共同可见的记录' : '这次有哪些需要核对？'}</h3><div className="stat-grid"><div className="stat"><strong>{pending.length}</strong><span>待承接草稿</span></div><div className="stat"><strong>{unknown.length}</strong><span>身份待核对</span></div><div className="stat"><strong>{candidates.length}</strong><span>记忆待确认</span></div></div><p className="meta">原话与候选分别保留，未使用模型生成会议结论。</p></Card>{flag(data, `review-${s.id}`) && <Notice tone="warning">来源发生修订，请重新核对相关结论与候选。</Notice>}{!shared && <><SectionTitle>我标记的重点</SectionTitle>{marks.length ? marks.map(mark => { const source = sourceFor(mark.sourceTime, mark.sourceId); return <Card key={mark.id}><div className="session-task-top"><Badge tone="gray">{mark.time}</Badge><Icon name="star" size={18} /></div><p>{mark.note || '此处已标记为重点'}</p>{source ? <Source title={source.text.slice(0, 32)} time={source.time} onClick={() => goSource(source)} /> : <p className="meta">{mark.sourceId || mark.sourceTime ? '来源片段已变化，待核对' : '时间标记，没有绑定原话'}</p>}</Card>; }) : <p className="meta">记录时标记的重点会留在这里。</p>}</>}
    <SectionTitle>原话摘录</SectionTitle>{lines.length ? lines.slice(-5).map(line => <Card key={line.id}><div className="session-task-top"><strong>{line.speaker}</strong><Badge tone="gray">{line.time}</Badge></div><p>{line.text}</p><Source title="查看这段原话" time={line.time} onClick={() => goSource(line)} />{!shared && <Button tone="quiet" onClick={() => onTask(line)}>从这段整理待办</Button>}</Card>) : <Empty title="没有保留的原话" body="可以手工填写结论和下一步，保留范围不会自动扩大。" />}
    <SectionTitle>待承接行动</SectionTitle>{pending.length ? pending.map(task => { const source = sourceFor(task.sourceTime); return <Card key={task.id}><Row title={task.title} subtitle={`${task.owner} · ${task.due ? task.due.replace('T', ' ') : '期限待核对'}`} icon="check-square" badge="待承接" onClick={() => navigate({ view: 'task-detail', id: task.id })} /><p className="meta">助手：{task.aiStatus}</p>{source ? <Source title={source.text.slice(0, 34)} time={source.time} onClick={() => goSource(source)} /> : <p className="meta">{task.sourceSession ? '原话未保留，要求需重新核对' : '手工创建，没有原话来源'}</p>}</Card>; }) : <p className="meta">没有待承接草稿，已处理的任务仍在“任务”分栏。</p>}
    {!shared && <><SectionTitle>声音身份待核对</SectionTitle>{unknown.length ? unknown.map(line => <Card key={line.id}><Row title={line.speaker} subtitle={line.text.slice(0, 40)} icon="user-circle" onClick={() => navigate({ view: 'session-identity', id: s.id, mode: line.id })} /><Source title="核对这段原话" time={line.time} onClick={() => goSource(line)} /></Card>) : <p className="meta">本次没有待确认的匿名标签。</p>}<SectionTitle>记忆候选</SectionTitle>{candidates.length ? candidates.map(memory => { const source = sourceFor(memory.sourceTime); return <Card key={memory.id}><Row title={memory.title} subtitle="私人候选，尚未确认" icon="bookmark-simple" onClick={() => navigate({ view: 'memory-candidate', id: memory.id })} />{source ? <Source title={source.text.slice(0, 34)} time={source.time} onClick={() => goSource(source)} /> : <p className="meta">来源片段需重新核对</p>}</Card>; }) : <p className="meta">从具体原话留下候选，再决定是否长期记住。</p>}<SectionTitle>确认本次结论</SectionTitle><Field label="我确认的结论" value={conclusions} onChange={setConclusions} multiline placeholder="每行一条，保留你核对过的结论" /><Field label="还没有定下来的问题" value={questions} onChange={setQuestions} multiline placeholder="每行一条，写清还缺什么或等谁确认" /><Button onClick={saveReview}>保存我确认的结论与问题</Button>{data.settings.retention[`session-reviewed:${s.id}`] && <p className="meta">最近确认：{data.settings.retention[`session-reviewed:${s.id}`]}</p>}<SectionTitle>从原话继续跟进</SectionTitle><SelectField label="选择实际片段" value={selected ? sourceLabel(selected) : '先选择一段原话'} options={['先选择一段原话', ...lines.map(sourceLabel)]} onChange={value => setSourceId(lines.find(t => sourceLabel(t) === value)?.id || '')} />{selected && <Card><p>{selected.text}</p><Source title="回到原话" time={selected.time} onClick={() => goSource(selected)} /></Card>}<div className="action-grid"><Button tone="secondary" disabled={!selected} onClick={() => onTask(selected)}>整理待办草稿</Button><Button tone="secondary" disabled={!selected} onClick={makeCandidate}>留下候选记忆</Button></div><Button tone="quiet" onClick={() => onTask()}>手工创建无来源待办</Button><Row title="我的表达练习" subtitle="可编辑草稿与私人反馈示例" icon="sparkle" onClick={() => navigate({ view: 'session-growth', id: s.id })} />{s.kind === '灵感' && <Row title="整理灵感与口播提纲" icon="lightbulb" onClick={() => navigate({ view: 'session-inspiration', id: s.id })} />}</>}<Button tone="secondary" icon="export" onClick={() => navigate({ view: 'session-export', id: s.id })}>导出与共享预览</Button></div>;
}

function EditTranscript({ session: s }: { session: Session }) {
  const { data, route, update, navigate, toast } = useOops();
  const item = s.transcript.find(t => t.id === route.mode || t.time === route.mode) || s.transcript[0];
  const [text, setText] = useState(item?.text || ''), [sensitive, setSensitive] = useState(item?.private || false), [remove, setRemove] = useState(false), [error, setError] = useState('');
  if (!item) return <Empty title="暂无可修订片段" body="先导入文字或开始示例记录。" />;
  function save(deleting = false) {
    if (!text.trim() && !deleting) { setError('片段文字不能为空'); return; }
    const sourceChanged = deleting || text.trim() !== item!.text.trim() || sensitive !== !!item!.private;
    const history: Memory = { id: uid('REV'), title: `${s.title} · ${item!.time}修订`, body: `原文：${item!.text}\n${deleting ? '本次：片段已删除' : `修订：${text.trim()}`}\n原说话人：${item!.speaker}\n可见范围：${sensitive ? '私有' : '可用于共同纪要'}`, category: '收藏', tags: ['修订历史', item!.id], visibility: '私有', updated: '今天', confirmed: true, sourceSession: s.id, sourceTime: item!.time };
    update(c => ({
      ...putFlag(patchSession(c, s.id, { transcript: deleting ? s.transcript.filter(t => t.id !== item!.id) : s.transcript.map(t => t.id === item!.id ? { ...t, text: text.trim(), private: sensitive } : t) }), `review-${s.id}`, sourceChanged || flag(c, `review-${s.id}`)),
      memories: [history, ...c.memories.map(m => sourceChanged && m.sourceSession === s.id && m.sourceTime === item!.time ? { ...m, confirmed: false, tags: [...new Set([...m.tags, '待复核'])], visibility: sensitive || deleting ? '私有' as const : m.visibility } : m)],
      tasks: c.tasks.map(t => {
        if (!sourceChanged || t.sourceSession !== s.id || t.sourceTime !== item!.time) return t;
        const previous = t as ReviewableTask;
        const changed: ReviewableTask = { ...previous, authorized: false, aiStatus: '待授权', needsReview: true, generationToken: undefined, version: previous.version + 1, artifacts: previous.artifacts?.map(a => ({ ...a, needsReview: true })), activities: [...previous.activities, `${dateLabel()} · 来源${item!.time}${deleting ? '已删除' : '已修订'}，原成果保留待复核；重新核对后才可授权`] };
        return changed;
      }),
    }));
    toast('已保留原文，相关输出标为待复核'); navigate({ view: 'session-transcript', id: s.id, mode: item!.time });
  }
  return <div className="stack"><TranscriptCard item={item} /><Field label="修订文字" value={text} onChange={setText} multiline /><Toggle label="标为敏感，仅本人可见" value={sensitive} onChange={setSensitive} hint="共同纪要、大屏和共享导出将隐藏这段。" /><Source title="确认这段的说话人" time={item.time} onClick={() => navigate({ view: 'session-identity', id: s.id, mode: item.id })} />{error && <p className="error-text">{error}</p>}<Button onClick={() => save()}>保存修订</Button><Button tone="secondary" onClick={() => navigate({ view: 'session-transcript', id: s.id, mode: item.time })}>取消</Button><Button tone="danger" onClick={() => setRemove(true)}>删除这个片段</Button><Sheet open={remove} onClose={() => setRemove(false)} title="删除选中的片段？"><p>原文进入私人修订历史；引用它的输出需要复核。</p><Button tone="danger" onClick={() => save(true)}>确认删除</Button></Sheet><Row title="查看修订历史" subtitle={`${data.memories.filter(m => m.sourceSession === s.id && m.tags.includes('修订历史')).length}个版本`} onClick={() => navigate({ view: 'session-revisions', id: s.id })} /></div>;
}

function Identity({ session: s }: { session: Session }) {
  const { data, update, route, navigate, toast } = useOops();
  const item = s.transcript.find(t => t.id === route.mode || t.time === route.mode) || s.transcript.find(t => unknownSpeaker(t.speaker));
  const [name, setName] = useState(item && !unknownSpeaker(item.speaker) ? item.speaker : ''), [scope, setScope] = useState('仅这个片段'), [voice, setVoice] = useState(false);
  if (!item) return <Empty title="本次没有未知身份" body="在转写中选一段，再进入人物纠正。" action="查看转写" onAction={() => navigate({ view: 'session-transcript', id: s.id })} />;
  function confirm() {
    if (!name.trim()) { toast('选择或填写本次显示姓名，也可以直接保持匿名'); return; }
    const match = (t: Transcript) => scope === '本次同一匿名标签' && unknownSpeaker(item!.speaker) ? t.speaker === item!.speaker : t.id === item!.id;
    const changedTurns = s.transcript.filter(match), times = changedTurns.map(t => t.time);
    const personId = data.people.find(p => p.name === name.trim())?.id || uid('person');
    update(c => ({ ...patchSession(c, s.id, { transcript: s.transcript.map(t => match(t) ? { ...t, speaker: name.trim() } : t), participants: [...new Set([...s.participants.filter(p => p !== item!.speaker || s.transcript.some(t => !match(t) && t.speaker === p)), name.trim()])] }), settings: { ...c.settings, toggles: { ...c.settings.toggles, [`review-${s.id}`]: true, [`person-name-confirmed:${personId}`]: true, ...Object.fromEntries(changedTurns.map(t => [`speaker-confirmed:${s.id}:${t.id}`, true])) } }, people: c.people.some(p => p.name === name.trim()) ? c.people : [...c.people, { id: personId, name: name.trim(), role: '本次手动确认', company: s.project === '个人记录' ? '' : s.project, note: '', voice, shared: false }], tasks: c.tasks.map(t => { if (t.sourceSession !== s.id || !times.includes(t.sourceTime || '')) return t; const previous = t as ReviewableTask; return { ...previous, authorized: false, aiStatus: '待授权' as const, needsReview: true, generationToken: undefined, version: previous.version + 1, artifacts: previous.artifacts?.map(a => ({ ...a, needsReview: true })), activities: [...previous.activities, '来源姓名已手动确认；工作归属与既有成果仍需复核，不自动改变负责人'] }; }), memories: c.memories.map(m => m.sourceSession === s.id && times.includes(m.sourceTime || '') && !m.tags.includes('修订历史') ? { ...m, confirmed: false, tags: [...new Set([...m.tags, '待复核'])] } : m) }));
    toast('姓名已手动确认，声音许可与任务归属分别处理'); navigate({ view: 'session-transcript', id: s.id, mode: item!.time });
  }
  return <div className="stack"><Badge tone="gray">手动核对姓名</Badge><TranscriptCard item={item} /><SectionTitle>这段发言是谁？</SectionTitle><p className="meta">下面是已保存人物，未据此识别或推断声音。</p><Chips items={data.people.filter(p => !unknownSpeaker(p.name)).map(p => p.name)} value={name} onChange={setName} /><Field label="本次显示姓名" value={name} onChange={setName} placeholder="尚未确认，可保持匿名" /><SelectField label="应用范围" value={scope} options={unknownSpeaker(item.speaker) ? ['仅这个片段', '本次同一匿名标签'] : ['仅这个片段']} onChange={setScope} /><Toggle label="新建人物时保留声音许可示意" value={voice} onChange={setVoice} hint="姓名确认不依赖声音许可；这里只改变本地演示设置，不采集声纹。" /><Notice>只核对所选片段。工作承接、关系记忆和外部行动需要各自确认。</Notice><Button disabled={!name.trim()} onClick={confirm}>确认本次显示姓名</Button><Button tone="secondary" onClick={() => { toast('保留原来的匿名标签，未写入姓名确认'); navigate({ view: 'session-transcript', id: s.id, mode: item.time }); }}>本次保持匿名</Button></div>;
}

function Material({ session: s }: { session: Session }) {
  const { data, route, update, navigate, toast } = useOops();
  const title = route.mode || s.attachments[0] || '会中资料卡';
  const saved = data.memories.find(m => m.sourceSession === s.id && m.title === title);
  const stock = /B-108|库存/.test(title);
  const fileOnly = /\.(pdf|xlsx?|mp3|wav|m4a|aac|ogg)$/i.test(title);
  if (data.settings.space !== '我的空间' && !canShareMaterial(data, s, title)) return <Empty title="这份资料尚未共享" body="私人资料不能从共同视角打开。" action="返回讨论" onAction={() => navigate({ view: 'session-detail', id: s.id })} />;
  const body = saved?.body || (stock ? data.tasks.find(t => t.id === 'TASK-032')?.results.join('\n') || '演示库存：在库24，预留6，可用18。当前出入库仍需核对。' : fileOnly ? '已关联文件信息。这个原型未解析音频、PDF或表格正文；可另行粘贴转写或资料文字。' : '资料卡回到相关议题旁边，需要时展开；不把每个结果都变成主动打断。');
  const sourceTime = saved?.sourceTime || (stock ? data.tasks.find(t => t.id === 'TASK-032')?.sourceTime : s.transcript.find(t => /资料/.test(t.text))?.time);
  return <div className="stack"><Badge tone="gray">本地示例资料</Badge><h2 className="title">{title}</h2><Card><p className="session-preserve">{body}</p></Card>{stock && <div className="stat-grid"><div className="stat"><strong>24</strong><span>在库</span></div><div className="stat"><strong>6</strong><span>预留</span></div><div className="stat"><strong>18</strong><span>可用</span></div></div>}<Source title={s.title} time={sourceTime} onClick={() => navigate({ view: 'session-transcript', id: s.id, mode: sourceTime })} /><Notice>资料来自本地演示，不代表实时查询。数据变化需要再次核对。</Notice><Button onClick={() => { update(c => patchSession(c, s.id, { privateNotes: [...s.privateNotes, `资料返回：${title}`] })); navigate({ view: 'session-detail', id: s.id, mode: '现场' }); toast('资料保留在当前议题旁'); }}>带回当前讨论</Button><Button tone="secondary" onClick={() => { const m: Memory = { id: uid('MEM'), title, body, category: '收藏', tags: ['资料'], visibility: '私有', updated: '今天', confirmed: true, sourceSession: s.id, sourceTime }; update(c => ({ ...c, memories: [m, ...c.memories] })); navigate({ view: 'memory-detail', id: m.id }); }}>收藏资料与出处</Button><Button tone="quiet" onClick={() => navigate({ view: 'session-display', id: s.id, mode: title })}>在大屏中预览</Button></div>;
}

function MeetingTools({ session: s }: { session: Session }) {
  const { data, update, route, navigate, toast } = useOops();
  const [agenda, setAgenda] = useState(s.agenda.join('\n')), [budget, setBudget] = useState('130000');
  const [index, setIndex] = useState(Number(data.settings.retention[`agenda-${s.id}`] || 0));
  const [plan, setPlan] = useState(data.settings.retention[`session-plan:${s.id}`] || '45');
  const planned = Number(data.settings.retention[`session-plan:${s.id}`] || 45) * 60;
  const elapsed = Number.isFinite(seconds(s.duration)) ? seconds(s.duration) : 0;
  const remaining = planned - elapsed;
  const topic = s.agenda[index] || '';
  const recent = s.transcript.filter(t => data.settings.space === '我的空间' || !t.private).slice(-3);
  const keywords = agendaKeywords(topic);
  const matched = keywords.filter(k => recent.some(t => t.text.toLowerCase().includes(k)));
  const showRule = topic && keywords.length > 0 && recent.length > 0 && !flag(data, `topic-dismissed:${s.id}:${index}`);
  function selectTopic(i: number) { setIndex(i); update(c => ({ ...c, settings: { ...c.settings, retention: { ...c.settings.retention, [`agenda-${s.id}`]: String(i) } } })); }
  if (route.view === 'session-reminders') return <div className="stack"><Card className="session-warning"><Badge tone="amber">预算冲突</Badge><h3>10万基准，条目合计13万</h3><p>先确认是否有重复费用或新增范围。</p></Card><Source title="预算原话" time={s.transcript.find(t => /十万|10万/.test(t.text))?.time} onClick={() => navigate({ view: 'session-transcript', id: s.id, mode: s.transcript.find(t => /十万|10万/.test(t.text))?.time })} /><Field label="确认后的预算（元）" value={budget} onChange={setBudget} type="number" /><Button onClick={() => { const amount = Number(budget); if (!Number.isFinite(amount) || amount <= 0) { toast('预算应为正数'); return; } update(c => ({ ...putFlag(c, `budget-resolved-${s.id}`, true), projects: c.projects.map(p => p.name === s.project ? { ...p, budget: amount } : p) })); toast('预算基准已更新，旧提醒关闭'); navigate({ view: 'session-detail', id: s.id, mode: '现场' }); }}>确认新基准</Button><Button tone="secondary" onClick={() => { update(c => putFlag(c, `budget-resolved-${s.id}`, true)); toast('本次提醒已忽略'); navigate({ view: 'session-detail', id: s.id }); }}>忽略本次提醒</Button><Row title="未决事项" subtitle={`${data.tasks.filter(t => t.sourceSession === s.id && t.status === '待承接').length}项等待承接`} onClick={() => navigate({ view: 'session-detail', id: s.id, mode: '任务' })} /><Toggle label="合并重复提醒" value={data.settings.toggles[`merge-reminders-${s.id}`] !== false} onChange={v => update(c => putFlag(c, `merge-reminders-${s.id}`, v))} /></div>;
  if (route.view === 'session-map' || route.view === 'session-display') return <div className="stack"><Badge tone="gray">{route.view === 'session-display' ? '大屏共享预览' : '讨论结构'}</Badge><div className="session-map"><div className="map-center">{s.title}</div>{s.agenda.map((a, i) => <button className="map-branch" key={i} onClick={() => navigate({ view: 'session-agenda', id: s.id })}><span>{i + 1}</span>{a}</button>)}{s.attachments.filter(name => route.view === 'session-map' && data.settings.space === '我的空间' || canShareMaterial(data, s, name)).map(name => <button key={name} className="map-material" onClick={() => navigate({ view: 'session-source', id: s.id, mode: name })}><Icon name="file-text" size={16} />{name}</button>)}</div>{route.view === 'session-display' && <Notice>仅展示已选共享资料，隐藏私人便签和敏感发言；这是本机大屏预览。</Notice>}<Button tone="secondary" onClick={() => navigate({ view: 'session-share', id: s.id })}>核对共享范围</Button><Button onClick={() => navigate({ view: 'session-detail', id: s.id, mode: '现场' })}>返回现场</Button></div>;
  return <div className="stack"><Card className={`session-timer ${remaining < 0 ? 'session-warning' : ''}`}><div className="session-task-top"><SectionTitle>{remaining < 0 ? '已超时' : s.status === '已结束' ? '结束时剩余' : '计划剩余'}</SectionTitle><Badge tone={remaining < 0 ? 'amber' : 'purple'}>{s.status}</Badge></div><strong className="session-timer-clock">{clock(Math.abs(remaining))}</strong><p className="meta">计划{planned / 60}分钟 · 已记录{clock(elapsed)}{s.status === '暂停' ? ' · 暂停期间不计时' : s.status === '进行中' ? ' · 随记录更新' : ''}</p></Card><Field label="计划总时长（分钟）" value={plan} onChange={setPlan} type="number" hint="只改变本次计划，已记录时长不会重置。" /><Button tone="secondary" onClick={() => { const minutes = Number(plan); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) { toast('计划时长填写1—1440的整数分钟'); return; } update(c => ({ ...c, settings: { ...c.settings, retention: { ...c.settings.retention, [`session-plan:${s.id}`]: String(minutes) } } })); toast('本次计划时长已保存'); }}>保存计划时长</Button><SectionTitle>当前议程</SectionTitle>{s.agenda.map((a, i) => <button className={`session-agenda-row ${index === i ? 'current' : ''}`} key={i} onClick={() => selectTopic(i)}><span>{i < index ? <Icon name="check" size={17} /> : i + 1}</span><strong>{a}</strong><Badge tone={index === i ? 'purple' : 'gray'}>{i < index ? '已讨论' : index === i ? '正在讨论' : '待讨论'}</Badge></button>)}{showRule && <Card className={!matched.length ? 'session-warning' : ''}><Badge tone={matched.length ? 'gray' : 'amber'}>规则提示</Badge><h3>{matched.length ? '最近片段提到了本议题词语' : '最近片段未命中本议题词语'}</h3><p className="meta">{matched.length ? `命中：${matched.join('、')}` : '建议主持人核对是否需要回到当前议题。'}</p><p className="meta">仅比较最近3段文字与议题关键词，不判断语义或评分。</p><Source title="核对最近发言" time={recent.at(-1)?.time} onClick={() => navigate({ view: 'session-transcript', id: s.id, mode: recent.at(-1)?.time })} /><Button tone="quiet" onClick={() => { update(c => putFlag(c, `topic-dismissed:${s.id}:${index}`, true)); toast('已忽略当前议题的规则提示'); }}>忽略当前议题提示</Button></Card>}<Button disabled={!s.agenda.length || index >= s.agenda.length - 1} onClick={() => selectTopic(index + 1)}>推进到下个议题</Button><Field label="编辑议程" value={agenda} onChange={setAgenda} multiline /><Button tone="secondary" onClick={() => { const next = agenda.split('\n').map(x => x.trim()).filter(Boolean); const current = Math.min(index, Math.max(0, next.length - 1)); setIndex(current); update(c => ({ ...patchSession(c, s.id, { agenda: next }), settings: { ...c.settings, retention: { ...c.settings.retention, [`agenda-${s.id}`]: String(current) } } })); toast('议程已更新'); }}>保存议程</Button><Row title="思维导图" icon="tree-structure" onClick={() => navigate({ view: 'session-map', id: s.id })} /><Row title="大屏预览" icon="monitor" onClick={() => navigate({ view: 'session-display', id: s.id })} /></div>;
}

function Sharing({ session: s }: { session: Session }) {
  const { data, route, update, navigate, toast } = useOops();
  const [shared, setShared] = useState(flag(data, `shared-${s.id}`)), [privateText, setPrivateText] = useState(false), [format, setFormat] = useState('共同纪要'), [recipient, setRecipient] = useState(data.settings.retention[`share-recipient-${s.id}`] || 'Alex');
  const [materials, setMaterials] = useState<string[]>(s.attachments.filter(name => canShareMaterial(data, s, name)));
  const team = data.settings.space !== '我的空间';
  const publicLines = digest(s, true);
  const includePrivate = privateText && !team;
  const exportMaterials = s.attachments.filter(name => includePrivate || canShareMaterial(data, s, name));
  const exportText = [s.title, s.date, '', ...(format === '转写原文' ? s.transcript.filter(t => includePrivate || !t.private).map(t => `${t.time} ${t.speaker}：${t.text}`) : includePrivate ? [...s.summary, ...s.privateNotes] : publicLines), ...(exportMaterials.length ? ['','附加资料目录（不含附件正文）：', ...exportMaterials.map(name => `· ${name}`)] : []), '', '本地原型导出 · 示例数据'].join('\n');
  function download() { const url = URL.createObjectURL(new Blob([exportText], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `${s.title}.txt`; a.click(); URL.revokeObjectURL(url); toast('本地文本已下载'); }
  function saveScope() {
    if (shared && !recipient.trim()) { toast('先指定接收者'); return; }
    update(c => {
      const space = c.settings.space === '我的空间' ? 'Oops 产品团队' : c.settings.space;
      const selected = shared ? materials.filter(name => s.attachments.includes(name) && materialEligible(c, s, name)) : [];
      const toggles = { ...c.settings.toggles, [`shared-${s.id}`]: shared };
      const retention = { ...c.settings.retention, [`share-recipient-${s.id}`]: recipient.trim(), [`session-space:${s.id}`]: space, [`session-materials:${s.id}`]: JSON.stringify(selected) };
      s.attachments.forEach(name => { toggles[materialKey(s.id, name)] = selected.includes(name); retention[`material-space:${s.id}:${name}`] = space; });
      const memories = c.memories.map(m => {
        if (m.sourceSession !== s.id || !s.attachments.includes(m.title) || m.tags.includes('修订历史')) return m;
        const visible = selected.includes(m.title);
        if (visible) retention[`memory-space:${m.id}`] = space;
        return { ...m, visibility: visible ? '项目共享' as const : '私有' as const };
      });
      return { ...c, memories, settings: { ...c.settings, toggles, retention } };
    });
    toast(shared ? `已保存共同纪要与${materials.filter(name => materialEligible(data, s, name)).length}份资料的共享范围` : '共同纪要和附加资料保持私有');
  }
  function revoke() {
    update(c => {
      const toggles = { ...c.settings.toggles, [`shared-${s.id}`]: false };
      s.attachments.forEach(name => { toggles[materialKey(s.id, name)] = false; });
      return { ...c, memories: c.memories.map(m => m.sourceSession === s.id && m.visibility === '项目共享' ? { ...m, visibility: '私有' as const } : m), settings: { ...c.settings, toggles, retention: { ...c.settings.retention, [`session-materials:${s.id}`]: '[]' } } };
    }); setShared(false); setMaterials([]); toast('纪要和附加资料的本地共享访问已撤销');
  }
  const sharedList = s.attachments.filter(name => canShareMaterial(data, s, name));
  return <div className="stack">{route.view === 'session-export' ? <><SelectField label="导出内容" value={format} options={team ? ['共同纪要', '转写原文'] : ['共同纪要', '转写原文', '个人复盘']} onChange={setFormat} />{!team && <Toggle label="包含我的私人内容" value={privateText} onChange={setPrivateText} hint="只用于本人本地导出，不加入共享纪要。" />}<Card><p className="session-preserve">{exportText}</p></Card><Button icon="download-simple" onClick={download}>下载当前文本</Button><Button tone="secondary" onClick={() => void navigator.clipboard?.writeText(exportText).then(() => toast('摘要已复制')).catch(() => toast('请使用下载保存文本'))}>复制当前文本</Button><Button tone="quiet" onClick={() => navigate({ view: 'session-share', id: s.id })}>管理共享范围</Button></> : team ? <><Card><Badge>当前团队可见</Badge><h3>共同纪要与{sharedList.length}份附加资料</h3><p className="meta">共享接收者：{data.settings.retention[`share-recipient-${s.id}`] || '项目成员'}</p></Card>{sharedList.map(name => <Row key={name} title={name} icon="file-text" onClick={() => navigate({ view: 'session-source', id: s.id, mode: name })} />)}<Notice>这里仅显示已明确共享的资料；完整范围在个人空间管理。</Notice><Button tone="secondary" onClick={() => { update(c => ({ ...c, settings: { ...c.settings, space: '我的空间' } })); toast('已切换到个人空间，可管理本地共享范围'); }}>在个人空间管理</Button><Button onClick={() => navigate({ view: 'session-export', id: s.id })}>预览可导出内容</Button></> : <><Toggle label="允许项目内查看共同纪要" value={shared} onChange={setShared} /><Field label="接收者" value={recipient} onChange={setRecipient} placeholder="指定演示人物" /><Card><SectionTitle>会共享什么</SectionTitle>{publicLines.map((line, i) => <p className="session-summary-line" key={i}>{line}</p>)}<p className="meta">隐藏{s.transcript.filter(t => t.private).length}段敏感发言 · 不含私人便签和表达反馈</p></Card><SectionTitle>附加资料</SectionTitle><p className="meta">逐份选择；未勾选资料不会出现在团队、共享大屏或共同导出目录。</p>{s.attachments.length ? s.attachments.map(name => <Card key={name}><Check label={name} value={materials.includes(name) && materialEligible(data, s, name)} onChange={value => { if (!materialEligible(data, s, name)) { toast('来源敏感、缺失或待复核，资料暂时保留私有'); return; } setMaterials(list => value ? [...new Set([...list, name])] : list.filter(x => x !== name)); }} />{!materialEligible(data, s, name) && <p className="meta">来源敏感、已缺失或尚待复核，暂时不能共享</p>}</Card>) : <Empty title="这次还没有附加资料" body="会中查询后，可在这里逐份选择。" />}<Button onClick={saveScope}>保存范围</Button><Button tone="danger" disabled={!flag(data, `shared-${s.id}`)} onClick={revoke}>撤销此会话共享</Button><Notice>只管理本地权限；已经下载的副本无法从本机收回。</Notice><Button tone="secondary" onClick={() => navigate({ view: 'session-export', id: s.id })}>预览导出内容</Button></>}</div>;
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
    const memory: Memory = { id: mid, title: title.trim(), body: selected.map(t => `${t.time} ${t.speaker}：${t.text}`).join('\n'), category: '灵感', tags: ['Recall', '待验证'], visibility: '私有', updated: '今天', confirmed: true, sourceTime: selected[0]?.time };
    const task: Task = { id: tid, title: `验证：${title.trim()}`, description: memory.body, owner: '我', requester: '我', due: '', priority: '中', status: '待承接', aiStatus: '未启动', activities: [`来自已保存片段 ${mid}`], results: [], version: 1 };
    update(c => ({ ...c, memories: [memory, ...c.memories], tasks: asTask ? [task, ...c.tasks] : c.tasks, settings: { ...c.settings, space: '我的空间' } })); setSaveOpen(false); setChosen([]); toast(asTask ? '独立待办草稿已创建，助手未启动' : '只保存了所选片段'); navigate({ view: asTask ? 'task-detail' : 'memory-detail', id: asTask ? tid : mid });
  }
  return <div className="stack"><div className="session-recall-hero"><Icon name="clock-counter-clockwise" size={32} /><h2>找回刚才那句</h2><p>{windowNumber === 1 ? '最近5分钟 · 预设示例窗口' : `新窗口 ${windowNumber} · 每4秒追加一句示例`}</p><Badge tone={dead ? 'gray' : 'purple'}>{dead ? '未保存缓存已失效' : `${Math.ceil(expires / 60)}分钟内可选择保存`}</Badge></div><Search value={query} onChange={setQuery} placeholder="刚才提到了什么？" />{rows.length ? rows.map(t => <div className="session-recall-choice" key={t.id}><Check label={`${t.time} ${t.speaker}`} value={chosen.includes(t.id)} onChange={v => setChosen(a => v ? [...a, t.id] : a.filter(id => id !== t.id))} /><p>{t.text}</p></div>) : <Empty title={dead ? '这段未保存内容已经移出' : '没有匹配片段'} body={dead ? '已保存的长期记忆仍可查看。' : '换一个关键词试试。'} />}
    {dead && <Button icon="play" onClick={() => { setChosen([]); setQuery(''); setSaveOpen(false); setExpires(300); update(c => ({ ...c, recallCleared: false, settings: { ...c.settings, retention: { ...c.settings.retention, 'recall-window-start': String(Date.now()), 'recall-window-number': String(windowNumber + 1) } } })); toast('新的示例窗口已开始，旧未保存片段不会恢复'); }}>开启新的5分钟示例窗口</Button>}<Button disabled={dead || !chosen.length} onClick={() => setSaveOpen(true)}>保存所选 {chosen.length} 段</Button><Button tone="secondary" onClick={() => navigate({ view: 'session-create', mode: '会议' })}>从现在开始完整会议记录</Button><Button tone="danger" disabled={dead} onClick={() => setClearOpen(true)}>停止并清空未保存缓存</Button><Button tone="quiet" onClick={() => navigate({ view: 'memory' })}>查看已保存记忆</Button><Notice>当前是预设片段，未打开麦克风。未保存内容到期不可找回。</Notice>
    <Sheet open={saveOpen} onClose={() => setSaveOpen(false)} title="只留下有用的片段"><Field label="保存标题" value={title} onChange={setTitle} /><p className="meta">仅自己可见 · 保留原文、时间与未知身份</p>{visibleSamples.filter(t => chosen.includes(t.id)).map(t => <p key={t.id}>{t.text}</p>)}<Button onClick={() => save(false)}>保存为长期记忆</Button><Button tone="secondary" onClick={() => save(true)}>保存来源并转独立待办草稿</Button></Sheet><Sheet open={clearOpen} onClose={() => setClearOpen(false)} title="清空未保存的片段？"><p>已保存记忆和完整会议不受影响。</p><Button tone="danger" onClick={() => { update(c => { const retention = { ...c.settings.retention }; delete retention['recall-window-start']; return { ...c, recallCleared: true, settings: { ...c.settings, retention } }; }); setChosen([]); setClearOpen(false); setSaveOpen(false); toast('未保存缓存已清空'); }}>确认清空</Button></Sheet></div>;
}

function CreativeSummary({ session: s }: { session: Session }) {
  const { update, navigate, toast } = useOops();
  const idea = s.kind === '灵感';
  const [core, setCore] = useState(s.transcript.map(t => t.text).join('\n')), [body, setBody] = useState('');
  function prepare() {
    if (!core.trim()) { toast('先写下核心想法'); return; }
    setBody(idea ? `开场：${s.title}。\n核心观点：${core.split('\n')[0]}\n例子：${core.split('\n')[1] || '用一个具体场景说明。'}\n结尾：先验证一版，再决定下一步。` : `你好，想跟进一下${s.title}。\n我们刚才提到：${core.split('\n')[0]}\n方便告诉我目前进度和还缺的资料吗？谢谢。`);
  }
  function save(asTask = false) {
    if (!body.trim()) { toast('先整理或填写草稿内容'); return; }
    const mid = uid('MEM'), tid = uid('TASK');
    const m: Memory = { id: mid, title: `${s.title} · ${idea ? '口播提纲' : '联系草稿'}`, body, category: idea ? '灵感' : '记忆', visibility: '私有', tags: [s.kind, '私人草稿'], confirmed: true, updated: '今天', sourceSession: s.id, sourceTime: s.transcript[0]?.time };
    const task: Task = { id: tid, title: idea ? `制作：${s.title}` : `跟进：${s.title}`, description: body, owner: '我', requester: '我', due: '', priority: '中', status: '待承接', aiStatus: '未启动', sourceSession: s.id, sourceTime: s.transcript[0]?.time, activities: [`从私人草稿${mid}创建建议`], results: [], version: 1 };
    update(c => ({ ...c, memories: [m, ...c.memories], tasks: asTask ? [task, ...c.tasks] : c.tasks }));
    toast(asTask ? '独立待办草稿已建立' : '已保存私人草稿'); navigate({ view: asTask ? 'task-detail' : 'memory-detail', id: asTask ? tid : mid });
  }
  return <div className="stack"><Field label={idea ? '核心想法' : '需要跟进的内容'} value={core} onChange={setCore} multiline /><Button onClick={prepare}>{idea ? '整理一分钟口播提纲' : '准备联系草稿'}</Button>{body && <><Field label={idea ? '口播提纲' : '联系草稿'} value={body} onChange={setBody} multiline /><Notice>本地结构示例，未生成视频或发送消息。</Notice><Button onClick={() => save()}>保存私人草稿</Button><Button tone="secondary" onClick={() => save(true)}>形成独立待办建议</Button><Button tone="quiet" onClick={() => void navigator.clipboard?.writeText(body).then(() => toast('草稿已复制')).catch(() => toast('可先保存为私人草稿'))}>复制草稿</Button></>}<Source title={s.title} time={s.transcript[0]?.time} onClick={() => navigate({ view: 'session-transcript', id: s.id })} /></div>;
}

function Practice({ session: s }: { session: Session }) {
  const { data, update, navigate, toast } = useOops();
  const [original, setOriginal] = useState(s.transcript.find(t => t.speaker === '我')?.text || ''), [rewrite, setRewrite] = useState(''), [goal, setGoal] = useState('先说结论，再说明依据与下一步'), [feedback, setFeedback] = useState('');
  const [language, setLanguage] = useState('中文'), [tone, setTone] = useState('平实清楚'), [emotion, setEmotion] = useState('平稳陈述');
  const [draftSettings, setDraftSettings] = useState({ language: '中文', tone: '平实清楚', emotion: '平稳陈述' });
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
    const m: Memory = { id: uid('MEM'), title: `${s.title} · 表达练习`, body: `目标：${goal}\n输出：${draftSettings.language} · 语气偏好：${draftSettings.tone}\n反馈情境（手动选择）：${draftSettings.emotion}\n原话：${original}\n改写草稿：${rewrite}\n反馈示例：${feedback || `${toneTips[tone]} ${emotionTips[emotion]}`}\n本地结构示例，未做真实情绪识别或翻译。`, category: '目标', tags: ['成长', '表达', draftSettings.language, '反馈示例'], visibility: '私有', updated: '今天', confirmed: true, sourceSession: s.id, sourceTime: s.transcript.find(t => t.speaker === '我')?.time };
    update(c => ({ ...c, memories: [m, ...c.memories] })); toast('可编辑练习草稿已保存为私人目标'); navigate({ view: 'memory-detail', id: m.id });
  }
  return <div className="stack"><Field label="想练习的原话" value={original} onChange={setOriginal} multiline /><Field label="本次成长目标" value={goal} onChange={setGoal} /><SelectField label="输出语言" value={language} onChange={setLanguage} options={['中文', '中英对照', 'English']} /><SelectField label="希望的语气" value={tone} onChange={setTone} options={['平实清楚', '温和协作', '简洁直接']} /><Card className="session-feedback"><Badge tone="gray">语气与情绪反馈示例</Badge><SelectField label="选择练习情境" value={emotion} onChange={setEmotion} options={['平稳陈述', '略显急切', '表达不确定', '希望得到支持']} /><p>{toneTips[tone]}</p><p>{emotionTips[emotion]}</p><p className="meta">情境由你选择，未分析声音、识别情绪或推断他人心理。</p></Card><Button icon="sparkle" onClick={analyze}>{rewrite ? '按当前选择重新整理草稿' : '整理表达结构'}</Button>{rewrite && <><Card><Badge tone="gray">本地结构示例</Badge><p className="meta">本稿：{draftSettings.language} · {draftSettings.tone} · {draftSettings.emotion}</p><p>{feedback}</p>{draftSettings.language !== '中文' && <p className="meta">英文部分是结构示例，请按原意编辑；未调用翻译服务。</p>}</Card><Field label="可编辑的改写草稿" value={rewrite} onChange={setRewrite} multiline /><Button onClick={save}>保存草稿与成长目标</Button><Button tone="secondary" onClick={() => { setFeedback('这条建议不适合我；后续先保留原来的表达方式。'); toast('个人反馈已保留在本次练习'); }}>这条建议不适合我</Button></>}<Notice>练习与反馈仅本人可见。当前偏好：{data.settings.tone}</Notice></div>;
}

function RevisionHistory({ session: s }: { session: Session }) {
  const { data, update, navigate, toast } = useOops();
  const versions = data.memories.filter(m => m.sourceSession === s.id && m.tags.includes('修订历史'));
  return <div className="stack">{versions.length ? versions.map(m => <Card key={m.id}><h3>{m.title}</h3><p className="session-preserve">{m.body}</p><Button tone="quiet" onClick={() => { const text = m.body.match(/^原文：(.*)$/m)?.[1] || ''; const speaker = m.body.match(/^原说话人：(.*)$/m)?.[1] || '我'; const existing = s.transcript.find(t => t.time === m.sourceTime); update(c => putFlag(patchSession(c, s.id, { transcript: existing ? s.transcript.map(t => t.time === m.sourceTime ? { ...t, text } : t) : [...s.transcript, { id: uid('restored'), speaker, time: m.sourceTime || '00:00:00', text, private: true }].sort((a, b) => a.time.localeCompare(b.time)) }), `review-${s.id}`, true)); toast('原文已恢复，敏感范围不会自动开放'); navigate({ view: 'session-transcript', id: s.id, mode: m.sourceTime }); }}>恢复此版本原文</Button></Card>) : <Empty title="还没有修订历史" body="修改转写后，原文和修订会在这里保留。" />}</div>;
}

function HistoryQuestion() {
  const { data, navigate } = useOops();
  const [question, setQuestion] = useState(''), [submitted, setSubmitted] = useState('');
  const matches = submitted ? data.sessions.filter(s => canViewSession(data, s)).flatMap(s => s.transcript.filter(t => (data.settings.space === '我的空间' || !t.private) && ( submitted.split(/[\s，。？?]/).some(k => k.length > 1 && t.text.includes(k)) || /任务|KPI|复盘/i.test(submitted) && /KPI|复盘/.test(t.text))).map(t => ({ s, t }))) : [];
  return <div className="stack"><Field label="问已有记录" value={question} onChange={setQuestion} multiline placeholder="比如：KPI复盘是谁提出的？" /><Button disabled={!question.trim()} onClick={() => setSubmitted(question.trim())}>查找本地记录</Button>{submitted && <><Notice>仅使用本地可查看的记录，结果保留出处。</Notice>{matches.length ? matches.map(({ s, t }) => <Card key={`${s.id}-${t.id}`}><p>{t.text}</p><Source title={s.title} time={t.time} onClick={() => navigate({ view: 'session-transcript', id: s.id, mode: t.time })} /></Card>) : <Empty title="没有找到可引用的内容" body="换一个具体关键词，不编造没有的答案。" />}</>}</div>;
}
