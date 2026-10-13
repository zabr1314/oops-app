import { useState } from 'react';
import { useOops } from '../store';
import { useViewState } from '../viewState';
import { Badge, Button, Card, Check, Field, Notice, SectionTitle } from '../ui';
import { applyDocumentRoleDraft, prepareDocumentRoleDraft, roleDocumentLines, type RoleDocument, type DocumentRoleDraft as RoleDraft } from '../documentRoleLogic';
import './DocumentRoleDraft.css';

export function DocumentRoleDraft() {
  const { data, update, navigate, toast } = useOops();
  const [document, setDocument] = useViewState<RoleDocument>('document-role:source', { title: '', text: '', url: '', kind: 'pasted' });
  const [selected, setSelected] = useViewState('document-role:line', -1);
  const [draft, setDraft] = useViewState<RoleDraft | null>('document-role:draft', null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');
  const lines = roleDocumentLines(document);
  if (data.settings.space !== '我的空间') return <Notice>在个人空间选择自己的角色依据。团队资料不会自动写入个人身份。</Notice>;
  function changeDocument(patch: Partial<RoleDocument>) { setDocument(current => ({ ...current, ...patch })); setSelected(-1); setDraft(null); setAcknowledged(false); setError(''); }
  function example() {
    changeDocument({ title: '首版项目分工（示例文档）', text: `${data.settings.name}｜产品负责人｜Oops 首版｜负责体验规划、需求核对和版本验收。\n王宁｜项目协调者｜Oops 首版｜负责项目节奏与跨团队协作。\n备注：职责可能随项目阶段变化，应用前请本人核对。`, url: '', kind: 'demo' });
  }
  function prepare() {
    const result = prepareDocumentRoleDraft(data, document, selected);
    setError(result.error || ''); setDraft(result.draft || null); setAcknowledged(false);
  }
  function edit(patch: Partial<RoleDraft>) { setDraft(current => current ? { ...current, ...patch } : current); setAcknowledged(false); setError(''); }
  function save() {
    if (!draft) return;
    const result = applyDocumentRoleDraft(data, document, draft, acknowledged);
    if (result.error) { setError(result.error); return; }
    update(current => applyDocumentRoleDraft(current, document, draft, acknowledged).data);
    setDraft(null); setAcknowledged(false);
    toast('当前身份已应用，历史角色背景等待单独核对');
    navigate({ view: 'memory-conflict', id: result.candidateId });
  }
  return <div className="stack document-role">
    <Card className="dr-intro"><Badge tone="gray">可跳过 · 只对你可见</Badge><h2>从文档整理自己的角色</h2><p>先选依据，再编辑建议。你的历史角色记忆保留，应用后可以单独比较变化。</p></Card>
    <Notice>飞书文档选择为示例。也可粘贴自己选定的正文；本页不会连接飞书或上传文档。</Notice>
    {!draft && <><SectionTitle>1 · 选择一份文档</SectionTitle>
    <Button tone="secondary" icon="file-text" onClick={example}>选择示例飞书文档</Button>
    <Field label="文档标题" value={document.title} onChange={title => changeDocument({ title, kind: 'pasted' })} placeholder="例如：本月项目分工" />
    <Field label="飞书原文链接（可选）" value={document.url} onChange={url => changeDocument({ url, kind: 'pasted' })} placeholder="https://…feishu.cn/docx/…" />
    <Field label="选定文档正文" value={document.text} onChange={text => changeDocument({ text, kind: 'pasted' })} placeholder="粘贴与你的职责有关的段落，按行分开。" multiline />
    {!!lines.length && <><SectionTitle>2 · 核对一段角色依据</SectionTitle><p className="meta">点击原文选择。其他人的职责不会自动关联到你。</p>{lines.map((line, index) => <button key={index} type="button" className="dr-quote" aria-pressed={selected === index} onClick={() => { setSelected(index); setDraft(null); setAcknowledged(false); setError(''); }}><span>原文 {index + 1}</span><p>{line}</p></button>)}<Button disabled={selected < 0} onClick={prepare}>整理角色建议</Button></>}</>}
    {draft && <><SectionTitle>3 · 编辑并确认应用</SectionTitle><Card className="dr-evidence"><Badge tone="gray">所选依据 · 原文 {draft.line + 1}</Badge><p>{draft.quote}</p><p className="meta">{document.title}{document.kind === 'demo' ? ' · 示例内容' : ' · 本人选定摘录'}</p></Card><Field label="称呼" value={draft.name} onChange={name => edit({ name })} /><Field label="建议角色" value={draft.role} onChange={role => edit({ role })} placeholder="无法从原文明确得到时，请自行补充" /><Field label="其他角色（可选）" value={draft.roles} onChange={roles => edit({ roles })} /><Field label="适用项目或场景" value={draft.context} onChange={context => edit({ context })} placeholder="例如：Oops 首版产品阶段" /><Check label="已核对原文描述属于我，并确认编辑后的角色" value={acknowledged} onChange={setAcknowledged} /><Button disabled={!acknowledged} onClick={save}>应用当前身份，核对历史背景</Button><Button tone="quiet" onClick={() => { setDraft(null); setAcknowledged(false); }}>取消这份建议</Button></>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <Button tone="quiet" onClick={() => navigate({ view: 'settings-identity' })}>暂不导入，回到身份</Button>
  </div>;
}
