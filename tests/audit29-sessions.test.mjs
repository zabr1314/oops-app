import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const target = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(target.pathname)) for (const extension of ['.ts', '.tsx', '.js', '.mjs']) {
      const candidate = new URL(target.href + extension);
      if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
} });
const logic = await import('../src/sessionIntelligenceLogic.ts');
const source = await readFile(new URL('../src/store.tsx', import.meta.url), 'utf8');
const seed = stripTypeScriptTypes(source.slice(source.indexOf('export function initialData')), { mode: 'strip' });
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(seed).toString('base64'));
const sessionId = 'session-001';
const read = (data, kind = 'understanding') => logic.readSessionIntelligence(data, sessionId, kind);
const topic = data => read(data).items.find(value => value.kind === 'topic');
function withAgenda() {
  const data = initialData();
  data.sessions[0].agenda = ['首版目标', '行动分工'];
  data.settings.retention[`agenda-${sessionId}`] = '0';
  return logic.refreshSessionIntelligence(data, sessionId, 'understanding');
}
function changeTopic(data, index) {
  // The actual Agenda.selectTopic path updates notices, then the understanding page reads the new state.
  return logic.refreshSessionIntelligence(logic.beginIntelligenceTopic({ ...data, settings: { ...data.settings, retention: { ...data.settings.retention, [`agenda-${sessionId}`]: String(index) } } }, sessionId), sessionId, 'notices');
}
function conflicts(text, budget = 100000, sensitive = false) {
  let data = initialData();
  data.projects.find(value => value.name === data.sessions[0].project).budget = budget;
  data.sessions[0].transcript = [{ id: 'amount-turn', speaker: '我', time: '00:01:00', text, private: sensitive }];
  data = logic.refreshSessionIntelligence(data, sessionId, 'notices');
  return { data, items: read(data, 'notices').items.filter(value => value.kind === 'budget-conflict') };
}

test('agenda advancement invalidates the previous current topic and refreshes it without discarding other manual corrections', () => {
  let data = withAgenda();
  const oldTopic = topic(data);
  const intent = read(data).items.find(value => value.kind === 'intent');
  data = logic.updateIntelligenceItem(data, sessionId, 'understanding', oldTopic.id, { text: '首版目标的人工修正' }).data;
  data = logic.updateIntelligenceItem(data, sessionId, 'understanding', intent.id, { text: '仍有效的人工意图整理' }).data;
  data = changeTopic(data, 1);
  assert.equal(read(data).generated, false);
  assert.equal(topic(data), undefined);
  assert.ok(read(data).staleCount >= 1);
  assert.match(logic.updateIntelligenceItem(data, sessionId, 'understanding', oldTopic.id, { text: '继续改旧议题' }).error, /来源已变化/);
  data = logic.refreshSessionIntelligence(data, sessionId, 'understanding');
  assert.equal(read(data).generated, true);
  assert.equal(topic(data).text, '行动分工');
  assert.equal(topic(data).edited, undefined);
  assert.equal(read(data).items.find(value => value.kind === 'intent').text, '仍有效的人工意图整理');
});

test('renaming the current agenda topic invalidates it, but editing a future topic preserves the current manual correction', () => {
  let data = withAgenda();
  data = logic.updateIntelligenceItem(data, sessionId, 'understanding', topic(data).id, { text: '本轮手工修正议题' }).data;
  data.sessions = data.sessions.map(value => value.id === sessionId ? { ...value, agenda: ['首版目标', '下一轮行动安排'] } : value);
  assert.equal(read(data).generated, true);
  data = logic.refreshSessionIntelligence(data, sessionId, 'understanding');
  assert.equal(topic(data).text, '本轮手工修正议题');
  data.sessions = data.sessions.map(value => value.id === sessionId ? { ...value, agenda: ['本轮预算决策', '下一轮行动安排'] } : value);
  assert.equal(read(data).generated, false);
  assert.equal(topic(data), undefined);
  data = logic.refreshSessionIntelligence(data, sessionId, 'understanding');
  assert.equal(topic(data).text, '本轮预算决策');
});

test('old understanding snapshots without agenda evidence are regenerated once', () => {
  let data = withAgenda();
  const key = logic.intelligenceKey('understanding', sessionId);
  const stored = JSON.parse(data.settings.retention[key]);
  delete stored.basis;
  stored.items = stored.items.map(value => { const copy = { ...value }; if (copy.kind === 'topic') delete copy.basis; return copy; });
  data.settings.retention[key] = JSON.stringify(stored);
  assert.equal(read(data).generated, false);
  assert.equal(topic(data), undefined);
  data = logic.refreshSessionIntelligence(data, sessionId, 'understanding');
  assert.equal(read(data).generated, true);
  assert.equal(topic(data).text, '首版目标');
});

test('later actual spending in a multi-amount passage produces a budget conflict with the exact source', () => {
  const { data, items } = conflicts('项目预算十万元，当前总费用十三万元。');
  assert.equal(items.length, 1);
  assert.match(items[0].text, /130,000元/);
  const ref = items[0].sources.find(value => value.kind === 'session');
  assert.equal(ref.sourceId, 'amount-turn');
  assert.equal(logic.intelligenceSourceRoute(data, sessionId, items[0], ref).mode, 'amount-turn');
});

test('Chinese two, hundreds and thousands and formatted numeric currency are compared in yuan', () => {
  for (const [text, budget, amount] of [
    ['这次费用是两万元。', 10000, '20,000元'],
    ['当前费用十二万三千元。', 100000, '123,000元'],
    ['实际支出十万零八百元。', 100000, '100,800元'],
    ['这次总费用为125,000元。', 100000, '125,000元'],
  ]) {
    const { items } = conflicts(text, budget);
    assert.equal(items.length, 1, text);
    assert.ok(items[0].text.includes(amount), text);
  }
});

test('multiple expense amounts are inspected but one source produces one deduplicated conflict', () => {
  const { items } = conflicts('费用为九万元，补充后的总成本十三万元，最终预计费用十三万元。');
  assert.equal(items.length, 1);
  assert.match(items[0].text, /130,000元/);
});

test('describing a higher budget baseline is not treated as actual spending, while a proposed budget change remains reviewable', () => {
  assert.equal(conflicts('项目预算上限十五万元，实际费用九万元。').items.length, 0);
  assert.equal(conflicts('原预算为十五万元。').items.length, 0);
  const changed = conflicts('这次预算改为十五万元。').items;
  assert.equal(changed.length, 1);
  assert.match(changed[0].text, /150,000元/);
});

test('equal, below-budget, non-money and private source passages do not produce budget conflicts', () => {
  for (const text of ['费用十万元。', '费用九万元。', '准备十三页方案。', '今天讨论预算，没有给出金额。']) assert.equal(conflicts(text).items.length, 0, text);
  assert.equal(conflicts('实际费用十三万元。', 100000, true).items.length, 0);
});
