import { useEffect, useState } from 'react';
import { useOops, type AppData, type Session } from '../store';
import { useKeyboardInsets } from '../mobile';
import { Badge, Button, Card, Check, Field, Icon, Notice, Row, SelectField, Sheet, Source } from '../ui';
import { sessionVisible } from './Home';
import { invalidateSessionSources } from '../sourceAccess';
import { preferredSaveScope, retainedTranscript, type SaveScope } from '../recordingLogic';
import './RecordingControls.css';

type RecordMark = { id: string; time: string; note?: string; sourceTime?: string; sourceId?: string };
type EndRequest = { id: string; resume: boolean };
type EndSnapshot = { session: Session; marks: RecordMark[]; space: string };
const markKey = (id: string) => 'record-marks:' + id;
function readMarks(data: AppData, id: string): RecordMark[] {
  try {
    const value: unknown = JSON.parse(data.settings.retention[markKey(id)] || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((m): m is RecordMark => !!m && typeof m === 'object' && typeof m.id === 'string' && typeof m.time === 'string');
  } catch { return []; }
}
function writeMarks(data: AppData, id: string, marks: RecordMark[]): AppData {
  return { ...data, settings: { ...data.settings, retention: { ...data.settings.retention, [markKey(id)]: JSON.stringify(marks) } } };
}
function snapshotOf(data: AppData, id: string): EndSnapshot | undefined {
  const s = data.sessions.find(x => x.id === id);
  if (!s) return undefined;
  return { session: { ...s, transcript: s.transcript.map(t => ({ ...t })), privateNotes: [...s.privateNotes], summary: [...s.summary], participants: [...s.participants], agenda: [...s.agenda], attachments: [...s.attachments] }, marks: readMarks(data, id).map(m => ({ ...m })), space: data.settings.space };
}

export function RecordingControls() {
  const { data, update, navigate, toast, requestEnd } = useOops();
  const { isKeyboardVisible } = useKeyboardInsets();
  const session = data.sessions.find(s => s.id === data.activeSessionId && !s.archived && ['进行中', '暂停'].includes(s.status));
  const visible = !!session && sessionVisible(data, session.id);
  const [editing, setEditing] = useState<{ sessionId: string; markId: string; note: string } | null>(null);
  const [showMarks, setShowMarks] = useState(false);
  useEffect(() => { if (!visible || editing && editing.sessionId !== session?.id) { setEditing(null); setShowMarks(false); } }, [visible, session?.id, editing?.sessionId]);
  const marks = session && visible ? readMarks(data, session.id) : [];
  const selected = editing ? marks.find(m => m.id === editing.markId) : undefined;
  const source = selected ? session?.transcript.find(t => t.id === selected.sourceId && !t.private) : undefined;
  function togglePause() {
    if (!session || !visible) return;
    const resume = session.status === '暂停';
    update(current => {
      const latest = current.sessions.find(s => s.id === session.id);
      if (!latest || !sessionVisible(current, latest.id) || current.activeSessionId !== latest.id || !['进行中', '暂停'].includes(latest.status)) return current;
      return { ...current, sessions: current.sessions.map(s => s.id === latest.id ? { ...s, status: resume ? '进行中' : '暂停' } : s) };
    });
    toast(resume ? '继续当前示例记录' : '记录已暂停，助手任务保持原状态');
  }
  function markNow() {
    if (!session || !visible) return;
    const recent = session.transcript.filter(t => !t.private).at(-1);
    const time = session.duration || '00:00';
    const existing = marks.find(m => m.time === time && m.sourceId === recent?.id);
    const mark: RecordMark = existing || { id: `mark-${session.id}-${time}-${recent?.id || 'point'}`, time, ...(recent ? { sourceTime: recent.time, sourceId: recent.id } : {}) };
    update(current => {
      const latest = current.sessions.find(s => s.id === session.id);
      if (!latest || current.activeSessionId !== latest.id || !sessionVisible(current, latest.id) || !['进行中', '暂停'].includes(latest.status)) return current;
      const previous = readMarks(current, latest.id);
      return previous.some(m => m.id === mark.id) ? current : writeMarks(current, latest.id, [...previous, mark]);
    });
    setShowMarks(false);
    setEditing({ sessionId: session.id, markId: mark.id, note: mark.note || '' });
    toast(existing ? '这个时间点已经标记' : `已标记 ${time}${recent ? '' : '，暂无转写来源'}`);
  }
  function saveNote() {
    if (!editing || !session || !visible || !selected) return;
    update(current => writeMarks(current, editing.sessionId, readMarks(current, editing.sessionId).map(m => m.id === editing.markId ? { ...m, note: editing.note.trim() || undefined } : m)));
    setEditing(null); toast('重点备注已保存');
  }
  function deleteMark() {
    if (!editing || !visible) return;
    update(current => writeMarks(current, editing.sessionId, readMarks(current, editing.sessionId).filter(m => m.id !== editing.markId)));
    setEditing(null); toast('已删除这个重点');
  }
  return <>
    {session && visible && !isKeyboardVisible && <aside className="recording-controls" aria-label="当前记录控制">
      <div className="rc-heading"><span className={`rc-dot ${session.status === '暂停' ? 'paused' : ''}`} /><div className="rc-session"><strong>{session.title}</strong><span>{session.status === '暂停' ? '已暂停' : '示例记录中'} · <time>{session.duration || '00:00'}</time></span></div><button className="rc-scene" onClick={() => navigate({ view: 'session-detail', id: session.id, mode: '现场' })}>现场<Icon name="caret-right" size={13} /></button></div>
      <div className="rc-actions"><button onClick={togglePause}><Icon name={session.status === '暂停' ? 'play' : 'pause'} size={19} /><span>{session.status === '暂停' ? '继续' : '暂停'}</span></button><button onClick={markNow}><Icon name="bookmark-simple" size={19} /><span>标记重点</span></button><button className="rc-end" onClick={() => requestEnd(session.id)}><Icon name="stop" size={19} /><span>结束</span></button></div>
      {!!marks.length && <button className="rc-mark-count" onClick={() => setShowMarks(true)}>{marks.length} 个重点<Icon name="caret-right" size={11} /></button>}
    </aside>}
    <Sheet open={!!editing && visible && !!selected} onClose={() => setEditing(null)} title="记下这个重点">
      <Card><Badge>时间点 · {selected?.time}</Badge><h3>{session?.title}</h3>{source ? <><p>{source.speaker}：{source.text}</p><Source title="对应原话" time={source.time} onClick={() => { setEditing(null); navigate({ view: 'session-transcript', id: session?.id, mode: source.id }); }} /></> : <p className="meta">保留时间点，没有关联转写来源。</p>}</Card>
      <Field label="备注（可选）" value={editing?.note || ''} onChange={note => setEditing(current => current ? { ...current, note } : null)} placeholder="刚才有什么需要记住？" multiline />
      <Button onClick={saveNote}>保存重点</Button><Button tone="danger" onClick={deleteMark}>删除这个重点</Button><Button tone="quiet" onClick={() => setEditing(null)}>取消修改</Button>
    </Sheet>
    <Sheet open={showMarks && visible} onClose={() => setShowMarks(false)} title="已标记的重点">
      <Card>{marks.map(m => <Row key={m.id} title={m.note || '未添加备注'} subtitle={`${m.time}${m.sourceId ? ' · 已关联原话' : ' · 时间点'}`} icon="bookmark-simple" onClick={() => { setShowMarks(false); setEditing({ sessionId: session!.id, markId: m.id, note: m.note || '' }); }} />)}</Card>
      <Button tone="quiet" onClick={() => setShowMarks(false)}>返回记录</Button>
    </Sheet>
  </>;
}

export function EndRecordingSheet({ request, onClose }: { request: EndRequest | null; onClose: () => void }) {
  return request ? <EndRecordingDialog key={`${request.id}:${request.resume}`} request={request} onClose={onClose} /> : null;
}

function EndRecordingDialog({ request, onClose }: { request: EndRequest; onClose: () => void }) {
  const { data, update, navigate, toast } = useOops();
  const [snapshot] = useState(() => snapshotOf(data, request.id));
  const [scope, setScope] = useState<SaveScope>(() => preferredSaveScope(data, request.id));
  const [keptIds, setKeptIds] = useState<string[]>(() => preferredSaveScope(data, request.id) === '手动选择片段' ? [] : snapshot?.session.transcript.map(t => t.id) || []);
  const [keptNotes, setKeptNotes] = useState<number[]>(() => snapshot?.session.privateNotes.map((_, i) => i) || []);
  const [error, setError] = useState('');
  const current = data.sessions.find(s => s.id === request.id);
  const allowed = !!snapshot && !!current && !current.archived && sessionVisible(data, current.id);
  const team = data.settings.space !== '我的空间';
  const transcripts = snapshot?.session.transcript || [];
  const retained = retainedTranscript(transcripts, scope, keptIds);
  const removed = transcripts.filter(t => !retained.some(k => k.id === t.id));
  function cancel() {
    const willResume = request.resume && allowed && current?.status === '暂停' && data.activeSessionId === request.id;
    update(latest => {
      const retention = { ...latest.settings.retention };
      delete retention['record-next-kind'];
      const s = latest.sessions.find(x => x.id === request.id);
      const resume = request.resume && s?.status === '暂停' && latest.activeSessionId === s.id && sessionVisible(latest, s.id);
      return { ...latest, settings: { ...latest.settings, retention }, sessions: resume ? latest.sessions.map(x => x.id === s.id ? { ...x, status: '进行中' } : x) : latest.sessions };
    });
    onClose();
    toast(willResume ? '已取消结束，继续当前记录' : '已取消结束，记录保持原状态');
  }
  function finish() {
    if (!snapshot || !current || !allowed) { setError('这段记录不在当前空间，请切回原空间检查。'); return; }
    if (current.status === '已结束') { onClose(); navigate({ view: 'session-detail', id: current.id, mode: '复盘' }); return; }
    if (current.status !== '暂停' || data.activeSessionId !== current.id) { setError('先暂停这段记录，再检查保存范围。'); return; }
    if (JSON.stringify(current.transcript) !== JSON.stringify(transcripts) || JSON.stringify(current.privateNotes) !== JSON.stringify(snapshot.session.privateNotes)) { setError('内容发生了变化，请取消后重新检查。'); return; }
    const notes = snapshot.session.privateNotes.filter((_, i) => keptNotes.includes(i));
    const removedTimes = new Set(removed.map(t => t.time)), removedIds = new Set(removed.map(t => t.id));
    const nextKind = data.settings.retention['record-next-kind'];
    const creatingNext = ['会议', '日常', '灵感', '练习'].includes(nextKind);
    update(latest => {
      const live = latest.sessions.find(s => s.id === current.id);
      if (!live || live.status !== '暂停' || latest.activeSessionId !== live.id || !sessionVisible(latest, live.id)) return latest;
      if (JSON.stringify(live.transcript) !== JSON.stringify(transcripts) || JSON.stringify(live.privateNotes) !== JSON.stringify(snapshot.session.privateNotes)) return latest;
      const reviewed = removed.length ? invalidateSessionSources(latest, live.id, [...removedIds], '结束时原话未保留') : latest;
      const marks = snapshot.marks.map(m => (m.sourceId ? removedIds.has(m.sourceId) : !!m.sourceTime && removedTimes.has(m.sourceTime)) ? { id: m.id, time: m.time, ...(m.note ? { note: m.note } : {}) } : m);
      const affectedTasks = reviewed.tasks.filter((t, index) => t !== latest.tasks[index]);
      const retention = { ...reviewed.settings.retention };
      delete retention['record-next-kind'];
      return { ...reviewed,
        sessions: latest.sessions.map(s => s.id === live.id ? { ...s, status: '已结束', transcript: retained.map(t => ({ ...t })), privateNotes: notes, summary: retained.slice(-5).map(t => `原话摘录 · ${t.time} ${t.speaker}：${t.text}`) } : s),
        activeSessionId: undefined,
        settings: { ...reviewed.settings, retention: { ...retention,
          [markKey(live.id)]: JSON.stringify(marks),
          ['session-' + live.id]: scope,
          ['record-end:' + live.id]: JSON.stringify({ endedAt: new Date().toISOString(), scope, total: transcripts.length, retained: retained.length, retainedIds: retained.map(t => t.id), notesTotal: snapshot.session.privateNotes.length, notesRetained: notes.length, reviewTaskIds: affectedTasks.map(t => t.id) }),
        } },
      };
    });
    onClose(); toast('记录已结束，原话摘录与保留内容已保存'); navigate(creatingNext ? { view: 'session-mode', mode: nextKind } : { view: 'session-detail', id: current.id, mode: '复盘' });
  }
  if (!allowed || !snapshot) return <Sheet open onClose={cancel} title="结束记录"><Notice>当前空间无法查看这段记录，切回原空间后再检查保存范围。</Notice><Button tone="secondary" onClick={cancel}>返回</Button></Sheet>;
  return <Sheet open onClose={cancel} title="结束前，确认留下什么">
    <div className="rc-end-heading"><div><h3>{snapshot.session.title}</h3><p className="meta">已暂停在 {snapshot.session.duration || '00:00'}</p></div><Badge tone="gray">保存范围</Badge></div>
    <SelectField label="原话片段" value={scope} onChange={value => setScope(value as SaveScope)} options={['完整保存', '仅保存非敏感片段', '手动选择片段']} />
    {scope === '手动选择片段' && <p className="meta">已沿用这段记录的保存偏好，请选择需要留下的原话。</p>}
    <div className="rc-retention-counts"><div><strong>{retained.length}<small> / {transcripts.length}</small></strong><span>保留原话片段</span></div><div><strong>{keptNotes.length}<small> / {snapshot.session.privateNotes.length}</small></strong><span>保留私人便签</span></div></div>
    {scope === '手动选择片段' && <Card className="rc-selection"><h3>勾选需要保留的原话</h3>{transcripts.length ? transcripts.map(t => <Check key={t.id} label={`${t.time} · ${t.private && team ? '私人片段（内容仅自己可见）' : `${t.speaker}：${t.text}`}${t.private ? ' · 私有' : ''}`} value={keptIds.includes(t.id)} onChange={value => setKeptIds(ids => value ? [...new Set([...ids, t.id])] : ids.filter(id => id !== t.id))} />) : <p className="meta">本次还没有转写片段。</p>}</Card>}
    {!!snapshot.session.privateNotes.length && <Card className="rc-selection"><h3>私人便签单独选择</h3>{snapshot.session.privateNotes.map((note, i) => <Check key={i} label={team ? `私人便签 ${i + 1}（仅自己可见）` : note} value={keptNotes.includes(i)} onChange={value => setKeptNotes(ids => value ? [...new Set([...ids, i])] : ids.filter(id => id !== i))} />)}<p className="meta">不会因为只保留非敏感原话而自动删除便签。</p></Card>}
    {removed.length > 0 && <Notice tone="warning">{removed.length} 段原话将不保留。关联记忆、任务与旧成果会标记待复核并限制本人查看；原成果和历史回执保留，助手执行授权撤回。</Notice>}
    {!retained.length && <Notice>没有选择原话片段，将保留记录信息与勾选的便签。</Notice>}
    <p className="meta rc-end-note">复盘仅整理保留的原话摘录，不会自动确认事实、任务责任或长期记忆。</p>
    {error && <p className="error-text" role="alert">{error}</p>}
    <Button onClick={finish} icon="check">确认结束并保存</Button><Button tone="secondary" onClick={cancel}>{request.resume ? '取消，继续记录' : '取消，保持暂停'}</Button>
  </Sheet>;
}
