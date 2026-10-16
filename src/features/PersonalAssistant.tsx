import { useState } from 'react';
import { useOops, type AppData, type Route, type SourceReference } from '../store';
import { buildPersonalContext, collectPersonalHabitCandidates, readPersonalAssistantState, reviewPersonalHabitCandidate, setPersonalLearning, setPersonalizationEnabled, type PersonalScenario } from '../personalAssistant';
import { Badge, Button, Card, Check, Chips, Empty, Field, Notice, Row, SectionTitle, SelectField, Sheet, Source, Tabs, Toggle } from '../ui';
import './PersonalAssistant.css';

export const PERSONAL_SCENARIOS = ['通用', '会议', '汇报', '写作', '研究'];
const labels: Record<string, string> = { identity: '当前身份', preference: '助理偏好', background: '已确认背景', goal: '当前目标', habit: '已确认习惯', person_fact: '人物身份', person_preference: '对方偏好', person_background: '交流背景', person_commitment: '双方约定' };
export function personalSourceRoute(source: SourceReference): Route {
  if (source.kind === 'person_memory') return { view: 'memory-person', id: source.personId };
  if (source.kind === 'profile') return { view: source.profileScope === 'preferences' ? 'settings-preferences' : 'settings-identity' };
  return { view: source.kind === 'session' ? 'session-transcript' : source.kind === 'memory' ? 'memory-detail' : source.kind === 'task' ? 'task-detail' : 'memory-project', id: source.id, mode: source.sourceId || source.sourceTime };
}
function sourceLabel(data: AppData, source: SourceReference) {
  if (source.kind === 'person_memory') return '人物记忆 · ' + (data.people.find(person => person.id === source.personId)?.name || '查看人物');
  if (source.kind === 'profile') return source.profileScope === 'preferences' ? '本人设置的偏好' : '本人填写的身份';
  return source.kind === 'session' ? data.sessions.find(item => item.id === source.id)?.title || '原话来源' : source.kind === 'memory' ? data.memories.find(item => item.id === source.id)?.title || '记忆来源' : '查看来源';
}

export function PersonContextSelect({ personId = '', onChange }: { personId?: string; onChange: (id: string) => void }) {
  const { data } = useOops();
  if (data.settings.space !== '我的空间') return null;
  const people = data.people.filter(person => person.name.trim() && !/未知|待确认|匿名|说话人|unknown|anonymous/i.test(person.name));
  const label = (person: typeof people[number]) => `${person.name} · ${person.company || person.role || '人物卡'} · ${person.id}`;
  return <SelectField label="这次与谁沟通" value={people.find(person => person.id === personId) ? label(people.find(person => person.id === personId)!) : '不使用人物记忆'} options={['不使用人物记忆', ...people.map(label)]} onChange={value => onChange(people.find(person => label(person) === value)?.id || '')}/>;
}

/** The caller owns exclusions so each request can freeze exactly what was selected. */
export function PersonalContextPicker({ scenario = '通用', query = '', personId, excludedIds = [], onChange }: { scenario?: PersonalScenario; query?: string; personId?: string; excludedIds?: string[]; onChange?: (ids: string[]) => void }) {
  const { data, navigate } = useOops();
  if (data.settings.space !== '我的空间') return null;
  const context = buildPersonalContext(data, { scenario, query, personId });
  const selected = buildPersonalContext(data, { scenario, query, personId, excludeIds: excludedIds });
  const entries = [...new Map([...context.entries,...selected.entries].map(entry=>[entry.id,entry])).values()];
  return <details className="personal-context-picker"><summary>本次使用的背景 <span>{context.enabled ? `${selected.entries.length} 项` : '已关闭'}</span></summary>
    <div className="stack">
      <p className="meta">适用场景：{scenario}。临时取消只影响这次准备。</p>
      {entries.map(entry => <div key={entry.id} className="personal-context-entry">
        {onChange ? <Check label={`${labels[entry.kind] || '背景'}${entry.kind.startsWith('person_') ? entry.origin === 'quote' ? '（对方原话整理）' : '（我的私人记录）' : ''}：${entry.text}`} value={!excludedIds.includes(entry.id)} onChange={selected => onChange(selected ? excludedIds.filter(id => id !== entry.id) : [...new Set([...excludedIds, entry.id])])}/> : <p>{entry.text}</p>}
        {entry.sources.slice(0, 2).map((source, index) => <Source key={index} title={sourceLabel(data, source)} onClick={() => navigate(personalSourceRoute(source))}/>)}
      </div>)}
      {!selected.entries.length && <p className="meta">{context.enabled ? '当前场景没有已确认且可用的个人背景。' : '开启个性化后，可以选择已确认的背景。'}</p>}
      <Button tone="quiet" onClick={() => navigate({ view: 'settings-personal-assistant' })}>管理个性化助理</Button>
    </div>
  </details>;
}

