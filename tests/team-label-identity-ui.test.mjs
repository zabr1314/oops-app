import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium, expect } from '@playwright/test'

// Run the real label UI against isolated, synthetic API responses. No production network.
const people = ['洪玉麟', '林春源', '江古月', '黄丽萍']
const source = { mode: 'voice_group', id: 'role:A', shared: true, by: '林春源', at: '2026-10-13T01:00:00Z' }
const rows = [
  { id: 'r1', text: '酒店需要问一下对接人。', start_ms: 1000, end_ms: 2500, fingerprint: 'r1-fp' },
  { id: 'r2', text: '我去问一下对接人。', start_ms: 3000, end_ms: 4500, fingerprint: 'r2-fp' },
]

async function setup(t, { confirmed = false, pendingIdentity = false } = {}) {
  const html = (await readFile(new URL('../scripts/team_label_ui.html', import.meta.url), 'utf8'))
    .replace('__PEOPLE__', JSON.stringify(people)).replace('__DUPS__', 'ABC')
  const browser = await chromium.launch({ headless: true, channel: process.env.OOPS_LABEL_TEST_BROWSER || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  const errors = [], writes = [], reads = []
  page.on('pageerror', e => errors.push(String(e)))
  let groupSpeaker = pendingIdentity ? null : '江古月'
  let singleSpeaker = pendingIdentity ? null : '黄丽萍'
  let identityRevision = 1, contentRevision = 1, itemRevision = 1
  let review = confirmed ? { status: 'confirmed', kind: 'task', title: '问酒店对接人', detail: '', due: '', owner: '洪玉麟' } : null
  const identity = () => ({ shared: true, scope: 'team', revision: identityRevision, can_undo: false, groups: [{
    id: 'role:A', fingerprint: 'group-fp', title: '角色 A', count: 2, shared: true,
    speaker: groupSpeaker, current: !!groupSpeaker, confirmed_by: '林春源', confirmed_at: source.at,
    approval: groupSpeaker ? { speaker: groupSpeaker, by: '林春源', fingerprint: 'group-fp' } : null,
    members: rows.map(r => ({ ...r, meeting: '0235' })), clips: [{ ...rows[0], meeting: '0235' }],
  }] })
  const labels = () => Object.fromEntries(rows.flatMap(r => {
    const speaker = r.id === 'r2' ? singleSpeaker : groupSpeaker
    return speaker ? [[r.id, { speaker, speaker_source: r.id === 'r2' ? { mode: 'single', by: '洪玉麟' } : source }]] : []
  }))
  const meeting = () => ({ meeting: '0235', rows, labels: labels(), review_mode: 'assisted', revision: contentRevision, can_undo: false,
    expressions: [{ id: 'e1', ids: ['r1', 'r2'], text: rows.map(r => r.text).join(''), start_ms: 1000, end_ms: 4500, fingerprint: 'expression-fp', required_for_content: true }],
    content_progress: { required_expression_count: 1, complete_required_expressions: 0 },
    assistance: { status: 'unavailable' }, blind: { total: 0, completed: 0, remaining: 0 },
  })
  const items = () => {
    const l = labels(), evidenceRows = rows.map(r => ({ ...r, speaker: l[r.id]?.speaker || null, speaker_source: l[r.id]?.speaker_source || null }))
    return { meeting: '0235', status: 'ready', revision: itemRevision, can_undo: false,
      counts: { todo: review ? 0 : 1, confirmed: review ? 1 : 0, rejected: 0 }, items: [{
        id: 'i1', fingerprint: 'item-fp', kind: 'task', title: '问酒店对接人', detail: '', due: '', claimed: true,
        source: 'ai', speakers: [...new Set(evidenceRows.map(r => r.speaker).filter(Boolean))],
        claimant_status: singleSpeaker ? 'identified' : 'identity_pending',
        claimants: [{ speaker: singleSpeaker, text: rows[1].text, ids: ['r2'], start_ms: 3000, end_ms: 4500,
          source: 'explicit_first_person', speaker_source: l.r2?.speaker_source || null }],
        evidence: [{ ids: ['r1', 'r2'], start_ms: 1000, end_ms: 4500, rows: evidenceRows }], review,
      }],
    }
  }
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    if (url.hostname !== 'oops-ui.test') return route.abort()
    if (path === '/label/') return route.fulfill({ contentType: 'text/html', body: html })
    if (request.method() === 'POST') {
      const body = request.postDataJSON(); writes.push({ path, body })
      if (path === '/label/api/identity') { groupSpeaker = body.action === 'revoke' ? null : body.speaker; identityRevision++; return route.fulfill({ json: identity() }) }
      if (path === '/label/api/meeting/0235/review') {
        if (body.field === 'speaker') { singleSpeaker = body.value; contentRevision++ }
        return route.fulfill({ json: meeting() })
      }
      if (path === '/label/api/meeting/0235/items/review') {
        review = { status: 'confirmed', kind: body.kind, title: body.title, detail: body.detail, due: body.due, owner: body.owner }; itemRevision++
        return route.fulfill({ json: items() })
      }
    }
    reads.push(path)
    if (path === '/label/api/me') return route.fulfill({ json: { name: '洪玉麟', meetings: [{ id: '0235', title: '合成测试会议' }] } })
    if (path === '/label/api/identity') return route.fulfill({ json: identity() })
    if (path === '/label/api/meeting/0235') return route.fulfill({ json: meeting() })
    if (path === '/label/api/meeting/0235/items') return route.fulfill({ json: items() })
    return route.fulfill({ status: 404, body: 'not found' })
  })
  await page.goto('https://oops-ui.test/label/')
  await expect(page.locator('#item-owner')).toBeVisible()
  t.after(() => assert.deepEqual(errors, []))
  return { page, writes, reads }
}

