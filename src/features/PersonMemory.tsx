import { useEffect, useState } from 'react';
import { useOops, type AppData, type Person } from '../store';
import { collectPersonMemoryCandidates, deletePersonMemory, readPersonMemories, reviewPersonMemory, savePersonMemory, type PersonMemory } from '../personMemory';
import type { PersonalScenario } from '../personalAssistant';
import { Badge, Button, Card, Empty, Field, Notice, SectionTitle, SelectField, Sheet, Source, Tabs } from '../ui';
import { PERSONAL_SCENARIOS } from './PersonalAssistant';

export const PERSON_MEMORY_KINDS = { fact: '身份与关系', preference: '沟通偏好', background: '交流背景', commitment: '约定与跟进' } as const;

/** A person's private notes stay separate from their shared identity card. */
export function PersonMemoryPanel({ person }: { person: Person }) {
  const { data, update, navigate, toast } = useOops();
  const [tab, setTab] = useState('已记住');
  const [editor, setEditor] = useState<{ id?: string; fingerprint?: string }>();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<PersonMemory['kind']>('background');
  const [scenario, setScenario] = useState<PersonalScenario>('通用');
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<PersonMemory>();
  const [pendingChange, setPendingChange] = useState<{ targets: { id: string; fingerprint: string }[]; message: string; change: (current: AppData) => { data: AppData; error?: string } }>();
  useEffect(() => {
    if (!pendingChange) return;
    const actual = readPersonMemories(data, person.id);
    const saved = pendingChange.targets.length > 0 && pendingChange.targets.every(target => actual.some(item => item.id === target.id && item.fingerprint === target.fingerprint));
    if (saved) { setError(''); if (editor) setTab('已记住'); setEditor(undefined); setRemoving(undefined); toast(pendingChange.message); }
    else setError(pendingChange.change(data).error || '人物或来源已变化，本次修改未保存，请重新核对。');
    setPendingChange(undefined);
  }, [data, pendingChange, person.id, toast, editor]);
  if (data.settings.space !== '我的空间') return null;
  const items = readPersonMemories(data, person.id).filter(item => !item.deleted);
  const pending = items.filter(item => item.status === 'pending' && !item.stale);
  const shown = items.filter(item => tab === '待确认' ? item.status === 'pending' && !item.stale : tab === '已记住' ? item.status === 'confirmed' && !item.stale : item.stale || ['disabled', 'rejected'].includes(item.status));
  const existing = editor?.id ? items.find(item => item.id === editor.id) : undefined;

  function apply(change: (current: AppData) => { data: AppData; error?: string }, message: string) {
    const result = change(data);
    if (result.error) { setError(result.error); return false; }
    const before = readPersonMemories(data, person.id);
    const targets = readPersonMemories(result.data, person.id).filter(item => !before.some(old => old.id === item.id && old.fingerprint === item.fingerprint)).map(item => ({ id: item.id, fingerprint: item.fingerprint }));
    if (!targets.length) { setError('内容未变化，请重新核对。'); return false; }
    setPendingChange({ targets, message, change });
    update(current => change(current).data);
    return true;
  }
  function open(item?: PersonMemory) {
    setEditor(item ? { id: item.id, fingerprint: item.fingerprint } : {});
    setText(item?.text || ''); setKind(item?.kind || 'background'); setScenario(item?.scenario || '通用'); setError('');
  }
  function save() {
    if (!text.trim()) { setError('请写下希望记住的具体信息。'); return; }
    const now = new Date();
    const change = (current: AppData) => {
      if (existing) return reviewPersonMemory(current, existing.id, 'correct', text, editor?.fingerprint, scenario);
      const saved = savePersonMemory(current, { personId: person.id, kind, text, scenario, now });
      return saved.error || !saved.id ? saved : reviewPersonMemory(saved.data, saved.id, 'confirm');
    };
    apply(change, '已记住，仅在你选用这位人物时使用');
  }

  return <section className="stack person-memory-panel">
    <SectionTitle action="添加" onAction={() => open()}>关于{person.name}的记忆</SectionTitle>
    <p className="meta">你的私人记录。姓名相同的人物分别保存，身份卡共享不包含这些内容。</p>
    <Tabs items={['已记住', '待确认', '已停用']} value={tab} onChange={value => { setTab(value); setError(''); }}/>
    {!editor && !removing && error && <p role="alert" className="error-text">{error}</p>}
    {tab === '待确认' && <><p className="meta">从已核对为这位人物的原话中整理，先确认再使用。</p><Button tone="secondary" onClick={() => { update(current => collectPersonMemoryCandidates(current, person.id)); toast('已检查当前可用的明确表达'); }}>整理已核对原话</Button></>}
    {shown.map(item => <Card key={item.id}>
      <div className="ms-card-heading"><Badge tone={item.status === 'pending' ? 'orange' : 'gray'}>{PERSON_MEMORY_KINDS[item.kind]}</Badge><span className="meta">{item.scenario}</span></div>
      <p className="personal-assistant-copy">{item.text || '原始依据或人物已变化，旧内容已隐藏。'}</p>
      <p className="meta">{item.origin === 'quote' ? '已核对的对方原话 · 本人整理' : '我的私人记录 · 本人填写'}{item.stale ? ' · 需要重新核对' : item.status === 'pending' ? ' · 等你确认' : item.status === 'rejected' ? ' · 已忽略' : item.status === 'disabled' ? ' · 已停用' : ' · 已确认'}</p>
      {item.sources.filter(source => source.kind === 'session').map((source, index) => <Source key={index} title={data.sessions.find(session => session.id === source.id)?.title || '查看原话'} time={source.sourceTime} onClick={() => navigate({ view: 'session-transcript', id: source.id, mode: source.sourceId })}/>)}
      {!item.stale && item.status === 'pending' && <div className="action-grid"><Button onClick={() => apply(current => reviewPersonMemory(current, item.id, 'confirm', undefined, item.fingerprint), '已确认并记住')}>确认记住</Button><Button tone="secondary" onClick={() => open(item)}>修改</Button><Button tone="quiet" onClick={() => apply(current => reviewPersonMemory(current, item.id, 'reject', undefined, item.fingerprint), '已忽略，相同原话不会重复提出')}>不记住</Button></div>}
      {!item.stale && item.status === 'confirmed' && <div className="action-grid"><Button tone="quiet" onClick={() => open(item)}>修改</Button><Button tone="quiet" onClick={() => apply(current => reviewPersonMemory(current, item.id, 'disable', undefined, item.fingerprint), '已停用，之后不再使用')}>停用</Button></div>}
      <Button tone="quiet" onClick={() => { setRemoving(item); setError(''); }}>删除这条记忆</Button>
    </Card>)}
    {!shown.length && <Empty title={tab === '待确认' ? '暂无待确认的新信息' : tab === '已停用' ? '没有停用的记忆' : '记住下次沟通需要的事'} body={tab === '已记住' ? '例如对方负责的事、沟通偏好，或你们约好的下一步。' : '人物信息由你确认，可以随时纠正。'}/>}
    {tab !== '待确认' && pending.length > 0 && <Button tone="secondary" onClick={() => setTab('待确认')}>{pending.length} 条新信息等你确认</Button>}
    <Button tone="secondary" icon="chat-circle-text" onClick={() => navigate({ view: 'assistant', id: person.id })}>准备与{person.name}的沟通</Button>
    <Sheet open={!!editor} onClose={() => { setEditor(undefined); setError(''); }} title={existing ? '修改人物记忆' : '记下一条人物信息'}>
      <p className="meta">{person.name} · {person.company || person.role || '人物卡'} · {person.id}</p>
      {!existing && <SelectField label="记住哪类信息" value={PERSON_MEMORY_KINDS[kind]} options={Object.values(PERSON_MEMORY_KINDS)} onChange={value => setKind((Object.keys(PERSON_MEMORY_KINDS) as PersonMemory['kind'][]).find(key => PERSON_MEMORY_KINDS[key] === value) || 'background')}/>}
      <Field label="具体内容" value={text} onChange={setText} multiline placeholder="例如：我答应周五前把预算明细发给对方"/>
      <SelectField label="适用场景" value={scenario} options={PERSONAL_SCENARIOS} onChange={value => setScenario(value as PersonalScenario)}/>
      {error && <p role="alert" className="error-text">{error}</p>}
      <Notice>{existing?.origin === 'quote' ? '保留原话依据；改写内容由你核对，来源变化后需重新确认。' : '这是你填写并确认的私人记录，不代表对方亲口说过。约定不会自动创建任务或发送消息。'}</Notice>
      <Button onClick={save}>确认并记住</Button>
    </Sheet>
    <Sheet open={!!removing} onClose={() => { setRemoving(undefined); setError(''); }} title="删除这条人物记忆？"><p>之后的问答和草稿不再使用，已引用的旧回答需重新核对。</p>{error && <p role="alert" className="error-text">{error}</p>}<Button tone="danger" onClick={() => { if (removing) apply(current => deletePersonMemory(current, removing.id, removing.fingerprint), '已删除这条人物记忆'); }}>确认删除</Button></Sheet>
  </section>;
}
