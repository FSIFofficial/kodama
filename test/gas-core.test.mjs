import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MemoryDb, createMemoryCache, createMockDocs, createMockFiles, createMockSlides, loadGasCore } from '../src/lib/memory-db.js'
import { buildContext, documentReplacements, fileReplacements, formItemsFor, generateOutputs, pickTemplates } from '../src/lib/engine.js'

const read = (f) => readFileSync(new URL(`../gas/${f}`, import.meta.url), 'utf8')
const gas = loadGasCore({ schema: read('Schema.gs'), mockData: read('MockData.gs'), core: read('Core.gs') })

function setup() {
  const db = new MemoryDb()
  gas.seedTables(db, new Date('2026-09-24T00:00:00Z'))
  let t = 0
  let clock = 0
  const files = createMockFiles()
  const env = {
    db,
    docs: createMockDocs({ ...gas.MOCK_DOCUMENTS, OTHER_DOC: '別の雛形 {{団体名}}' }),
    slides: createMockSlides(gas.MOCK_DOCUMENTS, files),
    files,
    cache: createMemoryCache(() => clock),
    props: { userKey: 'user-key', adminPassword: 'admin-pass' },
    withLock: (fn) => fn(),
    now: () => new Date(Date.UTC(2026, 8, 24, 0, 0, t++)),
  }
  const call = (action, payload = {}, adminPass, actor) => gas.handleRequest({ action, key: 'user-key', adminPass, actor, payload }, env)
  return { db, env, call, tick: (sec) => (clock += sec * 1000) }
}

test('認証：キーなし・誤りは UNAUTHORIZED、管理者操作はパス必須', () => {
  const { env, call } = setup()
  assert.deepEqual(gas.handleRequest({ action: 'init' }, env), { ok: false, error: 'UNAUTHORIZED' })
  assert.deepEqual(gas.handleRequest({ action: 'init', key: 'wrong' }, env), { ok: false, error: 'UNAUTHORIZED' })
  assert.equal(call('update', { entity: 'sets', key: 'S001', data: { name: 'x' } }).error, 'ADMIN_REQUIRED')
  assert.equal(call('update', { entity: 'sets', key: 'S001', data: { name: 'x' } }, 'bad').error, 'ADMIN_REQUIRED')
  assert.equal(call('deactivate', { entity: 'sets', key: 'S001' }).error, 'ADMIN_REQUIRED')
  assert.equal(call('deleteHistory', { id: 'H001' }).error, 'ADMIN_REQUIRED')
  assert.deepEqual(call('verifyAdmin', {}, 'admin-pass').data, { valid: true })
  assert.deepEqual(call('verifyAdmin', {}, 'nope').data, { valid: false })
  assert.equal(call('nope').error, 'UNKNOWN_ACTION')
})

test('設定が無いサーバーは SERVER_NOT_CONFIGURED', () => {
  const { env } = setup()
  env.props.userKey = null
  assert.equal(gas.handleRequest({ action: 'init', key: '' }, env).error, 'SERVER_NOT_CONFIGURED')
})

test('init：モックデータが一括で返り、生成まで通る', () => {
  const { call } = setup()
  const res = call('init')
  assert.equal(res.ok, true)
  const d = res.data
  assert.equal(d.media.length, 7)
  assert.equal(d.templates.length, 9)
  assert.equal(d.media.find((m) => m.id === 'M002').fields[0].countMode, 'X方式')
  assert.equal(d.media.find((m) => m.id === 'M002').fields[0].limit, 280)
  assert.equal(d.orgs[0].values['団体名'], 'サンプル団体')
  assert.ok(d.orgColumns.includes('団体紹介'))
  assert.equal(d.templates[0].active, true)
  assert.match(d.templates[0].updatedAt, /^2026-09-24T/)

  const picked = pickTemplates(d.templates, 'S001', 'シルバー')
  assert.equal(picked.M002.id, 'T003')
  assert.equal(picked.M004.id, 'T006')
  const ctx = buildContext({ values: { ...d.orgs[0].values, 締結日: '2026-09-24', 連携内容: '共同イベント' }, items: d.items, settings: d.settings })
  const out = generateOutputs({ picked: pickTemplates(d.templates, 'S001', 'ゴールド'), mediaIds: ['M002', 'M005'], media: d.media, ctx })
  assert.match(out.M002.fields['本文'], /9\/24\(木\)、サンプル団体/)
  assert.match(out.M005.fields['本文'], /^2026\/09\/24/)
})

