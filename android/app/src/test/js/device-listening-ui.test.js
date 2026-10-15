'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.resolve(__dirname, '../../main/assets/web');
function model() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(web, 'device-listening-demo.js'), 'utf8'), context);
  return context.window.OopsDeviceListeningDemo;
}
function ui() {
  const elements = new Map(), messages = [], errors = [];
  function el(id) {
    if (!elements.has(id)) elements.set(id, { id, dataset: {}, style: { setProperty() {} }, children: [],
      classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, appendChild() {}, insertBefore() {},
      querySelectorAll: () => [], listeners: {}, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); } });
    return elements.get(id);
  }
  const native = { postMessage(raw) { messages.push(JSON.parse(raw)); } };
  const context = { window: { OopsNative: native, addEventListener() {} }, location: { search: '' }, URLSearchParams,
    document: { addEventListener() {}, getElementById: el, createElement: () => el(Symbol()), querySelectorAll: () => [], documentElement: { dataset: {} } },
    console: { ...console, error(error) { errors.push(error); } }, setTimeout: () => 1, clearTimeout() {} };
  for (const file of ['device-listening-demo.js', 'app.js']) vm.runInNewContext(fs.readFileSync(path.join(web, file), 'utf8'), context);
  const receive = (type, payload) => native.onmessage({ data: JSON.stringify({ type, payload }) });
  const click = (act, data = {}, sheet = false) => el(sheet ? 'sheet' : 'root').listeners.click.forEach(fn => fn({ stopPropagation() {},
    target: { closest(selector) { return selector === '#sheet' ? null : { dataset: { act, ...data } }; } } }));
  receive('snapshot', { state: { capturing: false, recordingMode: 'daily', source: 'mic' }, transcript: [], team: [] });
  return { el, receive, click, messages, errors, screen: () => el('screen').innerHTML, sheet: () => el('sheet').innerHTML };
}
const pair = (u, on = false) => { u.click('go', { route: 'device' }); u.click('device-pair'); u.el('device-pair-auto').checked = on; u.click('device-pair-confirm', {}, true); };

