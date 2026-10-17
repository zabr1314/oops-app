import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Check, Empty, Field, Notice, SectionTitle, SelectField, Tabs } from '../ui';

type MessageKind = 'message' | 'instruction';
type RaftReply = { text: string; sender?: string; created_at?: string; reply_id?: string };
type RaftMessage = {
  id: string | number;
  request_id: string;
  kind: MessageKind;
  target: string;
  text: string;
  status: string;
  raft_message_id?: string | null;
  error?: string | null;
  replies?: RaftReply[];
  created_at?: string;
};
type RaftStatus = { enabled: boolean; bridge_online: boolean; allowed_targets: string[]; counts?: Record<string, number> };
type SendPayload = { request_id: string; kind: MessageKind; target: string; text: string; confirm: true };
type Attempt = { payload: SendPayload; state: 'sending' | 'unknown' | 'retryable' | 'known' };
type Operation = { generation: number; controller: AbortController; base: string; token: string };
const LOCAL_MESSAGE_SERVICE = 'http://127.0.0.1:8798';

function loopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname.toLowerCase());
}

/** Real connections are deliberately unavailable to public and isolated previews. */
export function isLocalRaftConnectionAllowed(): boolean {
  if (typeof window === 'undefined' || !loopback(window.location.hostname)) return false;
  const params = new URLSearchParams(window.location.search);
  if (params.has('board-preview') || params.has('tour') || params.has('guided-trial')) return false;
  // The experience centre may host an isolated preview in an iframe.
  try {
    if (window.parent !== window) {
      const parentParams = new URLSearchParams(window.parent.location.search);
      if (parentParams.has('tour') || parentParams.has('board-preview') || parentParams.has('guided-trial')) return false;
    }
  } catch { return false; }
  return true;
}