test('create：利用者が追加でき、IDが採番される', () => {
  const { call } = setup()
  const r = call('create', { entity: 'sets', data: { name: '新セット', order: 2 } })
  assert.deepEqual(r, { ok: true, data: { key: 'S002' } })
  const t = call('create', { entity: 'templates', data: { name: '新テンプレ', setId: 'S002', mediaId: 'M001', rank: '共通' }, children: { fields: { 件名: 'a', 本文: 'b' } } })
  assert.equal(t.data.key, 'T010')
  const tpl = call('init').data.templates.find((x) => x.id === 'T010')
  assert.deepEqual(tpl.fields, { 件名: 'a', 本文: 'b' })
  assert.equal(tpl.format, 'テキスト')
})

test('create：重複・不正値は弾く', () => {
  const { call } = setup()
  assert.equal(call('create', { entity: 'ranks', data: { name: 'ゴールド' } }).error, 'DUPLICATE')
  assert.equal(call('create', { entity: 'ranks', data: { name: '共通' } }).error, 'VALIDATION')
  assert.equal(call('create', { entity: 'items', data: { key: 'a{b' } }).error, 'VALIDATION')
  assert.equal(call('create', { entity: 'items', data: { key: '有効', category: '団体' } }).error, 'VALIDATION')
  assert.equal(call('create', { entity: 'templates', data: { name: 'x', setId: 'S999', mediaId: 'M001', rank: '共通' } }).error, 'VALIDATION')
  assert.equal(call('create', { entity: 'history', data: {} }).error, 'BAD_REQUEST')
})

test('区分＝団体の項目を追加すると団体マスタに列が増える', () => {
  const { call, db } = setup()
  call('create', { entity: 'items', data: { key: '設立年', category: '団体', type: '数値' } })
  const headers = db.readTable('団体マスタ').headers
  assert.equal(headers.indexOf('設立年'), headers.indexOf('ロゴファイルID') - 1)
  const org = call('create', { entity: 'orgs', data: { values: { 団体名: '新団体', 設立年: '2020', 存在しない列: 'x' } } })
  assert.equal(org.data.key, 'O003')
  const o = call('init').data.orgs.find((x) => x.id === 'O003')
  assert.equal(o.values['設立年'], '2020')
  assert.equal(o.values['団体名'], '新団体')
  assert.ok(!('存在しない列' in o.values))
  assert.equal(call('create', { entity: 'orgs', data: { values: {} } }).error, 'VALIDATION')
})

test('update / deactivate：管理者のみ。キーは変更できない', () => {
  const { call } = setup()
  const u = call('update', { entity: 'orgs', key: 'O001', data: { values: { 団体紹介: '更新後' } } }, 'admin-pass')
  assert.equal(u.ok, true)
  let orgs = call('init').data.orgs
  assert.equal(orgs[0].values['団体紹介'], '更新後')
  assert.equal(orgs[0].values['団体名'], 'サンプル団体')

  call('update', { entity: 'ranks', key: 'ゴールド', data: { name: '改名', order: 9 } }, 'admin-pass')
  const ranks = call('init').data.ranks
  assert.ok(ranks.some((r) => r.name === 'ゴールド' && r.order === 9))

  call('update', { entity: 'media', key: 'M003', data: { name: 'Insta' }, children: { fields: [{ fieldKey: '本文', limit: 100 }] } }, 'admin-pass')
  const m = call('init').data.media.find((x) => x.id === 'M003')
  assert.equal(m.name, 'Insta')
  assert.deepEqual(m.fields.map((f) => [f.fieldKey, f.limit, f.countMode]), [['本文', 100, '通常']])

  assert.deepEqual(call('deactivate', { entity: 'templates', key: 'T002' }, 'admin-pass').data, { key: 'T002', active: false })
  assert.equal(call('init').data.templates.find((t) => t.id === 'T002').active, false)
  assert.equal(call('deactivate', { entity: 'settings', key: '署名' }, 'admin-pass').error, 'BAD_REQUEST')
  assert.equal(call('update', { entity: 'sets', key: 'S999', data: {} }, 'admin-pass').error, 'NOT_FOUND')
})

