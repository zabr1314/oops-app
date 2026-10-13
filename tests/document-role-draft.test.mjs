import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes, registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const target = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(target.pathname)) for (const extension of ['.ts', '.tsx']) if (existsSync(new URL(target.href + extension))) return next(target.href + extension, context);
  }
  return next(specifier, context);
} });
const { applyDocumentRoleDraft, prepareDocumentRoleDraft, validRoleDocumentUrl } = await import('../src/documentRoleLogic.ts');
const { provenanceAvailable } = await import('../src/sourceAccess.ts');
const source = readFileSync(new URL('../src/store.tsx', import.meta.url), 'utf8');
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source.slice(source.indexOf('export function initialData')), { mode: 'strip' })).toString('base64'));
const now = new Date('2026-10-12T08:30:00Z');
function setup() { const data = initialData(); const document = { title: '项目分工', text: '林｜设计负责人｜体验验证阶段｜负责可用性走查。\n王宁｜项目协调者｜首版｜负责排期。', url: 'https://my.feishu.cn/docx/example', kind: 'pasted' }; return { data, document, draft: prepareDocumentRoleDraft(data, document, 0).draft }; }
test('role suggestions are editable and do not guess another person or a prose description', () => {
  const { data, document, draft } = setup();
  assert.equal(draft.role, '设计负责人'); assert.equal(draft.context, '体验验证阶段');
  assert.equal(prepareDocumentRoleDraft(data, document, 1).draft.role, '');
  assert.equal(prepareDocumentRoleDraft(data, { ...document, text: '团队负责完成排期。' }, 0).draft.role, '');
  assert.equal(data.settings.role, '产品负责人');
});
test('document links reject unsafe schemes, credentials and lookalike domains', () => {
  for (const value of ['', 'https://my.feishu.cn/docx/example', 'https://company.larksuite.com/wiki/example']) assert.equal(validRoleDocumentUrl(value), true);
  for (const value of ['javascript:alert(1)', 'https://my.feishu.cn.attacker.test/docx/a', 'https://x:secret@my.feishu.cn/docx/a', 'http://my.feishu.cn/docx/a', 'https://my.feishu.cn/other/a']) assert.equal(validRoleDocumentUrl(value), false);
});
test('application requires explicit review, complete fields and personal scope', () => {
  const { data, document, draft } = setup(), before = structuredClone(data);
  assert.ok(applyDocumentRoleDraft(data, document, draft, false, now).error);
  for (const field of ['name', 'role', 'context']) assert.ok(applyDocumentRoleDraft(data, document, { ...draft, [field]: ' ' }, true, now).error);
  data.settings.space = 'Oops 产品团队';
  assert.ok(prepareDocumentRoleDraft(data, document, 0).error);
  assert.ok(applyDocumentRoleDraft(data, document, draft, true, now).error);
  data.settings.space = before.settings.space; assert.deepEqual(data, before);
});
test('changed document, selected quote, or current identity invalidates a prepared suggestion', () => {
  const { data, document, draft } = setup();
  assert.ok(applyDocumentRoleDraft(data, { ...document, text: document.text + '\nchanged' }, draft, true, now).error);
  assert.ok(applyDocumentRoleDraft(data, document, { ...draft, quote: 'unrelated' }, true, now).error);
  data.settings.role = '角色已被其他入口更新';
  assert.ok(applyDocumentRoleDraft(data, document, draft, true, now).error);
});
test('explicit application keeps old role memory and creates a private source-bound candidate without extra permissions', () => {
  const { data, document, draft } = setup(), before = structuredClone(data);
  const result = applyDocumentRoleDraft(data, document, draft, true, now);
  assert.equal(result.error, undefined); assert.equal(result.data.settings.role, '设计负责人');
  assert.equal(result.data.settings.retention['identity-updated-at'], now.toISOString());
  assert.deepEqual(result.data.settings.toggles, before.settings.toggles);
  assert.deepEqual(result.data.settings.connections, before.settings.connections);
  assert.deepEqual(result.data.memories.find(item => item.id === 'MEM-001'), before.memories.find(item => item.id === 'MEM-001'));
  const candidate = result.data.memories.find(item => item.id === result.candidateId);
  assert.equal(candidate.confirmed, false); assert.equal(candidate.visibility, '私有');
  assert.equal(provenanceAvailable(result.data, candidate.sources), true);
  result.data.memories.find(item => item.id === result.sourceId).body = '原文已修订';
  assert.equal(provenanceAvailable(result.data, candidate.sources), false);
  assert.deepEqual(data, before);
});
test('repeated application and invalid time do not create duplicate sources or candidates', () => {
  const { data, document, draft } = setup();
  assert.ok(applyDocumentRoleDraft(data, document, draft, true, new Date('invalid')).error);
  const first = applyDocumentRoleDraft(data, document, draft, true, now);
  const second = applyDocumentRoleDraft(first.data, document, draft, true, now);
  assert.ok(second.error); assert.equal(second.data.memories.length, first.data.memories.length);
});
