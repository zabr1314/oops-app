import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useOops } from '../store';
import { Badge, Button, Card, Check, Empty, Field, Icon, Notice, Row, SectionTitle, SelectField, Sheet, Tabs } from '../ui';
import { useViewState } from '../viewState';
import { sessionReaderKey, normalizeSessionTab } from '../features/Sessions';
import { nativeMinutesSections, nativeSourceFocus } from './presentation';
import { nativeBridge } from '../nativeBridge';

export function useNativeSnapshot() { return useSyncExternalStore(nativeBridge.subscribe, nativeBridge.snapshot, nativeBridge.snapshot); }
const sourceNames: Record<string, string> = { mic: '手机麦克风', bean: '录音豆', remote: 'Mac 收音', wav: '测试音频', bean_sim: '录音豆模拟' };
const clock = (ms: unknown) => { const s = Math.floor(Number(ms || 0) / 1000); return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`; };

/** Advanced native operations keep their established confirmation/recovery flow. */
export function openNativeTools(tool: string, sessionId?: string, returnMode?: string) {
  const target = new URL('../native-tools/index.html', window.location.href);
  target.searchParams.set('unified-tools', tool);
  if (sessionId) target.searchParams.set('session', sessionId);
  target.searchParams.set('return', returnMode && sessionId ? '#session-detail/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(returnMode) : window.location.hash);
  if (new URLSearchParams(window.location.search).has('native-preview')) target.searchParams.set('preview', '1');
  window.location.assign(target.href);
}

export function NativeConnectionCard() {
  const n = useNativeSnapshot();
  return <Card><div className="card-head"><Badge tone={n.connected ? 'green' : 'orange'}>{n.connected ? '设备与服务' : '正在连接手机'}</Badge><span className="meta">{sourceNames[String(n.state.source)] || '选择收音设备'}</span></div><p className="meta">{n.state.backend === 'mock' ? '当前使用测试服务；连接自己的服务后读取真实会议。' : n.backendUrl ? '已使用当前配置的服务。' : '设置服务连接后，可读取已有会议与任务。'}</p>{n.error && <p className="error-text" role="alert">{String(n.error.message || '读取暂未完成')}</p>}<div className="action-grid"><Button tone="quiet" onClick={() => openNativeTools('connection')}>管理服务与收音</Button><Button tone="quiet" disabled={!n.connected} onClick={() => { nativeBridge.send('history.list'); nativeBridge.send('tasks.list', { mine: false, status: 'all' }); }}>刷新记录</Button></div></Card>;
}

function NativeStartRecording() {
  const { navigate } = useOops(); const n = useNativeSnapshot();
  const [kind, setKind] = useState('日常'), [source, setSource] = useState(String(n.state.source || 'mic'));
  const [cloud, setCloud] = useState(false), [audioDays, setAudioDays] = useState('30'), [textDays, setTextDays] = useState('30');
  const [starting, setStarting] = useState(false);
  useEffect(() => { if (starting && n.state.capturing && n.state.sessionId) navigate({ view: 'session-detail', id: String(n.state.sessionId), mode: '现场' }); }, [starting, n.state.capturing, n.state.sessionId]);
  const busy = !!n.state.capturing || !!n.state.capturePaused || n.state.asr === 'finishing';
  return <div className="stack session-quickstart"><div className="session-start-heading"><Icon name="microphone" size={30}/><h2>先把这一刻留下</h2><p>使用这台手机的真实收音通道。</p></div>
    {busy && <Card><h3>{n.state.asr === 'finishing' ? '上一段记录正在收尾' : '已有一段活动记录'}</h3><p className="meta">{clock(n.state.sessionMs)} · 请先处理当前记录。</p><Button onClick={() => navigate({ view: 'session-detail', id: String(n.state.sessionId), mode: '现场' })}>回到当前记录</Button></Card>}
    <Tabs items={['日常', '会议']} value={kind} onChange={value => { setKind(value); setCloud(false); }}/>
    <SelectField label="收音来源" value={sourceNames[source] || source} options={Object.values(sourceNames)} onChange={value => setSource(Object.keys(sourceNames).find(key => sourceNames[key] === value) || 'mic')}/>
    {kind === '会议' ? <Card><Check label="本次正式会议允许云端保存" value={cloud} onChange={setCloud}/><SelectField label="原音保存天数" value={audioDays} options={['7', '30', '90']} onChange={setAudioDays}/><SelectField label="全文保存天数" value={textDays} options={['7', '30', '90']} onChange={setTextDays}/></Card> : <Notice>完整原音与全文只暂存最近5分钟，停止后清除。私人重点由你另行确认保存。</Notice>}
    {n.error && <p role="alert" className="error-text">{String(n.error.message || '收音尚未开始')}</p>}
    <Button icon="play" disabled={!n.connected || busy || starting || kind === '会议' && !cloud} onClick={() => { setStarting(true); nativeBridge.send('capture.start', { source, recordingMode: kind === '会议' ? 'meeting' : 'daily', cloudSaveConfirmed: kind === '会议' && cloud, audioRetentionDays: Number(audioDays), transcriptRetentionDays: Number(textDays) }); }}>现在开始</Button>
    {starting && <Button tone="secondary" onClick={() => { nativeBridge.send('hello'); setStarting(false); }}>重新检查收音状态</Button>}
    <Button tone="quiet" onClick={() => openNativeTools('connection')}>设备、权限与收音设置</Button>
  </div>;
}

export function NativeRecordingControls() {
  const { navigate } = useOops(); const n = useNativeSnapshot(); const [stop, setStop] = useState(false);
  useEffect(() => { const open = () => setStop(true); window.addEventListener('oops:native-request-end', open); return () => window.removeEventListener('oops:native-request-end', open); }, []);
  const active = !!n.state.capturing || !!n.state.capturePaused; const pause = n.capabilities.pause;
  if (!active) return null;
  return <><aside className="recording-controls is-compact" aria-label="当前记录控制"><div className="rc-heading"><span className="rc-dot"/><button className="rc-session" onClick={() => navigate({ view: 'session-detail', id: String(n.state.sessionId), mode: '现场' })}><strong>{n.state.recordingMode === 'meeting' ? '会议记录' : '日常聆听'}</strong><span>{n.state.capturePauseDraining ? '正在处理最后转写' : n.state.capturePaused ? '已暂停' : '正在收音'} · {clock(n.state.sessionMs)}</span></button><div className="rc-compact-actions">{pause && <button aria-label={n.state.capturePaused ? '继续当前记录' : '暂停当前记录'} disabled={!!n.state.capturePauseDraining} onClick={() => nativeBridge.send(n.state.capturePaused ? 'capture.resume' : 'capture.pause')}><Icon name={n.state.capturePaused ? 'play' : 'pause'} size={18}/></button>}<button className="rc-end" aria-label="结束当前记录" onClick={() => setStop(true)}><Icon name="stop" size={18}/></button></div></div></aside>
    <Sheet open={stop} onClose={() => setStop(false)} title="结束这段记录？"><p>{n.state.recordingMode === 'meeting' ? '沿用本次开始时确认的保存范围收尾，等待最终转写和上传回执。' : '结束后清除临时全文与完整原音。已单独确认的私人重点保留。'}</p><Button onClick={() => { nativeBridge.send('capture.stop'); setStop(false); }}>确认结束</Button><Button tone="secondary" onClick={() => setStop(false)}>继续记录</Button></Sheet>
  </>;
}

function NativeMeeting() {
  const { data, route, navigate } = useOops(); const n = useNativeSnapshot(); const id = route.id || '';
  const session = data.sessions.find(value => value.id === id);
  const turnsRef = useRef<HTMLDivElement>(null);
  const focusId = route.view === 'session-transcript' ? nativeSourceFocus(session?.transcript || [], route.mode) : undefined;
  useEffect(() => { if (focusId) turnsRef.current?.querySelector(`[data-native-turn="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'center' }); }, [focusId, session?.transcript]);
  const active = !!session && session.id === data.activeSessionId && ['进行中', '暂停'].includes(session.status);
  const [reader, setReader] = useViewState(sessionReaderKey(id, data.settings.space), { tab: active ? '现场' : '概览', query: '', speaker: '全部', view: '我的视角', note: '' });
  useEffect(() => { const tab = route.view === 'session-transcript' ? '原文' : ['现场','概览','原文','资料','行动'].includes(route.mode || '') ? route.mode : undefined; if (tab) setReader(current => ({ ...current, tab })); }, [route.view, route.mode, id]);
  useEffect(() => { if (id && id !== n.state.sessionId) { nativeBridge.send('history.open', { sessionId: id }); nativeBridge.send('history.minutes', { sessionId: id }); } }, [id, n.scopeVersion]);
  if (!session) return <Empty title="正在读取这段记录" body="以当前服务的读取结果为准。" action="重新读取" onAction={() => nativeBridge.send('history.open', { sessionId: id })}/>;
  const mode = normalizeSessionTab(reader.tab, active);
  const minutes = n.minutes[id]; const sections = nativeMinutesSections(minutes);
  return <div className="stack"><Card><Badge tone={session.status === '进行中' ? 'green' : 'gray'}>{session.status}</Badge><h2>{session.title}</h2><p className="meta">{session.date} · {session.duration || '时长未记录'}</p></Card>{active && n.state.asr === 'unconfigured' && <Notice>实时转写尚未配置，当前不会产生实时文字。</Notice>}
    {['现场', '原文'].includes(mode) ? <div className="stack" ref={turnsRef}>{n.partial && id === n.state.sessionId && <Notice>{n.partial}</Notice>}{session.transcript.map(turn => <div key={turn.id} data-native-turn={turn.id} className={focusId === turn.id ? 'native-source-focus' : ''}><Card><div className="card-head"><strong>{turn.speaker}</strong><span className="meta">{turn.time}</span></div><p>{turn.text}</p></Card></div>)}{!session.transcript.length && <Empty title="还没有可读取的原话" body="收音、转写与保存状态会在这里更新。"/>}</div> : mode === '资料' ? <><SectionTitle>本场资料</SectionTitle>{session.attachments.map((title, index) => <Card key={index}><p>{title}</p></Card>)}<Button tone="secondary" onClick={() => openNativeTools('meeting', id, mode)}>查看服务端资料与原声</Button></> : mode === '行动' ? <><SectionTitle>核对与推进</SectionTitle><p className="meta">沿用已生成的纪要事项与人工负责人核对，不按说话人自动认领。</p><Button onClick={() => openNativeTools('meeting', id, mode)}>核对待办、决定与待定事项</Button><Button tone="secondary" onClick={() => navigate({ view: 'tasks' })}>查看任务</Button></> : <><SectionTitle>会后结果</SectionTitle>{sections.length ? sections.map(section => <Card key={section.title}><h3>{section.title}</h3>{section.lines.map((line, index) => <p key={index}>{line}</p>)}</Card>) : session.summary.length ? <Card>{session.summary.map((line, index) => <p key={index}>{line}</p>)}</Card> : <Notice>{session.status === '进行中' ? '记录还在进行，最终结果将在收尾后读取。' : '纪要尚未就绪，可重新读取当前状态。'}</Notice>}<Button tone="secondary" onClick={() => nativeBridge.send('history.minutes', { sessionId: id })}>刷新会后结果</Button><Button tone="secondary" onClick={() => openNativeTools('meeting', id, mode)}>逐项核对与交付</Button></>}
    <Button tone="quiet" onClick={() => openNativeTools('meeting', id, mode)}>原声、身份、保存与会议操作</Button>
  </div>;
}

function NativeAccount() {
  const n = useNativeSnapshot(); const linked = n.account?.status === 'connected';
  const account = n.account?.account as Record<string, unknown> | undefined;
  return <div className="stack"><Card><Badge tone={linked ? 'green' : 'orange'}>{linked ? '已连接本人账号' : '尚未连接本人账号'}</Badge><h2>{String(account?.name || n.state.selfName || '我的账户')}</h2><p>每个人连接自己的飞书账号，权限和发送确认分别处理。</p></Card><Button disabled={!n.connected} onClick={() => nativeBridge.send('feishu.connect')}>{linked ? '重新核对授权' : '连接我的飞书'}</Button><Button tone="secondary" disabled={!n.connected} onClick={() => nativeBridge.send('feishu.status')}>返回授权后，刷新状态</Button><Button tone="secondary" onClick={() => openNativeTools('account')}>管理账号、权限与连接</Button><NativeConnectionCard/></div>;
}

function NativePrivateSync() {
  const n = useNativeSnapshot();
  return <Card><Row title="本人账号中的背景与人物记忆" subtitle={n.account?.status === 'connected' ? '已连接本人账号，可核对服务器版本' : '连接自己的飞书后再同步'} icon="devices" onClick={() => openNativeTools('personal')}/><p className="meta">下方与网页相同的整理流程保存于本机。账号同步须核对具体内容，暂不自动合并同名档案。</p></Card>;
}

export function NativeRouteOutlet({ fallback }: { fallback: ReactNode }) {
  const { data, route } = useOops(); const n = useNativeSnapshot();
  const remoteSession = !!route.id && !!data.settings.retention['native-session:' + route.id];
  const remoteTask = !!route.id && !!data.settings.retention['native-task:' + route.id];
  if (['session-mode', 'session-create', 'voice'].includes(route.view)) return <NativeStartRecording/>;
  if (remoteSession && route.view.startsWith('session-')) return <NativeMeeting/>;
  if (remoteTask && route.view.startsWith('task-')) {
    const task = data.tasks.find(value => value.id === route.id); const raw = n.tasks.find(value => String(value.op_id || value.id || value.guid || value.task_guid) === route.id);
    return <div className="stack"><Card><Badge>{task?.status || '服务端任务'}</Badge><h2>{task?.title || '任务详情'}</h2><p>{task?.description}</p><p className="meta">{task?.owner} · {task?.due || '期限待确认'}</p></Card><Button onClick={() => openNativeTools('tasks')}>核对真实任务与来源</Button>{raw?.url && <Button tone="secondary" onClick={() => nativeBridge.send('open.url', { url: raw.url })}>打开任务</Button>}<Notice>真实任务状态以服务器与飞书回执为准。</Notice></div>;
  }
  if (route.view === 'settings-account') return <NativeAccount/>;
  if (route.view === 'settings-privacy' || route.view === 'settings-retention') return <div className="stack"><Card><h2>隐私与保存</h2><p>日常完整原音与全文只临时保留最近5分钟。正式会议每次开始时由你明确选择云端保存及期限。</p><p>麦克风与蓝牙由系统授权；姓名、声音身份、账号连接、长期记忆和外部发送分别确认。</p></Card><Button tone="secondary" onClick={() => openNativeTools('privacy')}>管理真实记录与保存范围</Button><Button tone="secondary" onClick={() => openNativeTools('account')}>管理个人授权与权限</Button></div>;

  const nativeTools: Record<string, [string, string]> = {
    'settings-devices': ['设备与收音', 'connection'], 'settings-device': ['设备与收音', 'connection'], 'settings-pair': ['设备连接', 'connection'],
    'settings-voice': ['我的声音身份', 'voice'], 'settings-voice-identities': ['声音身份与许可', 'voice'], 'settings-voice-match': ['声音身份核对', 'voice'],
    'settings-tools': ['真实服务与工具连接', 'connection'], 'settings-tool': ['真实服务与工具连接', 'connection'], 'settings-sync': ['录音上传与离线恢复', 'connection'],
    'session-recall': ['找回最近5分钟', 'recall'], 'session-listening': ['智能聆听与唤醒', 'connection'], 'settings-listening': ['智能聆听与唤醒', 'connection'],
  };
  if (nativeTools[route.view]) { const [title, tool] = nativeTools[route.view]; return <div className="stack"><Card><h2>{title}</h2><p>使用本机已连接的设备与原生权限。</p></Card><Button onClick={() => openNativeTools(tool)}>打开{title}</Button><NativeConnectionCard/></div>; }
  if (route.view === 'home') return <>{n.error && <Notice>{String(n.error.message || '部分记录暂未读取，请重新连接服务。')}</Notice>}{fallback}</>;
  if (route.view === 'tasks') return <><Card><Row title="真实会议事项与飞书任务" subtitle="核对待办、负责人、来源与既有回执" icon="list-checks" onClick={() => openNativeTools('tasks')}/></Card>{fallback}</>;
  if (['settings-personal-assistant', 'settings-identity', 'settings-preferences'].includes(route.view)) return <><NativePrivateSync/>{fallback}</>;
  if (route.view === 'memory') return <><Card><Row title="账号记忆、人物与项目" subtitle="查看已确认的服务器内容" icon="cloud" onClick={() => openNativeTools('memory')}/></Card>{fallback}</>;
  return <>{fallback}</>;
}
