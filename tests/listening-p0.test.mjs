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
const logic = await import('../src/listeningLogic.ts');
const text = await readFile(new URL('../src/store.tsx', import.meta.url), 'utf8');
const seed = stripTypeScriptTypes(text.slice(text.indexOf('export function initialData')), { mode: 'strip' });
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(seed).toString('base64'));
const date = new Date('2026-10-09T06:00:00Z');
const signal = (patch = {}) => ({ id: 'sound-a', kind: 'conversation', seconds: 24, confidence: .93, turns: [{ speaker: '我', text: '先确认首版流程。' }, { speaker: '说话人 B', text: '请把会后行动也一起整理。' }], ...patch });
const options = (patch = {}) => ({ sessionId: 'session-listen-new', config: { ...logic.defaultListeningConfig }, confirmed: true, date, ...patch });

test('an effective conversation creates a real session with explicit sample source and no accepted long-term memory', () => {
  const data = initialData(); data.settings.toggles.memory = false;
  const result = logic.startListeningSession(data, signal(), options());
  assert.equal(result.sessionId, 'session-listen-new');
  assert.equal(result.data.activeSessionId, result.sessionId);
  assert.equal(result.data.sessions[0].transcript[1].speaker, '说话人 B');
  assert.match(result.data.sessions[0].transcript[0].id, /^listen-session-listen-new-/);
  assert.equal(JSON.parse(result.data.settings.retention['listening-source:' + result.sessionId]).source, '本地示例声音文本');
  assert.equal(result.data.settings.toggles['shared-' + result.sessionId], false);
  assert.deepEqual(result.data.memories, data.memories);
  assert.equal(data.sessions.length, 3, 'the previous state stays immutable');
});

test('noise and empty text cannot create sessions even after a confirm click', () => {
  const data = initialData();
  for (const sample of [signal({ kind: 'noise', turns: [] }), signal({ turns: [{ speaker: '我', text: ' ' }] })]) {
    const result = logic.startListeningSession(data, sample, options());
    assert.equal(result.data, data);
    assert.match(result.error, /没有形成有效对话/);
  }
});

test('uncertain and short voices always need an explicit human confirmation', () => {
  const data = initialData(), config = { ...logic.defaultListeningConfig, startMode: 'automatic' };
  for (const sample of [signal({ confidence: .61 }), signal({ seconds: 4 }), signal({ kind: 'uncertain' })]) {
    assert.equal(logic.judgeListeningSignal(sample, config), 'uncertain');
    assert.match(logic.startListeningSession(data, sample, options({ config, confirmed: false })).error, /请先确认/);
    assert.equal(logic.startListeningSession(data, sample, options({ config })).data.sessions[0].status, '进行中');
  }
});

test('valid speech respects the selected automatic or suggested start method', () => {
  const data = initialData();
  assert.match(logic.startListeningSession(data, signal(), options({ confirmed: false })).error, /请先确认/);
  assert.equal(logic.startListeningSession(data, signal(), options({ confirmed: false, config: { ...logic.defaultListeningConfig, startMode: 'automatic' } })).data.sessions[0].status, '进行中');
});

test('already active or already processed sounds cannot create a second session', () => {
  const started = logic.startListeningSession(initialData(), signal(), options()).data;
  const duplicate = logic.startListeningSession(started, signal({ id: 'sound-b' }), options({ sessionId: 'another' }));
  assert.equal(duplicate.data, started);
  assert.match(duplicate.error, /已有一段活动记录/);
  const ended = { ...started, activeSessionId: undefined, sessions: started.sessions.map(session => session.id === 'session-listen-new' ? { ...session, status: '已结束' } : session) };
  assert.match(logic.startListeningSession(ended, signal(), options({ sessionId: 'another' })).error, /已经处理过/);
  const orphanActive = initialData(); orphanActive.sessions[0].status = '暂停';
  assert.match(logic.startListeningSession(orphanActive, signal(), options()).error, /已有一段活动记录/);
});

