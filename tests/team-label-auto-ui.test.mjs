import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium, expect } from '@playwright/test'

const people = ['洪玉麟', '林春源', '江古月', '黄丽萍']
const raw = '我去问一下对接人。'
const rows = [{ id: 'r1', text: raw, start_ms: 1000, end_ms: 3000, fingerprint: 'row-fp' }]
const sharedSource = { mode: 'voice_group', id: 'role:A', shared: true, by: '林春源' }

async function setup(t, initial = {}) {
  const browser = await chromium.launch({ headless: true, channel: process.env.OOPS_LABEL_TEST_BROWSER || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  await page.clock.install()
  const html = (await readFile(new URL('../scripts/team_label_ui.html', import.meta.url), 'utf8'))
    .replace('__PEOPLE__', JSON.stringify(people)).replace('__DUPS__', 'ABC')
  const requests = [], errors = []
  let catalogRevision = 1, failCatalog = false, holdWrite = null, releaseWrite = null
  const meetings = new Map([['0235', { id: '0235', title: '原有合成会议', stage: 'ready', revision: 1,
    audio_available: true, empty: false, name: '江古月', ...initial }]])
  const update = (id, patch) => {
    const current = meetings.get(id) || { id, title: '新导入合成会议', stage: 'waiting_transcript', revision: 0, imported: true, audio_available: false, empty: true, name: '江古月' }
    meetings.set(id, { ...current, ...patch, revision: current.revision + 1 }); catalogRevision++
  }
  const processing = m => ({ stage: m.stage, revision: m.revision, reason_code: m.reason_code || '', retryable: m.retryable !== false })
  const identity = () => ({ shared: true, scope: 'team', revision: 1, can_undo: false, groups: [{
    id: 'role:A', title: '角色 A', count: 1, fingerprint: 'group-fp', shared: true, speaker: '江古月', current: true,
    confirmed_by: '林春源', approval: { speaker: '江古月', by: '林春源' },
    members: [{ ...rows[0], meeting: '0235' }], clips: [{ ...rows[0], meeting: '0235' }],
  }] })
  const meetingPayload = m => {
    const visibleRows = m.stage === 'waiting_transcript' || ['expired', 'waiting_policy'].includes(m.stage) ? [] : rows
    return { id: m.id, rows: visibleRows, labels: visibleRows.length ? { r1: { speaker: m.name, speaker_source: m.speakerSource || sharedSource } } : {},
      revision: 1, review_mode: 'assisted', can_undo: false,
      expressions: visibleRows.length ? [{ id: 'e1', ids: ['r1'], text: raw, start_ms: 1000, end_ms: 3000, fingerprint: 'expression-fp', required_for_content: true }] : [],
      content_progress: { required_expression_count: visibleRows.length, complete_required_expressions: 0 },
      assistance: { status: 'unavailable' }, blind: { total: 0, completed: 0, remaining: 0 },
    }
  }
  const itemsPayload = m => ({ meeting: m.id, status: m.itemStatus || (m.stage === 'ready' ? 'ready' : 'pending'), processing: processing(m), source_kind: 'existing_summary',
    revision: 1, can_undo: false, counts: { todo: m.empty ? 0 : 1, confirmed: 0, rejected: 0 }, items: m.empty ? [] : [{
      id: 'i1', fingerprint: 'item-fp', kind: 'task', title: m.itemTitle || '问酒店对接人', detail: '', due: '', claimed: true, source: 'ai', review: null,
      speakers: [m.name], claimants: [{ speaker: m.name, text: raw, ids: ['r1'], start_ms: 1000, end_ms: 3000, source: 'explicit_first_person', speaker_source: m.speakerSource || sharedSource }],
      evidence: [{ ids: ['r1'], start_ms: 1000, end_ms: 3000, rows: [{ ...rows[0], speaker: m.name, speaker_source: m.speakerSource || sharedSource }] }],
    }],
  })
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    if (url.hostname !== 'oops-auto-ui.test') return route.abort()
    if (path === '/label/') return route.fulfill({ contentType: 'text/html', body: html })
    requests.push({ path, method: request.method(), body: request.method() === 'POST' ? request.postDataJSON() : null })
    if (path === '/label/api/me') {
      if (failCatalog) return route.fulfill({ status: 503, body: '{}' })
      return route.fulfill({ json: { name: '洪玉麟', catalog_revision: catalogRevision, meetings: [...meetings.values()].map(m => ({ id: m.id, title: m.title, imported: !!m.imported, processing: processing(m), audio_available: m.audio_available })) } })
    }
    if (path === '/label/api/identity') return route.fulfill({ json: identity() })
    const match = path.match(/^\/label\/api\/meeting\/(\d{4})(\/items(?:\/review)?|\/review)?$/)
    if (match) {
      const m = meetings.get(match[1]); if (!m) return route.fulfill({ status: 404, body: '{}' })
      if (request.method() === 'POST' && holdWrite) { await holdWrite; return route.fulfill({ status: 503, body: '{}' }) }
      return route.fulfill({ json: match[2]?.startsWith('/items') ? itemsPayload(m) : meetingPayload(m) })
    }
    return route.fulfill({ status: 404, body: '{}' })
  })
  await page.goto('https://oops-auto-ui.test/label/')
  await expect(page.locator('#state')).toHaveText('已读取')
  t.after(() => assert.deepEqual(errors, []))
  page.on('pageerror', e => errors.push(String(e)))
  const focus = async () => {
    const before = requests.filter(r => r.path.endsWith('/api/me')).length
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => requests.filter(r => r.path.endsWith('/api/me')).length).toBeGreaterThan(before)
    await expect(page.locator('#refresh-meetings')).toBeEnabled()
  }
  return { page, requests, update, focus, setCatalogFailure: v => { failCatalog = v },
    holdNextWrite: () => { holdWrite = new Promise(resolve => { releaseWrite = resolve }) }, releaseWrite: () => releaseWrite?.() }
}

