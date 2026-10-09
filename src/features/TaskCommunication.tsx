import { useEffect, useState } from 'react';
import { useOops } from '../store';
import { useViewState } from '../viewState';
import { taskArtifacts } from '../taskLogic';
import { provenanceAvailable, taskSourceAvailable } from '../sourceAccess';
import { artifactFingerprint, buildCommunicationDraft, buildCommunicationReview, communicationDraftSignature, communicationDraftStatus, communicationFingerprint, formatArtifactBody, formatDraftAttachments, initialCommunicationDraft, keepCommunicationDraft, latestCommunicationArtifacts, saveCommunicationDraft, submitCommunication, visibleCalendarConflicts, type CommunicationKind, type CommunicationOptions, type CommunicationReview, type CommunicationTask, type Draft } from '../communicationLogic';
import { Badge, Button, Card, Check, Empty, Field, Notice, SectionTitle, SelectField, Sheet } from '../ui';
import './TaskCommunication.css';
export type { Draft } from '../communicationLogic';
const stamp = () => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());
const PERSONAL = '我的空间';
export function initialDraft(task: CommunicationTask, kind: string, myName = '我', selectedIds?: string[], options: CommunicationOptions = {}): Draft {
  return initialCommunicationDraft(task, kind === '邮件' || kind === '日程' ? kind : '消息', myName, selectedIds, options);
}
function useTaskActions(task: CommunicationTask) {
  const { navigate } = useOops();
  return { go: (view: string, mode?: string) => navigate({ view, id: task.id, mode }) };
}
export function TaskCommunication({ task, kind }: { task: CommunicationTask; kind: CommunicationKind }) {
  const { data, route, update, navigate, toast } = useOops(), { go } = useTaskActions(task);
  const all = taskArtifacts(task), inquiryId = task.inquiries?.find(inquiry => inquiry.id === route.mode)?.id;
  const initialIds = all.some(artifact => artifact.id === route.mode) ? [route.mode!] : undefined;
  const storedDraft = task.drafts?.[kind];
  const storedRevision = initialIds === undefined && storedDraft && (storedDraft.snapshotSpace || PERSONAL) === data.settings.space && (!inquiryId || storedDraft.replyToInquiryId === inquiryId) ? communicationDraftSignature(storedDraft) : 'initial';
  const key = `task-communication-v3:${data.settings.space}:${task.id}:${kind}:${inquiryId || initialIds?.[0] || 'general'}:${storedRevision}`;
  const [draft, setDraft] = useViewState<Draft>(key, () => initialDraft(task, kind, data.settings.name, initialIds, { data, space: data.settings.space, replyToInquiryId: inquiryId }));
  const [selectedIds, setSelectedIds] = useViewState<string[]>(key + ':resources', () => draft.artifactRefs?.map(ref => ref.id) || latestCommunicationArtifacts(task).map(artifact => artifact.id));
  const [checkedSignature, setCheckedSignature] = useState(''), [review, setReview] = useState<CommunicationReview | null>(null), [error, setError] = useState(''), [conflictChecked, setConflictChecked] = useState(''), [historyOpen, setHistoryOpen] = useState(false), [submission, setSubmission] = useState<{ review: CommunicationReview; id: string; date: string } | null>(null);
  useEffect(() => { setCheckedSignature(''); setConflictChecked(''); setReview(null); setError(''); }, [key]);
  const sourceUnavailable = task.sourceNeedsReview || !taskSourceAvailable(data, task) || !provenanceAvailable(data, draft.sourceSnapshots) || (draft.artifactRefs || []).some(ref => all.find(artifact => artifact.id === ref.id && artifact.version === ref.version)?.sourceNeedsReview);
  const signature = communicationDraftSignature(draft), status = communicationDraftStatus(task, draft), attachmentText = formatDraftAttachments(task, draft);
  const conflicts = kind === '日程' ? visibleCalendarConflicts(data, task, draft) : [], conflictSignature = communicationFingerprint(conflicts.map(receipt => [receipt.id, receipt.body]));
  const selectionChanged = selectedIds.join('|') !== (draft.artifactRefs || []).map(ref => ref.id).join('|');
  const history = (task.draftHistory || []).filter(item => item.kind === kind && (item.draft.snapshotSpace || PERSONAL) === data.settings.space);
  const connection = kind === '消息' ? '飞书' : kind === '邮件' ? '邮箱' : draft.calendar?.startsWith('飞书') ? '飞书日程' : 'Calendar';
  function resetCheck() { setCheckedSignature(''); setConflictChecked(''); setReview(null); setError(''); }
  function edit(key: 'target' | 'body' | 'subject' | 'cc' | 'account' | 'start' | 'end' | 'calendar', value: string) { setDraft(current => ({ ...current, [key]: value })); resetCheck(); }
  function save() {
    const personal = sourceUnavailable;
    const saved = personal ? { ...draft, snapshotSpace: PERSONAL } : draft;
    update(current => saveCommunicationDraft(current, task.id, saved, kind));
    toast(personal ? '原稿已保留在个人任务中，来源核对后才能继续' : '草稿已保存，尚未提交');
  }
  function updateDraft() {
    if (selectedIds.some(id => !all.some(artifact => artifact.id === id))) return setError('选择中有已移除的成果，请重新勾选实际版本。');
    const newer = { ...buildCommunicationDraft(task, kind, data.settings.name, selectedIds, { data, space: data.settings.space, replyToInquiryId: inquiryId || draft.replyToInquiryId }), account: draft.account, cc: draft.cc, start: draft.start, end: draft.end, calendar: draft.calendar, versionChoice: 'updated' as const };
    update(current => saveCommunicationDraft(current, task.id, newer, kind, true, draft));
    setDraft(newer); resetCheck(); toast('已按所选成果更新正文和附件，原稿保留');
  }
  function keepDraft() {
    const result = keepCommunicationDraft(task, draft);
    if (!result.draft) return setError(result.error || '原绑定无法继续使用');
    setDraft(result.draft); setSelectedIds(result.draft.artifactRefs?.map(ref => ref.id) || []); resetCheck(); toast('保留原稿及原附件，请重新核对本次内容');
  }
  function openReview() {
    if (selectionChanged) return setError('附件选择尚未应用。按所选版本重新起草，或保留原稿及原附件。');
    const result = buildCommunicationReview(data, task, draft, kind);
    if (result.error || !result.review) return setError(result.error || '本次内容需要重新核对');
    if (checkedSignature !== signature) return setError('请勾选这一次的对象、正文和附件核对。');
    if (conflicts.length && conflictChecked !== conflictSignature) return setError('这个时段已有安排，请调整时间或确认已处理冲突。');
    setError(''); setReview(result.review);
  }
  function confirmReview() {
    if (!review || submission) return;
    if (checkedSignature !== review.signature) { setReview(null); setError('这次内容的核对状态已变化，请重新核对。'); return; }
    const pending = { review, id: `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, date: stamp() };
    const prepared = submitCommunication(data, review, draft, pending.id, pending.date);
    if (prepared.error) { setReview(null); setError(prepared.error); return; }
    setSubmission(pending);
    update(current => submitCommunication(current, pending.review, draft, pending.id, pending.date).data);
  }
  useEffect(() => {
    if (!submission) return;
    const result = submitCommunication(data, submission.review, draft, submission.id, submission.date);
    const recorded = data.receipts.find(receipt => receipt.taskId === task.id && receipt.kind === kind && (receipt.space || PERSONAL) === submission.review.space && (receipt.signature === submission.review.signature || receipt.id === submission.id)) || (result.existing ? result.receipt : undefined);
    if (recorded) { setSubmission(null); setReview(null); toast(recorded.id === submission.id ? '已生成本地模拟回执，未对外提交' : '同一确认已有回执，没有重复提交'); navigate({ view: 'task-receipt', id: task.id, mode: recorded.id }); return; }
    setSubmission(null); setReview(null); setError(result.error || '本次没有新增回执，请重新核对后确认。');
  }, [submission, data, task.id, kind, draft, navigate, toast]);
  const exact = review?.draft;
  return <div className="stack task-communication">
    <div className="section-title"><Badge>待本人确认</Badge><Badge tone="gray">{connection} · 本地演示</Badge></div>
    {inquiryId && <Notice>这份草稿围绕已记录的问题，回复与对外提交仍分别核对。</Notice>}
    {sourceUnavailable && <Notice>任务来源待核对。原草稿可以保存，暂时不能确认发送。<Button tone="quiet" onClick={() => go('task-edit')}>先核对任务来源</Button></Notice>}
    {status.stale && <Card className="communication-stale"><Badge tone="orange">草稿版本待核对</Badge><p>{status.reasons.join('；')}。</p><p className="meta">原正文和已绑定附件保持原样。</p><Button tone="secondary" onClick={keepDraft}>保留原稿及原附件</Button><Button onClick={updateDraft}>按所选版本重新起草</Button></Card>}
    {kind !== '日程' && <Field label="发送账号" value={draft.account || ''} onChange={value => edit('account', value)} />}
    <Field label={kind === '日程' ? '参与人' : '收件对象'} value={draft.target} onChange={value => edit('target', value)} placeholder="明确填写本次对象" hint={`当前负责人：${task.owner}；提出人：${task.requester}${task.transferTo ? '；待转交给：' + task.transferTo : ''}`} />
    {kind === '邮件' && <Field label="抄送" value={draft.cc || ''} onChange={value => edit('cc', value)} />}
    {kind !== '消息' && <Field label={kind === '日程' ? '日程标题' : '邮件主题'} value={draft.subject || ''} onChange={value => edit('subject', value)} />}
    {kind === '日程' && <><Field label="开始时间" value={draft.start || ''} onChange={value => edit('start', value)} placeholder="2026-10-09 14:00" /><Field label="结束时间" value={draft.end || ''} onChange={value => edit('end', value)} placeholder="2026-10-09 14:30" /><SelectField label="目标日历" value={draft.calendar || '我的工作日历'} onChange={value => edit('calendar', value)} options={['我的工作日历', '个人日历', '飞书工作日历']} /></>}
    <Field label={kind === '日程' ? '议程' : '完整正文'} value={draft.body} onChange={value => edit('body', value)} multiline />
    <SectionTitle>已绑定的附件</SectionTitle>
    <Card>{(draft.artifactRefs || []).length ? draft.artifactRefs!.map(ref => { const current = all.find(artifact => artifact.id === ref.id && artifact.version === ref.version), unchanged = !!current && ref.fingerprint === artifactFingerprint(current); return <div className="communication-bound" key={ref.id + ':' + ref.version}><div className="section-title"><strong>{ref.title || current?.title || '原成果'} · v{ref.version}</strong><Badge tone={unchanged ? 'gray' : 'orange'}>{unchanged ? '准确绑定' : '版本已变化'}</Badge></div><details><summary>查看绑定正文快照</summary><p className="communication-copy">{ref.body?.join('\n\n') || '旧草稿没有保存正文快照'}</p></details>{unchanged && <Button tone="quiet" onClick={() => go('task-preview', ref.id)}>打开这个成果版本</Button>}</div>; }) : <p className="meta">未附成果。可以只核对手工填写的正文。</p>}<p className="meta">{attachmentText || '无附件'}</p></Card>
    <SectionTitle>选择成果版本</SectionTitle>
    {all.length ? <Card>{[...all].reverse().map(artifact => <div className="communication-resource" key={artifact.id}><Check label={`${artifact.title} · ${artifact.kind} · v${artifact.version}${artifact.sourceNeedsReview ? ' · 来源失效' : ''}`} value={selectedIds.includes(artifact.id)} onChange={value => { setSelectedIds(ids => value ? [...new Set([...ids, artifact.id])] : ids.filter(id => id !== artifact.id)); resetCheck(); }} /><details><summary>查看此版本正文</summary><p className="communication-copy">{formatArtifactBody(artifact)}</p></details></div>)}</Card> : <Empty title="还没有成果附件" body="可先写下需要对方核对的问题，再保存通信草稿。" />}
    {selectionChanged && <Notice>附件选择尚未应用，正文与原附件保持原样。</Notice>}
    <Button tone="secondary" onClick={updateDraft}>按所选版本重新起草</Button>
    {selectionChanged && <Button tone="quiet" onClick={keepDraft}>保留原稿及原附件</Button>}
    {conflicts.length > 0 && <Notice>同一空间的个人日历中，这个时段已有{conflicts.length}条安排。<Check label="已调整或处理当前时段的冲突" value={conflictChecked === conflictSignature} onChange={value => setConflictChecked(value ? conflictSignature : '')} /></Notice>}
    <Check label={kind === '日程' ? '已核对本次参与人、正文、附件与起止时间' : '已核对本次收件对象、完整正文和实际附件版本'} value={checkedSignature === signature} onChange={value => setCheckedSignature(value ? signature : '')} />
    {error && <p className="error-text" role="alert">{error}</p>}
    <Button onClick={openReview}>{kind === '日程' ? '核对并创建' : '核对并发送'}</Button><Button tone="secondary" onClick={save}>保存草稿</Button>
    {history.length > 0 && <Button tone="quiet" onClick={() => setHistoryOpen(true)}>查看保留的原稿 · {history.length}份</Button>}
    {kind === '消息' && <Button tone="quiet" icon="copy" onClick={() => { if (!navigator.clipboard) { toast('当前环境暂不允许复制'); return; } navigator.clipboard.writeText(draft.body).then(() => toast('正文已复制，尚未发送')).catch(() => toast('当前环境暂不允许复制')); }}>复制正文</Button>}
    <p className="meta">仅在本机演示，不会发送到真实账号或写入真实日历。</p>
    <Sheet open={!!review} onClose={() => !submission && setReview(null)} title={kind === '日程' ? '确认这条日程' : '确认这次发送'}><div className="stack">{exact && <Card><Badge>{kind}</Badge><h3>{exact.target}</h3>{kind !== '日程' && <p className="meta">发送账号：{exact.account}</p>}{kind === '邮件' && exact.cc && <p className="meta">抄送：{exact.cc}</p>}{kind !== '消息' && <strong>{exact.subject}</strong>}{kind === '日程' && <p>{exact.start} — {exact.end}<br />{exact.calendar}</p>}<p className="communication-copy">{exact.body}</p><SectionTitle>本次实际附件</SectionTitle>{exact.artifactRefs?.length ? exact.artifactRefs.map(ref => <p key={ref.id + ':' + ref.version}>{ref.title || '已绑定成果'} · v{ref.version}</p>) : <p className="meta">无附件</p>}</Card>}<Button disabled={!!submission} onClick={confirmReview}>{submission ? '正在记录本地回执' : kind === '日程' ? '确认模拟创建' : '确认模拟发送'}</Button><Button tone="quiet" disabled={!!submission} onClick={() => setReview(null)}>继续修改</Button></div></Sheet>
    <Sheet open={historyOpen} onClose={() => setHistoryOpen(false)} title="保留的通信原稿"><div className="stack">{[...history].reverse().map((item, index) => <Card key={item.date + ':' + index}><Badge tone="gray">{item.date}</Badge><h3>{item.draft.target || '对象未填写'}</h3><p className="communication-copy">{item.draft.body}</p><p className="meta">{formatDraftAttachments(task, item.draft) || item.draft.attachments || '无附件'}</p><Button tone="secondary" onClick={() => { setDraft(item.draft); setSelectedIds(item.draft.artifactRefs?.map(ref => ref.id) || []); resetCheck(); setHistoryOpen(false); toast('已打开原稿，需要重新核对这一次内容'); }}>沿用这份原稿</Button></Card>)}</div></Sheet>
  </div>;
}
