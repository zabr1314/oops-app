import { useState } from 'react';
import { useOops } from '../store';
import { useViewState } from '../viewState';
import { autoListenEnabled, deviceStartupStatus, initialDeviceRuntime, pairStartupDevice, setAutoListenPreference,
  transitionDeviceStartup, unpairStartupDevice, type DeviceCondition, type DeviceStartupRuntime } from '../deviceStartupLogic';
import { Badge, Button, Card, Check, Icon, Notice, Row, SectionTitle, SelectField, Sheet, Toggle } from '../ui';
import './DeviceStartup.css';

const conditions: { value: DeviceCondition; label: string; help: string }[] = [
  { value: 'off', label: '尚未开机', help: '打开设备后，才会检查是否需要开始聆听。' },
  { value: 'ready', label: '设备与服务就绪', help: '已连接，声音记录与后台运行条件就绪。' },
  { value: 'permission', label: '声音权限缺失', help: '先检查系统麦克风与应用内声音记录选择。' },
  { value: 'background', label: '后台运行受限', help: '回到应用检查运行状态，允许后再明确恢复。' },
  { value: 'disconnected', label: '设备断连', help: '检查电源和连接；重连后仍尊重暂停、停止选择。' },
  { value: 'quiet', label: '安静时段', help: '安静时段不主动开始，离开安静时段后再确认恢复。' },
  { value: 'service', label: '聆听服务不可用', help: '检查连接与服务状态，恢复后不会擅自重新开始。' },
];

function previewRuntime(data: ReturnType<typeof useOops>['data']): DeviceStartupRuntime {
  if (new URLSearchParams(window.location.search).has('board-preview')) {
    const condition = data.settings.retention['board-device-condition'] as DeviceCondition;
    if (conditions.some(item => item.value === condition)) return { condition, recoveryRequired: data.settings.toggles['board-device-recovery'] === true };
  }
  return initialDeviceRuntime();
}

export function DevicePair() {
  const { data, update, route, navigate, toast } = useOops();
  const [device, setDevice] = useState(route.id || '录音豆');
  const [stage, setStage] = useState<'scan' | 'found' | 'failed' | 'done'>('scan');
  const [enabled, setEnabled] = useState(false);
  const [, setRuntime] = useViewState<DeviceStartupRuntime>('device-startup-runtime:' + device, initialDeviceRuntime);
  const changeDevice = (next: string) => { setDevice(next); setStage('scan'); setEnabled(false); };
  function pair() {
    update(current => pairStartupDevice(current, device, enabled));
    setRuntime(initialDeviceRuntime()); setStage('done');
    toast(enabled ? '配对完成，已保存开机聆听选择' : '配对完成，开机自动聆听保持关闭');
  }
  return <div className="stack device-startup">
    <Notice>本机配对示例，不请求蓝牙或麦克风，不连接真实录音豆。</Notice>
    <SelectField label="设备类型" value={device} onChange={changeDevice} options={['录音豆', '桌面伙伴', '会议室入口']} />
    <Card className="ds-pair-hero"><Icon name="bluetooth" size={42} /><Badge tone={stage === 'done' ? 'green' : 'gray'}>{stage === 'done' ? '示例配对完成' : '设备配对'}</Badge>
      <h2>{stage === 'scan' ? '让设备靠近手机' : stage === 'found' ? device + ' · OOPS Demo' : stage === 'failed' ? '没有连接成功' : '现在，决定它怎样陪你'}</h2>
      <p className="meta">{stage === 'failed' ? '检查设备电源后重新扫描，未保存任何配对选择。' : stage === 'done' ? enabled ? '已选择：开机自动进入日常临时聆听。' : '已选择：开机只连接，需要时手动开始。' : '这里展示配对步骤，设备开机状态需另行核对。'}</p>
    </Card>
    {stage === 'scan' || stage === 'failed' ? <Button onClick={() => setStage('found')}>{stage === 'failed' ? '重新扫描' : '扫描示例设备'}</Button> : stage === 'found' ? <>
      <Card><h3>开机后如何开始？</h3><Check label="这台设备开机后自动聆听" value={enabled} onChange={setEnabled} />
        <p className="meta">默认关闭。选择开启后，只在设备、权限和服务就绪时进入日常临时聆听；暂停、停止和安静时段优先。</p>
        <p className="meta">完整原音和临时全文滚动保留最近5分钟，停止清除；正式会议云保存仍需单独选择。</p>
      </Card><Button onClick={pair}>确认配对并保存选择</Button><Button tone="secondary" onClick={() => setStage('failed')}>体验连接失败</Button>
    </> : <><Button onClick={() => navigate({ view: 'settings-device', id: device })}>查看设备与聆听</Button><Button tone="secondary" onClick={() => navigate({ view: 'settings-devices' })}>返回设备列表</Button></>}
    <p className="meta">配对不会自动注册声纹、确认人物身份或开启内容共享。</p>
  </div>;
}

