import { useEffect, useRef, useState } from 'react';
import { useOops, type Task } from '../store';
import { taskSourceAvailable } from '../sourceAccess';
import { Badge, Button, Card, Check, Empty, Field, Notice, Row, SectionTitle, Sheet, Tabs } from '../ui';
import { isLocalRaftConnectionAllowed } from './RaftConnection';

type Member = { id: string; name: string; handle: string; type: 'agent' | 'human' };
type Group = { id: string; name: string; target: string; members: Member[]; url?: string; bridge_agent_id?: string; updated_at?: string };
type TaskRef = { kind: 'prototype'; id: string; version: number; space_key: string };
type Reply = { reply_id: string; text: string; sender: string; created_at?: string };
type Review = { id: string; request_id?: string; reply_id: string; kind: 'progress' | 'artifact'; text: string; created_at?: string };
type Communication = { request_id: string; text: string; status: string; raft_message_id?: string; error?: string };
type Thread = {
  id: string; request_id: string; title: string; brief: string; participant_ids: string[]; group_id: string;
  task_ref?: TaskRef; status: string; raft_message_id?: string; error?: string;
  replies: Reply[]; reviews: Review[]; communications: Communication[]; created_at?: string; demo?: boolean;
};
type ReviewDraft = { thread: Thread; reply: Reply; kind: 'progress' | 'artifact'; text: string };
type Snapshot = { group: Group | null; group_status: string; group_version: string | number; group_error: string; items: Thread[]; bridge_online: boolean };
type Operation = { controller: AbortController; generation: number; base: string; token: string };
type Pending = { path: string; body: Record<string, unknown> & { request_id: string }; signature: string; state: 'unknown' | 'retryable' | 'known' };
const LOCAL_SERVICE = 'http://127.0.0.1:8798';
const COLLABORATION = '/v1/raft/collaboration';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function groupUrl(value: unknown, id: string): string | undefined {
  if (typeof value !== 'string' || !UUID.test(id)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['app.raft.build', 'app.slock.ai'].includes(url.hostname) || url.port
      || url.username || url.password || url.search || url.hash
      || !/^\/s\/[^/]+\/channel\/[a-f0-9-]+$/i.test(url.pathname)
      || !url.pathname.toLowerCase().endsWith('/channel/' + id.toLowerCase())) return undefined;
    return url.href;
  } catch { return undefined; }
}

const DEMO_GROUP: Group = {
  id: 'demo-oops-group', name: 'Oops 协作群（演示）', target: '页面内存演示',
  members: [
    { id: 'demo-research', name: '资料助手（演示）', handle: 'research-demo', type: 'agent' },
    { id: 'demo-writing', name: '写作助手（演示）', handle: 'writing-demo', type: 'agent' },
    { id: 'demo-review', name: '核对助手（演示）', handle: 'review-demo', type: 'agent' },
  ],
};
const uid = (prefix: string) => prefix + '-' + crypto.randomUUID();
const stamp = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const labels: Record<string, string> = {
  queued: '等待发送', dispatching: '正在发送', sent: 'Raft 已接收', unknown: '送达未知',
  preparing: '等待后端登记', unavailable: '发送回执暂不可读',
  failed: '发送失败', cancelled: '已取消', replied: '收到回复', demo_queued: '演示 · 待发送',
  demo_sent: '演示 · 已送达', demo_replied: '演示 · 收到回复',
};

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务回包不完整，请重新读取。');
  return value as Record<string, unknown>;
}
function string(value: unknown, required = false): string {
  if (typeof value !== 'string') { if (required) throw new Error('服务回包缺少可核对的标识或正文。'); return ''; }
  return value;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('服务未返回可核对的列表。'); return value; }
