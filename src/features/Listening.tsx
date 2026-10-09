import { useEffect, useRef, useState } from 'react';
import { useOops, type Route } from '../store';
import { Badge, Button, Card, Check, Empty, Field, Icon, Notice, Row, SectionTitle, SelectField, Sheet, Source, Toggle } from '../ui';
import { useViewState } from '../viewState';
import { sessionVisible } from '../sourceAccess';
import { inListeningQuietHours, judgeListeningSignal, listeningArchivePreview, listeningConfigKey, listeningEndEligible, readListeningConfig, startListeningSession, validateListeningConfig, type ListeningConfig, type ListeningSignal } from '../listeningLogic';
import './Listening.css';

type Phase = 'idle' | 'standby' | 'detecting' | 'valid' | 'uncertain' | 'noise' | 'wake' | 'wake-missed' | 'quiet' | 'end' | 'archive-preview';
type ListeningDraft = { phase: Phase; signal?: ListeningSignal; sessionId?: string; allowQuietOnce?: boolean; error?: string };
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const phaseTitles: Record<Phase, string> = { idle: '先体验一段声音', standby: '等待一段有效对话', detecting: '正在判断这段声音', valid: '检测到有效对话', uncertain: '这段声音需要你核对', noise: '这段更像环境声', wake: '唤醒词已匹配', 'wake-missed': '没有匹配到唤醒词', quiet: '处于安静时段', end: '这场讨论可能结束了', 'archive-preview': '结束后将留下什么' };
export function listeningTitle(route: Route) { return route.view === 'settings-listening' ? '聆听设置' : '智能聆听'; }
export function ListeningEntry() { const { navigate } = useOops(); return <Row title="智能聆听" subtitle="有效对话、声音唤醒与自动起止" icon="waveform" onClick={() => navigate({ view: 'session-listening' })} />; }

function sampleSignal(kind: ListeningSignal['kind'], config: ListeningConfig): ListeningSignal {
  return { id: id('listen-sound'), kind, seconds: kind === 'wake' ? 2 : Math.max(24, config.minSeconds), confidence: kind === 'uncertain' ? 0.61 : kind === 'noise' ? 0.18 : 0.93,
    ...(kind === 'wake' ? { wakeText: config.wakeWord } : {}),
    turns: kind === 'noise' ? [] : kind === 'wake' ? [{ speaker: '我', text: `${config.wakeWord}，请留下接下来的讨论。` }] : [
      { speaker: '我', text: '这次先确认首版体验的目标，再安排下次走查。' },
      { speaker: kind === 'uncertain' ? '说话人待确认' : '说话人 B', text: '我赞成先把记录、核对结果和行动跟进这条流程跑通。' },
    ],
  };
}
function initialDraft(mode: string | undefined, config: ListeningConfig): ListeningDraft {
  const known: Phase[] = ['standby', 'detecting', 'valid', 'uncertain', 'noise', 'wake', 'wake-missed', 'quiet', 'end', 'archive-preview'];
  const phase = known.includes(mode as Phase) ? mode as Phase : 'idle';
  const signal = ['valid', 'detecting', 'uncertain', 'noise', 'wake', 'wake-missed'].includes(phase) ? sampleSignal(phase === 'uncertain' ? 'uncertain' : phase === 'noise' ? 'noise' : phase.startsWith('wake') ? 'wake' : 'conversation', config) : undefined;
  if (signal && phase === 'wake-missed') signal.wakeText = '请帮我记一下';
  return { phase, signal };
}

export function ListeningScreen() {
  const { route } = useOops();
  return route.view === 'settings-listening' ? <ListeningSettings /> : <ListeningExperience />;
}

