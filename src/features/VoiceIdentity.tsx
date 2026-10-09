import { useState } from 'react';
import { useOops } from '../store';
import { useViewState } from '../viewState';
import { Avatar, Badge, Button, Card, Check, Chips, Empty, Field, Icon, Notice, Row, SectionTitle, SelectField, Sheet } from '../ui';
import { SELF_VOICE_ID, addVoiceSample, bindVoiceSample, currentVoiceMatch, resolveVoiceMatch, revokeContactVoice, runVoiceMatch, unbindVoiceSample, voiceContactConfirmed, voiceMatches, voiceSamples, voiceSubjectAllowed, voiceSubjectName, voiceSubjects, type VoiceMatch, type VoiceSample } from '../voiceIdentityLogic';
import './VoiceIdentity.css';

const newId = (prefix: string) => prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const createdNow = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const phrase = '今天我想把重要的想法记下来，让每一步都更清楚。';
const sampleLabel = (sample: VoiceSample) => `${sample.label} · ${sample.id.slice(-4)}`;
const statusTone = (status: VoiceMatch['status']) => status === '已匹配' || status === '已纠正' ? 'green' : status === '保持匿名' ? 'gray' : 'orange';

function Waveform({ active = false }: { active?: boolean }) {
  return <div className={'vi-waveform' + (active ? ' active' : '')} aria-label={active ? '声音采集示例进行中' : '声音样本示意'}>{[14, 25, 37, 19, 46, 30, 52, 34, 20, 42, 29, 48, 31, 18, 38, 24, 13].map((height, index) => <span key={index} style={{ height, animationDelay: `${index * .06}s` }} />)}</div>;
}

function PersonalOnly() {
  const { navigate } = useOops();
  return <Empty title="在个人空间管理声音身份" body="声音样本和识别核对保留在你的个人空间。" action="切换工作空间" onAction={() => navigate({ view: 'settings-spaces' })} icon="waveform" />;
}

function SubjectPicker({ sample, matchId, initialId, onComplete }: { sample: VoiceSample; matchId?: string; initialId?: string; onComplete: () => void }) {
  const { data, update, navigate, toast } = useOops();
  const subjects = voiceSubjects(data);
  const firstId = initialId || sample.subjectId || SELF_VOICE_ID;
  const [subjectId, setSubjectId] = useState(subjects.some(subject => subject.id === firstId) ? firstId : SELF_VOICE_ID);
  const [checked, setChecked] = useState(false);
  const [grant, setGrant] = useState(false);
  const [error, setError] = useState('');
  const subject = subjects.find(item => item.id === subjectId);
  const person = data.people.find(item => item.id === subjectId);
  const selfNeedsRegistration = subjectId === SELF_VOICE_ID && !data.settings.toggles.voice;
  const needsPermission = !!person && !person.voice;
  const save = () => {
    if (!checked) { setError('请先核对这段声音与所选身份'); return; }
    const apply = matchId ? (current: typeof data) => resolveVoiceMatch(current, matchId, subjectId, grant) : (current: typeof data) => bindVoiceSample(current, sample.id, subjectId, grant);
    const result = apply(data);
    if (result.error) { setError(result.error); return; }
    update(current => apply(current).data);
    toast(matchId ? '声音识别结果已核对' : '声音样本已关联');
    onComplete();
  };
  return <div className="stack vi-subject-picker"><Badge tone="gray">{sample.label} · {sample.duration} 秒</Badge><SelectField label="关联到哪个身份" value={subject?.label || '请选择已确认的身份'} options={subjects.map(item => item.label)} onChange={label => { setSubjectId(subjects.find(item => item.label === label)?.id || ''); setChecked(false); setGrant(false); setError(''); }} />{selfNeedsRegistration ? <><Notice>先完成本人的声音登记，再把样本关联到自己。</Notice><Button tone="secondary" onClick={() => { onComplete(); navigate({ view: 'settings-voice' }); }}>完成我的声音登记</Button></> : <Badge tone={needsPermission ? 'orange' : 'green'}>{needsPermission ? '姓名已确认 · 声音许可待允许' : '个人声音识别已允许'}</Badge>}<Check label={`我已核对这段声音属于「${subject?.name || '所选身份'}」`} value={checked} onChange={setChecked} />{needsPermission && <Check label="另行允许在个人空间使用此人的声音识别示例" value={grant} onChange={setGrant} />}<p className="meta">这次只调整声音样本与身份的对应。会话原话中的说话人仍需逐段核对。</p>{error && <p className="error-text" role="alert">{error}</p>}<Button disabled={selfNeedsRegistration || !checked || needsPermission && !grant} onClick={save}>{matchId ? '确认识别结果与声音关联' : '保存声音关联'}</Button></div>;
}

