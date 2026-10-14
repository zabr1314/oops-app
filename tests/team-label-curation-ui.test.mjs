import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium, expect } from '@playwright/test'

// Entirely synthetic, intercepted in memory: no server, real recording, or paid API is used.
const people = ['洪玉麟', '林春源', '江古月', '黄丽萍']
const rows = [
  { id: 'r1', text: '嗯，那个，先这样。', start_ms: 0, end_ms: 1800, fingerprint: 'synthetic-r1' },
  { id: 'r2', text: '现有方案仍然按三条业务线组织。', start_ms: 2000, end_ms: 4800, fingerprint: 'synthetic-r2' },
  { id: 'r3', text: '我明天把样稿和对照表一起交给大家核对。', start_ms: 5000, end_ms: 9000, fingerprint: 'synthetic-r3' },
  { id: 'r4', text: '刚才那个历史人物叫什么来着？', start_ms: 10000, end_ms: 13000, fingerprint: 'synthetic-r4' },
]
const folded = ['r1', 'r4']
const draftOwner = '洪玉麟'
const mergedId = 'curated-merged'

async function setup(t, { rememberSuppressed = false } = {}) {
  const browser = await chromium.launch({ headless: true, channel: process.env.OOPS_LABEL_TEST_BROWSER || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  await page.clock.install()
  const html = (await readFile(new URL('../scripts/team_label_ui.html', import.meta.url), 'utf8'))
    .replace('__PEOPLE__', JSON.stringify(people)).replace('__DUPS__', 'ABC')
  if (rememberSuppressed) await page.addInitScript(() => {
    localStorage.setItem('oops-label-item:洪玉麟:0235', 'old-upload')
  })
  const requests = [], errors = [], blockedHosts = []
  page.on('pageerror', error => errors.push(String(error)))
  t.after(() => {
    assert.deepEqual(errors, [])
    assert.deepEqual(blockedHosts, [])
  })
  let revision = 1
  const makeItem = (id, title, kind = 'task', extra = {}) => ({
    id, fingerprint: 'synthetic-fp-' + id, kind, title, detail: '', due: '', claimed: false,
    source: 'ai', review: null, speakers: [], claimants: [], evidence: [{ ids: ['r3'], start_ms: 5000, end_ms: 9000, rows: [rows[2]] }], ...extra,
  })
  const items = [
    makeItem('old-upload', '交付样稿', 'task', { curation: { suppressed: true, action: 'merge', into: mergedId, reason: '样稿与对照表是同一份核对交付，已合并。' } }),
    makeItem('old-principle', '有问题马上说', 'task', { curation: { suppressed: true, action: 'suppress', reason: '属于沟通原则，没有独立交付物。' } }),
    makeItem(mergedId, '交付样稿及对照表，供大家统一核对', 'task', { source: 'curated', curation: { plan_hash: 'synthetic-plan', source_item_ids: ['old-upload', 'old-table'] } }),
    makeItem('direction', '按三条业务线组织方案', 'decision'),
    makeItem('confirmed-history', '已由人工核对过的合成事项', 'task', { review: { status: 'confirmed', kind: 'task', title: '已由人工核对过的合成事项', detail: '', due: '', owner: '江古月' } }),
  ]
  const itemState = it => !it.review ? it.curation?.suppressed ? 'curated' : 'todo' : it.review.status === 'confirmed' ? 'confirmed' : 'rejected'
  const payload = () => ({ meeting: '0235', status: 'ready', source_kind: 'existing_summary', revision, can_undo: revision > 1,
    curation: { status: 'ready', plan_hash: 'synthetic-plan' }, processing: { stage: 'ready', revision: 1 },
    counts: Object.fromEntries(['todo', 'confirmed', 'rejected', 'curated'].map(key => [key, items.filter(it => itemState(it) === key).length])),
    items: structuredClone(items),
  })
  const meeting = mode => ({ id: '0235', rows, labels: {}, revision: 1, review_mode: mode, can_undo: false,
    expressions: rows.map((r, index) => ({ id: 'e' + (index + 1), ids: [r.id], text: r.text, start_ms: r.start_ms, end_ms: r.end_ms, fingerprint: 'synthetic-expression-' + index, required_for_content: true })),
    content_progress: { required_expression_count: 4, complete_required_expressions: 0 },
    assistance: { status: 'unavailable' }, blind: { total: 4, completed: 0, remaining: 4 },
    // Even if the server includes curation metadata with blind rows, blind sampling must not be filtered.
    curation: { status: 'ready', folded_ids: folded },
  })
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    if (url.hostname !== 'oops-curation-ui.test') { blockedHosts.push(url.hostname); return route.abort() }
    if (path === '/label/') return route.fulfill({ contentType: 'text/html', body: html })
    const body = request.method() === 'POST' ? request.postDataJSON() : null
    requests.push({ path, method: request.method(), body, query: url.search })
    if (path === '/label/api/me') return route.fulfill({ json: { name: '洪玉麟', catalog_revision: 1,
      meetings: [{ id: '0235', title: '整理核对合成会议', audio_available: false, processing: { stage: 'ready', revision: 1 } }] } })
    if (path === '/label/api/identity') return route.fulfill({ json: { shared: true, revision: 1, can_undo: false, groups: [] } })
    if (path === '/label/api/meeting/0235') return route.fulfill({ json: meeting(url.searchParams.get('mode') || 'assisted') })
    if (path === '/label/api/meeting/0235/items') return route.fulfill({ json: payload() })
    if (path === '/label/api/meeting/0235/items/review' && request.method() === 'POST') {
      const item = items.find(it => it.id === body.item)
      assert.ok(item, 'write must target a fixture candidate')
      assert.equal(body.fingerprint, item.fingerprint)
      assert.equal(body.revision, revision)
      if (body.action === 'reopen') {
        // Match server semantics: restore the candidate, without confirming it or selecting an owner.
        item.review = null
        item.curation = { ...item.curation, suppressed: false, restored: true }
      } else if (body.action === 'confirm') {
        assert.ok(body.owner, 'a task confirmation must explicitly select an owner')
        item.review = { status: 'confirmed', kind: body.kind, title: body.title, detail: body.detail, due: body.due, owner: body.owner }
      } else assert.fail('unexpected write action ' + body.action)
      revision++
      return route.fulfill({ json: payload() })
    }
    return route.fulfill({ status: 404, body: '{}' })
  })
  await page.goto('https://oops-curation-ui.test/label/')
  await expect(page.locator('#state')).toHaveText('已读取')
  await expect(page.locator('#tab-items')).toHaveAttribute('aria-pressed', 'true')
  return { page, requests, items }
}
const writes = requests => requests.filter(r => r.method === 'POST')

