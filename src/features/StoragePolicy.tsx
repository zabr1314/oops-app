import { useState } from 'react';
import { useOops, type Session } from '../store';
import { Badge, Button, Card, Check, Notice, SelectField, Sheet } from '../ui';
import { retentionDays, switchDailyToMeeting } from '../storagePolicy';
import { clearObjectViewState } from '../viewState';

type FieldsProps = { confirmed: boolean; onConfirmed: (value: boolean) => void; audioDays: string; onAudioDays: (value: string) => void; textDays: string; onTextDays: (value: string) => void };
export function MeetingStorageFields(props: FieldsProps) {
  return <Card><Check label="将本次正式会议保存到云端" value={props.confirmed} onChange={props.onConfirmed} />
    <div className="action-grid"><SelectField label="原音保留（天）" value={props.audioDays} options={['7', '30', '90']} onChange={props.onAudioDays} /><SelectField label="全文保留（天）" value={props.textDays} options={['7', '30', '90']} onChange={props.onTextDays} /></div>
    <p className="meta">到期分别清除。独立保存的摘要、任务与短证据继续保留；不会修改历史会议期限。</p>
    <p className="meta">云端语音识别的即时处理与长期存档分别确认。当前网站仅使用隔离示例，不采集麦克风。</p></Card>;
}

export function SessionStorageStatus({ session, allowSwitch = false }: { session: Session; allowSwitch?: boolean }) {
  const { data, update, navigate, toast } = useOops();
  const [open, setOpen] = useState(false), [confirmed, setConfirmed] = useState(false), [includeBuffer, setIncludeBuffer] = useState(false);
  const [audioDays, setAudioDays] = useState(String(retentionDays(data.settings.retention['meeting-audio-days'])));
  const [textDays, setTextDays] = useState(String(retentionDays(data.settings.retention['meeting-transcript-days'])));
  const policy = session.storage;
  if (!policy) return null;
  const daily = policy.mode === 'daily', active = ['进行中', '暂停'].includes(session.status);
  const date = (days: number) => new Date(policy.archiveStartedAt + days * 86400000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  function convert() {
    const id = `session-meeting-${Date.now().toString(36)}`;
    const result = switchDailyToMeeting(data, session.id, id, confirmed, includeBuffer, audioDays, textDays);
    if (result.error) { toast(result.error); return; }
    update(current => switchDailyToMeeting(current, session.id, id, confirmed, includeBuffer, audioDays, textDays).data);
    clearObjectViewState(session.id); setOpen(false);
    navigate({ view: 'session-detail', id, mode: '现场' }); toast(includeBuffer ? '已明确加入最近五分钟，从现在开始会议存档示例' : '从现在开始会议存档，之前全文已清除');
  }
  return <><Card><Badge tone={daily ? 'gray' : 'purple'}>{daily ? active ? '日常 · 五分钟临时缓冲' : '日常 · 全文已清除' : '正式会议 · 已选择云保存'}</Badge>
    <p className="meta">{daily ? active ? '完整内容不进全场存档或团队同步；停止后仅留私人候选和独立短证据。' : `仅保留 ${session.savedEvidence?.length || 0} 段独立短证据；候选核对后才进入长期记忆。` : `原音：${policy.audioState === 'expired' ? '已到期清除' : `至 ${date(policy.audioRetentionDays)}`} · 全文：${policy.transcriptState === 'expired' ? '已到期清除' : `至 ${date(policy.transcriptRetentionDays)}`}`}</p>
    {!daily && policy.transcriptState === 'expired' && <p className="meta">下方仅展示独立保存的短证据，全文不可找回。</p>}
    {daily && active && allowSwitch && <Button tone="secondary" onClick={() => { setConfirmed(false); setIncludeBuffer(false); setOpen(true); }}>切换为正式会议</Button>}</Card>
    <Sheet open={open} onClose={() => setOpen(false)} title="从现在开始正式会议"><Notice>默认从切换时刻开始存档。之前的日常全文会清除，候选重点保持私人。</Notice>
      <MeetingStorageFields confirmed={confirmed} onConfirmed={setConfirmed} audioDays={audioDays} onAudioDays={setAudioDays} textDays={textDays} onTextDays={setTextDays} />
      <Check label="另外加入最近5分钟的缓冲" value={includeBuffer} onChange={setIncludeBuffer} />
      <p className="meta">只包含仍在缓冲中的内容，已过期部分无法恢复。此选择会把这部分也纳入本次会议保存期限。</p>
      <Button disabled={!confirmed} onClick={convert}>确认切换并开始会议</Button><Button tone="quiet" onClick={() => setOpen(false)}>继续日常临时聆听</Button></Sheet></>;
}