export function PersonalAssistantScreen() {
  const { data, update, navigate, toast, route } = useOops();
  const [tab, setTab] = useState(route.mode==='pending'?'待确认':'正在使用');
  const [scenario, setScenario] = useState<PersonalScenario>('通用');
  const [editing, setEditing] = useState<string>();
  const [text, setText] = useState('');
  const [editScenario, setEditScenario] = useState<PersonalScenario>('通用');
  const [error, setError] = useState('');
  const [manual, setManual] = useState(false);
  const [manualMemoryId,setManualMemoryId]=useState<string>();
  const state = readPersonalAssistantState(data);
  const context = buildPersonalContext(data, { scenario });
  const pending = state.candidates.filter(item => item.status === 'pending' && !item.stale);
  const history = state.candidates.filter(item => ['rejected', 'disabled'].includes(item.status));
  const candidate = state.candidates.find(item => item.id === editing);

  if (data.settings.space !== '我的空间') return <Empty title="这是你的私人助理设置" body="回到我的空间，管理个人背景和习惯。" action="回到我的空间" onAction={() => update(current => ({ ...current, settings: { ...current.settings, space: '我的空间' } }))}/>;
  function review(id: string, action: 'confirm' | 'correct' | 'reject' | 'disable', correctedText?: string) {
    const current = state.candidates.find(item => item.id === id);
    if (!current) return;
    const result = reviewPersonalHabitCandidate(data, id, { action, text: correctedText, scenario: action === 'correct' ? editScenario : current.scenario, expectedFingerprint: current.fingerprint });
    if (result.error) { setError(result.error); return; }
    update(latest => reviewPersonalHabitCandidate(latest, id, { action, text: correctedText, scenario: action === 'correct' ? editScenario : current.scenario, expectedFingerprint: current.fingerprint }).data);
    setEditing(undefined); setError('');
    toast(action === 'reject' ? '已忽略，相同建议不再重复出现' : action === 'disable' ? '已停用，之后不再使用' : '已记住，之后按适用场景使用');
  }
  function rememberManual() {
    const body = text.trim();
    if (!body || body.length > 280) { setError('请填写 1–280 字的具体偏好。'); return; }
    const id = manualMemoryId || `MEM-preference-${Date.now().toString(36)}`;
    update(current => { const saved={id,title:body.slice(0,24),body,category:'记忆' as const,tags:['偏好','沟通习惯','本人确认',`场景:${editScenario}`],visibility:'私有' as const,confirmed:true,updated:new Date().toISOString()}; return {...current,memories:manualMemoryId?current.memories.map(memory=>memory.id===id?{...memory,...saved}:memory):[saved,...current.memories],settings:{...current.settings,retention:{...current.settings.retention,['memory-context:'+id]:editScenario}}}; });
    setManual(false); setText(''); setError(''); toast('这条偏好已确认并记住');
  }
  return <div className="stack personal-assistant-screen">
    <Card className="personal-assistant-hero"><Badge tone="gray">{new URLSearchParams(window.location.search).has('board-preview')?'示例 · 只对你可见':'只对你可见'}</Badge><h2>按你的方式，<br/>做好下一步。</h2><p>记住你确认的信息，在合适的时候用上。</p><div className="personal-assistant-counts"><span><strong>{context.entries.length}</strong>项当前背景</span><span><strong>{pending.length}</strong>条等你确认</span></div></Card>
    <Card><Toggle label="使用已确认的个人背景" value={state.personalizationEnabled} onChange={enabled => update(current => setPersonalizationEnabled(current, enabled))} hint="用于私人问答与个人草稿；每次都可以调整。"/><Toggle label="从我的明确表达中学习偏好" value={state.learningEnabled} onChange={enabled => update(current => collectPersonalHabitCandidates(setPersonalLearning(current, enabled), { scenario }))} hint="先形成待确认建议，确认后才使用。"/></Card>
    <Tabs items={['正在使用', '待确认', '已停用']} value={tab} onChange={value=>{setTab(value);setError('')}}/>
    {error&&!candidate&&!manual&&<p className="error-text" role="alert">{error}</p>}
    {tab === '正在使用' && <>
      <Chips items={PERSONAL_SCENARIOS} value={scenario} onChange={value => setScenario(value as PersonalScenario)}/>
      <Card><Row title="身份与职责" subtitle={data.settings.role || '填写你当前负责的事'} icon="user-circle" onClick={() => navigate({ view: 'settings-identity' })}/><Row title="回答与工作偏好" subtitle={data.settings.tone} icon="sliders-horizontal" onClick={() => navigate({ view: 'settings-preferences' })}/><Row title="当前目标" subtitle="优先推进什么，由你确认" icon="target" onClick={() => navigate({ view: 'memory-goals' })}/></Card>
      <SectionTitle>用于{scenario === '通用' ? '一般交流' : scenario}的背景</SectionTitle>
      {context.entries.map(entry => <Card key={entry.id}><Badge tone="gray">{labels[entry.kind] || '已确认信息'}</Badge><p className="personal-assistant-copy">{entry.text}</p>{entry.sources.slice(0, 2).map((source, index) => <Source key={index} title={sourceLabel(data, source)} onClick={() => navigate(personalSourceRoute(source))}/>)}{entry.kind === 'habit' && state.candidates.some(item => item.id === entry.id) && <Button tone="quiet" onClick={() => review(entry.id, 'disable')}>停用这条习惯</Button>}{entry.kind==='habit'&&data.memories.some(item=>item.id===entry.id&&item.tags.includes('本人确认'))&&<div className="action-grid"><Button tone="quiet" onClick={()=>{const memory=data.memories.find(item=>item.id===entry.id)!;setManualMemoryId(memory.id);setText(memory.body);setEditScenario((data.settings.retention['memory-context:'+memory.id]||'通用') as PersonalScenario);setError('');setManual(true);}}>修改偏好</Button><Button tone="quiet" onClick={()=>{update(current=>({...current,memories:current.memories.map(memory=>memory.id===entry.id?{...memory,tags:[...new Set([...memory.tags,'已停用'])]}:memory)}));toast('已停用，之后不再使用');}}>停用这条偏好</Button></div>}</Card>)}
      {!context.entries.length && <Empty title={state.personalizationEnabled ? '给 Oops 一点明确的背景' : '个性化已暂停'} body={state.personalizationEnabled ? '填写身份、偏好或确认一条目标，之后的帮助会更贴合你。' : '已保存的信息保留，重新开启后才继续使用。'}/>}
      <Button tone="secondary" icon="plus" onClick={() => { setManualMemoryId(undefined); setText(''); setEditScenario(scenario); setError(''); setManual(true); }}>记下一条偏好</Button>
    </>}
    {tab === '待确认' && <>
      <p className="meta">只从已核对为你本人的明确表达整理；不会把他人的话当成你的习惯。</p>
      <Button tone="secondary" disabled={!state.learningEnabled} onClick={() => { update(current => collectPersonalHabitCandidates(current, { scenario })); toast('已检查当前可用的本人表达'); }}>检查新的偏好表达</Button>
      {pending.map(item => <Card key={item.id}><Badge>待你确认 · {item.scenario}</Badge><p className="personal-assistant-copy">{item.text}</p>{item.sources.map((source, index) => <Source key={index} title={sourceLabel(data, source)} time={source.sourceTime} onClick={() => navigate(personalSourceRoute(source))}/>)}<div className="action-grid"><Button onClick={() => review(item.id, 'confirm')}>确认记住</Button><Button tone="secondary" onClick={() => { setEditing(item.id); setText(item.text); setEditScenario(item.scenario); setError(''); }}>修改</Button><Button tone="quiet" onClick={() => review(item.id, 'reject')}>不记住</Button></div></Card>)}
      {!pending.length && <Empty title="暂时没有新的建议" body={state.learningEnabled ? '有新的明确偏好表达时，会先放在这里等你确认。' : '你可以开启偏好学习，或直接记下一条偏好。'}/>}
    </>}
    {tab === '已停用' && <>{data.memories.filter(memory=>!memory.deleted&&memory.tags.includes('本人确认')&&memory.tags.includes('已停用')).map(memory=><Card key={memory.id}><Badge tone="gray">已停用</Badge><p>{memory.body}</p><Source title="查看这条偏好" onClick={()=>navigate({view:'memory-detail',id:memory.id})}/></Card>)}{history.map(item => <Card key={item.id}><Badge tone="gray">{item.status === 'rejected' ? '已忽略' : '已停用'}</Badge><p>{item.text || '原始依据已不可用'}</p><p className="meta">{item.scenario} · 不参与之后的建议</p></Card>)}{!history.length&&!data.memories.some(memory=>!memory.deleted&&memory.tags.includes('本人确认')&&memory.tags.includes('已停用')) && <Empty title="还没有停用的建议" body="忽略或停用过的信息会在这里留下记录。"/>}</>}
    <Card><Row title="这份背景保存在哪里？" subtitle="当前网页保存在本机；安卓版接入个人服务后可同步。" icon="devices" onClick={() => navigate({ view: 'settings-account' })}/></Card>
    <Sheet open={!!candidate} onClose={() => { setEditing(undefined); setError(''); }} title="修改这条偏好"><Field label="希望 Oops 记住什么" value={text} onChange={setText} multiline/><SelectField label="适用场景" value={editScenario} onChange={value => setEditScenario(value as PersonalScenario)} options={PERSONAL_SCENARIOS}/>{error && <p role="alert" className="error-text">{error}</p>}<Button onClick={() => candidate && review(candidate.id, 'correct', text)}>确认修改并记住</Button></Sheet>
    <Sheet open={manual} onClose={() => { setManual(false); setError(''); }} title={manualMemoryId?'修改这条偏好':'明确记住一条偏好'}><Field label="我希望 Oops 怎么帮忙" value={text} onChange={setText} multiline placeholder="例如：做汇报时先给结论，再列依据和下一步"/><SelectField label="适用场景" value={editScenario} onChange={value => setEditScenario(value as PersonalScenario)} options={PERSONAL_SCENARIOS}/>{error && <p role="alert" className="error-text">{error}</p>}<Button onClick={rememberManual}>确认并记住</Button><Notice>仅用于你选定的场景，之后可以修改或移入回收站。</Notice></Sheet>
  </div>;
}
