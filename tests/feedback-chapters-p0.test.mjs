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

const { readSessionPresentation } = await import('../src/sessionPresentationLogic.ts');
const { sourceTurn, invalidateSessionSources } = await import('../src/sourceAccess.ts');
const store = await readFile(new URL('../src/store.tsx', import.meta.url), 'utf8');
const seed = stripTypeScriptTypes(store.slice(store.indexOf('export function initialData')), { mode: 'strip' });
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(seed).toString('base64'));
const sessionId = 'session-001';
const current = data => data.sessions.find(value => value.id === sessionId);
const fact = { id: 'fact', speaker: '我', time: '00:00:20', text: '用户测试显示按钮不容易找到。' };
const setup = () => {
  const data = initialData();
  data.tasks = []; data.memories = [];
  Object.assign(current(data), { title: '用户测试复盘', agenda: ['用户测试'], transcript: [{ ...fact }], summary: [], status: '进行中' });
  data.activeSessionId = sessionId;
  return data;
};
const read = (data, shared = false, session = current(data)) => readSessionPresentation(data, session, shared);
const allPoints = data => Object.values(read(data).chapterPoints).flat();

test('plain factual discussion has a visible quote with an exact source and does not become a confirmed result', () => {
  const data = setup(), before = JSON.stringify(data), result = read(data);
  assert.equal(JSON.stringify(data), before);
  assert.equal(result.decisions.length, 0);
  assert.equal(result.actions.length, 0);
  assert.equal(result.topicPoints.length, 1);
  const point = result.topicPoints[0];
  assert.equal(point.label, '原话摘录');
  assert.equal(point.text, fact.text);
  assert.equal(point.sourceId, fact.id);
  assert.equal(point.sourceTime, fact.time);
  assert.deepEqual(point.route, { view: 'session-transcript', id: sessionId, mode: fact.id });
  assert.equal(sourceTurn(data, { sourceSession: point.route.id, sourceId: point.sourceId }).text, point.text);
  assert.equal(data.settings.retention[`session-review-items:${sessionId}`], undefined);
});

test('an idea without an agenda has a sourced excerpt instead of an empty topic', () => {
  const data = setup();
  Object.assign(current(data), { kind: '灵感', agenda: [], transcript: [{ id: 'idea', speaker: '我', time: '', text: '我觉得安静陪伴的小伙伴很舒服。' }] });
  const result = read(data);
  assert.equal(result.chapters[0].id, 'conversation');
  assert.equal(result.topicPoints[0].text, '我觉得安静陪伴的小伙伴很舒服。');
  assert.equal(result.topicPoints[0].sourceTime, '');
  assert.equal(result.topicPoints[0].route.mode, 'idea');
  assert.equal(result.pendingCount, 0);
});

test('separate chapters show their own facts, while empty chapters stay empty', () => {
  const data = setup();
  current(data).agenda = ['用户测试', '合作反馈', '下次议程'];
  current(data).transcript.push({ id: 'feedback', speaker: '同事', time: fact.time, text: '合作反馈来自三位设计师。' });
  data.settings.retention[`agenda-${sessionId}`] = '1';
  const result = read(data);
  assert.equal(result.chapterPoints['agenda-0'][0].sourceId, 'fact');
  assert.equal(result.chapterPoints['agenda-1'][0].sourceId, 'feedback');
  assert.deepEqual(result.chapterPoints['agenda-2'], []);
  assert.equal(result.topicPoints[0].sourceId, 'feedback');
  assert.deepEqual(result.chapters.map(value => value.state), ['已讨论', '当前', '待讨论']);
});

test('unmatched or stale legacy summaries are not presented as current chapter evidence', () => {
  const data = setup();
  current(data).summary = ['旧版判断：按钮入口已经没有问题。', '用户测试显示按钮不容易找到。 另一个私密项目的底价为九元。'];
  const result = read(data);
  assert.equal(result.topicPoints[0].text, fact.text);
  assert.equal(JSON.stringify(result.chapterPoints).includes('私密项目'), false);
  assert.equal(JSON.stringify(result.chapterPoints).includes('没有问题'), false);
});

test('a legacy summary can select an exactly matching current quote but never supplies its own wording', () => {
  const data = setup(), session = current(data);
  session.transcript.push(
    { id: 'later-1', speaker: '我', time: '00:00:30', text: '用户测试里三个人停在欢迎页。' },
    { id: 'later-2', speaker: '我', time: '00:00:40', text: '用户测试里两个人找不到返回入口。' },
  );
  session.summary = [`原话摘录 · ${fact.time} ${fact.speaker}：${fact.text}`];
  const points = read(data).topicPoints;
  assert.equal(points[0].sourceId, 'fact');
  assert.equal(points[0].text, fact.text);
  assert.equal(points[0].text.includes('原话摘录 ·'), false);
  assert.equal(points.length, 2);
});

test('editing and removing a source immediately replaces or removes its excerpt, even with an old screen object', () => {
  let data = setup();
  const previousSession = current(data);
  current(data).summary = [fact.text];
  data = invalidateSessionSources(data, sessionId, ['fact'], '修订测试');
  data.sessions = data.sessions.map(session => session.id === sessionId ? { ...session, transcript: [{ ...fact, text: '用户测试显示入口文字太长。', time: '00:01:05' }] } : session);
  const revised = read(data, false, previousSession).topicPoints[0];
  assert.equal(revised.text, '用户测试显示入口文字太长。');
  assert.equal(revised.sourceTime, '00:01:05');
  assert.equal(JSON.stringify(read(data, false, previousSession).chapterPoints).includes(fact.text), false);
  current(data).transcript = [];
  assert.deepEqual(read(data, false, previousSession).topicPoints, []);
  assert.equal(allPoints(data).length, 0);
});