test('evidence names and explicit claimant remain separate from owner confirmation', async t => {
  const { page, writes } = await setup(t)
  await expect(page.locator('.evidence-row')).toHaveCount(2)
  await expect(page.locator('.evidence-row').nth(0)).toContainText('江古月')
  await expect(page.locator('.evidence-row').nth(0)).toContainText('团队音色组 · 林春源确认')
  await expect(page.locator('.evidence-row').nth(1)).toContainText('黄丽萍')
  await expect(page.locator('.evidence-row').nth(1)).toContainText('单句核对 · 洪玉麟确认')
  await expect(page.locator('.claimant')).toContainText('黄丽萍')
  await expect(page.locator('.claimant')).toContainText('我去问一下对接人。')
  await expect(page.locator('#item-owner')).toHaveValue('')
  await page.locator('#item-confirm').click()
  await expect(page.locator('#item-error')).toContainText('先选负责人')
  assert.equal(writes.length, 0)
  await page.locator('#item-owner').selectOption('洪玉麟')
  await page.locator('#item-confirm').click()
  await expect(page.locator('.reviewed-result')).toContainText('负责人 玉麟')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].body.owner, '洪玉麟')
  assert.notEqual(writes[0].body.owner, '黄丽萍')
})

test('team identity is already shared and correcting it refreshes item names without changing owner', async t => {
  const { page, writes, reads } = await setup(t, { confirmed: true })
  await expect(page.locator('#item-owner')).toHaveValue('洪玉麟')
  await page.locator('#tab-voice').click()
  await expect(page.locator('.voice-current')).toContainText('由 林春源确认')
  await expect(page.locator('.voice-current')).toContainText('其他成员无需重复认人')
  await expect(page.locator('.voice-title')).toHaveText('角色 A → 江古月')
  await expect(page.locator('#progress-copy')).toHaveText('团队已确认 1 / 1 个音色组')
  await expect(page.locator('#confirm-voice')).toHaveCount(0)
  await expect(page.locator('.voice-scope')).toContainText('修改和撤回会更新团队共用的姓名')
  await page.locator('#edit-voice').click()
  await page.locator('#voice-person').selectOption('林春源')
  const before = reads.filter(p => p.endsWith('/items')).length
  await page.locator('#confirm-voice').click()
  await expect(page.locator('.voice-title')).toHaveText('角色 A → 林春源')
  await expect.poll(() => reads.filter(p => p.endsWith('/items')).length).toBeGreaterThan(before)
  await page.locator('#tab-items').click()
  await expect(page.locator('.evidence-row').nth(0)).toContainText('林春源')
  await expect(page.locator('.evidence-row').nth(1)).toContainText('黄丽萍')
  await expect(page.locator('#item-owner')).toHaveValue('洪玉麟')
  assert.equal(writes.filter(w => w.path.endsWith('/items/review')).length, 0)
})

test('single-row correction takes precedence and refreshes claimant while retaining confirmed owner', async t => {
  const { page, writes } = await setup(t, { confirmed: true })
  await page.locator('.claimant [data-span-jump]').click()
  await expect(page.locator('[data-row="r2"][data-field="speaker"]')).toBeVisible()
  await page.locator('[data-row="r2"][data-field="speaker"]').selectOption('林春源')
  await expect(page.locator('#state')).toHaveText('已保存')
  await page.locator('#tab-items').click()
  await expect(page.locator('.claimant')).toContainText('林春源')
  await expect(page.locator('.evidence-row').nth(1)).toContainText('林春源')
  await expect(page.locator('#item-owner')).toHaveValue('洪玉麟')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].body.field, 'speaker')
})

test('unidentified first-person claim is shown without inventing a name or owner', async t => {
  const { page, writes } = await setup(t, { pendingIdentity: true })
  await expect(page.locator('.claimant')).toContainText('身份待核对')
  await expect(page.locator('.claimant')).toContainText('我去问一下对接人。')
  await expect(page.locator('#item-owner')).toHaveValue('')
  assert.equal(writes.length, 0)
})

test('team revocation updates names but preserves single-row corrections and confirmed owner', async t => {
  const { page, writes } = await setup(t, { confirmed: true })
  await page.locator('#tab-voice').click()
  await page.locator('#revoke-voice').click()
  await expect(page.locator('.voice-title')).toHaveText('角色 A')
  await page.locator('#tab-items').click()
  await expect(page.locator('.evidence-row').nth(0)).toContainText('身份待核对')
  await expect(page.locator('.evidence-row').nth(1)).toContainText('黄丽萍')
  await expect(page.locator('#item-owner')).toHaveValue('洪玉麟')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].body.action, 'revoke')
})

test('mobile evidence and claimant provenance fit the screen and keep owner unselected', async t => {
  const { page } = await setup(t)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.claimant')).toBeVisible()
  await expect(page.locator('#item-owner')).toHaveValue('')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  if (process.env.OOPS_LABEL_TEST_SCREENSHOT) await page.screenshot({ path: process.env.OOPS_LABEL_TEST_SCREENSHOT, fullPage: true })
})
