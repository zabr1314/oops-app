import { useEffect, useState } from 'react';
import { useOops, type AppData, type Session } from '../store';
import { Avatar, Badge, Button, Card, Check, Empty, Field, Icon, Notice, Row, SectionTitle, Sheet, Source, Tabs } from '../ui';
import { useViewState } from '../viewState';
import { PERSONAL_SPACE, sourceTurn } from '../sourceAccess';
import { intelligenceActionRoute, intelligenceSourceRoute, readNoticePlan, readPersonalContext, readSessionIntelligence, refreshSessionIntelligence, saveNoticePlan, savePersonalContext, updateIntelligenceItem, type IntelligenceItem, type IntelligenceKind, type IntelligenceResult, type IntelligenceState } from '../sessionIntelligenceLogic';
import './SessionIntelligence.css';

const views: Record<string, IntelligenceKind> = { 'session-understanding': 'understanding', 'session-decisions': 'decisions', 'session-notices': 'notices', 'session-personal': 'personal' };
const names: Record<IntelligenceKind, string> = { understanding: '此刻的理解', decisions: '决定建议', notices: '会议提醒', personal: '我的复盘' };
const icons: Record<string, string> = { topic: 'chat-circle-text', people: 'users-three', event: 'list-checks', intent: 'target', context: 'link', decision: 'check-circle', proposal: 'lightbulb', conclusion: 'note-pencil', 'my-focus': 'target', 'my-todo': 'check-square', 'my-insight': 'sparkle' };
const stateNames: Record<IntelligenceState, string> = { pending: '待核对', accepted: '已采纳', rejected: '不采纳', handled: '已处理', ignored: '已忽略', deferred: '稍后处理' };
const kindNames: Record<string, string> = { 'off-topic': '议题偏离', 'meeting-ending': '会议时间', 'topic-overtime': '议题超时', undiscussed: '未讨论', 'budget-conflict': '预算冲突', 'rule-conflict': '规则冲突', 'history-conflict': '历史决定', unresolved: '结论遗漏' };