test('curation defaults to pending candidates and excludes collapsed originals from todo count and navigation', async t => {
  const { page, requests } = await setup(t, { rememberSuppressed: true })
  await expect(page.locator('#items-count')).toHaveText('2')
  await expect(page.locator('#queue-summary')).toHaveText('事项 · 待核对 2 件')
  await expect(page.locator('#progress-copy')).toContainText('待核对 2 · 已确认 1 · 已排除 0 · 整理收起 2')
  await expect(page.locator('[data-item-filter="todo"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#queue-list [data-item]')).toHaveCount(2)
  await expect(page.locator('.item-title')).toHaveText('交付样稿及对照表，供大家统一核对')
  await expect(page.locator('#focus .position')).toContainText('第 1 件 / 2')
  await expect(page.locator('#queue-list')).not.toContainText('有问题马上说')
  await expect(page.locator('#queue-list')).not.toContainText('已由人工核对过的合成事项')
  await page.locator('#item-next').click()
  await expect(page.locator('.item-title')).toHaveText('按三条业务线组织方案')
  await expect(page.locator('#item-next')).toBeDisabled()
  assert.equal(writes(requests).length, 0)
})

test('collapsed candidates remain browsable and reopening sends neither owner nor a confirmation', async t => {
  const { page, requests } = await setup(t)
  await page.locator('[data-item-filter="out"]').click()
  await expect(page.locator('#queue-list [data-item]')).toHaveCount(2)
  await expect(page.locator('.item-title')).toHaveText('交付样稿')
  await expect(page.locator('#focus .badge')).toHaveText('整理时收起')
  await expect(page.locator('.reviewed-result')).toContainText('合并到「交付样稿及对照表，供大家统一核对」')
  await expect(page.locator('#item-owner')).toHaveCount(0)
  await expect(page.locator('#item-confirm')).toHaveCount(0)
  assert.equal(writes(requests).length, 0)
  await page.locator('#item-reopen').click()
  await expect(page.locator('#state')).toHaveText('已保存')
  const sent = writes(requests)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.action, 'reopen')
  assert.equal(sent[0].body.item, 'old-upload')
  assert.equal(Object.hasOwn(sent[0].body, 'owner'), false)
  assert.equal(Object.hasOwn(sent[0].body, 'kind'), false)
  assert.equal(sent.some(r => r.body.action === 'confirm'), false)
  await expect(page.locator('#items-count')).toHaveText('3')
  await page.locator('[data-item-filter="todo"]').click()
  await expect(page.locator('#queue-list [data-item]')).toHaveCount(3)
  await expect(page.locator('#item-owner')).toHaveValue('')
  await expect(page.locator('#item-confirm')).toHaveText('确认这件事')
})