function threadResult(value: unknown): Thread {
  const item = object(value);
  const reference = item.local_task_ref ? object(item.local_task_ref) : null;
  const replies = array(item.replies ?? []).map(value => { const reply = object(value); return { reply_id: string(reply.reply_id, true), text: string(reply.text, true), sender: string(reply.sender) || 'Raft', created_at: string(reply.created_at) }; });
  const reviews = array(item.reviews ?? []).map(value => { const review = object(value); if (!['progress', 'artifact'].includes(String(review.kind))) throw new Error('核对记录类别无效。'); return { id: string(review.id) || string(review.request_id, true), request_id: string(review.request_id), reply_id: string(review.reply_id, true), kind: review.kind as Review['kind'], text: string(review.note), created_at: string(review.confirmed_at) || string(review.created_at) }; });
  const communications = array(item.communications ?? []).map(value => { const message = object(value); return { request_id: string(message.request_id, true), text: string(message.text), status: string(message.status, true), raft_message_id: string(message.raft_message_id), error: string(message.transport_error) || string(message.last_error) || string(message.error) }; });
  return { id: string(item.id, true), request_id: string(item.request_id, true), title: string(item.title, true), brief: string(item.text, true), group_id: string(item.group_channel_id, true),
    participant_ids: array(item.member_ids).map(id => string(id, true)), status: string(item.status, true), raft_message_id: string(item.raft_message_id),
    error: string(item.transport_error) || string(item.last_error) || string(item.error), replies, reviews, communications, created_at: string(item.created_at),
    ...(reference ? { task_ref: { kind: 'prototype' as const, id: string(reference.id, true), version: typeof reference.version === 'number' ? reference.version : 0, space_key: string(reference.space_key, true) } } : {}) };
}
function snapshotResult(value: unknown): Snapshot {
  const result = object(value); const rawStatus = string(result.group_status, true);
  const groupStatus = rawStatus === 'available' ? 'ready' : result.group_error === 'GROUP_READ_EXPIRED' ? 'expired' : rawStatus;
  const source = result.group ? object(result.group) : null;
  const group: Group | null = source ? { id: string(source.id, true), name: string(source.name) || 'Oops 共用协作群', target: string(source.target), url: groupUrl(source.url, string(source.id, true)), bridge_agent_id: string(source.bridge_agent_id), updated_at: string(source.read_at) || string(source.updated_at),
    members: array(source.members ?? []).map(value => { const member = object(value); if (!['agent', 'human', 'user'].includes(String(member.type))) throw new Error('群成员类型缺失，不能确定派工范围。'); return { id: string(member.id, true), name: string(member.name) || string(member.handle) || '未提供显示名', handle: string(member.handle, member.type === 'agent'), type: member.type === 'agent' ? 'agent' as const : 'human' as const }; }) } : null;
  if (groupStatus === 'ready' && (!group || !['string', 'number'].includes(typeof result.group_version))) throw new Error('群快照或版本缺失，暂停派工。');
  return { group, group_status: groupStatus, group_version: typeof result.group_version === 'number' ? result.group_version : string(result.group_version), group_error: string(result.group_error), items: array(result.items ?? []).map(threadResult), bridge_online: result.bridge_online === true };
}
function endpoint(value: string): string {
  let url: URL; try { url = new URL(value.trim()); } catch { throw new Error('填写完整的后端服务地址。'); }
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('服务地址须为 HTTPS 或本机 HTTP，不能包含凭据或查询参数。');
  return url.href.replace(/\/+$/, '');
}
function safeError(error: unknown, token = ''): string {
  const text = error instanceof Error ? error.message : '请求失败，请读取原回执。';
  return (token ? text.split(token).join('[凭据已隐藏]') : text).slice(0, 500);
}

