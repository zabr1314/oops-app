import { useEffect, useState } from 'react';
import { useOops, type AppData, type Session } from '../store';
import { Badge, Button, Card, Empty, Field, Icon, Notice, Row, SectionTitle, SelectField, Sheet, Source, Tabs } from '../ui';
import { useViewState } from '../viewState';
import { PERSONAL_SPACE } from '../sourceAccess';
import { createTaskFromSuggestion, readTaskSuggestions, refreshTaskSuggestions, saveTaskSuggestionDraft, setTaskSuggestionIgnored, taskSuggestionOwners, type TaskSuggestion, type TaskSuggestionDraft, type TaskSuggestionResult } from '../taskSuggestionsLogic';
import './TaskSuggestions.css';

const emptyDraft = (): TaskSuggestionDraft & { id: string } => ({ id: '', title: '', ownerId: '', due: '', priority: '中' });

export function TaskSuggestions({ session }: { session: Session }) {
  const { data, update, navigate, toast } = useOops();
  const current = data.sessions.find(value => value.id === session.id);
  const personal = data.settings.space === PERSONAL_SPACE;
  const read = readTaskSuggestions(data, session.id);
  const owners = taskSuggestionOwners(data);
  const [tab, setTab] = useViewState(`task-suggestion-filter:${session.id}:${data.settings.space}`, '待确认');
  const [draft, setDraft] = useViewState(`task-suggestion-draft:${session.id}:${data.settings.space}`, emptyDraft);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const selected = read.items.find(value => value.id === openId);
  const selectedOwner = owners.find(value => value.id === draft.ownerId);
  const pending = read.items.filter(value => value.state === 'pending').length;
  const filtered = read.items.filter(value => tab === '已整理' ? value.state === 'created' : tab === '已忽略' ? value.state === 'ignored' : value.state === 'pending');

  useEffect(() => {
    if (current && personal && !read.generated) update(value => refreshTaskSuggestions(value, session.id));
  }, [current?.id, personal, read.generated, session.id, update]);
  useEffect(() => { setOpenId(null); setError(''); }, [session.id, data.settings.space]);

  function commit(action: (value: AppData) => TaskSuggestionResult, message: string): TaskSuggestionResult | undefined {
    const result = action(data);
    if (result.error) { setError(result.error); return; }
    update(value => action(value).data); setError(''); toast(message); return result;
  }
  function refresh() { update(value => refreshTaskSuggestions(value, session.id)); setError(''); toast('已按当前可用原话整理任务建议'); }
  function open(value: TaskSuggestion) {
    if (draft.id !== value.id) setDraft({ id: value.id, title: value.title, ownerId: value.ownerId, due: value.due, priority: value.priority });
    setOpenId(value.id); setError('');
  }
  function ignore(value: TaskSuggestion, ignored: boolean) {
    if (commit(latest => setTaskSuggestionIgnored(latest, session.id, value.id, ignored), ignored ? '已忽略这项建议' : '已重新打开建议')) setOpenId(null);
  }
  function save(create: boolean) {
    if (!selected) return;
    const taskId = `TASK-SUG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const action = (latest: AppData) => create ? createTaskFromSuggestion(latest, session.id, selected.id, draft, { taskId, created: new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }) : saveTaskSuggestionDraft(latest, session.id, selected.id, draft);
    const result = commit(action, create ? '已建立待承接任务，未开启助手' : '修改已保存');
    if (result) { setOpenId(null); if (create) setTab('已整理'); }
  }

  if (!current) return <Empty title="这条会话已移除" body="返回会话列表继续查看。" action="会话列表" onAction={() => navigate({ view: 'sessions' })} />;
  if (!personal) return <Empty icon="lock-simple" title="请在我的空间核对任务建议" body="已建立的任务可从本次行动查看。" action="查看本次行动" onAction={() => navigate({ view: 'session-detail', id: session.id, mode: '行动' })} />;

  return <div className="stack task-suggestions-page">
    <Card className="task-suggestions-hero"><div className="task-suggestions-hero-top"><span className="task-suggestions-symbol"><Icon name="list-checks" size={25} /></span><Badge tone="gray">{current.status}</Badge></div><h2>先把行动核对清楚</h2><p>{current.title}</p><div className="task-suggestions-hero-meta"><span>{pending}项待确认</span><Button tone="quiet" icon="arrows-clockwise" onClick={refresh}>更新建议</Button></div></Card>
    {read.staleCount > 0 && <Notice tone="warning">{read.staleCount}项建议的原话已变化，旧内容暂不显示。更新后重新核对。</Notice>}
    <Tabs items={['待确认', '已整理', '已忽略']} value={tab} onChange={setTab} />
    {!filtered.length ? <Empty icon="check-square" title={tab === '已整理' ? '还没有整理为任务' : tab === '已忽略' ? '还没有忽略的建议' : '当前没有待确认任务建议'} body={tab === '待确认' ? '记录具体要做的事后，再更新建议。也可以从本次行动手工整理。' : '继续核对任务建议，或查看本次行动。'} action={tab === '待确认' ? '查看本次行动' : '查看待确认'} onAction={() => tab === '待确认' ? navigate({ view: 'session-detail', id: session.id, mode: '行动' }) : setTab('待确认')} /> : filtered.map(value => {
      const task = value.taskId ? data.tasks.find(item => item.id === value.taskId) : undefined;
      const owner = owners.find(item => item.id === value.ownerId);
      const title = task?.title || value.title;
      return <Card key={value.id} className="task-suggestion-card"><div className="task-suggestion-card-top"><Badge tone={value.taskNeedsReview ? 'orange' : value.state === 'created' ? 'green' : value.state === 'ignored' ? 'gray' : 'purple'}>{value.taskNeedsReview ? '已有任务 · 需复核' : value.state === 'created' ? '已整理为任务' : value.state === 'ignored' ? '已忽略' : value.edited ? '已编辑 · 待确认' : '待确认建议'}</Badge><span>{value.speaker}</span></div><h3>{title}</h3>
        <dl className="task-suggestion-fields"><div><dt>负责人</dt><dd>{task?.owner || owner?.name || '待确认'}</dd></div><div><dt>截止</dt><dd>{task ? task.due ? task.due.replace('T', ' ') : '未填写期限' : value.due ? value.due.replace('T', ' ') : value.dueHint}</dd></div><div><dt>优先级</dt><dd><Badge tone={(task?.priority || value.priority) === '高' ? 'orange' : 'gray'}>{task?.priority || value.priority}</Badge></dd></div></dl>
        <div className="task-suggestion-original"><small>{value.speaker} · {value.sourceTime || '时间未提供'}</small><p>{value.text}</p><Source title="核对这段原话" time={value.sourceTime || undefined} onClick={() => navigate({ view: 'session-transcript', id: session.id, mode: value.sourceId })} /></div>
        {value.state === 'created' ? <><p className="meta">{task?.status || '已建立'}{value.taskNeedsReview ? ' · 先核对变化后的来源与要求' : ' · 承接和助手授权分别确认'}</p><Button tone="secondary" onClick={() => value.taskId && navigate({ view: 'task-detail', id: value.taskId })}>{value.taskNeedsReview ? '核对现有任务' : '查看任务'}</Button></> : value.state === 'ignored' ? <Button tone="secondary" onClick={() => ignore(value, false)}>重新核对这项</Button> : <div className="task-suggestion-actions"><Button onClick={() => open(value)} icon="note-pencil">核对并整理</Button><Button tone="quiet" onClick={() => ignore(value, true)}>忽略</Button></div>}
      </Card>;
    })}
    {error && !openId && <p className="error-text">{error}</p>}
    <SectionTitle>本次行动</SectionTitle><Row title="查看已建立的任务" subtitle="继续承接、执行与跟进" icon="check-square" onClick={() => navigate({ view: 'session-detail', id: session.id, mode: '行动' })} />
    <Button tone="quiet" onClick={() => navigate({ view: 'session-detail', id: session.id, mode: current.status === '进行中' || current.status === '暂停' ? '现场' : '概览' })}>返回本次会话</Button>
    <Sheet open={openId !== null} onClose={() => { setOpenId(null); setError(''); }} title={selected?.state === 'created' ? '这段原话已有任务' : '核对任务建议'}>
      {selected ? selected.state === 'created' ? <><Notice>{selected.taskNeedsReview ? '来源已变化，请核对现有任务。' : '已保留原任务，继续从任务详情推进。'}</Notice><Button onClick={() => { setOpenId(null); if (selected.taskId) navigate({ view: 'task-detail', id: selected.taskId }); }}>查看现有任务</Button></> : <><div className="task-suggestion-original"><small>{selected.speaker} · {selected.sourceTime || '时间未提供'}</small><p>{selected.text}</p><Source title="查看原话上下文" time={selected.sourceTime || undefined} onClick={() => { setOpenId(null); navigate({ view: 'session-transcript', id: session.id, mode: selected.sourceId }); }} /></div>
        <Field label="任务标题" value={draft.title} onChange={title => setDraft(value => ({ ...value, title }))} placeholder="具体要做什么" />
        <SelectField label="建议负责人" value={selectedOwner?.label || '负责人待确认'} options={['负责人待确认', ...owners.map(value => value.label)]} onChange={label => setDraft(value => ({ ...value, ownerId: owners.find(owner => owner.label === label)?.id || '' }))} />
        {!selectedOwner && <Row title="先核对说话人" subtitle="姓名未确认时，保留未定负责人" icon="user-circle" onClick={() => { setOpenId(null); navigate({ view: 'session-identity', id: session.id, mode: selected.sourceId }); }} />}
        <Field label="截止时间（可留空）" value={draft.due.replace('T', ' ')} onChange={due => setDraft(value => ({ ...value, due }))} placeholder="2026-10-10 17:00" hint={selected.dueHint} />
        <SelectField label="优先级" value={draft.priority} options={['高', '中', '低']} onChange={priority => setDraft(value => ({ ...value, priority: priority as TaskSuggestionDraft['priority'] }))} />
        <p className="meta">整理后等待负责人承接，助手尚未开启。</p>{error && <p className="error-text" role="alert">{error}</p>}
        <Button onClick={() => save(true)}>确认建立待承接任务</Button><Button tone="secondary" onClick={() => save(false)}>只保存修改</Button><Button tone="quiet" onClick={() => ignore(selected, true)}>忽略这项建议</Button>
      </> : <><Notice>原话已修订或移除，旧建议暂不可用。</Notice><Button onClick={() => { setOpenId(null); refresh(); }}>重新整理建议</Button></>}
    </Sheet>
  </div>;
}

export default TaskSuggestions;