test('a merged task remains unconfirmed until an owner is explicitly selected', async t => {
  const { page, requests, items } = await setup(t)
  await expect(page.locator('.item-meta')).toContainText('整理合并 · 待你核对')
  await expect(page.locator('#item-owner')).toHaveValue('')
  await page.locator('#item-confirm').click()
  await expect(page.locator('#item-error')).toHaveText('待办需要先选负责人')
  assert.equal(writes(requests).length, 0)
  assert.equal(items.find(it => it.id === mergedId).review, null)
  await page.locator('#item-owner').selectOption(draftOwner)
  assert.equal(writes(requests).length, 0)
  await page.locator('#item-confirm').click()
  await expect(page.locator('#state')).toHaveText('已保存')
  const sent = writes(requests)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.action, 'confirm')
  assert.equal(sent[0].body.item, mergedId)
  assert.equal(sent[0].body.owner, draftOwner)
  assert.equal(items.find(it => it.id === 'old-upload').review, null)
  assert.equal(items.find(it => it.id === 'old-principle').review, null)
  await expect(page.locator('#items-count')).toHaveText('1')
})

test('assisted content skips a folded first sentence while all text and blind samples remain reachable', async t => {
  const { page, requests } = await setup(t)
  await page.locator('#tab-content').click()
  await expect(page.locator('#focus .transcript')).toHaveText(rows[1].text)
  await expect(page.locator('#queue-list [data-expression]')).toHaveCount(2)
  await expect(page.locator('#queue-list')).not.toContainText(rows[0].text)
  await expect(page.locator('#queue-list')).not.toContainText(rows[3].text)
  await page.locator('[data-filter="all"]').click()
  await expect(page.locator('#queue-list [data-expression]')).toHaveCount(4)
  for (const row of rows) await expect(page.locator('#queue-list')).toContainText(row.text)
  await page.locator('[data-expression="0"]').click()
  await expect(page.locator('#focus .transcript')).toHaveText(rows[0].text)
  await page.locator('#review-blind').click()
  await expect(page.locator('#review-blind')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-filter="todo"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#queue-list [data-expression]')).toHaveCount(4)
  await expect(page.locator('#focus .transcript')).toHaveText(rows[0].text)
  for (const row of rows) await expect(page.locator('#queue-list')).toContainText(row.text)
  assert.ok(requests.some(r => r.path === '/label/api/meeting/0235' && r.query === '?mode=blind'))
  assert.equal(writes(requests).length, 0)
})