test('履歴：保存・上書き・一覧・詳細・削除', () => {
  const { call } = setup()
  const outputs = [
    { mediaId: 'M001', templateId: 'T001', fieldKey: '件名', text: '件名1', edited: false },
    { mediaId: 'M001', templateId: 'T001', fieldKey: '本文', text: '本文1', edited: false },
  ]
  const history = { author: '見本', orgId: 'O001', orgName: 'サンプル団体', setId: 'S001', rank: 'ゴールド', values: { 締結日: '2026-09-24' } }
  const first = call('saveHistory', { history, outputs }).data
  assert.equal(first.id, 'H001')
  const second = call('saveHistory', { history, outputs }).data
  assert.equal(second.id, 'H002')

  call('saveHistory', { history: { ...history, id: 'H001' }, outputs: [{ ...outputs[1], text: '修正後', edited: true }] })
  const h1 = call('getHistory', { id: 'H001' }).data
  assert.equal(h1.createdAt, first.createdAt)
  assert.deepEqual(h1.values, { 締結日: '2026-09-24' })
  assert.deepEqual(h1.outputs.map((o) => [o.fieldKey, o.text, o.edited]), [['本文', '修正後', true]])
  assert.equal(call('getHistory', { id: 'H002' }).data.outputs.length, 2)

  const list = call('listHistory').data
  assert.deepEqual(list.map((h) => h.id), ['H002', 'H001'])

  assert.equal(call('deleteHistory', { id: 'H002' }, 'admin-pass').ok, true)
  assert.deepEqual(call('listHistory').data.map((h) => h.id), ['H001'])
  assert.equal(call('getHistory', { id: 'H002' }).error, 'NOT_FOUND')
  assert.equal(call('getHistory', { id: 'H001' }).data.outputs.length, 1)
  assert.equal(call('saveHistory', { history: { id: 'H999' }, outputs: [] }).error, 'NOT_FOUND')
})

test('seedTables：既存データがあるシートは上書きしない', () => {
  const { db, call } = setup()
  call('create', { entity: 'sets', data: { name: '追加' } })
  const seeded = gas.seedTables(db, new Date())
  assert.deepEqual(seeded, [])
  assert.equal(call('init').data.sets.length, 2)
})

test('書類テンプレ：雛形の本文を読み込み、差し込んで出力する', () => {
  const { call } = setup()
  assert.equal(call('create', { entity: 'templates', data: { name: '書類', setId: 'S001', mediaId: 'M006', rank: '共通', format: 'PDF' } }).error, 'VALIDATION')
  assert.equal(call('create', { entity: 'templates', data: { name: '書類', setId: 'S001', mediaId: 'M006', rank: '共通', format: 'PDF', fileId: 'NOPE' } }).error, 'DOC_NOT_FOUND')

  // 画面から送られた欄は無視し、雛形の本文を「本文」欄に写す
  const created = call('create', { entity: 'templates', data: { name: '書類', setId: 'S001', mediaId: 'M006', rank: 'ゴールド', format: 'Docx', fileId: 'OTHER_DOC' }, children: { fields: { 本文: '無視される' } } })
  const t = call('init').data.templates.find((x) => x.id === created.data.key)
  assert.deepEqual(t.fields, { 本文: '別の雛形 {{団体名}}' })
  assert.deepEqual(call('readDocument', { fileId: 'SAMPLE_CONTRACT' }).data.text.split('\n')[0], 'サンプル連携契約書')

  const d = call('init').data
  const sample = d.templates.find((x) => x.id === 'T008')
  const ctx = buildContext({ values: { 団体名: 'サンプル団体', 締結日: '2026-09-24' }, items: d.items, settings: d.settings })
  const replacements = documentReplacements(sample.fields['本文'], ctx)
  assert.equal(replacements['{{締結日}}'], '2026年9月24日')
  assert.equal(replacements['{{連携内容}}'], '')
  const file = call('renderDocument', { templateId: 'T008', format: 'Docx', replacements: { ...replacements, 'bad key': 'x' }, fileName: 'A/B' }).data
  assert.equal(file.fileName, 'A_B.txt')
  const text = Buffer.from(file.base64, 'base64').toString('utf8')
  assert.match(text, /本番ではDocxで出力/)
  assert.match(text, /サンプル運営フォーラム（以下「甲」という。）とサンプル団体/)
  assert.ok(!text.includes('{{'))
  assert.equal(call('renderDocument', { templateId: 'T001' }).error, 'VALIDATION')
  assert.equal(call('renderDocument', { templateId: 'T008', format: 'Excel' }).error, 'VALIDATION')
})