const itemReads = requests => requests.filter(r => r.method === 'GET' && r.path.endsWith('/items')).length
const writes = requests => requests.filter(r => r.method === 'POST')

test('focus and the 15-second timer discover new meetings using GET and retain current meeting', async t => {
  const { page, requests, update, focus } = await setup(t)
  const before = itemReads(requests)
  update('0236', { stage: 'waiting_transcript' })
  await focus()
  await expect(page.locator('#meeting option')).toHaveCount(2)
  await expect(page.locator('#meeting option[value="0236"]')).toContainText('等待转录')
  await expect(page.locator('#meeting')).toHaveValue('0235')
  assert.equal(itemReads(requests), before)
  update('0238', { stage: 'waiting_summary' })
  await page.clock.fastForward(15000)
  await expect(page.locator('#meeting option')).toHaveCount(3)
  await expect(page.locator('#meeting')).toHaveValue('0235')
  assert.equal(itemReads(requests), before)
  assert.equal(writes(requests).length, 0)
})

test('new meeting moves from waiting transcript through waiting summary to ready without model or review writes', async t => {
  const { page, requests, update, focus } = await setup(t)
  update('0236', { stage: 'waiting_transcript' }); await focus()
  await page.locator('#meeting').selectOption('0236')
  await expect(page.locator('#focus h2')).toHaveText('等待转录')
  await expect(page.locator('#add-item')).toBeHidden()
  await expect(page.locator('#item-add-empty')).toHaveCount(0)
  await expect(page.locator('#listen')).toHaveCount(0)
  update('0236', { stage: 'waiting_summary', audio_available: true }); await focus()
  await expect(page.locator('#focus h2')).toHaveText('等待纪要')
  await expect(page.locator('#item-add-empty')).toHaveCount(0)
  update('0236', { stage: 'processing' }); await focus()
  await expect(page.locator('#focus h2')).toHaveText('整理中')
  update('0236', { stage: 'ready', empty: false }); await focus()
  await expect(page.locator('.item-title')).toHaveText('问酒店对接人')
  await expect(page.locator('.item-meta')).toContainText('从已有纪要整理')
  await expect(page.locator('#item-owner')).toHaveValue('')
  await expect(page.locator('.claimant')).toContainText('江古月')
  await page.locator('#tab-voice').click()
  await expect(page.locator('.voice-current')).toContainText('其他成员无需重复认人')
  assert.equal(writes(requests).length, 0)
})

test('catalog updates preserve an edit draft and only replace content after cancellation and explicit reading', async t => {
  const { page, requests, update, focus } = await setup(t)
  await page.locator('#item-edit').click()
  await page.locator('[data-item-field="title"]').fill('我还在改这件事')
  const before = itemReads(requests)
  update('0235', { itemTitle: '后台更新后的事项', stage: 'processing' }); await focus()
  await expect(page.locator('[data-item-field="title"]')).toHaveValue('我还在改这件事')
  await expect(page.locator('#catalog-note')).toContainText('已保留你的编辑')
  await expect(page.locator('#read-updates')).toBeDisabled()
  assert.equal(itemReads(requests), before)
  await page.locator('#item-cancel').click()
  await expect(page.locator('#read-updates')).toBeEnabled()
  update('0235', { stage: 'ready' })
  await page.locator('#read-updates').click()
  await expect(page.locator('.item-title')).toHaveText('后台更新后的事项')
  await expect(page.locator('#item-owner')).toHaveValue('')
  assert.equal(writes(requests).length, 0)
})

test('unconfirmed owner choice survives polling and is never submitted or replaced automatically', async t => {
  const { page, requests, update, focus } = await setup(t)
  await page.locator('#item-owner').selectOption('洪玉麟')
  const before = itemReads(requests)
  update('0235', { stage: 'failed', retryable: true }); await focus()
  await expect(page.locator('#item-owner')).toHaveValue('洪玉麟')
  await expect(page.locator('#catalog-note')).toContainText('已保留你的编辑')
  assert.equal(itemReads(requests), before)
  assert.equal(writes(requests).length, 0)
})