function serviceBase(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('填写完整的后端服务地址。'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含凭据、查询参数或页面锚点。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) {
    throw new Error('服务地址须使用 HTTPS，本机回环地址可使用 HTTP。');
  }
  return url.href.replace(/\/+$/, '');
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function messageResult(value: unknown): RaftMessage {
  const item = record(value);
  if (!item || !['string', 'number'].includes(typeof item.id) || typeof item.request_id !== 'string'
    || !['message', 'instruction'].includes(String(item.kind)) || typeof item.target !== 'string'
    || typeof item.text !== 'string' || typeof item.status !== 'string') throw new Error('后端返回的消息回执不完整，请重新读取。');
  const replies = Array.isArray(item.replies) ? item.replies.map(reply => {
    const entry = record(reply);
    if (!entry || typeof entry.text !== 'string') throw new Error('回复记录不完整，请重新读取。');
    return { text: entry.text, sender: typeof entry.sender === 'string' ? entry.sender : undefined,
      created_at: typeof entry.created_at === 'string' ? entry.created_at : undefined,
      reply_id: typeof entry.reply_id === 'string' ? entry.reply_id : undefined };
  }) : [];
  return { id: item.id as string | number, request_id: item.request_id, kind: item.kind as MessageKind,
    target: item.target, text: item.text, status: item.status, replies,
    raft_message_id: typeof item.raft_message_id === 'string' ? item.raft_message_id : null,
    error: typeof item.error === 'string' ? item.error : null,
    created_at: typeof item.created_at === 'string' ? item.created_at : undefined };
}

function messageList(value: unknown): RaftMessage[] {
  const response = record(value);
  if (!response || !Array.isArray(response.items)) throw new Error('后端未返回可核对的消息列表。');
  return response.items.map(messageResult);
}

function statusResult(value: unknown): RaftStatus {
  const result = record(value);
  if (!result || typeof result.enabled !== 'boolean' || !Array.isArray(result.allowed_targets)
    || !result.allowed_targets.every(target => typeof target === 'string')) throw new Error('后端未返回连接状态或获准收件人。');
  return { enabled: result.enabled, bridge_online: result.bridge_online === true, allowed_targets: result.allowed_targets as string[] };
}

function errorText(error: unknown, token = ''): string {
  const text = error instanceof Error ? error.message : '服务读取失败，请重新核对连接。';
  return (token ? text.split(token).join('[凭据已隐藏]') : text).slice(0, 500);
}

function stateLabel(status: string): string {
  const labels: Record<string, string> = { queued: '等待发送', sending: '正在发送', dispatching: '正在发送', sent: 'Raft 已接收',
    delivered: 'Raft 已接收', replied: '收到回复', failed: '发送失败', cancelled: '已取消',
    unknown: '发送回执未知', uncertain: '发送回执未知', awaiting_reply: '等待回复' };
  return labels[status] || status;
}

function requestId(): string {
  return 'oops-raft-' + crypto.randomUUID();
}

export function RaftConnection() {
  const allowed = isLocalRaftConnectionAllowed();
  const [base, setBase] = useState(LOCAL_MESSAGE_SERVICE);
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<RaftStatus | null>(null);
  const [messages, setMessages] = useState<RaftMessage[]>([]);
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<MessageKind>('message');
  const [text, setText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [unresolved, setUnresolved] = useState<SendPayload[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const attemptRef = useRef<Attempt | null>(null);
  const secretRef = useRef('');

  useEffect(() => {
    // Fast Refresh replays effects while retaining state and refs. Start a new
    // page session so an aborted operation cannot leave its busy lock behind.
    busyRef.current = false; active.current = null; secretRef.current = ''; attemptRef.current = null;
    setBusy(''); setToken(''); setStatus(null); setMessages([]); setTarget('');
    setAttempt(null); setUnresolved([]); setConfirmed(false); setLoaded(false);
    setError(''); setNotice('');
    return () => {
      generation.current += 1;
      active.current?.abort();
      active.current = null;
      busyRef.current = false;
      secretRef.current = '';
      attemptRef.current = null;
    };
  }, []);

  function rememberAttempt(value: Attempt | null) { attemptRef.current = value; setAttempt(value); }
  function resetConnection() {
    generation.current += 1;
    active.current?.abort(); active.current = null; busyRef.current = false;
    setBusy(''); setStatus(null); setMessages([]); setUnresolved([]); setLoaded(false);
    setTarget(''); setConfirmed(false); rememberAttempt(null); setError(''); setNotice('');
  }
  function editDraft(change: () => void) {
    change(); setConfirmed(false); rememberAttempt(null); setError(''); setNotice('');
  }
  function start(label: string): Operation | null {
    if (!allowed || busyRef.current) return null;
    try {
      const endpoint = serviceBase(base);
      if (!token.trim()) throw new Error('填写 Oops 后端服务访问令牌，再连接。');
      const controller = new AbortController();
      busyRef.current = true; active.current = controller;
      setBusy(label); setError(''); setNotice('');
      return { generation: generation.current, controller, base: endpoint, token: token.trim() };
    } catch (failure) { setError(errorText(failure, token)); return null; }
  }
  function current(operation: Operation): boolean {
    return operation.generation === generation.current && active.current === operation.controller;
  }
  function finish(operation: Operation) {
    if (!current(operation)) return;
    active.current = null; busyRef.current = false; setBusy('');
  }
  async function api(operation: Operation, path: string, body?: unknown): Promise<unknown> {
    const timer = window.setTimeout(() => operation.controller.abort(), 15000);
    try {
      const response = await fetch(operation.base + path, { method: body === undefined ? 'GET' : 'POST',
        signal: operation.controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { ...(operation.token ? { Authorization: 'Bearer ' + operation.token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value: unknown = await response.json();
      if (!response.ok) {
        const detail = record(value);
        const structuredError = record(detail?.error);
        const message = typeof structuredError?.message === 'string' ? structuredError.message
          : typeof detail?.error === 'string' ? detail.error
          : typeof detail?.detail === 'string' ? detail.detail : `后端请求失败（${response.status}）。`;
        throw new Error(errorText(new Error(message), operation.token));
      }
      return value;
    } finally { window.clearTimeout(timer); }
  }
  function mergeMessage(item: RaftMessage) {
    setMessages(items => [item, ...items.filter(existing => existing.id !== item.id)].slice(0, 30));
  }
  async function readConnection(operation: Operation) {
    const result = statusResult(await api(operation, '/v1/raft/status'));
    if (!current(operation)) return;
    setStatus(result);
    if (!result.allowed_targets.includes(target)) {
      setTarget(result.allowed_targets[0] || ''); rememberAttempt(null);
    }
    const items = messageList(await api(operation, '/v1/raft/messages?limit=30'));
    if (!current(operation)) return;
    setMessages(items); setLoaded(true);
    setNotice(!result.enabled ? '消息数据库已连接，暂未允许提交请求。'
      : result.bridge_online ? '消息数据库已连接，Raft 桥接在线。实际发送以逐条回执为准。'
      : '消息数据库已连接；桥接离线，等待 Raft 授权或启动。提交的内容会留在待发送队列。');
  }
  async function connect() {
    const operation = start('连接中'); if (!operation) return;
    setStatus(null); setMessages([]); setLoaded(false); setConfirmed(false);
    try { await readConnection(operation); }
    catch (failure) { if (current(operation)) setError(errorText(failure, operation.token)); }
    finally { finish(operation); }
  }
  async function connectLocal() {
    if (!allowed || busyRef.current) return;
    try {
      if (serviceBase(base) !== LOCAL_MESSAGE_SERVICE) throw new Error('本机快捷连接仅适用于默认的本机消息服务地址。');
    } catch (failure) { setError(errorText(failure, token)); return; }
    resetConnection(); setToken(''); secretRef.current = '';
    const controller = new AbortController();
    const operation: Operation = { generation: generation.current, controller, base: LOCAL_MESSAGE_SERVICE, token: '' };
    active.current = controller; busyRef.current = true; setBusy('连接本机服务');
    try {
      const session = record(await api(operation, '/v1/raft/local-session'));
      if (!current(operation)) return;
      if (typeof session?.token !== 'string' || !session.token.trim()) throw new Error('本机消息服务没有返回有效会话令牌。');
      operation.token = session.token.trim(); secretRef.current = operation.token; setToken(operation.token);
      await readConnection(operation);
    } catch (failure) {
      if (current(operation)) setError('本机连接失败。请确认消息服务已运行，并从获准的本机预览地址打开。' + errorText(failure, operation.token));
    } finally { finish(operation); }
  }
  async function refresh() {
    const operation = start('读取回执'); if (!operation) return;
    try {
      const connection = statusResult(await api(operation, '/v1/raft/status'));
      if (!current(operation)) return;
      setStatus(connection);
      if (!connection.allowed_targets.includes(target)) { setTarget(''); setConfirmed(false); rememberAttempt(null); }
      const items = messageList(await api(operation, '/v1/raft/messages?limit=30'));
      if (!current(operation)) return;
      setMessages(items); setLoaded(true);
      for (const payload of unresolved) {
        const found = messageList(await api(operation, '/v1/raft/messages?limit=30&request_id=' + encodeURIComponent(payload.request_id)));
        if (!current(operation)) return;
        if (found.length > 1 || found.some(item => item.request_id !== payload.request_id)) throw new Error('后端未按请求编号精确核对，未知请求继续保留，暂不重发。');
        if (found[0]) {
          mergeMessage(found[0]);
          if (attemptRef.current?.payload.request_id === payload.request_id) rememberAttempt({ payload, state: 'known' });
        } else if (attemptRef.current?.payload.request_id === payload.request_id) {
          rememberAttempt({ payload, state: 'retryable' }); setConfirmed(false);
          setNotice('已按原请求编号查询，数据库没有这条记录。重新勾选后可用同一编号手动重试。');
        }
        setUnresolved(values => values.filter(item => item.request_id !== payload.request_id));
      }
      if (!unresolved.length) setNotice('已读取当前数据库回执。');
    } catch (failure) {
      if (current(operation)) setError(errorText(failure, operation.token));
    } finally { finish(operation); }
  }
  async function send() {
    if (!confirmed || !status?.enabled || !status.allowed_targets.includes(target) || !text.trim()
      || text.length > 12000
      || attemptRef.current && !['retryable'].includes(attemptRef.current.state)) return;
    if (attemptRef.current && (attemptRef.current.payload.target !== target || attemptRef.current.payload.kind !== kind
      || attemptRef.current.payload.text !== text.trim())) { rememberAttempt(null); setConfirmed(false); return; }
    const operation = start('提交中'); if (!operation) return;
    const payload: SendPayload = attemptRef.current?.payload || { request_id: requestId(), kind, target, text: text.trim(), confirm: true };
    rememberAttempt({ payload, state: 'sending' }); setConfirmed(false);
    try {
      const item = messageResult(await api(operation, '/v1/raft/messages', payload));
      if (!current(operation)) return;
      if (item.request_id !== payload.request_id || item.target !== payload.target || item.kind !== payload.kind || item.text !== payload.text) {
        throw new Error('回执与本次内容不一致，请按请求编号核对。');
      }
      mergeMessage(item); setLoaded(true);
      if (attemptRef.current?.payload.request_id === payload.request_id) rememberAttempt({ payload, state: 'known' });
      setUnresolved(values => values.filter(value => value.request_id !== payload.request_id));
      setNotice('后端已登记请求；实际发送和回复以本条回执为准。');
    } catch (failure) {
      if (!current(operation)) return;
      if (attemptRef.current?.payload.request_id === payload.request_id) rememberAttempt({ payload, state: 'unknown' });
      setUnresolved(values => [...values.filter(value => value.request_id !== payload.request_id), payload]);
      setError('发送回执未知。先刷新并核对原请求，暂不重复发送。' + errorText(failure, operation.token));
    } finally { finish(operation); }
  }
  async function cancel(item: RaftMessage) {
    if (item.status !== 'queued') return;
    const operation = start('取消中'); if (!operation) return;
    try {
      const result = messageResult(await api(operation, '/v1/raft/messages/' + encodeURIComponent(String(item.id)) + '/cancel', { confirm: true }));
      if (!current(operation)) return;
      if (result.id !== item.id || result.request_id !== item.request_id) throw new Error('取消回执不一致，请刷新核对。');
      mergeMessage(result); setNotice('取消请求已收到回执：' + stateLabel(result.status));
    } catch (failure) {
      if (current(operation)) setError('尚未确认取消结果，请刷新回执。' + errorText(failure, operation.token));
    } finally { finish(operation); }
  }

  if (!allowed) return <Notice>Raft 连接仅在本机私人体验中开放。公开网站与引导示例不连接真实服务。</Notice>;

  const canSend = !busy && !!status?.enabled && status.allowed_targets.includes(target) && !!text.trim() && confirmed
    && text.length <= 12000
    && (!attempt || attempt.state === 'retryable');
  let localService = false;
  try { localService = serviceBase(base) === LOCAL_MESSAGE_SERVICE; } catch { /* Keep invalid addresses editable. */ }
  return <div className="stack">
    <Card><Badge tone="gray">本机私人连接</Badge><h2>和 Raft 沟通</h2><p>向获准的收件人发送消息或指令，在这里查看发送状态与回复。</p></Card>
    <SectionTitle>连接 Oops 后端</SectionTitle>
    <Field label="后端服务地址" type="url" value={base} onChange={value => { resetConnection(); setBase(value); setToken(''); secretRef.current = ''; }} placeholder="http://127.0.0.1:8798" />
    {localService && <Button disabled={!!busy} onClick={() => void connectLocal()}>{busy === '连接本机服务' ? '连接本机服务中…' : '连接本机消息服务'}</Button>}
    <Field label="Oops 服务访问令牌" type="password" value={token} onChange={value => { resetConnection(); setToken(value); secretRef.current = value; }} hint="只在本页内存中使用，退出后清除。请使用 Oops 服务令牌。" />
    <Button tone="secondary" disabled={!!busy || !token.trim()} onClick={() => void connect()}>{busy === '连接中' ? '连接中…' : status ? '重新连接' : '连接后端'}</Button>
    {status && <Notice tone={status.enabled && status.bridge_online ? 'soft' : 'warning'}>消息数据库已连接 · {!status.enabled ? '提交入口未启用' : status.bridge_online ? 'Raft 桥接在线' : '桥接离线，等待授权或启动'} · {status.allowed_targets.length} 个获准收件人</Notice>}
    {status?.enabled && <>
      <SectionTitle>发送内容</SectionTitle>
      {status.allowed_targets.length ? <SelectField label="收件人" value={target} options={target ? status.allowed_targets : ['', ...status.allowed_targets]} onChange={value => editDraft(() => setTarget(value))} /> : <Notice tone="warning">后端尚未配置获准收件人，暂时无法发送。</Notice>}
      <Tabs items={['消息', '指令']} value={kind === 'message' ? '消息' : '指令'} onChange={value => editDraft(() => setKind(value === '消息' ? 'message' : 'instruction'))} />
      <Field label={kind === 'message' ? '消息正文' : '指令正文'} value={text} onChange={value => editDraft(() => setText(value))} multiline placeholder={kind === 'message' ? '填写要和 Raft 沟通的内容' : '填写要交给 Raft 的具体工作与范围'} hint="只发送本页填写的正文，不附入会议、任务或其他资料。" />
      {text.length > 12000 && <p className="error-text" role="alert">正文最多 12000 字符，当前 {text.length} 字符。缩短内容后再发送。</p>}
      <Check label={kind === 'message' ? '允许将这段正文发送给所选收件人' : '允许将这条指令交给所选收件人处理'} value={confirmed} onChange={setConfirmed} />
      {!status.bridge_online && <p className="meta">桥接尚未在线。此时提交只进入后端待发送队列；可在发送前取消。</p>}
      <Button disabled={!canSend} onClick={() => void send()}>{busy === '提交中' ? '等待后端回执…' : attempt?.state === 'retryable' ? '用原请求编号重试' : kind === 'message' ? '发送消息' : '发送指令'}</Button>
      {attempt?.state === 'known' && <p className="meta">这份内容已经提交。编辑正文或收件人后，可以起草新的请求。</p>}
    </>}
    {!!unresolved.length && <Notice tone="warning">{unresolved.length} 条请求尚未确认发送结果，请先刷新核对。{unresolved.map(payload => <p key={payload.request_id} style={{ overflowWrap: 'anywhere' }}>{payload.target} · {payload.request_id}</p>)}</Notice>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {notice && <Notice>{notice}</Notice>}
    <SectionTitle>发送与回复</SectionTitle>
    <Button tone="secondary" disabled={!status || !!busy} onClick={() => void refresh()}>{busy === '读取回执' ? '读取中…' : '刷新回执'}</Button>
    {!messages.length && <Empty title={loaded ? '暂无消息记录' : '等待读取回执'} body={loaded ? '提交后，状态与回复会在这里展示。' : '连接后读取后端保存的消息记录。'} />}
    {messages.map(item => <Card key={item.id}>
      <div className="card-head"><strong>{item.target}</strong><Badge tone={['failed', 'unknown', 'uncertain'].includes(item.status) ? 'orange' : item.status === 'cancelled' ? 'gray' : 'purple'}>{stateLabel(item.status)}</Badge></div>
      <p className="meta">{item.kind === 'instruction' ? '指令' : '消息'}{item.created_at ? ' · ' + item.created_at : ''}</p>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--ink)' }}>{item.text}</p>
      <p className="meta" style={{ overflowWrap: 'anywhere' }}>请求编号：{item.request_id}</p>
      {item.raft_message_id && <p className="meta" style={{ overflowWrap: 'anywhere' }}>Raft 消息：{item.raft_message_id}</p>}
      {item.error && <p className="error-text">{errorText(new Error(item.error), token)}</p>}
      {item.replies?.map((reply, index) => <div className="chat-bubble" key={reply.reply_id || index}>
        <small>{reply.sender || 'Raft 回复'}{reply.created_at ? ' · ' + reply.created_at : ''}</small>
        <p style={{ overflowWrap: 'anywhere' }}>{reply.text}</p>
      </div>)}
      {item.status === 'queued' && <Button tone="quiet" disabled={!!busy} onClick={() => void cancel(item)}>取消这条待发送请求</Button>}
    </Card>)}
    {busy && <p className="meta" role="status">{busy}…</p>}
  </div>;
}