test('device model defaults off; pairing and preference changes never start a capture', () => {
  const m = model(); let s = m.create(); assert.equal(s.autoListen, false); assert.equal(s.paired, false);
  s = m.reduce(s, { type: 'pair', autoListen: true }); assert.equal(s.status, 'idle'); assert.equal(s.sessionId, null);
  s = m.reduce(s, { type: 'preferences', autoListen: true, quietEnabled: true, quietStart: '22:00', quietEnd: '08:00' });
  assert.equal(s.status, 'idle'); assert.equal(s.sessionId, null);
  s = m.reduce(s, { type: 'power' }); assert.equal(s.status, 'listening'); assert.match(s.sessionId, /^device-demo-daily-/);
  const again = m.reduce(s, { type: 'power' }); assert.equal(again.sessionId, s.sessionId); assert.equal(again.serial, 1);
});
test('unpaired, opt-out, and unavailable conditions block automatic start', () => {
  const m = model(); assert.equal(m.reduce(m.create(), { type: 'power' }).status, 'idle');
  const off = m.reduce(m.create(), { type: 'pair', autoListen: false }); assert.equal(m.reduce(off, { type: 'power' }).status, 'idle');
  for (const condition of ['permission', 'background', 'disconnected', 'quiet', 'service']) {
    let s = m.reduce(m.create(), { type: 'pair', autoListen: true });
    s = m.reduce(s, { type: 'condition', condition }); s = m.reduce(s, { type: 'power' }); assert.notEqual(s.status, 'listening', condition);
  }
});
test('all recovered conditions remain interrupted until an explicit resume preserves the same daily example', () => {
  const m = model();
  for (const condition of ['permission', 'background', 'disconnected', 'quiet', 'service']) {
    let s = m.reduce(m.reduce(m.create(), { type: 'pair', autoListen: true }), { type: 'power' }); const id = s.sessionId;
    s = m.reduce(s, { type: 'condition', condition }); assert.equal(s.status, 'interrupted');
    s = m.reduce(s, { type: 'condition', condition: 'ready' }); s = m.reduce(s, { type: 'power' });
    assert.equal(s.status, 'interrupted'); assert.equal(s.needsResume, true);
    s = m.reduce(s, { type: 'resume' }); assert.equal(s.status, 'listening'); assert.equal(s.sessionId, id);
  }
});
test('user pause and stop stay above reconnect and preference changes', () => {
  const m = model(); let s = m.reduce(m.reduce(m.create(), { type: 'pair', autoListen: true }), { type: 'power' }); const id = s.sessionId;
  s = m.reduce(s, { type: 'pause' }); s = m.reduce(s, { type: 'condition', condition: 'disconnected' }); s = m.reduce(s, { type: 'condition', condition: 'ready' });
  s = m.reduce(s, { type: 'preferences', autoListen: true, quietEnabled: false, quietStart: '22:00', quietEnd: '08:00' });
  s = m.reduce(s, { type: 'power' }); assert.equal(s.status, 'paused'); assert.equal(s.hold, 'paused');
  s = m.reduce(s, { type: 'resume' }); assert.equal(s.sessionId, id);
  s = m.reduce(s, { type: 'stop' }); s = m.reduce(s, { type: 'power' }); assert.equal(s.status, 'stopped'); assert.equal(s.sessionId, null);
  s = m.reduce(s, { type: 'resume' }); assert.equal(s.status, 'listening'); assert.notEqual(s.sessionId, id);
});
test('an existing session blocks every device capture action without changing the external session', () => {
  const m = model(), external = { activeSessionId: 'already-formal-meeting', recordingMode: 'meeting' };
  let s = m.reduce(m.create(), { type: 'pair', autoListen: true }, external);
  for (const type of ['power', 'resume', 'pause', 'stop']) s = m.reduce(s, { type }, external);
  assert.equal(s.status, 'idle'); assert.equal(s.serial, 0); assert.equal(external.activeSessionId, 'already-formal-meeting'); assert.equal(external.recordingMode, 'meeting');
});
// 2026-10-13: four tab bar entries around the record button; Settings ("me") opens from the home header.
test('settings opens from the home header beside four tab entries and keeps old routes and existing entry actions', () => {
  const u = ui(); for (const label of ['首页', '会话', '任务', '记忆']) assert.match(u.el('nav').innerHTML, new RegExp(`aria-label="${label}"`));
  assert.match(u.el('nav').innerHTML, /data-act="record-button"/); assert.doesNotMatch(u.el('nav').innerHTML, /aria-label="(设置|我的)"/);
  assert.match(u.el('hdr').innerHTML, /aria-label="设置" data-act="go" data-route="me"/); assert.match(u.el('hdr').innerHTML, /icons\/gear-six.svg/);
  u.click('go', { route: 'me' }); assert.match(u.el('hdr').innerHTML, /<h1>设置<\/h1>/);
  for (const text of ['账户与身份', '声音身份与许可', '收音、唤醒与提醒偏好', '隐私、保存与共享', '服务连接']) assert.ok(u.screen().includes(text), text);
  u.click('go', { route: 'settings' }); assert.match(u.screen(), /id="set-source"/); assert.match(u.screen(), /data-act="apply-settings"/);
  u.click('back'); assert.match(u.el('hdr').innerHTML, /<h1>设置<\/h1>/); assert.deepEqual(u.errors, []);
});
test('first-pair sheet is opt-in and cancel or unchecked confirmation never starts anything', () => {
  const u = ui(); u.click('go', { route: 'device' }); u.click('device-pair');
  assert.match(u.sheet(), /id="device-pair-auto" type="checkbox">/); assert.doesNotMatch(u.sheet(), /id="device-pair-auto"[^>]*checked/);
  u.click('close', {}, true); assert.match(u.screen(), /还未进行示例配对/);
  pair(u); u.click('device-power'); assert.match(u.screen(), /开机自动聆听未开启/); assert.doesNotMatch(u.screen(), /device-demo-daily-1/);
  assert.ok(u.messages.every(x => !/^(capture\.|settings.set|voiceprint\.)/.test(x.type))); assert.deepEqual(u.errors, []);
});
test('paired device UI needs a power event, then explicit recovery, and stays isolated from native events', () => {
  const u = ui(); pair(u, true); assert.match(u.screen(), /等待示例设备开机/); u.click('device-power'); assert.match(u.screen(), /日常临时聆听中 · 示例/);
  const nativeCount = u.messages.length;
  u.click('device-condition', { value: 'permission' }); assert.match(u.screen(), /权限缺失/);
  u.click('device-condition', { value: 'ready' }); u.click('device-power'); assert.match(u.screen(), /条件已恢复，等待你恢复/);
  u.click('device-resume'); assert.match(u.screen(), /日常临时聆听中 · 示例/);
  u.click('device-pause'); u.click('device-power'); assert.match(u.screen(), /你已暂停 · 示例/);
  u.click('device-stop'); u.click('device-power'); assert.match(u.screen(), /你已停止 · 示例/);
  assert.equal(u.messages.length, nativeCount); assert.deepEqual(u.errors, []);
});
test('device preference validation and cancel preserve current choice and do not start a session', () => {
  const u = ui(); pair(u); u.click('device-preferences'); u.el('device-auto').checked = true; u.click('close', {}, true); assert.match(u.screen(), /开机自动聆听未开启/);
  u.click('device-preferences'); u.el('device-auto').checked = true; u.el('device-quiet').checked = true;
  u.el('device-quiet-start').value = '25:00'; u.el('device-quiet-end').value = '08:00'; u.click('device-preferences-save', {}, true); assert.equal(u.el('sheet').hidden, false);
  u.el('device-quiet-start').value = '22:00'; u.click('device-preferences-save', {}, true); assert.match(u.screen(), /22:00–08:00/); assert.match(u.screen(), /等待示例设备开机/);
  assert.doesNotMatch(u.screen(), /device-demo-daily-1/); assert.ok(u.messages.every(x => x.type !== 'settings.set')); assert.deepEqual(u.errors, []);
});
test('native active meeting takes priority over the device example and retains mode and session id', () => {
  const u = ui(); pair(u, true);
  u.receive('state', { capturing: true, sessionId: 'native-meeting', recordingMode: 'meeting', cloudSaveConfirmed: true, audioRetentionDays: 7, transcriptRetentionDays: 90 });
  u.click('go', { route: 'device' }); const count = u.messages.length;
  for (const act of ['device-power', 'device-resume', 'device-stop']) u.click(act);
  assert.match(u.screen(), /现有正式会议继续/); assert.match(u.screen(), /不会新建重复会话/); assert.equal(u.messages.length, count);
  u.click('go', { route: 'home' }); assert.match(u.screen(), /正式会议/); assert.match(u.el('rc').innerHTML, /native-meeting|正式会议/); assert.deepEqual(u.errors, []);
});


test('when native recording occupies a running example, ending it never silently restores example listening', () => {
  const u = ui(); pair(u, true); u.click('device-power'); assert.match(u.screen(), /日常临时聆听中 · 示例/);
  u.receive('state', { capturing: true, sessionId: 'native-daily', recordingMode: 'daily' }); u.click('go', { route: 'device' }); assert.match(u.screen(), /现有日常记录继续/);
  u.receive('state', { capturing: false, sessionId: '' }); u.click('device-power'); assert.match(u.screen(), /条件已恢复，等待你恢复/);
  u.click('device-resume'); assert.match(u.screen(), /日常临时聆听中 · 示例/);
  assert.ok(u.messages.every(x => !/^capture\./.test(x.type))); assert.deepEqual(u.errors, []);
});
