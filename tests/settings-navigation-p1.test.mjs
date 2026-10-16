import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

const prototype = readFileSync(new URL('../src/Prototype.tsx', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../src/features/MemorySettings.tsx', import.meta.url), 'utf8');
const expectedRoutes = ['settings-account', 'settings-usage', 'settings-personal-assistant', 'settings-identity', 'settings-preferences', 'settings-voice', 'settings-devices', 'settings-listening', 'settings-tools', 'settings-notifications', 'settings-privacy', 'settings-spaces'];

async function load(code, names, bindings = {}) {
  const plainCode = code.replace(/\bexport (?=function)/g, '').replace(/\bexport \{[^}]+\};/g, '');
  const { code: output } = await transformWithOxc(plainCode, 'settings-navigation-test.tsx', { jsx: { runtime: 'classic' } });
  return new Function(...Object.keys(bindings), output + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings));
}

const titleCode = settings.slice(settings.indexOf('export function settingsTitle('), settings.indexOf('export function MemoryScreens('));
const { settingsTitle } = await load(titleCode, ['settingsTitle']);

async function renderSettings(space = '我的空间') {
  const data = { settings: { name: '小林', role: '产品负责人', space, tone: '先结论，再给依据', retention: { focus: '不应在设置重复显示的记忆内容', answerLength: '适中' }, devices: { 录音豆: true, 桌面伙伴: false }, connections: { 飞书: true, 日历: false } } };
  const before = structuredClone(data), rows = [], navigations = [];
  const code = settings.slice(settings.indexOf('function SettingsHome()'), settings.indexOf('\nfunction Identity()')) + '\nexport { SettingsHome };';
  const { SettingsHome } = await load(code, ['SettingsHome'], {
    React, PERSONAL: '我的空间', useOops: () => ({ data, navigate: route => navigations.push(route) }),
    Card: ({ children, className }) => React.createElement('section', { className }, children),
    SectionTitle: ({ children }) => React.createElement('h2', null, children),
    Row: props => { rows.push(props); return React.createElement('button', { type: 'button' }, props.title, props.subtitle && React.createElement('small', null, props.subtitle)); },
  });
  const markup = renderToStaticMarkup(React.createElement(SettingsHome));
  return { data, before, rows, navigations, markup };
}

test('five primary destinations stay stable while the fifth becomes Settings with a bundled gear icon', async () => {
  const declaration = prototype.match(/const tabs=\[[^\n]+;/)?.[0];
  assert.ok(declaration);
  const { tabs } = await load(declaration, ['tabs']);
  assert.deepEqual(tabs.map(tab => tab.view), ['home', 'sessions', 'tasks', 'memory', 'settings']);
  assert.deepEqual(tabs.map(tab => tab.title), ['首页', '会话', '任务', '记忆', '设置']);
  assert.equal(tabs[4].icon, 'gear');
  assert.ok(existsSync(new URL('../public/icons/gear.svg', import.meta.url)));
});

test('the existing settings deep links retain their page titles and the root consistently says Settings', () => {
  assert.equal(settingsTitle({ view: 'settings' }), '设置');
  assert.equal(settingsTitle({ view: 'settings-unrecognized-old-link' }), '设置');
  for (const view of expectedRoutes.filter(view => view !== 'settings-listening')) assert.notEqual(settingsTitle({ view }), '设置');
  assert.match(prototype, /route\.view === 'settings-listening' \? '聆听设置'/);
  assert.equal(settingsTitle({ view: 'settings-role-import' }), '文档角色建议');
  assert.equal(settingsTitle({ view: 'settings-retention' }), '保存期限');
  assert.equal(settingsTitle({ view: 'settings-sharing' }), '已共享内容');
  assert.equal(settingsTitle({ view: 'settings-members' }), '协作与共享');
});

test('the settings page keeps every previous entry once, groups account first, and leaves memory content in Memory', async () => {
  const { rows, markup } = await renderSettings();
  assert.equal(rows.length, expectedRoutes.length);
  const headings = [...markup.matchAll(/<h2>([^<]+)<\/h2>/g)].map(match => match[1]);
  assert.deepEqual(headings, ['账户', '身份与助理', '设备与聆听', '工具与通知', '隐私与共享']);
  assert.match(markup, /小林/);
  assert.match(markup, /产品负责人/);
  assert.match(markup, /1 台示例设备/);
  assert.match(markup, /1 个示例连接/);
  assert.doesNotMatch(markup, /不应在设置重复显示的记忆内容|ms-profile|创建团队|加入团队/);
});

test('each visible entry opens the same settings route without mutating profile, scope, connections or device state', async () => {
  for (const space of ['我的空间', '历史项目范围']) {
    const { data, before, rows, navigations, markup } = await renderSettings(space);
    for (const row of rows) row.onClick();
    assert.deepEqual(navigations, expectedRoutes.map(view => ({ view })));
    assert.equal(new Set(navigations.map(route => route.view)).size, expectedRoutes.length);
    assert.deepEqual(data, before);
    assert.match(markup, space === '我的空间' ? /我的内容/ : /历史项目范围的共享内容/);
  }
});