export function SessionIntelligence({ session }: { session: Session }) {
  const { data, update, route, navigate, toast } = useOops();
  const kind = views[route.view] || 'understanding';
  const current = data.sessions.find(value => value.id === session.id);
  const personal = data.settings.space === PERSONAL_SPACE;
  const read = readSessionIntelligence(data, session.id, kind);
  const [tab, setTab] = useViewState(`intelligence-filter:${session.id}:${kind}:${data.settings.space}`, '待核对');
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [configuration, setConfiguration] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useViewState(`intelligence-draft:${session.id}:${kind}:${data.settings.space}`, { id: '', text: '' });
  const context = readPersonalContext(data, session.id);
  const plan = readNoticePlan(data, current || session);
  const [contextDraft, setContextDraft] = useViewState(`intelligence-context-draft:${session.id}:${data.settings.space}`, { role: context.role, focus: context.focus });
  const [planDraft, setPlanDraft] = useViewState(`intelligence-plan-draft:${session.id}:${data.settings.space}`, { meeting: String(plan.meetingMinutes), topic: String(plan.topicMinutes), restart: false });
  const selected = read.items.find(value => value.id === openId);
  const safeCount = (current?.transcript || []).filter(turn => !turn.private && turn.text.trim()).length;

  useEffect(() => {
    if (personal && current && !read.generated) update(value => refreshSessionIntelligence(value, session.id, kind));
  }, [personal, current?.id, session.id, kind, read.generated, update]);
  useEffect(() => { setOpenId(null); setEditing(false); setConfiguration(false); setError(''); }, [session.id, kind, personal]);

  function commit(action: (value: AppData) => IntelligenceResult, message: string): boolean {
    const result = action(data);
    if (result.error) { setError(result.error); return false; }
    update(value => action(value).data);
    setError(''); toast(message); return true;
  }
  function refresh() { update(value => refreshSessionIntelligence(value, session.id, kind)); toast(kind === 'notices' ? '已检查当前议程和讨论' : '已按当前可用原话整理'); }
  function open(value: IntelligenceItem, edit = false) {
    if (draft.id !== value.id) setDraft({ id: value.id, text: value.text });
    setOpenId(value.id); setEditing(edit); setError('');
  }
  function change(value: IntelligenceItem, state: IntelligenceState) {
    return commit(latest => updateIntelligenceItem(latest, session.id, kind, value.id, { state }), kind === 'decisions' && state === 'accepted' ? '已加入本次确认结论，尚未共享' : stateNames[state]);
  }
  function save() {
    if (!selected) return;
    if (commit(value => updateIntelligenceItem(value, session.id, kind, selected.id, { text: draft.text }), kind === 'decisions' ? '修改已保存，请重新确认是否采纳' : '修正已保存')) { setEditing(false); setOpenId(null); }
  }
  function goAction(value: IntelligenceItem) {
    const target = intelligenceActionRoute(data, session.id, value);
    if (!target) { setError('关联内容已变化，请重新检查'); return; }
    setOpenId(null); navigate(target);
  }

  if (!current) return <Empty title="这条记录已移除" body="返回会话列表继续查看。" action="会话列表" onAction={() => navigate({ view: 'sessions' })} />;
  if (!personal) return <Empty icon="lock-simple" title="请到我的空间核对" body="会中理解、候选提醒和我的复盘只在本人空间整理。已确认的共同纪要可在会话概览查看。" action="查看共同纪要" onAction={() => navigate({ view: 'session-detail', id: session.id, mode: '概览' })} />;

  const pending = read.items.filter(value => value.state === 'pending').length;
  const filtered = kind === 'decisions' ? read.items.filter(value => tab === '已采纳' ? value.state === 'accepted' : tab === '不采纳' ? value.state === 'rejected' : value.state === 'pending') : kind === 'notices' ? read.items.filter(value => tab === '稍后' ? value.state === 'deferred' : tab === '已处理' ? ['handled', 'ignored'].includes(value.state) : value.state === 'pending') : read.items;
  const title = kind === 'personal' ? `${context.name}的会后视角` : names[kind];
  return <div className={`stack intelligence-page intelligence-${kind}`}>
    <Card className="intelligence-hero">
      <div className="intelligence-hero-top"><span className="intelligence-hero-icon"><Icon name={kind === 'notices' ? 'bell' : kind === 'personal' ? 'sparkle' : kind === 'decisions' ? 'check-circle' : 'waveform'} size={25} /></span><Badge tone="gray">{current.status}</Badge></div>
      <h2>{title}</h2><p>{kind === 'personal' ? `${context.role} · ${context.focus}` : current.title}</p>
      <div className="intelligence-hero-meta"><span>{kind === 'decisions' ? `${pending}项待核对` : kind === 'notices' ? `${pending}条待处理` : `${safeCount}段可用原话`}</span><Button tone="quiet" icon="arrows-clockwise" onClick={refresh}>{kind === 'notices' ? '重新检查' : '更新整理'}</Button></div>
    </Card>
    {read.staleCount > 0 && <Notice tone="warning">{read.staleCount}项内容的来源或关注点已变化。重新整理后再核对。</Notice>}
    {kind === 'understanding' && <div className="intelligence-caption"><Icon name="sparkle" size={15} /><span>会中整理 · 点击卡片核对或修正</span></div>}
    {kind === 'decisions' && <><Tabs items={['待核对', '已采纳', '不采纳']} value={['待核对', '已采纳', '不采纳'].includes(tab) ? tab : '待核对'} onChange={setTab} /><p className="intelligence-caption">逐项采纳后，加入本次确认结论。</p></>}
    {kind === 'notices' && <><Row title="时间与当前议题" subtitle={`${plan.meetingMinutes}分钟会议 · 每个议题${plan.topicMinutes}分钟`} icon="clock" onClick={() => { setPlanDraft({ meeting: String(plan.meetingMinutes), topic: String(plan.topicMinutes), restart: false }); setConfiguration(true); setError(''); }} /><Tabs items={['待处理', '稍后', '已处理']} value={['待处理', '稍后', '已处理'].includes(tab) ? tab : '待处理'} onChange={setTab} /></>}
    {kind === 'personal' && <><div className="intelligence-personal-context"><Avatar name={context.name} /><span><strong>只给我的复盘</strong><small>按本次角色和关注目标整理</small></span><Button tone="quiet" onClick={() => { setContextDraft({ role: context.role, focus: context.focus }); setConfiguration(true); setError(''); }}>调整</Button></div></>}

    {!safeCount ? <Empty title="还没有可整理的原话" body="记录几句话，或添加文字原文后再整理。" action="查看原文" onAction={() => navigate({ view: 'session-detail', id: session.id, mode: '原文' })} icon="quotes" /> : !filtered.length ? <Empty title={kind === 'notices' ? '当前没有待处理提醒' : kind === 'decisions' ? tab === '已采纳' ? '还没有采纳的决定' : tab === '不采纳' ? '还没有不采纳的建议' : '当前没有决定建议' : '还没有整理结果'} body={kind === 'notices' ? '继续记录，或回看议程后重新检查。' : kind === 'decisions' ? '有了决定、方案或结论的原话，再更新整理。' : '按当前可用原话更新整理。'} action={kind === 'notices' ? '查看议程' : '更新整理'} onAction={kind === 'notices' ? () => navigate({ view: 'session-agenda', id: session.id }) : refresh} /> : filtered.map(value => <Card key={value.id} className={`intelligence-result ${value.state !== 'pending' ? 'processed' : ''}`}>
      <div className="intelligence-result-head"><span className="intelligence-result-symbol"><Icon name={kind === 'notices' ? value.kind.includes('conflict') ? 'warning' : value.kind.includes('time') || value.kind === 'meeting-ending' ? 'clock' : 'bell' : icons[value.kind] || 'sparkle'} size={19} /></span><strong>{kind === 'notices' ? kindNames[value.kind] || '会议提醒' : value.title}</strong>{value.edited ? <Badge tone="gray">已修正</Badge> : value.state !== 'pending' ? <Badge tone={value.state === 'accepted' || value.state === 'handled' ? 'green' : 'gray'}>{kind === 'personal' && value.state === 'accepted' ? '已记录' : stateNames[value.state]}</Badge> : kind === 'decisions' ? <Badge tone="orange">待确认</Badge> : null}</div>
      {kind === 'notices' && <h3>{value.title}</h3>}<p className="intelligence-body">{value.text}</p>
      <div className="intelligence-card-source"><span>{value.sources.filter(ref => ref.kind === 'session').length}段原话依据</span><Button tone="quiet" onClick={() => open(value)}>{kind === 'notices' ? '查看证据' : '查看原话'}</Button></div>
      {kind === 'decisions' ? <div className="intelligence-actions">{value.state === 'pending' ? <><Button onClick={() => change(value, 'accepted')} icon="check">采纳</Button><Button tone="secondary" onClick={() => open(value, true)}>修改</Button><Button tone="quiet" onClick={() => change(value, 'rejected')}>不采纳</Button></> : <><Button tone="secondary" onClick={() => change(value, 'pending')}>重新核对</Button>{value.state === 'accepted' && <Button tone="quiet" onClick={() => navigate({ view: 'session-review-edit', id: session.id })}>查看本次结论</Button>}</>}</div> : kind === 'notices' ? <div className="intelligence-actions">{['pending', 'deferred'].includes(value.state) ? <><Button onClick={() => goAction(value)}>{value.actionLabel || '处理提醒'}</Button><Button tone="secondary" onClick={() => change(value, value.state === 'deferred' ? 'pending' : 'deferred')}>{value.state === 'deferred' ? '移回待处理' : '稍后'}</Button><Button tone="quiet" onClick={() => open(value)}>标记处理</Button></> : <Button tone="secondary" onClick={() => change(value, 'pending')}>重新打开</Button>}</div> : <div className="intelligence-actions"><Button tone="secondary" onClick={() => open(value, true)} icon="note-pencil">修正</Button>{kind === 'understanding' && value.kind === 'people' && <Button tone="quiet" onClick={() => { const turn = current.transcript.find(row => !row.private && /未知|待确认|说话人/.test(row.speaker)) || current.transcript.find(row => !row.private); if (turn) navigate({ view: 'session-identity', id: session.id, mode: turn.id }); }}>核对说话人</Button>}{kind === 'personal' && value.action && <Button onClick={() => goAction(value)}>{value.actionLabel}</Button>}{kind === 'personal' && value.kind === 'my-insight' && <Button tone="quiet" onClick={() => change(value, value.state === 'accepted' ? 'pending' : 'accepted')}>{value.state === 'accepted' ? '取消标记' : '记为我的观察'}</Button>}</div>}
    </Card>)}
    {error && !openId && !configuration && <p className="error-text">{error}</p>}
    {kind === 'decisions' && <Row title="手工补充结论" subtitle="写下已经核对的决定或待确认问题" icon="note-pencil" onClick={() => navigate({ view: 'session-review-edit', id: session.id })} />}
    {kind === 'personal' && <Row title="本次确认结论" subtitle="查看本次核对的结论与问题" icon="users-three" onClick={() => navigate({ view: 'session-detail', id: session.id, mode: '概览' })} />}
    {kind === 'understanding' && <><SectionTitle>接着核对</SectionTitle><Row title="任务建议" subtitle="核对具体要求、负责人、期限与优先级" icon="list-checks" onClick={() => navigate({ view: 'session-task-suggestions', id: session.id })} /><Row title="决定建议" subtitle="逐项确认方案、结论与决定" icon="check-circle" onClick={() => navigate({ view: 'session-decisions', id: session.id })} /><Row title="会议提醒" subtitle="查看偏离、时间与待定问题" icon="bell" onClick={() => navigate({ view: 'session-notices', id: session.id })} /></>}
    <Button tone="quiet" onClick={() => navigate({ view: 'session-detail', id: session.id, mode: current.status === '进行中' || current.status === '暂停' ? '现场' : '概览' })}>返回本次会话</Button>

    <Sheet open={openId !== null} onClose={() => { setOpenId(null); setEditing(false); setError(''); }} title={selected ? editing ? `修正${selected.title}` : kind === 'notices' ? selected.title : '结果与原话' : '来源需要重新核对'}>
      {selected ? <><Badge tone="gray">{selected.edited ? '本人已修正' : kind === 'decisions' ? stateNames[selected.state] : '待核对的整理结果'}</Badge>{editing ? <Field label="内容" value={draft.id === selected.id ? draft.text : selected.text} onChange={text => setDraft({ id: selected.id, text })} multiline /> : <p className="intelligence-sheet-text">{selected.text}</p>}
        {selected.evidence?.map((evidence, index) => <Card className="intelligence-evidence" key={index}><small>{evidence.label}</small><p>{evidence.text}</p></Card>)}
        <SectionTitle>原话与依据</SectionTitle>{selected.sources.map((ref, index) => {
          const origin = ref.kind === 'session' ? sourceTurn(data, { sourceSession: ref.id, sourceId: ref.sourceId, sourceTime: ref.sourceTime }) : undefined;
          const target = intelligenceSourceRoute(data, session.id, selected, ref);
          const label = origin ? `${origin.speaker}的原话` : ref.kind === 'project' ? data.projects.find(value => value.id === ref.id)?.name || '项目规则' : ref.kind === 'memory' ? data.memories.find(value => value.id === ref.id)?.title || '历史记忆' : ref.kind === 'task' ? data.tasks.find(value => value.id === ref.id)?.title || '关联待办' : '我的角色与偏好';
          return <div className="intelligence-quote" key={`${ref.kind}:${ref.id}:${index}`}>{origin && <p>{origin.text}</p>}<Source title={label} time={origin?.time} onClick={() => { if (target) { setOpenId(null); navigate(target); } }} /></div>;
        })}
        {error && <p className="error-text">{error}</p>}{editing ? <Button onClick={save}>保存修正</Button> : kind === 'notices' ? <><Button onClick={() => goAction(selected)}>{selected.actionLabel || '处理提醒'}</Button><p className="meta">核对并完成跟进后，可标记已处理。</p><Button tone="secondary" onClick={() => { if (change(selected, 'handled')) setOpenId(null); }}>我已核对，标记已处理</Button><div className="intelligence-actions"><Button tone="secondary" onClick={() => { if (change(selected, 'deferred')) setOpenId(null); }}>稍后处理</Button><Button tone="quiet" onClick={() => { if (change(selected, 'ignored')) setOpenId(null); }}>忽略此条</Button></div></> : <Button tone="secondary" onClick={() => setEditing(true)}>修正这项内容</Button>}
      </> : <><Notice>这项内容的原话或关注点已变化，旧内容暂不显示。</Notice><Button onClick={() => { setOpenId(null); refresh(); }}>重新整理</Button></>}
    </Sheet>
    <Sheet open={configuration} onClose={() => { setConfiguration(false); setError(''); }} title={kind === 'personal' ? '我的本次关注点' : '会议时间安排'}>
      {kind === 'personal' ? <><Field label="我的本次角色" value={contextDraft.role} onChange={role => setContextDraft(value => ({ ...value, role }))} placeholder="例如：产品负责人" /><Field label="这次最关注什么" value={contextDraft.focus} onChange={focus => setContextDraft(value => ({ ...value, focus }))} multiline placeholder="例如：预算、首版目标与我需要跟进的事" /><p className="meta">只用于本次私人复盘。</p></> : <><Field label="会议计划时长（分钟）" type="number" value={planDraft.meeting} onChange={meeting => setPlanDraft(value => ({ ...value, meeting }))} /><Field label="每个议题的分配时间（分钟）" type="number" value={planDraft.topic} onChange={topic => setPlanDraft(value => ({ ...value, topic }))} /><Check label="从此刻重新计时当前议题" value={planDraft.restart} onChange={restart => setPlanDraft(value => ({ ...value, restart }))} /><Row title="当前议题" subtitle={current.agenda[plan.topicIndex] || '尚未添加议题'} icon="list-checks" onClick={() => { setConfiguration(false); navigate({ view: 'session-agenda', id: session.id }); }} /></>}
      {error && <p className="error-text">{error}</p>}<Button onClick={() => { const saved = kind === 'personal' ? commit(value => savePersonalContext(value, session.id, contextDraft), '已按本次关注点更新私人复盘') : commit(value => saveNoticePlan(value, session.id, { meetingMinutes: Number(planDraft.meeting), topicMinutes: Number(planDraft.topic), restartTopic: planDraft.restart }), '时间安排已保存'); if (saved) setConfiguration(false); }}>保存并更新</Button>
    </Sheet>
  </div>;
}

export default SessionIntelligence;