test('告知画像：ロゴをアップロードし、スライドに差し込んで画像にする', () => {
  const { call } = setup()
  assert.equal(call('create', { entity: 'templates', data: { name: '画像', setId: 'S001', mediaId: 'M007', rank: '共通', format: '画像' } }).error, 'VALIDATION')
  assert.equal(call('uploadImage', { fileName: 'a.svg', mimeType: 'image/svg+xml', base64: 'AAAA' }).error, 'VALIDATION')
  assert.equal(call('uploadImage', { fileName: 'a.png', mimeType: 'image/png', base64: 'A'.repeat(8 * 1024 * 1024) }).error, 'VALIDATION')
  const { fileId } = call('uploadImage', { fileName: 'logo.png', mimeType: 'image/png', base64: 'iVBORw0KGgo=' }).data
  assert.deepEqual(call('readImage', { fileId }).data, { mimeType: 'image/png', base64: 'iVBORw0KGgo=' })
  assert.equal(call('readImage', { fileId: 'NOPE' }).error, 'IMAGE_NOT_FOUND')

  // 団体にロゴを登録（新規追加なので利用者でよい）
  const org = call('create', { entity: 'orgs', data: { values: { 団体名: 'ロゴ団体' }, logoFileId: fileId } }).data.key
  const d = call('init').data
  assert.equal(d.orgs.find((o) => o.id === org).logoFileId, fileId)
  assert.equal(call('readDocument', { fileId: 'SAMPLE_SLIDES', format: '画像' }).data.text.split('\n')[0], '{{ロゴ}}')

  const t = d.templates.find((x) => x.id === 'T009')
  const picked = pickTemplates(d.templates, 'S001', 'シルバー')
  const form = formItemsFor({ picked, mediaIds: ['M007'], items: d.items, settings: d.settings })
  assert.equal(form.usesLogo, true)
  assert.deepEqual(form.unknownKeys, [])
  const ctx = buildContext({ values: { 団体名: 'ロゴ団体', 締結日: '2026-09-24' }, items: d.items, settings: d.settings })
  const { replacements, images } = fileReplacements(t.fields['本文'], ctx, { logoFileId: fileId, withImages: true })
  assert.deepEqual(images, { '{{ロゴ}}': fileId })
  assert.equal(replacements['{{締結日:YYYY.MM.DD}}'], '2026.09.24')
  assert.ok(!('{{ロゴ}}' in replacements))

  const out = call('renderDocument', { templateId: 'T009', replacements, images, fileName: '締結告知' }).data
  assert.deepEqual(out.images.map((i) => i.fileName), ['締結告知_1.svg', '締結告知_2.svg'])
  const svg = Buffer.from(out.images[0].base64, 'base64').toString('utf8')
  assert.match(svg, /ロゴ団体/)
  assert.match(svg, /2026\.09\.24/)
  assert.match(svg, /data:image\/png;base64,iVBORw0KGgo=/)
  // 画像として使えるのは保存済みの画像だけ
  assert.equal(call('renderDocument', { templateId: 'T009', replacements, images: { '{{ロゴ}}': 'OTHER_FILE' } }).error, 'IMAGE_NOT_FOUND')
})