function ListeningExperience() {
  const { data, update, route, navigate, toast, requestEnd } = useOops();
  const config = readListeningConfig(data);
  const [draft, setDraft] = useViewState<ListeningDraft>(`listening:${data.settings.space}:${route.id || 'new'}:${route.mode || 'main'}`, () => initialDraft(route.mode, config));
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const startGuard = useRef(false);
  const active = data.sessions.find(s => s.id === data.activeSessionId && !s.archived && ['进行中', '暂停'].includes(s.status));
  const visibleActive = active && sessionVisible(data, active.id) ? active : undefined;
  const last = data.sessions.find(s => s.id === (draft.sessionId || route.id) && sessionVisible(data, s.id));
  const preview = listeningArchivePreview(data, visibleActive?.id || last?.id || '');
  const allowed = data.settings.toggles.recordingAllowed !== false;
  const allowTeam = data.settings.space === '我的空间' || config.shared;
  const signal = draft.signal;

  function start(confirmed: boolean) {
    if (!signal || startGuard.current) return;
    const result = startListeningSession(data, signal, { sessionId: id('session'), config, confirmed, allowQuietOnce: draft.allowQuietOnce });
    if (result.error) { setDraft(d => ({ ...d, error: result.error })); return; }
    startGuard.current = true;
    update(current => startListeningSession(current, signal, { sessionId: result.sessionId!, config, confirmed, allowQuietOnce: draft.allowQuietOnce }).data);
    setDraft({ phase: 'standby', sessionId: result.sessionId });
    toast(confirmed ? '已确认这段对话，示例记录开始' : '有效对话已自动进入示例记录');
  }
  function standby() {
    startGuard.current = false;
    setDraft({ phase: inListeningQuietHours(config) ? 'quiet' : 'standby' });
  }
  function detect(kind: ListeningSignal['kind'], allowQuietOnce = false) {
    if (!allowed || active || !allowTeam) return;
    startGuard.current = false;
    if (inListeningQuietHours(config) && !allowQuietOnce) { setDraft({ phase: 'quiet' }); return; }
    setDraft({ phase: 'detecting', signal: sampleSignal(kind, config), ...(allowQuietOnce ? { allowQuietOnce: true } : {}) });
  }
  useEffect(() => {
    if (draft.phase !== 'detecting' || !signal || active) return;
    const timer = window.setTimeout(() => setDraft(current => current.phase === 'detecting' && current.signal?.id === signal.id ? { ...current, phase: judgeListeningSignal(signal, config) } : current), 1000);
    return () => window.clearTimeout(timer);
  }, [draft.phase, signal?.id, active?.id, config.wakeWord, config.minSeconds]);
  useEffect(() => {
    if (draft.phase !== 'valid' || config.startMode !== 'automatic' || !signal || active || !allowed || !allowTeam || draft.allowQuietOnce) return;
    const timer = window.setTimeout(() => start(false), 900);
    return () => window.clearTimeout(timer);
  }, [draft.phase, signal?.id, active?.id, config.startMode, allowed, allowTeam]);

  function endSuggestion() {
    if (!visibleActive || !listeningEndEligible(data, visibleActive.id)) return;
    setDraft(d => ({ ...d, phase: 'end', sessionId: visibleActive.id, error: undefined }));
    if (config.endMode === 'automatic') requestEnd(visibleActive.id);
  }
  function continueRecording() {
    if (!visibleActive || !listeningEndEligible(data, visibleActive.id)) return;
    update(current => ({ ...current, sessions: current.sessions.map(s => s.id === visibleActive.id && current.activeSessionId === s.id ? { ...s, status: '进行中' as const } : s) }));
    setDraft({ phase: 'standby', sessionId: visibleActive.id }); toast('已纠正结束判断，继续当前记录');
  }
  function submitCorrection() {
    if (!correction.trim()) return;
    startGuard.current = false;
    setDraft({ phase: 'uncertain', signal: { id: id('corrected-sound'), kind: 'uncertain', seconds: Math.max(config.minSeconds, 24), confidence: 0.61, turns: [{ speaker: '说话人待确认', text: correction.trim() }] } });
    setCorrecting(false); setCorrection('');
  }
  const currentPhase = visibleActive && draft.phase !== 'end' && draft.phase !== 'archive-preview' ? 'recording' : draft.phase;
  const phaseIcon = currentPhase === 'quiet' ? 'moon' : currentPhase === 'recording' ? 'microphone' : currentPhase === 'end' ? 'clock' : 'waveform';
  return <div className="stack listening-screen">
    <div className={`listen-hero listen-${currentPhase}`}><span className="listen-state-icon"><Icon name={phaseIcon} size={35} /></span><Badge tone={['uncertain', 'end'].includes(currentPhase) ? 'amber' : currentPhase === 'noise' || currentPhase === 'quiet' ? 'gray' : 'purple'}>{currentPhase === 'recording' ? '示例记录中' : currentPhase === 'detecting' ? '声音检测' : '本地流程体验'}</Badge><h2>{currentPhase === 'recording' ? '这一段对话正在留下' : phaseTitles[draft.phase]}</h2><p>{currentPhase === 'recording' ? '有效对话已进入会话，姓名仍需独立核对。' : currentPhase === 'quiet' ? `${config.quietStart}–${config.quietEnd} 暂不主动开始记录。` : currentPhase === 'noise' ? '暂不保留这段声音，也不创建会话。' : currentPhase === 'uncertain' ? '声音较短或判断不明确，确认后再保留。' : currentPhase === 'end' ? `示例检测到连续 ${config.silenceSeconds} 秒静默。` : '先判断是否需要记录，再留下值得继续处理的内容。'}</p><div className="listen-wave" aria-hidden="true">{Array.from({ length: 19 }, (_, index) => <i key={index} style={{ height: `${12 + (index * 17 % 39)}px`, animationDelay: `${index * -0.08}s` }} />)}</div></div>
    <p className="listen-demo-label"><Icon name="info" size={15} />示例声音与文本演示，麦克风未开启。</p>
    {!allowed && <Notice tone="warning">声音记录已关闭。<Row title="检查隐私设置" icon="lock-key" onClick={() => navigate({ view: 'settings-privacy' })} /></Notice>}
    {!allowTeam && <Notice>这次在项目空间，先确认保存范围再开始。<Row title="设置项目内共同纪要" icon="gear-six" onClick={() => navigate({ view: 'settings-listening' })} /><Button tone="quiet" onClick={() => { update(c => ({ ...c, settings: { ...c.settings, space: '我的空间' } })); navigate({ view: 'session-listening' }); }}>到我的空间体验</Button></Notice>}
    {active && !visibleActive && <Card><Badge tone="gray">另一个空间正在记录</Badge><h3>先处理已有活动记录</h3><p className="meta">同时只能保留一段活动记录。</p><Button tone="secondary" onClick={() => { update(c => ({ ...c, settings: { ...c.settings, space: '我的空间' } })); navigate({ view: 'session-detail', id: active.id }); }}>回到当前记录</Button></Card>}
    {visibleActive && <Card className="listen-current"><div className="listen-card-heading"><h3>{visibleActive.title}</h3><Badge>{visibleActive.status}</Badge></div><p className="meta">{visibleActive.duration || '00:00'} · {visibleActive.transcript.length} 段原话 · {data.settings.retention['session-' + visibleActive.id] || '完整保存'}</p>{draft.phase === 'end' ? <><Notice>静默也可能只是暂时休息，结束前仍会核对原话与私人便签的保存范围。</Notice><Button onClick={() => requestEnd(visibleActive.id)}>结束并确认保存范围</Button><Button tone="secondary" onClick={continueRecording}>会议还在继续</Button></> : <><Row title="打开当前会话" subtitle="查看原文、核对人物与会后行动" icon="chat-circle" onClick={() => navigate({ view: 'session-detail', id: visibleActive.id, mode: '现场' })} /><Button tone="secondary" onClick={endSuggestion}>体验静默结束判断</Button></>}<Row title="结束后保存预览" icon="tray" onClick={() => setPreviewOpen(true)} /></Card>}
    {!active && signal && !['standby', 'idle', 'quiet'].includes(draft.phase) && <Card className="listen-signal"><div className="listen-card-heading"><h3>{signal.kind === 'wake' ? '听到的唤醒指令' : '这段声音的判断'}</h3><Badge tone={draft.phase === 'uncertain' ? 'amber' : 'gray'}>{signal.seconds} 秒</Badge></div>{draft.phase === 'noise' ? <p className="meta">连续背景声，没有清楚的对话文本。</p> : signal.turns.map((turn, index) => <div className="listen-turn" key={index}><strong>{turn.speaker}</strong><p>{turn.text}</p></div>)}{draft.phase === 'uncertain' && <Notice>判断把握较低 · 61%。先核对是否有效对话，说话人保留为待确认。</Notice>}{draft.phase === 'valid' && <p className="meta">有连续对话 · 达到 {config.minSeconds} 秒阈值 · {config.startMode === 'automatic' && !draft.allowQuietOnce ? '将自动进入示例记录' : '确认后开始保留'}</p>}{draft.phase === 'wake' && <p className="meta">与当前唤醒词「{config.wakeWord}」匹配，确认后开始。</p>}{draft.phase === 'wake-missed' && <p className="meta">与当前唤醒词「{config.wakeWord}」不匹配，保持待机。</p>}</Card>}
    {!active && ['idle', 'standby'].includes(draft.phase) && <><Button disabled={!allowed || !allowTeam} icon={draft.phase === 'idle' ? 'play' : 'waveform'} onClick={draft.phase === 'idle' ? standby : () => detect('conversation')}>{draft.phase === 'idle' ? '开始体验' : '体验一段有效对话'}</Button>{draft.phase === 'standby' && <Button tone="secondary" disabled={!allowed || !allowTeam} onClick={() => detect('wake')}>体验声音唤醒</Button>}</>}
    {!active && ['valid', 'uncertain', 'wake'].includes(draft.phase) && <><Button disabled={!allowed || !allowTeam} onClick={() => start(true)}>{draft.phase === 'uncertain' ? '这是有效对话，确认记录' : draft.phase === 'wake' ? '确认唤醒并开始' : '保留这段并开始记录'}</Button><Button tone="quiet" onClick={standby}>{draft.phase === 'wake' ? '取消这次唤醒' : '不保留，返回待机'}</Button></>}
    {!active && draft.phase === 'noise' && <><Button tone="secondary" onClick={standby}>丢弃并继续等待</Button><Button tone="quiet" onClick={() => { setCorrection(''); setCorrecting(true); }}>判断有误，改为有效对话</Button></>}
    {!active && draft.phase === 'wake-missed' && <Button tone="secondary" onClick={standby}>返回待机</Button>}
    {!active && draft.phase === 'quiet' && <><Button disabled={!allowed || !allowTeam} tone="secondary" onClick={() => detect('conversation', true)}>仅本次手动开始</Button><Row title="调整安静时段" icon="moon" onClick={() => navigate({ view: 'settings-listening' })} /></>}
    {draft.error && <p className="error-text" role="alert">{draft.error}</p>}
    {!active && last?.status === '已结束' && <Card><Badge tone="green">会话已保存</Badge><h3>{last.title}</h3><p className="meta">{last.transcript.length} 段原话 · 仍有结果待核对</p><Button onClick={() => navigate({ view: 'session-detail', id: last.id, mode: '概览' })}>查看会后结果</Button></Card>}
    {!active && draft.phase === 'end' && <Empty title="先开始一段示例记录" body="检测会议结束需要绑定当前活动会话。" action="返回待机" onAction={standby} icon="clock" />}
    {draft.phase === 'archive-preview' && <Card><h3>自动归档预览</h3><p>{config.saveScope} · 保存到 {data.settings.space}</p><p className="meta">自动判断只提出结束建议；保存时仍核对片段、私人便签和项目共享范围。</p><Button tone="secondary" onClick={standby}>返回聆听</Button></Card>}
    <Card><Row title="聆听设置" subtitle={`${config.wakeWord} · 有效对话 ${config.minSeconds} 秒 · 静默 ${config.silenceSeconds} 秒`} icon="gear-six" onClick={() => navigate({ view: 'settings-listening' })} /><div className="listen-save-summary"><Icon name="lock-key" size={16} /><span>{config.saveScope} · {data.settings.space === '我的空间' ? '仅自己可见' : config.shared ? '项目内共同纪要' : '尚未允许项目共享'}</span></div>{data.settings.toggles.memory === false && <p className="meta">长期记忆已关闭，本次不自动建立新记忆。</p>}</Card>
    <details className="listen-scenarios"><summary>查看其他示例情境</summary><p className="meta">用预设声音体验不同判断；不改变真实设备状态。</p><div className="listen-scenario-buttons"><Button tone="quiet" disabled={!!active || !allowed || !allowTeam} onClick={() => detect('uncertain')}>较短／不确定对话</Button><Button tone="quiet" disabled={!!active || !allowed || !allowTeam} onClick={() => detect('noise')}>环境声</Button><Button tone="quiet" disabled={!!active} onClick={() => { setDraft({ phase: 'quiet' }); startGuard.current = false; }}>安静时段</Button><Button tone="quiet" onClick={() => setPreviewOpen(true)}>保存范围预览</Button></div></details>
    <Sheet open={correcting} onClose={() => setCorrecting(false)} title="纠正这段声音的判断"><Notice>补充你听到的内容，确认后按有效对话保留；人物身份之后再核对。</Notice><Field label="这段对话说了什么" value={correction} onChange={setCorrection} multiline placeholder="写下需要保留的对话" /><Button disabled={!correction.trim()} onClick={submitCorrection}>保存修正，继续核对</Button><Button tone="quiet" onClick={() => setCorrecting(false)}>取消</Button></Sheet>
    <Sheet open={previewOpen} onClose={() => setPreviewOpen(false)} title="结束后保存预览"><Card><h3>{preview?.title || '下一段智能聆听'}</h3><Row title="原话保存范围" subtitle={preview?.scope || config.saveScope} icon="waveform" /><Row title="原话片段" subtitle={preview ? `${preview.turns} 段，结束时再选择` : '产生对话后才有可保存的片段'} icon="quotes" /><Row title="保存位置" subtitle={data.settings.space} icon="lock-key" /><Row title="长期记忆" subtitle={data.settings.toggles.memory === false ? '已关闭，不自动新建记忆' : '会后候选需独立核对，不自动接受'} icon="bookmark-simple" /></Card><Notice>结束判断不会直接丢弃或保存内容。下一步会暂停当前记录，并核对原话与私人便签。</Notice>{visibleActive ? <Button onClick={() => { setPreviewOpen(false); requestEnd(visibleActive.id); }}>结束并检查保存范围</Button> : <Button tone="secondary" onClick={() => setPreviewOpen(false)}>知道了</Button>}{last?.transcript[0] && <Source title="已保留的原话" time={last.transcript[0].time} onClick={() => { setPreviewOpen(false); navigate({ view: 'session-transcript', id: last.id, mode: last.transcript[0].id }); }} />}</Sheet>
  </div>;
}