export function DeviceDetail() {
  const { data, route, update, navigate, toast, requestEnd } = useOops();
  const device = route.id || '录音豆';
  const [runtime, setRuntime] = useViewState<DeviceStartupRuntime>('device-startup-runtime:' + device, () => previewRuntime(data));
  const [remove, setRemove] = useState(false);
  const [enable, setEnable] = useState(false);
  const connected = !!data.settings.devices[device];
  const enabled = autoListenEnabled(data, device);
  const status = deviceStartupStatus(data, device, runtime);
  const condition = conditions.find(item => item.value === runtime.condition)!;
  function run(type: 'signal' | 'recover' | 'pause', nextRuntime = runtime) {
    const options = { sessionId: 'session-device-' + crypto.randomUUID(), now: new Date() };
    const outcome = transitionDeviceStartup(data, nextRuntime, device, { type }, options);
    update(current => transitionDeviceStartup(current, nextRuntime, device, { type }, options).data);
    setRuntime(outcome.runtime); toast(outcome.message);
  }
  function chooseCondition(label: string) {
    const condition = conditions.find(item => item.label === label)!.value;
    const options = { sessionId: '', now: new Date() };
    const event = { type: 'condition' as const, condition };
    const outcome = transitionDeviceStartup(data, runtime, device, event, options);
    update(current => transitionDeviceStartup(current, runtime, device, event, options).data);
    setRuntime(outcome.runtime);
  }
  const toggle = (key: string, value: boolean) => update(current => ({ ...current, settings: { ...current.settings, toggles: { ...current.settings.toggles, [key]: value } } }));
  return <div className="stack device-startup">
    <Notice>设备与启动均为前端示例，不连接真实硬件。</Notice>
    <Card className="ds-device-head"><span className="ds-device-icon"><Icon name="microphone" size={32} /></span><div><h2>{device}</h2><p className="meta">{connected ? '已完成本机示例配对' : '尚未配对'}</p></div><Badge tone={connected ? 'green' : 'gray'}>{connected ? '示例设备' : '未配对'}</Badge></Card>
    {!connected ? <Button onClick={() => navigate({ view: 'settings-pair', id: device })}>配对设备</Button> : <>
      <SectionTitle>开机与恢复体验</SectionTitle>
      <Card className={'ds-status ds-' + status.phase}><div className="ds-status-heading"><Icon name={status.phase === 'listening' ? 'ear' : status.phase === 'blocked' ? 'warning-circle' : 'power'} size={27} /><Badge tone={status.phase === 'listening' ? 'green' : 'gray'}>前端示例</Badge></div><h3 role="status">{status.title}</h3><p>{status.body}</p>
        {status.sessionId && <Button tone="quiet" onClick={() => navigate({ view: 'session-detail', id: status.sessionId, mode: '现场' })}>查看当前记录</Button>}
      </Card>
      <SelectField label="设备条件（示例）" value={condition.label} onChange={chooseCondition} options={conditions.map(item => item.label)} />
      <p className="meta">{condition.help}</p>
      <Button tone="secondary" icon="power" onClick={() => run('signal', runtime.condition === 'off' ? { ...runtime, condition: 'ready' } : runtime)}>体验设备开机／重连</Button>
      {status.canRecover && <Button onClick={() => run('recover')}>{status.sessionId ? '明确继续这段聆听' : '明确恢复日常聆听'}</Button>}
      {status.phase === 'listening' && <div className="ds-controls"><Button tone="secondary" onClick={() => run('pause')}>暂停聆听</Button><Button tone="danger" onClick={() => status.sessionId && requestEnd(status.sessionId)}>停止并检查重点</Button></div>}
      {status.phase === 'disabled' && <Button onClick={() => navigate({ view: 'session-create', mode: '日常' })}>手动开始日常记录</Button>}
      {(runtime.condition === 'permission' || data.settings.toggles.recordingAllowed === false) && <Button tone="quiet" onClick={() => navigate({ view: 'settings-privacy' })}>检查声音记录选择</Button>}
      <p className="meta">返回就绪只改变示例条件；受限后需明确恢复。暂停或停止后，重连不会擅自开始。</p>
      <SectionTitle>开机聆听偏好</SectionTitle>
      <Card><Toggle label="开机自动聆听" value={enabled} onChange={value => { if (value) setEnable(true); else { update(current => setAutoListenPreference(current, device, false)); toast('已关闭，当前记录可手动继续或结束'); } }} hint="只对这台已配对设备生效；保存选择本身不会启动录音。" />
        <Row title="聆听与安静时段" subtitle="唤醒、对话检测和安静时段单独设置" icon="ear" onClick={() => navigate({ view: 'settings-listening', id: device, mode: 'device-startup' })} />
        <Row title="会议保存与期限" subtitle="会议云保存需要每场明确选择" icon="clock" onClick={() => navigate({ view: 'settings-retention' })} />
      </Card>
      <SectionTitle>设备偏好</SectionTitle><Card><Toggle label="按键启动记录" value={data.settings.toggles['buttonRecord:' + device] !== false} onChange={value => toggle('buttonRecord:' + device, value)} /><Toggle label="指示灯反馈" value={data.settings.toggles['light:' + device] !== false} onChange={value => toggle('light:' + device, value)} /><Row title="离线记录与同步" icon="cloud-arrow-up" onClick={() => navigate({ view: 'settings-sync' })} /></Card>
      <Button tone="danger" onClick={() => setRemove(true)}>解除配对</Button>
    </>}
    <Sheet open={enable} onClose={() => setEnable(false)} title="允许这台设备开机自动聆听？"><p>设备与服务就绪后进入私人日常临时聆听。完整原音和临时全文只滚动保留5分钟；停止后清除，候选重点核对后再保存。</p><p className="meta">暂停、停止与安静时段优先。不会自动开启正式会议云保存、声纹或共享。当前只保存本机体验偏好。</p><Button onClick={() => { update(current => setAutoListenPreference(current, device, true)); setEnable(false); toast('选择已保存，下次示例开机信号再检查是否开始'); }}>确认开启这台设备</Button><Button tone="secondary" onClick={() => setEnable(false)}>保持关闭</Button></Sheet>
    <Sheet open={remove} onClose={() => setRemove(false)} title="解除配对？"><p>关闭这台设备的开机聆听选择；它正在进行的日常记录会暂停，已保存内容保留。</p><Button tone="danger" onClick={() => { update(current => unpairStartupDevice(current, device)); setRuntime(initialDeviceRuntime()); setRemove(false); toast('已解除配对并关闭开机聆听'); }}>解除配对</Button><Button tone="secondary" onClick={() => setRemove(false)}>取消</Button></Sheet>
  </div>;
}