test('操作ログ：追加・編集・無効化・削除を記録し、新しい順に返す', () => {
  const { call, db } = setup()
  assert.deepEqual(call('listLogs').data, [])
  call('create', { entity: 'sets', data: { name: '新セット' } }, undefined, '山田')
  call('update', { entity: 'orgs', key: 'O001', data: { values: { 団体紹介: '改行\nあり' } } }, 'admin-pass', '管理 太郎')
  call('update', { entity: 'templates', key: 'T001', data: { name: '改名' }, children: { fields: { 件名: '新しい件名', 本文: 'b' } } }, 'admin-pass')
  call('deactivate', { entity: 'sets', key: 'S002' }, 'admin-pass', '山田')
  call('saveHistory', { history: { orgName: 'サンプル団体' }, outputs: [] })
  call('deleteHistory', { id: 'H001' }, 'admin-pass', '山田')
  const logs = call('listLogs').data
  assert.deepEqual(logs.map((l) => [l.action, l.entity, l.key]), [
    ['削除', '履歴', 'H001'],
    ['無効化', 'セット', 'S002'],
    ['編集', 'テンプレート', 'T001'],
    ['編集', '団体', 'O001'],
    ['追加', 'セット', 'S002'],
  ])
  assert.equal(logs[4].actor, '山田')
  assert.equal(logs[4].role, '利用者')
  assert.equal(logs[4].detail, '新セット')
  assert.equal(logs[3].role, '管理者')
  assert.match(logs[3].detail, /^サンプル団体：団体紹介：「.*」→「改行⏎あり」$/)
  assert.equal(logs[2].actor, '（名前未入力）')
  assert.match(logs[2].detail, /テンプレ名：「.+」→「改名」/)
  assert.match(logs[2].detail, /欄「件名」を変更/)
  assert.match(logs[2].detail, /欄「本文」を変更/)
  assert.match(logs[0].at, /^2026-09-24T/)
  assert.equal(call('listLogs', { limit: 2 }).data.length, 2)
  // 失敗した操作は記録しない
  call('create', { entity: 'ranks', data: { name: 'ゴールド' } })
  assert.equal(call('listLogs').data.length, 5)
  assert.equal(db.readTable('操作ログ').rows.length, 5)
})

test('操作ログ：シートが無い既存環境でも自動で作る', () => {
  const { call, db } = setup()
  delete db.sheets['操作ログ']
  assert.deepEqual(call('listLogs').data, [])
  assert.equal(call('create', { entity: 'sets', data: { name: 'x' } }).ok, true)
  assert.deepEqual(db.readTable('操作ログ').headers, ['日時', '操作者', '権限', '操作', '種類', '対象', '内容'])
  assert.equal(call('listLogs').data.length, 1)
})

test('団体の一括登録：空・重複は飛ばし、まとめて追加する', () => {
  const { call } = setup()
  const res = call('bulkCreate', {
    entity: 'orgs',
    rows: [
      { values: { 団体名: ' 一括A ', 団体紹介: '紹介A', 知らない列: 'x' } },
      { values: { 団体名: '' } },
      { values: { 団体名: 'サンプル団体' } },
      { values: { 団体名: '一括B' } },
      { values: { 団体名: '一括A' } },
    ],
  }, undefined, '山田')
  assert.equal(res.ok, true)
  assert.deepEqual(res.data.created, [{ id: 'O003', name: '一括A' }, { id: 'O004', name: '一括B' }])
  assert.deepEqual(res.data.skipped.map((s) => [s.row, s.reason]), [[2, '団体名が空です'], [3, 'すでに登録されています'], [5, 'すでに登録されています']])
  assert.deepEqual(res.data.ignoredColumns, ['知らない列'])
  const orgs = call('init').data.orgs
  const a = orgs.find((o) => o.id === 'O003')
  assert.equal(a.values['団体名'], '一括A')
  assert.equal(a.values['団体紹介'], '紹介A')
  assert.equal(a.active, true)
  assert.deepEqual(call('listLogs').data.map((l) => [l.action, l.key, l.detail]), [['一括追加', 'O004', '一括B'], ['一括追加', 'O003', '一括A']])
  assert.equal(call('bulkCreate', { entity: 'sets', rows: [{}] }).error, 'BAD_REQUEST')
  assert.equal(call('bulkCreate', { entity: 'orgs', rows: [] }).error, 'VALIDATION')
})