test('voice permission, save preference and project sharing stay independent', () => {
  const data = initialData(); data.settings.toggles.recordingAllowed = false;
  assert.equal(logic.startListeningSession(data, signal(), options()).data, data);
  data.settings.toggles.recordingAllowed = true; data.settings.space = '项目 A';
  assert.match(logic.startListeningSession(data, signal(), options()).error, /共同纪要/);
  const config = { ...logic.defaultListeningConfig, shared: true, saveScope: '手动选择片段' };
  const started = logic.startListeningSession(data, signal(), options({ config })).data;
  assert.equal(started.settings.space, '项目 A');
  assert.equal(started.settings.toggles['shared-session-listen-new'], true);
  assert.equal(started.settings.retention['session-space:session-listen-new'], '项目 A');
  assert.equal(started.settings.retention['session-session-listen-new'], '手动选择片段');
});

test('cross-midnight quiet hours prevent automatic creation but allow one explicit override', () => {
  const config = { ...logic.defaultListeningConfig, quietEnabled: true, startMode: 'automatic' };
  const quietDate = new Date('2026-10-09T15:00:00Z');
  assert.equal(logic.inListeningQuietHours(config, quietDate), true);
  assert.equal(logic.inListeningQuietHours(config, date), false);
  assert.match(logic.startListeningSession(initialData(), signal(), options({ config, date: quietDate })).error, /安静时段/);
  assert.equal(logic.startListeningSession(initialData(), signal(), options({ config, date: quietDate, allowQuietOnce: true })).data.sessions[0].status, '进行中');
});

test('matched wake words require confirmation and wrong words keep standby intact', () => {
  const config = { ...logic.defaultListeningConfig, startMode: 'automatic' }, data = initialData();
  const wake = signal({ kind: 'wake', seconds: 2, wakeText: '你好oops，请开始' });
  assert.equal(logic.judgeListeningSignal(wake, config), 'wake');
  assert.match(logic.startListeningSession(data, wake, options({ config, confirmed: false })).error, /请先确认/);
  const incorrect = logic.startListeningSession(data, { ...wake, wakeText: '请开始' }, options({ config }));
  assert.equal(incorrect.data, data);
  assert.equal(logic.judgeListeningSignal({ ...wake, wakeText: '请开始' }, config), 'wake-missed');
});

test('end detection only validates the actual current visible session and cannot finalize or destroy it', () => {
  const started = logic.startListeningSession(initialData(), signal(), options()).data;
  const before = JSON.stringify(started);
  assert.equal(logic.listeningEndEligible(started, 'session-listen-new'), true);
  assert.equal(logic.listeningEndEligible(started, 'session-001'), false);
  assert.equal(JSON.stringify(started), before, 'suggesting or cancelling an end does not save, erase or complete content');
  const hidden = { ...started, settings: { ...started.settings, space: '另一个空间' } };
  assert.equal(logic.listeningEndEligible(hidden, 'session-listen-new'), false);
  assert.equal(logic.listeningArchivePreview(hidden, 'session-listen-new'), undefined);
});

test('bad settings are rejected and old or malformed stored config falls back safely', () => {
  assert.match(logic.validateListeningConfig({ ...logic.defaultListeningConfig, wakeWord: '' }), /唤醒词/);
  assert.match(logic.validateListeningConfig({ ...logic.defaultListeningConfig, minSeconds: 0 }), /5–120/);
  assert.match(logic.validateListeningConfig({ ...logic.defaultListeningConfig, silenceSeconds: NaN }), /30–1800/);
  assert.match(logic.validateListeningConfig({ ...logic.defaultListeningConfig, quietEnabled: true, quietStart: '08:00', quietEnd: '08:00' }), /不能相同/);
  const data = initialData(); data.settings.retention[logic.listeningConfigKey(data.settings.space)] = '{broken';
  assert.deepEqual(logic.readListeningConfig(data), logic.defaultListeningConfig);
});
