import type { AppData, Memory } from './store';
import { makeSourceReference } from './sourceAccess';

export type RoleDocument = { title: string; text: string; url: string; kind: 'demo' | 'pasted' };
export type DocumentRoleDraft = { documentKey: string; quote: string; line: number; name: string; role: string; roles: string; context: string; profileKey: string };
export function roleDocumentLines(document: RoleDocument): string[] {
  return document.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
const documentKey = (document: RoleDocument) => JSON.stringify([document.title.trim(), document.text, document.url.trim(), document.kind]);
const profileKey = (data: AppData) => JSON.stringify([data.settings.name, data.settings.role, data.settings.retention.roles, data.settings.retention.roleContext]);
export function validRoleDocumentUrl(value: string): boolean {
  if (!value.trim()) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && /(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname) && /^\/(docx|docs|wiki)\//.test(url.pathname); } catch { return false; }
}
export function prepareDocumentRoleDraft(data: AppData, document: RoleDocument, line: number): { draft?: DocumentRoleDraft; error?: string } {
  if (data.settings.space !== '我的空间') return { error: '请在个人空间整理自己的角色。' };
  if (!document.title.trim() || !document.text.trim()) return { error: '先补充文档标题和你选定的正文。' };
  if (!validRoleDocumentUrl(document.url)) return { error: '请使用有效的飞书文档链接，或留空。' };
  const quote = roleDocumentLines(document)[line];
  if (!Number.isInteger(line) || !quote) return { error: '先选择一段实际原文作为依据。' };
  // Structured examples can suggest fields. Ordinary prose stays editable, without guessing identity.
  const cells = quote.split(/[｜|]/).map(value => value.trim());
  const structured = cells.length >= 3 && cells[0] === data.settings.name;
  const naturalRole = quote.startsWith(data.settings.name + '：') || quote.startsWith(data.settings.name + ':')
    ? quote.match(/(?:担任|当前角色[：:]|角色为)([^，。；\n]{1,30})/)?.[1] || '' : '';
  return { draft: { documentKey: documentKey(document), quote, line, name: data.settings.name, role: structured ? cells[1] : naturalRole, roles: '', context: structured ? cells[2] : '', profileKey: profileKey(data) } };
}
function shortKey(text: string) { let hash = 2166136261; for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return (hash >>> 0).toString(36); }

/** Explicitly apply the edited identity; preserve the old role memory for a separate comparison. */
export function applyDocumentRoleDraft(data: AppData, document: RoleDocument, draft: DocumentRoleDraft, acknowledged: boolean, now = new Date()): { data: AppData; candidateId?: string; sourceId?: string; error?: string } {
  if (data.settings.space !== '我的空间') return { data, error: '请在个人空间应用自己的角色。' };
  if (!acknowledged) return { data, error: '请先核对原文描述属于你，并确认编辑后的角色。' };
  if (draft.documentKey !== documentKey(document) || draft.quote !== roleDocumentLines(document)[draft.line]) return { data, error: '文档或所选原文已变化，请重新整理建议。' };
  if (draft.profileKey !== profileKey(data)) return { data, error: '当前身份已变化，请重新整理并核对建议。' };
  if (!document.title.trim() || !validRoleDocumentUrl(document.url)) return { data, error: '请重新检查文档标题与链接。' };
  const name = draft.name.trim(), role = draft.role.trim(), context = draft.context.trim();
  if (!name || !role || !context) return { data, error: '请补齐称呼、当前角色和适用场景。' };
  if (!Number.isFinite(now.getTime())) return { data, error: '保存时间不可用，请稍后重试。' };
  const updated = now.toISOString(), key = shortKey(JSON.stringify([draft.documentKey, draft.line, name, role, context, draft.roles]));
  const sourceId = 'role-document-source-' + key, candidateId = 'role-document-candidate-' + key;
  if (data.memories.some(memory => memory.id === sourceId || memory.id === candidateId)) return { data, error: '这份角色建议已经保存，请到身份页核对已有背景。' };
  const source: Memory = { id: sourceId, title: '角色依据 · ' + document.title.trim(), body: draft.quote + (document.url.trim() ? '\n原文链接：' + document.url.trim() : ''), category: '收藏', tags: ['资料', '角色依据', document.kind === 'demo' ? '演示资料' : '本人选定摘录'], visibility: '私有', confirmed: true, updated };
  const withSource = { ...data, memories: [source, ...data.memories] };
  const candidate: Memory = { id: candidateId, title: '文档角色建议待核对', body: `${name}在${context}担任${role}。${draft.roles.trim() ? '其他角色：' + draft.roles.trim() + '。' : ''}`, category: '记忆', tags: ['待确认', '身份', '角色背景', '角色冲突', '档案更新'], visibility: '私有', confirmed: false, updated, sources: [makeSourceReference(withSource, { kind: 'memory', id: sourceId })] };
  return { candidateId, sourceId, data: { ...withSource, memories: [candidate, ...withSource.memories], settings: { ...data.settings, name, avatar: name.slice(0, 1), role, retention: { ...data.settings.retention, roles: draft.roles.trim(), roleContext: context, 'identity-updated-at': updated, 'role-setting-candidate': candidateId } } } };
}