test('管理者パス：5回続けて間違えると10分止まり、正しいパスで回数が戻る', () => {
  const { call, tick } = setup()
  for (let i = 0; i < 4; i++) assert.deepEqual(call('verifyAdmin', {}, 'wrong').data, { valid: false })
  // 成功すると回数は0に戻る
  assert.deepEqual(call('verifyAdmin', {}, 'admin-pass').data, { valid: true })
  for (let i = 0; i < 4; i++) call('verifyAdmin', {}, 'wrong')
  // 空のパスは数えない
  assert.equal(call('update', { entity: 'sets', key: 'S001', data: {} }).error, 'ADMIN_REQUIRED')
  assert.equal(call('update', { entity: 'sets', key: 'S001', data: {} }, 'wrong').error, 'ADMIN_REQUIRED')
  // 5回目以降は正しいパスでも止まる
  const locked = call('verifyAdmin', {}, 'admin-pass')
  assert.equal(locked.error, 'ADMIN_LOCKED')
  assert.match(locked.message, /10分間/)
  assert.equal(call('deactivate', { entity: 'sets', key: 'S001' }, 'admin-pass').error, 'ADMIN_LOCKED')
  // 利用者の操作は止まらない
  assert.equal(call('init').ok, true)
  tick(601)
  assert.deepEqual(call('verifyAdmin', {}, 'admin-pass').data, { valid: true })
})

test('テンプレートの変更履歴：追加・編集ごとに内容を残し、新しい順に返す', () => {
  const { call, db } = setup()
  // 履歴の記録を始める前からあるテンプレートは、最初の編集で変更前も残る
  call('update', { entity: 'templates', key: 'T001', data: { name: '改名' }, children: { fields: { 件名: '新件名', 本文: '新本文' } } }, 'admin-pass', '山田')
  let revs = call('listTemplateRevisions', { templateId: 'T001' }).data
  assert.equal(revs.length, 2)
  assert.equal(revs[0].actor, '山田')
  assert.equal(revs[0].template.name, '改名')
  assert.deepEqual(revs[0].template.fields, { 件名: '新件名', 本文: '新本文' })
  assert.equal(revs[1].actor, '（履歴の記録開始前）')
  assert.notEqual(revs[1].template.name, '改名')
  assert.ok(revs[1].template.fields['本文'].length > 10)
  // 欄を送らない更新（名前だけ）でも、欄は今の内容のまま残る
  call('update', { entity: 'templates', key: 'T001', data: { name: '再改名' } }, 'admin-pass')
  revs = call('listTemplateRevisions', { templateId: 'T001' }).data
  assert.equal(revs.length, 3)
  assert.equal(revs[0].template.name, '再改名')
  assert.deepEqual(revs[0].template.fields, { 件名: '新件名', 本文: '新本文' })
  // 新規追加も1件目として残る
  const key = call('create', { entity: 'templates', data: { name: '新', setId: 'S001', mediaId: 'M001', rank: '共通' }, children: { fields: { 本文: 'x' } } }).data.key
  assert.deepEqual(call('listTemplateRevisions', { templateId: key }).data.map((r) => r.template.fields), [{ 本文: 'x' }])
  assert.equal(call('listTemplateRevisions', {}).error, 'VALIDATION')
  // シートが無い本番環境でも自動で作る
  delete db.sheets['テンプレート履歴']
  assert.deepEqual(call('listTemplateRevisions', { templateId: 'T002' }).data, [])
  call('update', { entity: 'templates', key: 'T002', data: { name: 'a' } }, 'admin-pass')
  assert.equal(call('listTemplateRevisions', { templateId: 'T002' }).data.length, 2)
})