export function VoiceIdentitySamples() {
  const { data, route, update, navigate, toast } = useOops();
  const [filter, setFilter] = useViewState('voice-sample-filter:' + data.settings.space + ':' + (route.id || 'all'), '全部');
  const [capture, setCapture] = useState(false);
  const [stage, setStage] = useState(0);
  const [label, setLabel] = useViewState('voice-sample-draft:' + data.settings.space + ':' + (route.id || 'all'), '');
  const [quality, setQuality] = useState<VoiceSample['quality']>('清晰');
  const [selectedId, setSelectedId] = useState('');
  const [removal, setRemoval] = useState<{ id: string; remove: boolean }>();
  const [revoke, setRevoke] = useState(false);
  const [error, setError] = useState('');
  if (data.settings.space !== '我的空间') return <PersonalOnly />;
  const scopedPerson = data.people.find(person => person.id === route.id);
  if (route.id && (!scopedPerson || !voiceContactConfirmed(data, scopedPerson))) return <Empty title="先核对联系人身份" body="选择已确认的联系人后，再关联声音样本。" action="核对说话人" onAction={() => navigate({ view: 'memory-unknown', id: route.id })} />;
  const samples = voiceSamples(data).filter(sample => !route.id || sample.subjectId === route.id || !sample.subjectId);
  const filtered = samples.filter(sample => filter === '全部' || (filter === '已关联' ? !!sample.subjectId && voiceSubjectAllowed(data, sample.subjectId) : !sample.subjectId || !voiceSubjectAllowed(data, sample.subjectId)));
  const selected = voiceSamples(data).find(sample => sample.id === selectedId);
  const matches = voiceMatches(data).filter(match => samples.some(sample => sample.id === match.sampleId));
  const saveSample = () => {
    const sample: VoiceSample = { id: newId('voice-sample'), label: label.trim(), phrase, duration: 8, quality, created: createdNow() };
    const result = addVoiceSample(data, sample);
    if (result.error) { setError(result.error); return; }
    update(current => addVoiceSample(current, sample).data);
    setCapture(false); setStage(0); setLabel(''); setError(''); setSelectedId(sample.id); toast('示例声音已保存，请关联明确身份');
  };
  return <div className="stack voice-identity"><Card className="vi-hero"><div className="vi-heading"><span className="vi-hero-icon"><Icon name="waveform" size={28} /></span><Badge tone="gray">声音 ID · 前端示例</Badge></div><h2>{scopedPerson ? scopedPerson.name + '的声音关联' : '声音样本与身份'}</h2><p>保存一段示例声音，关联到本人或已确认的联系人，再核对识别结果。</p><div className="stat-grid"><div className="stat"><strong>{samples.length}</strong><span>声音样本</span></div><div className="stat"><strong>{matches.filter(match => currentVoiceMatch(data, match).status === '待确认').length}</strong><span>待核对结果</span></div></div></Card><Button icon="microphone" onClick={() => { setStage(0); setQuality('清晰'); setError(''); if (!label) setLabel(scopedPerson ? scopedPerson.name + ' · 对话声音' : '我的声音片段'); setCapture(true); }}>采集示例声音</Button>{scopedPerson && <Card><div className="vi-heading"><strong>个人声音识别许可</strong><Badge tone={scopedPerson.voice ? 'green' : 'orange'}>{scopedPerson.voice ? '已允许' : '未允许'}</Badge></div><p className="meta">姓名已确认；声音识别单独授权。关闭许可后，已有样本保留，识别结果需要重新核对。</p>{scopedPerson.voice && <Button tone="quiet" onClick={() => setRevoke(true)}>关闭此人的声音识别许可</Button>}</Card>}<Chips items={['全部', '待关联', '已关联']} value={filter} onChange={setFilter} />{filtered.length ? filtered.map(sample => <Card key={sample.id}><div className="vi-heading"><strong>{sample.label}</strong><Badge tone={sample.subjectId && voiceSubjectAllowed(data, sample.subjectId) ? 'green' : 'orange'}>{sample.subjectId ? voiceSubjectAllowed(data, sample.subjectId) ? '已关联' : '许可需核对' : '待关联'}</Badge></div><Waveform /><div className="vi-sample-meta"><span>{sample.duration} 秒 · {sample.quality}</span><span>{sample.created}</span></div><div className="vi-person"><Avatar name={sample.subjectId ? voiceSubjectName(data, sample.subjectId) : '?'} /><div><strong>{voiceSubjectName(data, sample.subjectId)}</strong><p className="meta">{sample.subjectId ? '个人空间声音关联' : '尚未确认对应身份'}</p></div></div><div className="action-grid"><Button tone="secondary" onClick={() => setSelectedId(sample.id)}>{sample.subjectId ? '修改关联' : '关联身份'}</Button><Button tone="secondary" onClick={() => navigate({ view: 'settings-voice-match', id: route.id, mode: sample.id })}>识别这段</Button></div><div className="vi-small-actions">{sample.subjectId && <Button tone="quiet" onClick={() => setRemoval({ id: sample.id, remove: false })}>解绑身份</Button>}<Button tone="quiet" onClick={() => setRemoval({ id: sample.id, remove: true })}>删除样本</Button></div></Card>) : <Empty title={filter === '全部' ? '还没有声音样本' : '这个分组没有样本'} body="采集一段示例声音后，可逐个关联和核对。" icon="waveform" />}<Card><Row title="声音识别与核对" subtitle="匹配、低置信度、失败与改正" icon="waveform" onClick={() => navigate({ view: 'settings-voice-match', id: route.id })} /><Row title="本人的声音登记" subtitle={data.settings.toggles.voice ? '已完成个人登记' : '还未完成登记'} icon="user-circle" onClick={() => navigate({ view: 'settings-voice' })} /></Card><p className="meta">使用示例声音片段体验流程，不调用麦克风或真实声纹服务。</p><Sheet open={capture} onClose={() => setCapture(false)} title="采集示例声音"><div className="stack"><Badge tone="gray">声音采集示例</Badge><Card className="vi-capture"><Waveform active={stage === 1} /><h3>{stage === 0 ? '准备读一段话' : stage === 1 ? '示例采集中' : '片段已准备'}</h3><p>{phrase}</p><p className="meta">{stage === 2 ? '8 秒 · 可核对采集质量' : '自然说话，保持与平时对话相近的声音。'}</p></Card>{stage === 0 ? <Button onClick={() => setStage(1)}>开始示例采集</Button> : stage === 1 ? <Button onClick={() => setStage(2)}>完成示例片段</Button> : <><Field label="样本名称" value={label} onChange={setLabel} placeholder="例如：上午对话声音" /><SelectField label="采集质量示例" value={quality} options={['清晰', '较弱', '噪声']} onChange={value => setQuality(value as VoiceSample['quality'])} />{quality !== '清晰' && <Notice>这段声音较弱或有噪声。可先保存，再体验低置信度或重新采集。</Notice>}{error && <p className="error-text" role="alert">{error}</p>}<Button disabled={!label.trim()} onClick={saveSample}>保存片段并关联身份</Button><Button tone="secondary" onClick={() => setStage(1)}>重新采集示例</Button></>}</div></Sheet><Sheet open={!!selected} onClose={() => setSelectedId('')} title="核对声音关联">{selected && <SubjectPicker key={selected.id} sample={selected} initialId={route.id} onComplete={() => setSelectedId('')} />}</Sheet><Sheet open={revoke} onClose={() => setRevoke(false)} title="关闭声音识别许可？"><p>保留联系人姓名和声音样本，关闭个人及项目声音识别范围。</p><Button tone="danger" onClick={() => { if (!scopedPerson) return; update(current => revokeContactVoice(current, scopedPerson.id).data); setRevoke(false); toast('声音识别许可已关闭，姓名确认保留'); }}>确认关闭许可</Button></Sheet><Sheet open={!!removal} onClose={() => setRemoval(undefined)} title={removal?.remove ? '删除声音样本？' : '解绑声音与身份？'}><p>{removal?.remove ? '移除这段样本和它的识别记录。联系人身份、姓名确认和其他声音样本保留。' : '这段声音不再对应当前身份，它的既有识别结果将重新待核对。'}</p><Button tone="danger" onClick={() => { if (!removal) return; const result = unbindVoiceSample(data, removal.id, removal.remove); if (result.error) { toast(result.error); return; } update(current => unbindVoiceSample(current, removal.id, removal.remove).data); toast(removal.remove ? '声音样本已删除' : '声音关联已解绑'); setRemoval(undefined); }}>{removal?.remove ? '确认删除样本' : '确认解绑'}</Button></Sheet></div>;
}