function ListeningSettings() {
  const { data, update, navigate, toast } = useOops();
  const [config, setConfig] = useViewState<ListeningConfig>(`listening-settings:${data.settings.space}`, () => readListeningConfig(data));
  const [numbers, setNumbers] = useState(() => ({ min: String(config.minSeconds), silence: String(config.silenceSeconds) }));
  const [error, setError] = useState('');
  const patch = (change: Partial<ListeningConfig>) => setConfig(previous => ({ ...previous, ...change }));
  function save() {
    const next = { ...config, wakeWord: config.wakeWord.trim(), minSeconds: Number(numbers.min), silenceSeconds: Number(numbers.silence) };
    const failure = validateListeningConfig(next);
    if (failure) { setError(failure); return; }
    setConfig(next); update(current => ({ ...current, settings: { ...current.settings, retention: { ...current.settings.retention, [listeningConfigKey(current.settings.space)]: JSON.stringify(next) } } }));
    setError(''); toast('聆听偏好已保存'); navigate({ view: 'session-listening' });
  }
  return <form className="stack listening-screen" onSubmit={event => { event.preventDefault(); save(); }}><Notice>调整示例流程中的判断与保存方式。当前前端未开启后台监听。</Notice><Card><SectionTitle>什么时候开始</SectionTitle><Field label="唤醒词" value={config.wakeWord} onChange={wakeWord => patch({ wakeWord })} placeholder="你好 Oops" hint="唤醒成功会显示识别结果，可取消这次开始。" /><Field label="最小有效对话时长（秒）" type="number" value={numbers.min} onChange={min => setNumbers(previous => ({ ...previous, min }))} hint="5–120 秒；声音不明确时始终先确认。" /><SelectField label="有效对话后的开始方式" value={config.startMode === 'confirm' ? '建议后确认' : '自动开始（示例）'} onChange={value => patch({ startMode: value === '建议后确认' ? 'confirm' : 'automatic' })} options={['建议后确认', '自动开始（示例）']} /></Card><Card><SectionTitle>什么时候结束</SectionTitle><Field label="静默结束时长（秒）" type="number" value={numbers.silence} onChange={silence => setNumbers(previous => ({ ...previous, silence }))} hint="30–1800 秒；可纠正暂时休息造成的判断。" /><SelectField label="静默后的结束方式" value={config.endMode === 'confirm' ? '建议后确认' : '自动进入保存核对（示例）'} onChange={value => patch({ endMode: value === '建议后确认' ? 'confirm' : 'automatic' })} options={['建议后确认', '自动进入保存核对（示例）']} /><p className="meta">两种方式都先暂停，再检查保存范围；取消结束会恢复原记录状态。</p></Card><Card><SectionTitle>安静时段</SectionTitle><Toggle label="安静时段不主动开始" value={config.quietEnabled} onChange={quietEnabled => patch({ quietEnabled })} hint="仍可以明确选择仅本次手动记录。" />{config.quietEnabled && <><Field label="开始时间" value={config.quietStart} onChange={quietStart => patch({ quietStart })} placeholder="22:00" /><Field label="结束时间" value={config.quietEnd} onChange={quietEnd => patch({ quietEnd })} placeholder="08:00" /><p className="meta">北京时间，可跨过午夜。</p></>}</Card><Card><SectionTitle>保存偏好</SectionTitle><SelectField label="结束后保留什么" value={config.saveScope} onChange={saveScope => patch({ saveScope: saveScope as ListeningConfig['saveScope'] })} options={['完整保存', '仅保存非敏感片段', '手动选择片段']} />{data.settings.space !== '我的空间' && <Check label="允许当前项目查看共同纪要" value={config.shared} onChange={shared => patch({ shared })} />}<p className="meta">保存到 {data.settings.space}。私人便签及敏感片段不进入共同纪要，长期记忆另行确认。</p><Row title="隐私与长期记忆设置" icon="lock-key" onClick={() => navigate({ view: 'settings-privacy' })} /></Card>{error && <p className="error-text" role="alert">{error}</p>}<Button type="submit">保存并返回聆听</Button><Button tone="quiet" onClick={() => navigate({ view: 'session-listening' })}>暂不保存</Button></form>;
}