test('archiveLogs：新しい行だけ残し、古い行を過去分シートに移す', () => {
  const { call, db } = setup()
  for (let i = 0; i < 5; i++) call('create', { entity: 'sets', data: { name: `セット${i}` } })
  assert.equal(gas.archiveLogs(db, 2), 3)
  assert.deepEqual(call('listLogs').data.map((l) => l.detail), ['セット4', 'セット3'])
  const archived = db.readTable('操作ログ（過去分）')
  assert.deepEqual(archived.headers, ['日時', '操作者', '権限', '操作', '種類', '対象', '内容'])
  assert.deepEqual(archived.rows.map((r) => r[6]), ['セット0', 'セット1', 'セット2'])
  assert.equal(gas.archiveLogs(db, 2), 0)
  call('create', { entity: 'sets', data: { name: 'セット5' } })
  assert.equal(gas.archiveLogs(db, 2), 1)
  assert.equal(db.readTable('操作ログ（過去分）').rows.length, 4)
})

test('共通パーツ：追加・編集・無効化。シートが無い本番でも init は空で返し、追加で作る', () => {
  const { call, db } = setup()
  assert.deepEqual(call('init').data.parts, [])
  assert.equal(call('create', { entity: 'parts', data: { name: '署名ブロック', content: '  ――\n{{署名}}\n', order: 1 } }).data.key, '署名ブロック')
  assert.equal(call('create', { entity: 'parts', data: { name: '署名ブロック' } }).error, 'DUPLICATE')
  assert.equal(call('create', { entity: 'parts', data: { name: 'a:b' } }).error, 'VALIDATION')
  let parts = call('init').data.parts
  assert.deepEqual(parts.map((p) => [p.name, p.content, p.active]), [['署名ブロック', '  ――\n{{署名}}\n', true]])
  call('update', { entity: 'parts', key: '署名ブロック', data: { content: '新' } }, 'admin-pass')
  call('deactivate', { entity: 'parts', key: '署名ブロック' }, 'admin-pass')
  parts = call('init').data.parts
  assert.equal(parts[0].content, '新')
  assert.equal(parts[0].active, false)
  assert.equal(call('listLogs').data[0].entity, '共通パーツ')

  delete db.sheets['共通パーツ']
  assert.deepEqual(call('init').data.parts, [])
  assert.equal(call('create', { entity: 'parts', data: { name: 'x' } }).ok, true)
  assert.deepEqual(db.readTable('共通パーツ').headers, ['パーツ名', '内容', '説明', '並び順', '有効'])
})

test('媒体のコピー形式：既定は通常、CSV行を選べる。列が無い本番のシートには足してから書く', () => {
  const { call, db } = setup()
  const key = call('create', { entity: 'media', data: { name: 'HPデータ', copyFormat: 'CSV行' }, children: { fields: [{ fieldKey: 'id' }, { fieldKey: 'title' }] } }).data.key
  let media = call('init').data.media
  assert.equal(media.find((m) => m.id === key).copyFormat, 'CSV行')
  assert.equal(call('create', { entity: 'media', data: { name: 'x', copyFormat: 'TSV' } }).error, 'VALIDATION')
  assert.equal(call('create', { entity: 'media', data: { name: '既定' } }).ok, true)
  assert.equal(call('init').data.media.find((m) => m.name === '既定').copyFormat, '通常')

  // 「コピー形式」列が無い（この列を足す前に setup した）本番のシート
  const sh = db.sheets['媒体']
  const at = sh.headers.indexOf('コピー形式')
  sh.headers.splice(at, 1)
  sh.rows.forEach((r) => r.splice(at, 1))
  assert.equal(call('init').data.media.find((m) => m.id === 'M005').copyFormat, '')
  call('update', { entity: 'media', key: 'M005', data: { copyFormat: 'CSV行' } }, 'admin-pass')
  assert.ok(db.readTable('媒体').headers.includes('コピー形式'))
  media = call('init').data.media
  assert.equal(media.find((m) => m.id === 'M005').copyFormat, 'CSV行')
  assert.equal(media.find((m) => m.id === 'M005').name, 'HPニュース')
})