test('failed processing and catalog read failure retain real recovery states without pretending to enqueue work', async t => {
  const { page, requests, update, focus, setCatalogFailure } = await setup(t, { stage: 'failed', empty: true, retryable: true })
  await expect(page.locator('#focus h2')).toHaveText('整理未完成')
  await expect(page.locator('.processing-copy')).toContainText('后台会自动恢复')
  setCatalogFailure(true); await focus()
  await expect(page.locator('#catalog-note')).toContainText('列表更新失败')
  await expect(page.locator('#focus h2')).toHaveText('整理未完成')
  setCatalogFailure(false); update('0235', { stage: 'ready', empty: true })
  await page.locator('#refresh-meetings').click()
  await expect(page.locator('#focus h2')).toHaveText('整理完成，没有需核对的事项')
  assert.equal(writes(requests).length, 0)
})

test('waiting-policy and expiry hide cached original text and audio even with an unsaved draft', async t => {
  const { page, requests, update, focus } = await setup(t)
  await page.locator('#item-edit').click()
  await page.locator('[data-item-field="title"]').fill('暂存我的编辑')
  update('0235', { stage: 'expired', empty: true, audio_available: false }); await focus()
  await expect(page.locator('#focus h2')).toHaveText('全文已到期')
  await expect(page.locator('#focus')).not.toContainText(raw)
  await expect(page.locator('#listen')).toHaveCount(0)
  await expect(page.locator('#add-item')).toBeHidden()
  await expect(page.locator('#catalog-note')).toContainText('已保留你的编辑')
  await page.locator('#cancel-restricted-draft').click()
  await page.locator('#tab-content').click()
  await expect(page.locator('#focus h2')).toHaveText('全文已到期')
  await expect(page.locator('#focus')).not.toContainText(raw)
  await expect(page.locator('#queue-list')).not.toContainText(raw)
  await page.locator('#tab-voice').click()
  await expect(page.locator('.clip')).toHaveCount(0)
  update('0235', { stage: 'waiting_policy' }); await focus()
  await page.locator('#tab-items').click()
  await expect(page.locator('#focus h2')).toHaveText('等待明确授权')
  assert.equal(writes(requests).length, 0)
})

test('pending write receipts are untouched while catalog polling discovers additional meetings', async t => {
  const { page, requests, update, holdNextWrite, releaseWrite } = await setup(t)
  holdNextWrite()
  await page.locator('#item-owner').selectOption('洪玉麟')
  await page.locator('#item-confirm').click()
  await expect(page.locator('#state')).toHaveText('保存中')
  const before = itemReads(requests)
  update('0236', { stage: 'waiting_transcript' })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('#meeting option')).toHaveCount(2)
  await expect(page.locator('#item-owner')).toHaveValue('洪玉麟')
  assert.equal(itemReads(requests), before)
  assert.equal(writes(requests).length, 1)
  releaseWrite()
  await expect(page.locator('#notice')).toContainText('保存未确认')
})

test('mobile waiting labels and recovery controls fit a 390-pixel viewport', async t => {
  const { page, requests, update, focus } = await setup(t)
  update('0236', { stage: 'waiting_summary', title: '新导入的较长合成会议名称', audio_available: false }); await focus()
  await page.locator('#meeting').selectOption('0236')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('#focus h2')).toHaveText('等待纪要')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.equal(writes(requests).length, 0)
  if (process.env.OOPS_LABEL_AUTO_TEST_SCREENSHOT) await page.screenshot({ path: process.env.OOPS_LABEL_AUTO_TEST_SCREENSHOT, fullPage: true })
})


test('backend manual identity is labelled as App single-row review without implying blind truth', async t => {
  const { page, requests } = await setup(t, { speakerSource: { mode: 'single', origin: 'backend_manual', by: '林春源', source_session_id: 'synthetic-session', source_utterance_id: 'synthetic-utterance' } })
  await expect(page.locator('.evidence-row')).toContainText('App单句核对 · 林春源确认')
  await expect(page.locator('.evidence-row')).not.toContainText('独立盲测')
  await expect(page.locator('#item-owner')).toHaveValue('')
  assert.equal(writes(requests).length, 0)
})


test('stale evidence status takes precedence over a previously ready catalog stage', async t => {
  const { page, requests } = await setup(t, { stage: 'ready', empty: true, itemStatus: 'stale' })
  await expect(page.locator('#focus h2')).toHaveText('来源已变化')
  await expect(page.locator('.processing-copy')).toContainText('旧事项停止使用')
  await expect(page.locator('#focus')).not.toContainText('未发现需要核对的事项')
  assert.equal(writes(requests).length, 0)
})