export function VoiceIdentityMatch() {
  const { data, route, update, navigate, toast } = useOops();
  const key = 'voice-match-view:' + data.settings.space + ':' + (route.id || 'all') + ':' + (route.mode || 'any');
  const [sampleId, setSampleId] = useViewState(key + ':sample', route.mode || '');
  const [scenario, setScenario] = useViewState<VoiceMatch['scenario']>(key + ':scenario', '匹配');
  const [activeId, setActiveId] = useViewState(key + ':result', '');
  const [correctingId, setCorrectingId] = useState('');
  const [error, setError] = useState('');
  if (data.settings.space !== '我的空间') return <PersonalOnly />;
  const samples = voiceSamples(data).filter(sample => !route.id || sample.subjectId === route.id || !sample.subjectId);
  if (!samples.length) return <div className="stack"><Badge tone="gray">声音 ID · 前端示例</Badge><Empty title="先保存一段声音样本" body="声音样本可关联到本人或已确认的联系人，再体验识别和核对。" action="采集示例声音" onAction={() => navigate({ view: 'settings-voice-identities', id: route.id })} icon="waveform" /></div>;
  const selected = samples.find(sample => sample.id === sampleId) || samples[0];
  const matches = voiceMatches(data).filter(match => samples.some(sample => sample.id === match.sampleId)).map(match => currentVoiceMatch(data, match));
  const result = matches.find(match => match.id === activeId) || matches.find(match => match.sampleId === selected.id);
  const correcting = matches.find(match => match.id === correctingId);
  const correctingSample = samples.find(sample => sample.id === correcting?.sampleId);
  const recognize = () => {
    const id = newId('voice-match'), created = createdNow();
    const result = runVoiceMatch(data, selected.id, scenario, id, created);
    if (result.error) { setError(result.error); return; }
    update(current => runVoiceMatch(current, selected.id, scenario, id, created).data);
    setActiveId(id); setSampleId(selected.id); setError(''); toast('示例识别结果已生成');
  };
  return <div className="stack voice-identity"><Card className="vi-hero"><div className="vi-heading"><Icon name="waveform" size={28} /><Badge tone="gray">识别结果示例</Badge></div><h2>这一段声音属于谁</h2><p>核对识别出的身份；不确定时可以重试，或保持匿名。</p></Card><SelectField label="选择声音样本" value={sampleLabel(selected)} options={samples.map(sampleLabel)} onChange={label => { setSampleId(samples.find(sample => sampleLabel(sample) === label)?.id || ''); setActiveId(''); setError(''); }} /><Card><Waveform /><div className="vi-heading"><strong>{selected.label}</strong><Badge tone="gray">{selected.quality} · {selected.duration} 秒</Badge></div><p className="meta">当前关联：{voiceSubjectName(data, selected.subjectId)}{selected.subjectId && !voiceSubjectAllowed(data, selected.subjectId) ? ' · 个人声音许可需核对' : ''}</p></Card><p className="meta">下一次识别要体验哪种结果</p><Chips items={['匹配', '低置信度', '识别失败']} value={scenario} onChange={value => setScenario(value as VoiceMatch['scenario'])} />{error && <p className="error-text" role="alert">{error}</p>}<Button icon="waveform" onClick={recognize}>{result ? '重新识别示例片段' : '识别示例片段'}</Button>{result && <Card className="vi-result"><div className="vi-heading"><Badge tone={statusTone(result.status)}>{result.status}</Badge><span className="meta">{result.created}</span></div><h2>{result.confirmedSubjectId ? voiceSubjectName(data, result.confirmedSubjectId) : result.proposedSubjectId ? voiceSubjectName(data, result.proposedSubjectId) + '？' : result.status === '保持匿名' ? '暂不确认身份' : '还不能确认是谁'}</h2>{result.previousSubjectId && <p className="meta">原匹配：{voiceSubjectName(data, result.previousSubjectId)} → 已纠正为：{voiceSubjectName(data, result.confirmedSubjectId)}</p>}{result.confidence > 0 && <div className="vi-confidence"><div><span>{result.confidence === 100 ? '人工核对' : result.status === '待确认' ? '候选匹配度' : '示例匹配度'}</span><strong>{result.confidence}%</strong></div><div className="vi-confidence-track"><span style={{ width: result.confidence + '%' }} /></div></div>}<p>{result.reason}</p><p className="meta">{voiceSamples(data).find(sample => sample.id === result.sampleId)?.label} · 仅此声音样本</p><Button tone="secondary" onClick={() => setCorrectingId(result.id)}>{result.status === '待确认' || result.status === '识别失败' || result.status === '保持匿名' ? '人工选择并核对身份' : '结果不对，改正声音关联'}</Button>{result.status !== '保持匿名' && <Button tone="quiet" onClick={() => { update(current => resolveVoiceMatch(current, result.id, undefined).data); toast('这条结果保持匿名'); }}>保持匿名</Button>}</Card>}<SectionTitle>最近识别记录</SectionTitle>{matches.length ? <Card>{matches.slice(0, 6).map(match => <Row key={match.id} title={voiceSamples(data).find(sample => sample.id === match.sampleId)?.label || '声音片段'} subtitle={`${match.confirmedSubjectId ? voiceSubjectName(data, match.confirmedSubjectId) : match.proposedSubjectId ? '候选：' + voiceSubjectName(data, match.proposedSubjectId) : '尚未确认身份'} · ${match.created}`} badge={match.status} icon="waveform" onClick={() => setActiveId(match.id)} />)}</Card> : <Notice>识别后，结果会保留在这里，便于重新核对。</Notice>}<Button tone="secondary" onClick={() => navigate({ view: 'settings-voice-identities', id: route.id })}>管理声音样本与关联</Button><Sheet open={!!correcting && !!correctingSample} onClose={() => setCorrectingId('')} title="核对识别出的身份">{correcting && correctingSample && <SubjectPicker key={correcting.id} sample={correctingSample} matchId={correcting.id} initialId={correcting.proposedSubjectId || route.id} onComplete={() => setCorrectingId('')} />}</Sheet></div>;
}