// Google ログイン（Access Manager で権限を決める）
function setupGoogle({ legacy = false } = {}) {
  const base = setup()
  const access = {
    'admin@example.com': { allowed: true, roleKey: 'admin', name: '管理 花子', reason: '' },
    'user@example.com': { allowed: true, roleKey: 'user', name: '利用 太郎', reason: '' },
    'gone@example.com': { allowed: false, roleKey: '', name: '退会 次郎', reason: '退会済み' },
  }
  base.env.auth = {
    verifyIdToken: (t) => {
      if (!t.startsWith('tok:')) {
        const e = new Error('Google のログインが切れています')
        e.appCode = 'UNAUTHORIZED'
        throw e
      }
      return { email: t.slice(4).toUpperCase(), name: 'Googleの名前' }
    },
    checkAccess: (email) => access[email] ?? { allowed: false, roleKey: '', name: '', reason: 'メンバー未登録' },
  }
  if (!legacy) base.env.props = { logoFolderId: '' }
  const as = (email) => (action, payload = {}) => gas.handleRequest({ action, idToken: `tok:${email}`, payload }, base.env)
  return { ...base, as }
}

test('Google ログイン：Access Manager の役割で、利用者と管理者が決まる', () => {
  const { as, env } = setupGoogle()
  const admin = as('admin@example.com')
  const user = as('user@example.com')
  assert.deepEqual(user('whoami').data, { email: 'user@example.com', name: '利用 太郎', role: 'user' })
  assert.deepEqual(admin('whoami').data, { email: 'admin@example.com', name: '管理 花子', role: 'admin' })
  assert.equal(user('init').ok, true)
  // 利用者は追加できるが、編集・無効化・履歴の削除はできない
  assert.equal(user('create', { entity: 'ranks', data: { name: 'ブロンズ' } }).ok, true)
  const denied = user('update', { entity: 'sets', key: 'S001', data: { name: 'x' } })
  assert.equal(denied.error, 'ADMIN_REQUIRED')
  assert.match(denied.message, /Access Manager/)
  assert.deepEqual(user('verifyAdmin').data, { valid: false })
  // 管理者は管理者パスワードなしで編集できる
  assert.equal(admin('update', { entity: 'sets', key: 'S001', data: { name: '締結告知セット（改）' } }).ok, true)
  assert.deepEqual(admin('verifyAdmin').data, { valid: true })
  // 使えない人・未登録・トークンが不正
  const gone = as('gone@example.com')('init')
  assert.equal(gone.error, 'NOT_ALLOWED')
  assert.match(gone.message, /退会済み/)
  assert.equal(as('nobody@example.com')('init').error, 'NOT_ALLOWED')
  assert.equal(gas.handleRequest({ action: 'init', idToken: 'broken' }, env).error, 'UNAUTHORIZED')
  // USER_KEY が無ければ、以前の方式（キー）は使えない
  assert.equal(gas.handleRequest({ action: 'init', key: 'user-key' }, env).error, 'UNAUTHORIZED')
})

test('Google ログイン：操作ログと履歴の作成者はログインしている人になる', () => {
  const { as } = setupGoogle()
  const user = as('user@example.com')
  user('create', { entity: 'ranks', data: { name: 'ブロンズ' } })
  as('admin@example.com')('deactivate', { entity: 'ranks', key: 'ブロンズ' })
  const logs = user('listLogs').data
  assert.equal(logs[0].actor, '管理 花子（admin@example.com）')
  assert.equal(logs[0].role, '管理者')
  assert.equal(logs[1].actor, '利用 太郎（user@example.com）')
  assert.equal(logs[1].role, '利用者')
  // 画面が別の作成者名を送っても、記録されるのはログインしている人
  const saved = user('saveHistory', { history: { author: 'なりすまし', orgId: 'O001', orgName: 'サンプル団体', setId: 'S001', rank: 'ゴールド', values: {} }, outputs: [] })
  assert.equal(saved.ok, true)
  const h = user('getHistory', { id: saved.data.id }).data
  assert.equal(h.author, '利用 太郎')
})

test('移行期間：USER_KEY があれば、以前の方式（キー＋管理者パスワード）も使える', () => {
  const { as, env } = setupGoogle({ legacy: true })
  assert.equal(gas.handleRequest({ action: 'init', key: 'user-key' }, env).ok, true)
  assert.equal(gas.handleRequest({ action: 'update', key: 'user-key', adminPass: 'admin-pass', payload: { entity: 'sets', key: 'S001', data: { name: 'y' } } }, env).ok, true)
  assert.equal(as('user@example.com')('whoami').data.role, 'user')
})