test('private turns never become chapter highlights and no removed session can leave an excerpt behind', () => {
  const data = setup();
  current(data).transcript[0].private = true;
  current(data).summary = [fact.text];
  assert.deepEqual(read(data).topicPoints, []);
  const previous = current(data);
  data.sessions = data.sessions.filter(value => value.id !== sessionId);
  assert.deepEqual(readSessionPresentation(data, previous).chapterPoints, {});
});

test('shared views only quote current public turns and never use a personal summary to rank them', () => {
  const data = setup(), session = current(data);
  session.transcript.push(
    { id: 'private', speaker: '我', time: '00:00:25', text: '用户测试背后的私人底价为九元。', private: true },
    { id: 'public-2', speaker: '同事', time: '00:00:30', text: '用户测试里三个人停在欢迎页。' },
    { id: 'public-3', speaker: '同事', time: '00:00:35', text: '用户测试里两个人找不到返回入口。' },
  );
  session.summary = [fact.text, '用户测试背后的私人底价为九元。'];
  const shared = read(data, true);
  assert.deepEqual(shared.topicPoints.map(value => value.sourceId), ['public-2', 'public-3']);
  assert.equal(JSON.stringify(shared).includes('私人底价'), false);
  assert.deepEqual(shared.decisions, []);
  assert.deepEqual(shared.checks, []);
  data.settings.space = 'Oops 产品团队';
  data.settings.toggles[`shared-${sessionId}`] = true;
  assert.equal(read(data).topicPoints.length, 2);
  data.settings.toggles[`shared-${sessionId}`] = false;
  assert.deepEqual(read(data).chapterPoints, {});
});

test('decision and action highlights keep their prior meaning and are not replaced by plain excerpts', () => {
  const data = setup();
  current(data).transcript.push(
    { id: 'decision', speaker: '我', time: '00:00:30', text: '用户测试决定先按十万元预算。' },
    { id: 'action', speaker: '我', time: '00:00:40', text: '用户测试里我来整理访谈清单。' },
  );
  const result = read(data);
  assert.deepEqual(result.topicPoints.map(value => value.label), ['结论候选', '行动草稿']);
  assert.deepEqual(result.topicPoints.map(value => value.sourceId), ['decision', 'action']);
  assert.equal(result.decisions[0].state, 'pending');
  assert.equal(data.tasks.length, 0);
});

test('a lengthy excerpt stays short but its source route still resolves the complete original passage', () => {
  const data = setup();
  current(data).transcript[0].text = `用户测试${'说明文字很长。'.repeat(40)}`;
  const point = read(data).topicPoints[0];
  assert.equal(point.text.length, 181);
  assert.equal(point.text.endsWith('…'), true);
  assert.equal(sourceTurn(data, { sourceSession: point.route.id, sourceId: point.route.mode }).text, current(data).transcript[0].text);
});

test('a finished factual conversation has overview excerpts without inventing a conclusion or action', () => {
  const data = setup();
  current(data).status = '已结束';
  delete data.activeSessionId;
  const result = read(data);
  assert.deepEqual(result.findings, []);
  assert.equal(result.excerptPoints[0].text, fact.text);
  assert.deepEqual(result.excerptPoints[0].route, { view: 'session-transcript', id: sessionId, mode: fact.id });
  assert.equal(result.pendingCount, 0);
  assert.equal(data.settings.retention[`session-review-items:${sessionId}`], undefined);
});

test('overview keeps an ordinary fact visible beside decision and action candidates from the same chapter', () => {
  const data = setup();
  current(data).status = '已结束';
  current(data).transcript.push(
    { id: 'decision', speaker: '我', time: '00:00:30', text: '用户测试决定先按十万元预算。' },
    { id: 'action', speaker: '我', time: '00:00:40', text: '用户测试里我来整理访谈清单。' },
  );
  const result = read(data);
  assert.equal(result.findings.some(value => value.kind === '决定'), true);
  assert.equal(result.findings.some(value => value.kind === '行动'), true);
  assert.deepEqual(result.excerptPoints.map(value => value.sourceId), ['fact']);
  assert.equal(result.excerptPoints[0].text, fact.text);
  assert.deepEqual(result.topicPoints.map(value => value.label), ['结论候选', '行动草稿']);
});

test('overview offers facts from different chapters before taking a second excerpt from the first chapter', () => {
  const data = setup();
  current(data).agenda.push('合作反馈');
  current(data).transcript.push(
    { id: 'fact-2', speaker: '我', time: '00:00:25', text: '用户测试里三个人停在欢迎页。' },
    { id: 'feedback', speaker: '同事', time: '00:00:30', text: '合作反馈来自三位设计师。' },
  );
  const points = read(data).excerptPoints;
  assert.deepEqual(points.map(value => value.sourceId), ['fact', 'feedback']);
  assert.equal(points.length, 2);
});

test('overview excerpts disappear or refresh with source access and never promote a private legacy summary', () => {
  const data = setup(), previousSession = current(data);
  current(data).summary = [fact.text, '旧的私密业务结论。'];
  data.sessions = data.sessions.map(session => session.id === sessionId ? { ...session, transcript: [{ ...fact, text: '用户测试显示入口文字太长。' }] } : session);
  assert.equal(read(data, false, previousSession).excerptPoints[0].text, '用户测试显示入口文字太长。');
  current(data).transcript[0].private = true;
  assert.deepEqual(read(data).excerptPoints, []);
  assert.deepEqual(read(data, true).excerptPoints, []);
  data.settings.space = '未共享的团队';
  assert.deepEqual(read(data).excerptPoints, []);
});