export function RaftCollaboration({ task }: { task?: Task }) {
  const { data, navigate } = useOops();
  const liveAllowed = isLocalRaftConnectionAllowed();
  const [mode, setMode] = useState<'live' | 'demo'>(liveAllowed ? 'live' : 'demo');
  const [base, setBase] = useState(LOCAL_SERVICE);
  const [token, setToken] = useState('');
  const [group, setGroup] = useState<Group | null>(null);
  const [groupStatus, setGroupStatus] = useState('not_connected');
  const [groupError, setGroupError] = useState('');
  const [groupVersion, setGroupVersion] = useState<string | number>('');
  const [bridgeOnline, setBridgeOnline] = useState(false);
  const [liveThreads, setLiveThreads] = useState<Thread[]>([]);
  const [demoThreads, setDemoThreads] = useState<Thread[]>([]);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [participants, setParticipants] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [followMembers, setFollowMembers] = useState<string[]>([]);
  const [followConfirmed, setFollowConfirmed] = useState(false);
  const [review, setReview] = useState<ReviewDraft | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const secret = useRef('');
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const pendingRef = useRef<Pending | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [unknown, setUnknown] = useState<Pending[]>([]);
  const draftValues = useRef({ title, brief, participants, followUp, followMembers, selectedId, review });
  draftValues.current = { title, brief, participants, followUp, followMembers, selectedId, review };
  const currentTaskRef: TaskRef | undefined = task ? { kind: 'prototype', id: task.id, version: task.version, space_key: data.settings.space } : undefined;
  const contextKey = JSON.stringify([mode, task?.id, task?.version, data.settings.space]);

  useEffect(() => {
    active.current = null; secret.current = ''; busyRef.current = false; pendingRef.current = null;
    setBusy(''); setToken(''); setGroup(null); setGroupStatus('not_connected'); setGroupError(''); setGroupVersion(''); setBridgeOnline(false); setLiveThreads([]); setError(''); setNotice(''); setPending(null); setUnknown([]);
    setTitle(''); setBrief(''); setParticipants([]); setConfirmed(false);
    setSelectedId(''); setFollowUp(''); setFollowMembers([]); setFollowConfirmed(false); setReview(null); setReviewConfirmed(false);
    return () => {
      generation.current += 1; active.current?.abort(); active.current = null; secret.current = ''; busyRef.current = false; pendingRef.current = null;
    };
  }, [contextKey]);

  const demo = mode === 'demo' || !liveAllowed;
  const visibleGroup = demo ? DEMO_GROUP : group;
  const members = visibleGroup?.members.filter(member => member.type === 'agent' && member.id !== visibleGroup.bridge_agent_id) || [];
  const threads = (demo ? demoThreads : liveThreads).filter(item => !task || item.task_ref?.id === task.id && item.task_ref.space_key === data.settings.space);
  const selected = threads.find(item => item.id === selectedId);
  const closed = (value: Task | undefined) => !!value && ['已完成', '已取消', '已拒绝'].includes(value.status);
  const invalidSource = (value: Task | undefined) => !!value && (!!value.sourceNeedsReview || !taskSourceAvailable(data, value));
  const taskClosed = closed(task);
  const taskSourceInvalid = invalidSource(task);
  const taskBlocked = taskClosed || taskSourceInvalid;
  const selectedTask = task || (selected?.task_ref && selected.task_ref.space_key === data.settings.space ? data.tasks.find(value => value.id === selected.task_ref?.id) : undefined);
  const selectedClosed = closed(selectedTask);
  const selectedSourceInvalid = invalidSource(selectedTask) || !!selected?.task_ref && !selectedTask;
  const selectedBlocked = taskBlocked || selectedClosed || selectedSourceInvalid;
  useEffect(() => { setConfirmed(false); setFollowConfirmed(false); setReviewConfirmed(false); }, [groupVersion, task?.version, taskBlocked, selectedBlocked]);
  const draftValid = !!title.trim() && title.trim().length <= 160 && !!brief.trim() && brief.length <= 12000
    && participants.length > 0 && participants.length <= 16 && participants.every(id => members.some(member => member.id === id));

  function remember(value: Pending | null) { pendingRef.current = value; setPending(value); }
  function edit(change: () => void) { change(); setConfirmed(false); remember(null); setError(''); setNotice(''); }
  function updateDemoThread(id: string, change: (item: Thread) => Thread) {
    setDemoThreads(items => items.map(item => item.id === id ? change(item) : item));
  }
  function chooseThread(id: string) {
    setSelectedId(id); setFollowUp(''); setFollowMembers([]); setFollowConfirmed(false); setReview(null); setReviewConfirmed(false); remember(null); setError(''); setNotice('');
  }
  function createDemo() {
    if (!demo || !draftValid || !confirmed || taskBlocked) return;
    const thread: Thread = { id: uid('demo-thread'), request_id: uid('demo-request'), title: title.trim(), brief: brief.trim(), group_id: DEMO_GROUP.id,
      participant_ids: [...participants], task_ref: currentTaskRef, status: 'demo_queued', replies: [], reviews: [], communications: [], created_at: stamp(), demo: true };
    setDemoThreads(items => [thread, ...items]); chooseThread(thread.id); setConfirmed(false);
    setTitle(''); setBrief(''); setParticipants([]); setNotice('已创建页面内的演示线程。');
  }
  function simulateDelivery() {
    if (!demo || !selected || selectedClosed || selected.status !== 'demo_queued') return;
    updateDemoThread(selected.id, item => ({ ...item, status: 'demo_sent' }));
    setNotice('已切到演示送达状态，没有向 Raft 发送。');
  }
  function simulateReply() {
    if (!demo || !selected || selectedClosed || !['demo_sent', 'demo_replied'].includes(selected.status)) return;
    const reply: Reply = { reply_id: uid('demo-reply'), sender: DEMO_GROUP.members.find(member => selected.participant_ids.includes(member.id))?.name || '演示助手',
      text: '演示回复：我已收到这份简报。具体工作与成果仍等待核对，这段文字不代表已经执行。', created_at: stamp() };
    updateDemoThread(selected.id, item => ({ ...item, status: 'demo_replied', replies: [...item.replies, reply] }));
  }
  function sendDemoFollowUp() {
    if (!demo || !selected || selectedBlocked || !followConfirmed || !followUp.trim() || followUp.length > 12000 || !followMembers.length || followMembers.length > 16) return;
    const message: Communication = { request_id: uid('demo-followup'), text: followUp.trim(), status: 'demo_sent' };
    updateDemoThread(selected.id, item => ({ ...item, communications: [...item.communications, message] }));
    setFollowUp(''); setFollowMembers([]); setFollowConfirmed(false); setNotice('补充内容已留在本页演示线程。');
  }
  function openReview(item: Thread, reply: Reply, kind: ReviewDraft['kind']) {
    if (selectedBlocked) return;
    setReview({ thread: item, reply, kind, text: reply.text.length <= 1000 ? reply.text : '' }); setReviewConfirmed(false); remember(null);
  }
  function saveDemoReview() {
    if (!demo || !review || selectedBlocked || !reviewConfirmed || !review.text.trim() || review.text.length > 1000) return;
    const value: Review = { id: uid('demo-review'), reply_id: review.reply.reply_id, kind: review.kind, text: review.text.trim(), created_at: stamp() };
    updateDemoThread(review.thread.id, item => ({ ...item, reviews: [...item.reviews, value] }));
    setReview(null); setReviewConfirmed(false); setNotice('已保存演示核对记录；任务状态保持原样。');
  }
  function resetConnection() {
    generation.current += 1; active.current?.abort(); active.current = null; busyRef.current = false; secret.current = '';
    setToken(''); setBusy(''); setGroup(null); setGroupStatus('not_connected'); setGroupError(''); setGroupVersion(''); setBridgeOnline(false);
    setLiveThreads([]); setParticipants([]); setFollowMembers([]); setConfirmed(false); setFollowConfirmed(false);
    setReview(null); setReviewConfirmed(false); setSelectedId(''); setUnknown([]); remember(null); setError(''); setNotice('');
  }
  function start(label: string, session = false): Operation | null {
    if (demo || !liveAllowed || busyRef.current) return null;
    try {
      const service = endpoint(base);
      if (session && service !== LOCAL_SERVICE) throw new Error('快捷连接仅适用于默认的本机协作服务。');
      if (!session && !secret.current) throw new Error('先连接协作服务。');
      const controller = new AbortController(); active.current = controller; busyRef.current = true; setBusy(label); setError(''); setNotice('');
      return { controller, generation: generation.current, base: service, token: session ? '' : secret.current };
    } catch (failure) { setError(safeError(failure, secret.current)); return null; }
  }
  function current(operation: Operation) { return operation.generation === generation.current && active.current === operation.controller; }
  function finish(operation: Operation) { if (current(operation)) { active.current = null; busyRef.current = false; setBusy(''); } }
  async function api(operation: Operation, path: string, body?: unknown): Promise<unknown> {
    const timer = window.setTimeout(() => operation.controller.abort(), 15000);
    try {
      const response = await fetch(operation.base + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: operation.controller.signal,
        headers: { ...(operation.token ? { Authorization: 'Bearer ' + operation.token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value: unknown = await response.json();
      if (!response.ok) { const detail = object(value); const nested = detail.error && typeof detail.error === 'object' ? object(detail.error) : null; throw new Error(safeError(new Error(string(nested?.message) || string(detail.error) || `服务请求失败（${response.status}）。`), operation.token)); }
      return value;
    } finally { window.clearTimeout(timer); }
  }
  function applySnapshot(value: Snapshot) {
    setGroup(value.group); setGroupStatus(value.group_status); setGroupError(value.group_error); setGroupVersion(value.group_version); setBridgeOnline(value.bridge_online);
    setLiveThreads(value.items);
    const allowedIds = value.group?.members.filter(member => member.type === 'agent' && member.id !== value.group?.bridge_agent_id).map(member => member.id) || [];
    setParticipants(ids => ids.filter(id => allowedIds.includes(id))); setFollowMembers(ids => ids.filter(id => allowedIds.includes(id)));
    setConfirmed(false); setFollowConfirmed(false);
  }
  function merge(item: Thread) { setLiveThreads(items => [item, ...items.filter(value => value.id !== item.id)]); }
  function requestPresent(item: Thread, request: string) { return item.request_id === request || item.communications.some(value => value.request_id === request) || item.reviews.some(value => value.request_id === request); }
  async function connect(session: boolean) {
    const operation = start('连接中', session); if (!operation) return;
    setGroup(null); setGroupStatus('not_connected'); setGroupError(''); setLiveThreads([]);
    try {
      if (session) { const value = object(await api(operation, '/v1/raft/local-session')); if (!current(operation)) return; operation.token = string(value.token, true).trim(); if (!operation.token) throw new Error('本机消息服务没有返回有效会话。'); secret.current = operation.token; setToken(operation.token); }
      const snapshot = snapshotResult(await api(operation, COLLABORATION)); if (!current(operation)) return;
      applySnapshot(snapshot); setNotice(snapshot.group_status === 'ready' ? '已读取真实群成员与任务线程。' : '协作群尚未就绪，请先核对群配置与快照。');
    } catch (failure) { if (current(operation)) setError('协作连接失败，请核对服务及本机预览地址。' + safeError(failure, operation.token)); }
    finally { finish(operation); }
  }
  async function refresh() {
    const operation = start('读取回执'); if (!operation) return;
    try {
      const snapshot = snapshotResult(await api(operation, COLLABORATION)); if (!current(operation)) return; applySnapshot(snapshot);
      for (const action of unknown) {
        const value = object(await api(operation, COLLABORATION + '/handoffs?request_id=' + encodeURIComponent(action.body.request_id)));
        const found = array(value.items).map(threadResult); if (!current(operation)) return;
        if (found.length > 1 || found.some(item => !requestPresent(item, action.body.request_id))) throw new Error('服务未按原请求编号精确核对，暂不重发。');
        if (found[0]) {
          merge(found[0]);
          if (pendingRef.current?.body.request_id === action.body.request_id) {
            remember({ ...action, state: 'known' }); setNotice('原请求已登记，已恢复它的实际回执。');
            if (action.path === COLLABORATION + '/reviews') { setReview(null); setReviewConfirmed(false); }
          }
        }
        else if (pendingRef.current?.body.request_id === action.body.request_id) { remember({ ...action, state: 'retryable' }); setNotice('数据库未登记原请求。重新明确确认后，可使用同一编号手动重试。'); }
        setUnknown(items => items.filter(value => value.body.request_id !== action.body.request_id));
      }
      if (!unknown.length) setNotice('已读取当前线程、送达与回复记录。');
    } catch (failure) { if (current(operation)) { setGroup(null); setGroupStatus('unavailable'); setLiveThreads([]); setReview(null); setConfirmed(false); setFollowConfirmed(false); setError(safeError(failure, operation.token)); } }
    finally { finish(operation); }
  }
  async function submit(path: string, fields: Record<string, unknown>, confirmation: boolean): Promise<boolean> {
    if (!confirmation || groupStatus !== 'ready' || !group || unknown.length) return false;
    const signature = JSON.stringify([path, fields]);
    if (pendingRef.current?.signature === signature && pendingRef.current.state !== 'retryable') return false;
    const operation = start('提交中'); if (!operation) return false;
    const action: Pending = pendingRef.current?.signature === signature ? pendingRef.current : { path, signature, body: { ...fields, request_id: uid('oops-collaboration'), confirm: true }, state: 'unknown' };
    remember(action); setConfirmed(false); setFollowConfirmed(false); setReviewConfirmed(false);
    try {
      const item = threadResult(await api(operation, path, action.body)); if (!current(operation)) return false;
      if (!requestPresent(item, action.body.request_id)) throw new Error('回执没有本次请求编号，请先核对原请求。');
      merge(item); if (pendingRef.current?.body.request_id === action.body.request_id) remember({ ...action, state: 'known' });
      setUnknown(items => items.filter(value => value.body.request_id !== action.body.request_id)); setNotice('后端已登记本次请求；送达、执行与人工核对分别查看。'); return true;
    } catch (failure) { if (current(operation)) { if (pendingRef.current?.body.request_id === action.body.request_id) remember({ ...action, state: 'unknown' }); setUnknown(items => [...items.filter(value => value.body.request_id !== action.body.request_id), action]); setError('请求回执未知，先刷新核对原编号，不重复发送。' + safeError(failure, operation.token)); } return false; }
    finally { finish(operation); }
  }
  async function createLive() {
    if (!draftValid || !group || taskBlocked) return;
    const draft = JSON.stringify([title, brief, participants]);
    const saved = await submit(COLLABORATION + '/handoffs', { title: title.trim(), text: brief.trim(), group_channel_id: group.id, group_version: groupVersion, member_ids: [...participants], ...(currentTaskRef ? { local_task_ref: currentTaskRef } : {}) }, confirmed);
    if (saved && draft === JSON.stringify([draftValues.current.title, draftValues.current.brief, draftValues.current.participants])) { setTitle(''); setBrief(''); setParticipants([]); }
  }
  async function continueLive() {
    if (!selected || selectedBlocked || !followUp.trim() || followUp.length > 12000 || !followMembers.length || followMembers.length > 16 || followMembers.some(id => !members.some(member => member.id === id))) return;
    const draft = JSON.stringify([selected.id, followUp, followMembers]);
    const saved = await submit(COLLABORATION + '/continue', { handoff_id: selected.id, text: followUp.trim(), group_version: groupVersion, member_ids: [...followMembers] }, followConfirmed);
    if (saved && draft === JSON.stringify([draftValues.current.selectedId, draftValues.current.followUp, draftValues.current.followMembers])) { setFollowUp(''); setFollowMembers([]); }
  }
  async function reviewLive() {
    if (!review || selectedBlocked || !review.text.trim() || review.text.length > 1000) return;
    const draft = JSON.stringify([review.thread.id, review.reply.reply_id, review.kind, review.text]);
    const saved = await submit(COLLABORATION + '/reviews', { handoff_id: review.thread.id, reply_id: review.reply.reply_id, kind: review.kind, note: review.text.trim() }, reviewConfirmed);
    const latest = draftValues.current.review;
    if (saved && latest && draft === JSON.stringify([latest.thread.id, latest.reply.reply_id, latest.kind, latest.text])) { setReview(null); setReviewConfirmed(false); }
  }
  async function cancelLive(item: Thread) {
    if (item.status !== 'queued' || unknown.length || selectedClosed) return;
    const operation = start('取消中'); if (!operation) return;
    try { const value = threadResult(await api(operation, COLLABORATION + '/handoffs/' + encodeURIComponent(item.id) + '/cancel', { confirm: true })); if (!current(operation)) return; if (value.id !== item.id) throw new Error('取消回执不一致。'); merge(value); setNotice('取消回执：' + (labels[value.status] || value.status)); }
    catch (failure) { if (current(operation)) setError('取消结果未确认，请刷新原线程。' + safeError(failure, operation.token)); }
    finally { finish(operation); }
  }
  const liveReady = !!group && groupStatus === 'ready' && !unknown.length && pending?.state !== 'known';
  const followValid = !!followUp.trim() && followUp.length <= 12000 && followMembers.length > 0 && followMembers.length <= 16 && followMembers.every(id => members.some(member => member.id === id));
  const groupLabels: Record<string, string> = { not_connected: '尚未连接', ready: '群快照已就绪', unavailable: '群快照暂不可用', expired: '群快照已过期', not_configured: '共用群尚未配置' };
  const groupReasons: Record<string, string> = { GROUP_READ_EXPIRED: '刷新后重新核对当前群成员。', GROUP_NOT_JOINED: 'Oops 尚未加入这个共用群。', GROUP_ARCHIVED: '这个共用群已归档。', GROUP_READ_FAILED: '暂时无法读取真实群成员。', GROUP_ROSTER_UNAVAILABLE: '暂时无法核对群成员，恢复读取后再派工。' };
  let localService = false;
  try { localService = endpoint(base) === LOCAL_SERVICE; } catch { /* Keep invalid input editable. */ }
  const liveGroupUrl = !demo && liveAllowed ? group?.url : undefined;
  let threadUrl: string | undefined;
  if (liveGroupUrl && group && selected?.status === 'sent' && selected.group_id === group.id && UUID.test(selected.raft_message_id || '')) {
    const url = new URL(liveGroupUrl); url.searchParams.set('thread', group.id + ':' + selected.raft_message_id); threadUrl = url.href;
  }
  function openRaft(url: string | undefined) { if (!demo && liveAllowed && url) window.open(url, '_blank', 'noopener,noreferrer'); }

  return <div className="stack">
    {liveAllowed && <Tabs items={['本机协作', '协作演示']} value={demo ? '协作演示' : '本机协作'} onChange={value => setMode(value === '协作演示' ? 'demo' : 'live')} />}
    {demo && <Notice>协作演示 · 只在本页内存中运行，刷新后清空。成员、送达和回复均为示例。</Notice>}
    <Card>
      <div className="card-head"><h2>{visibleGroup?.name || 'Oops 共用协作群'}</h2><Badge tone="gray">{demo ? '本地演示' : group ? '已读取群快照' : '等待读取'}</Badge></div>
      <p>共用一个群，每个任务在独立线程中推进。</p>
      {visibleGroup?.updated_at && <p className="meta">成员快照：{visibleGroup.updated_at}</p>}
      {visibleGroup ? visibleGroup.members.map(member => <Row key={member.id} title={member.name} subtitle={(member.handle ? member.handle + ' · ' : '') + (member.type === 'human' ? '群成员' : member.id === visibleGroup.bridge_agent_id ? 'Oops 任务入口' : 'Agent')} icon={member.type === 'human' ? 'user-circle' : 'robot'} />) : <p className="meta">连接后读取群成员，当前未选择任何 Agent。</p>}
      {liveGroupUrl && <Button tone="secondary" onClick={() => openRaft(liveGroupUrl)}>进入 Raft 群聊</Button>}
    </Card>
    {!demo && <>
      <Field label="协作服务地址" type="url" value={base} onChange={value => { resetConnection(); setBase(value); }} />
      {localService && <Button disabled={!!busy} tone="secondary" onClick={() => void connect(true)}>连接本机协作服务</Button>}
      <Field label="Oops 服务访问令牌（手动连接可选）" type="password" value={token} onChange={value => { resetConnection(); setToken(value); secret.current = value.trim(); }} hint="凭据只在本页内存中使用。" />
      <Button disabled={!!busy || !token.trim()} tone="quiet" onClick={() => void connect(false)}>使用令牌连接</Button>
      <Notice tone={groupStatus === 'ready' && bridgeOnline ? 'soft' : 'warning'}>{groupLabels[groupStatus] || groupStatus}{groupStatus === 'ready' ? bridgeOnline ? ' · Raft 桥接在线' : ' · 桥接离线，登记后等待发送' : ''}</Notice>
      {groupError && <p className="meta">{groupReasons[groupError] || groupError}</p>}
    </>}
    {task && <Notice>关联任务：{task.id}。标题与简报由你填写，任务原话和资料不会自动附入。</Notice>}
    {taskSourceInvalid && <Notice tone="warning">来源变化，先回任务核对。</Notice>}
    {taskClosed && <Notice>这项任务已结束，仅查看协作历史。可从工具连接发起独立的手写协作。</Notice>}
    {!taskClosed && <>
    <SectionTitle>发起协作任务</SectionTitle>
    <Field label="协作标题" value={title} onChange={value => edit(() => setTitle(value))} placeholder="给这次协作起一个标题" />
    {title.trim().length > 160 && <p className="error-text" role="alert">标题最多 160 字符。</p>}
    <Field label="任务简报" value={brief} onChange={value => edit(() => setBrief(value))} multiline placeholder="填写目标、分工、限制和预期成果" hint="只发送这次明确填写的简报。群内所有成员可能看到线程内容。" />
    {brief.length > 12000 && <p className="error-text" role="alert">简报最多 12000 字符，当前 {brief.length} 字符。</p>}
    <Card><h3>参与 Agent</h3>{members.length ? members.map(member => <Check key={member.id} label={member.name + ' · ' + member.handle} value={participants.includes(member.id)} onChange={checked => edit(() => setParticipants(ids => checked ? [...new Set([...ids, member.id])] : ids.filter(id => id !== member.id)))} />) : <p className="meta">先读取共用群成员，再明确选择参与者。</p>}</Card>
    {participants.length > 16 && <p className="error-text" role="alert">每次最多通知 16 个 Agent，请缩小本次分工范围。</p>}
    <Check label={demo ? '确认在本页创建这份协作演示' : '允许将标题与简报发送到共用群，并通知所选 Agent'} value={confirmed} onChange={setConfirmed} />
    <Button disabled={!draftValid || !confirmed || !!busy || taskBlocked || !demo && !liveReady} onClick={demo ? createDemo : () => void createLive()}>{demo ? '创建演示线程' : pending?.state === 'retryable' ? '用原编号重试任务简报' : '发起任务线程'}</Button>
    </>}
    <SectionTitle>任务线程</SectionTitle>
    {!demo && <Button disabled={!token.trim() || !!busy} tone="secondary" onClick={() => void refresh()}>刷新线程与回复</Button>}
    {threads.length ? threads.map(item => <Card key={item.id} onClick={() => chooseThread(item.id)}><div className="card-head"><strong>{item.title}</strong><Badge tone={['failed', 'unknown'].includes(item.status) ? 'orange' : 'purple'}>{labels[item.status] || item.status}</Badge></div><p className="meta">{item.replies.length} 条回复 · {item.reviews.length} 条已核对记录{item.created_at ? ' · ' + item.created_at : ''}</p></Card>) : <Empty title="暂无协作线程" body={demo ? '写好简报并选择演示 Agent 后创建线程。' : '连接后读取真实线程；发送与收到回复都不代表业务完成。'} />}
    {selected && <>
      <SectionTitle>{selected.title}</SectionTitle>
      {selectedSourceInvalid && <Notice tone="warning">来源变化，先回任务核对。</Notice>}
      {selectedClosed && <Notice>关联任务已结束，当前线程仅查看历史。</Notice>}
      <Card><Badge>{labels[selected.status] || selected.status}</Badge><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--ink)' }}>{selected.brief}</p><p className="meta" style={{ overflowWrap: 'anywhere' }}>参与者：{selected.participant_ids.map(id => visibleGroup?.members.find(member => member.id === id)?.name || id).join('、')}</p>{selected.raft_message_id && <p className="meta" style={{ overflowWrap: 'anywhere' }}>Raft 线程：{selected.raft_message_id}</p>}{selected.error && <p className="error-text">{safeError(new Error(selected.error), token)}</p>}</Card>
      {threadUrl && <Button tone="secondary" onClick={() => openRaft(threadUrl)}>在 Raft 中打开本任务</Button>}
      {!demo && !selectedClosed && selected.status === 'queued' && <Button tone="quiet" disabled={!!busy || !!unknown.length} onClick={() => void cancelLive(selected)}>取消尚未发出的任务简报</Button>}
      {demo && !selectedClosed && <div className="action-grid"><Button tone="secondary" disabled={selected.status !== 'demo_queued'} onClick={simulateDelivery}>体验示例送达</Button><Button tone="secondary" disabled={!['demo_sent', 'demo_replied'].includes(selected.status)} onClick={simulateReply}>体验示例回复</Button></div>}
      {!selected.replies.length && <Notice>还没有回复记录。</Notice>}
      {selected.replies.map(reply => <Card key={reply.reply_id}><p className="meta">{reply.sender}{reply.created_at ? ' · ' + reply.created_at : ''}</p><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--ink)' }}>{reply.text}</p>{!selectedClosed && <div className="action-grid"><Button tone="secondary" disabled={selectedBlocked} onClick={() => openReview(selected, reply, 'progress')}>核对为进展</Button><Button tone="secondary" disabled={selectedBlocked} onClick={() => openReview(selected, reply, 'artifact')}>核对为成果</Button></div>}</Card>)}
      {selected.reviews.length > 0 && <><SectionTitle>已核对记录</SectionTitle>{selected.reviews.map(item => <Card key={item.id}><Badge tone="gray">{item.kind === 'progress' ? '人工记录进展' : '人工记录成果'}{demo ? ' · 演示' : ''}</Badge><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.text}</p><p className="meta">{item.created_at || '时间未记录'} · 保留回复来源</p></Card>)}</>}
      {selected.communications.length > 0 && <><SectionTitle>补充沟通</SectionTitle>{selected.communications.map(item => <Card key={item.request_id}><Badge tone={['unknown', 'failed'].includes(item.status) ? 'orange' : 'purple'}>{labels[item.status] || item.status}</Badge><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.text}</p>{item.error && <p className="error-text">{safeError(new Error(item.error), token)}</p>}</Card>)}</>}
      {!selectedClosed && <><Field label="补充简报" value={followUp} onChange={value => { setFollowUp(value); setFollowConfirmed(false); remember(null); }} multiline placeholder="继续说明同一任务的补充要求" />
      <Card><h3>通知 Agent</h3>{members.map(member => <Check key={member.id} label={member.name + ' · ' + member.handle} value={followMembers.includes(member.id)} onChange={checked => { setFollowMembers(ids => checked ? [...new Set([...ids, member.id])] : ids.filter(id => id !== member.id)); setFollowConfirmed(false); remember(null); }} />)}</Card>
      {followMembers.length > 16 && <p className="error-text" role="alert">每次最多通知 16 个 Agent。</p>}
      {followUp.length > 12000 && <p className="error-text" role="alert">补充简报最多 12000 字符。</p>}
      <Check label={demo ? '确认将补充内容加入本页演示线程' : '允许将这段补充简报发送到当前线程'} value={followConfirmed} onChange={setFollowConfirmed} />
      <Button disabled={!followValid || !followConfirmed || !!busy || selectedBlocked || !demo && !liveReady} onClick={demo ? sendDemoFollowUp : () => void continueLive()}>{demo ? '加入演示线程' : pending?.state === 'retryable' ? '用原编号重试补充沟通' : '发送到当前线程'}</Button></>}
    </>}
    {!demo && unknown.length > 0 && <Notice tone="warning">有 {unknown.length} 条请求回执未知。先刷新，按原请求编号核对。{unknown.map(item => <p key={item.body.request_id} style={{ overflowWrap: 'anywhere' }}>{item.body.request_id}</p>)}</Notice>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {notice && <Notice>{notice}</Notice>}
    {busy && <p className="meta" role="status">{busy}…</p>}
    <Button tone="quiet" onClick={() => navigate(task ? { view: 'task-detail', id: task.id } : { view: 'settings-tools' })}>{task ? '返回当前任务' : '返回工具连接'}</Button>
    <Sheet open={!!review} onClose={() => { setReview(null); setReviewConfirmed(false); }} title={review?.kind === 'artifact' ? '核对并记录成果' : '核对并记录进展'}>
      <Notice>{demo ? '演示记录仅保存在本页。' : '只记录本次人工核对的结果。'}记为成果不代表验收、交付或业务完成。</Notice>
      {review && <><Card><p className="meta">来源：{review.reply.sender} · {review.reply.reply_id}</p><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{review.reply.text}</p></Card><Field label="核对后的记录" value={review.text} onChange={value => { setReview(current => current ? { ...current, text: value } : null); setReviewConfirmed(false); remember(null); }} multiline placeholder="填写核对后的进展或成果说明" hint="最多 1000 字符；原回复另行保留。" />{review.text.length > 1000 && <p className="error-text" role="alert">核对记录最多 1000 字符。</p>}<Check label="已核对这段回复与编辑后的记录，确认保存" value={reviewConfirmed} onChange={setReviewConfirmed} /><Button disabled={!reviewConfirmed || !review.text.trim() || review.text.length > 1000 || !!busy || selectedBlocked || !demo && !liveReady} onClick={demo ? saveDemoReview : () => void reviewLive()}>{demo ? '保存演示核对记录' : pending?.state === 'retryable' ? '用原编号重试核对记录' : '保存核对记录'}</Button>{!demo && unknown.length > 0 && <Button tone="secondary" disabled={!!busy} onClick={() => void refresh()}>刷新原请求回执</Button>}{error && <p className="error-text" role="alert">{error}</p>}</>}
    </Sheet>
  </div>;
}
