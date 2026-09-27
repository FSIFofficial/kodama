import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  countX, documentReplacements, driveIdFrom, fileReplacements, renderDocumentText, countPlain, extractKeys, extractPlaceholders, formatDate, formItemsFor, generateOutputs, buildContext,
  pickTemplates, placeholderAt, renderSegments, renderTemplate, splitBySeparator, splitXThread,
} from '../src/lib/engine.js'

const items = [
  { key: '団体名', category: '団体', type: '短文', order: 1 },
  { key: '締結日', category: '案件', type: '日付', format: 'YYYY年M月D日', order: 2 },
  { key: 'URL', category: '案件', type: 'URL', order: 3 },
]
const settings = [{ key: '署名', value: 'サンプル運営事務局' }]
const ctx = (values) => buildContext({ values, items, settings })

test('extractPlaceholders: キーと書式を取り出す', () => {
  const p = extractPlaceholders('{{団体名}}と{{ 締結日 : M/D(曜) }}')
  assert.deepEqual(p.map((x) => [x.key, x.format]), [['団体名', ''], ['締結日', 'M/D(曜)']])
  assert.deepEqual(extractKeys(['{{a}}{{b}}', '{{a:X}}{{c}}']), ['a', 'b', 'c'])
})

test('placeholderAt: カーソル位置の差し込みを返す', () => {
  const text = 'x{{締結日:M/D}}y'
  assert.equal(placeholderAt(text, 4).key, '締結日')
  assert.equal(placeholderAt(text, 0), null)
})

test('formatDate: 仕様の書式候補', () => {
  assert.equal(formatDate('2026-09-24', 'YYYY年M月D日'), '2026年9月24日')
  assert.equal(formatDate('2026-09-24', 'YYYY年M月D日（曜）'), '2026年9月24日（木）')
  assert.equal(formatDate('2026-09-24', 'M月D日'), '9月24日')
  assert.equal(formatDate('2026-09-24', 'M/D(曜)'), '9/24(木)')
  assert.equal(formatDate('2026-01-05', 'YYYY/MM/DD'), '2026/01/05')
  assert.equal(formatDate('2026/9/24', 'M/D'), '9/24')
  assert.equal(formatDate('未定', 'M/D'), '未定')
  assert.equal(formatDate('2026-02-30', 'M/D'), '2026-02-30')
})

test('renderTemplate: 差し込み・共通設定・日付の標準書式と上書き', () => {
  const tpl = '{{団体名}}：{{締結日}} / {{締結日:M/D(曜)}}\n{{署名}}'
  assert.equal(renderTemplate(tpl, ctx({ 団体名: 'サンプル団体', 締結日: '2026-09-24' })), 'サンプル団体：2026年9月24日 / 9/24(木)\nサンプル運営事務局')
})

test('renderTemplate: 未入力は空にして空行を詰める', () => {
  assert.equal(renderTemplate('A\n\n{{URL}}\n\nB', ctx({})), 'A\n\nB')
})

test('renderTemplate: 差し込みがすべて未入力の行は見出しごと消す', () => {
  const tpl = '{{団体名}}と締結しました。\n今回のポイント：{{URL}}\n{{URL}}（{{締結日}}）\n詳細：{{URL}}\n---\n固定の行'
  assert.equal(renderTemplate(tpl, ctx({ 団体名: 'A', 締結日: '2026-09-24' })), 'Aと締結しました。\n（2026年9月24日）\n---\n固定の行')
  assert.equal(renderTemplate('{{団体名}}様\n本文', ctx({})), '本文')
})

test('renderSegments: 差し込み部分と未入力を区別する', () => {
  const seg = renderSegments('こんにちは{{団体名}}{{URL}}', ctx({ 団体名: 'X' }))
  assert.deepEqual(seg, [{ text: 'こんにちは' }, { text: 'X', key: '団体名' }, { text: '［URL］', key: 'URL', missing: true }])
})

test('pickTemplates: ランク専用を優先し、なければ共通', () => {
  const templates = [
    { id: 'T1', setId: 'S1', mediaId: 'X', rank: '共通', active: true },
    { id: 'T2', setId: 'S1', mediaId: 'X', rank: 'ゴールド', active: true },
    { id: 'T3', setId: 'S1', mediaId: 'MAIL', rank: '共通', active: true },
    { id: 'T4', setId: 'S1', mediaId: 'NOTE', rank: 'ゴールド', active: false },
    { id: 'T5', setId: 'S2', mediaId: 'MAIL', rank: 'ゴールド', active: true },
  ]
  const gold = pickTemplates(templates, 'S1', 'ゴールド')
  assert.deepEqual(Object.fromEntries(Object.entries(gold).map(([k, v]) => [k, v.id])), { X: 'T2', MAIL: 'T3' })
  const silver = pickTemplates(templates, 'S1', 'シルバー')
  assert.deepEqual(Object.fromEntries(Object.entries(silver).map(([k, v]) => [k, v.id])), { X: 'T1', MAIL: 'T3' })
})

test('countX: 全角2・半角1・URLは23', () => {
  assert.equal(countX('abc'), 3)
  assert.equal(countX('あいう'), 6)
  assert.equal(countX('詳細 https://example.com/very/long/path?x=1 です'), 4 + 1 + 23 + 1 + 4)
  assert.equal(countX('あ'.repeat(140)), 280)
  assert.equal(countPlain('あa😀'), 3)
})

test('splitBySeparator: 単独行の --- で分割', () => {
  assert.deepEqual(splitBySeparator('A\n---\nB\n  ---  \nC\n--- x'), ['A', 'B', 'C\n--- x'])
})

test('splitXThread: 上限超えは句点・改行で自動分割', () => {
  const long = 'あ'.repeat(100) + '。' + 'い'.repeat(100) + '。'
  const posts = splitXThread(long)
  assert.equal(posts.length, 2)
  assert.ok(posts.every((p) => !p.over))
  assert.equal(posts[0].text, 'あ'.repeat(100) + '。')
})

test('splitXThread: 句点がなければ文字単位で分割', () => {
  const posts = splitXThread('あ'.repeat(300))
  assert.deepEqual(posts.map((p) => p.count), [280, 280, 40])
})

test('splitXThread: 番号付与 (1/3) も上限内に収める', () => {
  const posts = splitXThread('A\n---\nB\n---\n' + 'あ'.repeat(140), { numbering: true })
  assert.equal(posts.length, 4)
  assert.equal(posts[0].text, 'A\n(1/4)')
  assert.ok(posts.every((p) => p.count <= 280))
  assert.equal(splitXThread('単独', { numbering: true })[0].text, '単独')
})

test('generateOutputs と formItemsFor', () => {
  const media = [{ id: 'M1', fields: [{ fieldKey: '件名' }, { fieldKey: '本文' }] }]
  const picked = { M1: { id: 'T1', fields: { 件名: '{{団体名}}', 本文: '{{締結日}}{{署名}}{{謎}}' } } }
  const out = generateOutputs({ picked, mediaIds: ['M1'], media, ctx: ctx({ 団体名: 'A', 締結日: '2026-09-24' }) })
  assert.deepEqual(out, { M1: { templateId: 'T1', fields: { 件名: 'A', 本文: '2026年9月24日サンプル運営事務局' } } })
  const form = formItemsFor({ picked, mediaIds: ['M1'], items, settings })
  assert.deepEqual(form.orgItems.map((i) => i.key), ['団体名'])
  assert.deepEqual(form.caseItems.map((i) => i.key), ['締結日'])
  assert.deepEqual(form.settingKeys, ['署名'])
  assert.deepEqual(form.unknownKeys, ['謎'])
})

test('書類：行を消さずに差し込み、差し込み表を作る', () => {
  const tpl = '甲：{{署名}}\n乙：{{団体名}}\n締結日：{{締結日:M/D(曜)}}'
  assert.equal(renderDocumentText(tpl, ctx({ 締結日: '2026-09-24' })), '甲：サンプル運営事務局\n乙：\n締結日：9/24(木)')
  assert.deepEqual(documentReplacements(tpl, ctx({ 締結日: '2026-09-24' })), { '{{署名}}': 'サンプル運営事務局', '{{団体名}}': '', '{{締結日:M/D(曜)}}': '9/24(木)' })
})

test('雛形ファイル：画像の差し込みを分け、ドライブの URL から ID を取り出す', () => {
  assert.equal(driveIdFrom('https://docs.google.com/presentation/d/1AbCdEfGhIjK_lm-no/edit#slide=id.p'), '1AbCdEfGhIjK_lm-no')
  assert.equal(driveIdFrom('https://drive.google.com/open?id=1AbCdEfGhIjKlmno'), '1AbCdEfGhIjKlmno')
  assert.equal(driveIdFrom(' RAWID '), 'RAWID')
  const imgItems = [...items, { key: '写真', category: '案件', type: '画像' }]
  const c = buildContext({ values: { 団体名: 'A', 写真: 'https://drive.google.com/file/d/1PhotoIdPhoto/view' }, items: imgItems, settings })
  const tpl = '{{ロゴ}}{{団体名}}{{写真}}'
  assert.deepEqual(fileReplacements(tpl, c, { logoFileId: 'L', withImages: true }), { replacements: { '{{団体名}}': 'A' }, images: { '{{ロゴ}}': 'L', '{{写真}}': '1PhotoIdPhoto' } })
  // 書類では画像の差し込みは空欄にする
  assert.deepEqual(documentReplacements(tpl, c), { '{{ロゴ}}': '', '{{団体名}}': 'A', '{{写真}}': '' })
})

test('共通パーツ：{{部品:名前}} を展開し、中の差し込みも解決する', async () => {
  const { buildContext, expandParts, fileReplacements, formItemsFor, renderSegments, renderTemplate, unknownParts } = await import('../src/lib/engine.js')
  const parts = [
    { name: '署名ブロック', content: '――\n{{署名}}\n{{部品:連絡先}}', active: true },
    { name: '連絡先', content: '担当：{{担当者}}', active: true },
    { name: '無効', content: 'x', active: false },
    { name: '自分', content: '{{部品:自分}}', active: true },
  ]
  const ctx = buildContext({ values: { 担当者: '山田' }, items: [{ key: '担当者', category: '案件', order: 1 }], settings: [{ key: '署名', value: '事務局' }], parts })
  assert.equal(expandParts('A\n{{部品:署名ブロック}}', ctx.parts), 'A\n――\n{{署名}}\n担当：{{担当者}}')
  assert.equal(renderTemplate('本文\n{{部品:署名ブロック}}', ctx), '本文\n――\n事務局\n担当：山田')
  // 登録の無い・無効のパーツは残り、未入力として扱われる
  assert.ok(renderSegments('{{部品:無効}}', ctx).some((s) => s.missing))
  assert.deepEqual(unknownParts(['{{部品:無効}} {{部品:署名ブロック}} {{部品:ない}}'], ctx.parts), ['無効', 'ない'])
  // 自分自身を呼んでも止まる
  assert.equal(expandParts('{{部品:自分}}', ctx.parts), '')
  // 入力フォームにはパーツの中の項目も出る
  const form = formItemsFor({ picked: { M1: { fields: { 本文: '{{部品:連絡先}}' } } }, mediaIds: ['M1'], items: [{ key: '担当者', category: '案件', order: 1 }], settings: [], parts })
  assert.deepEqual(form.caseItems.map((i) => i.key), ['担当者'])
  assert.deepEqual(form.unknownKeys, [])
  // 書類：雛形の {{部品:名前}} を差し込み済みの内容に置き換える
  assert.deepEqual(fileReplacements('{{部品:連絡先}}', ctx).replacements, { '{{部品:連絡先}}': '担当：山田' })
})

test('自由記述：{{自由:見出し}} は項目に登録せず、資料ごとに入力した文を差し込む', async () => {
  const { buildContext, fileReplacements, formItemsFor, renderSegments, renderTemplate } = await import('../src/lib/engine.js')
  const items = [{ key: '団体名', category: '団体', order: 1 }]
  const tpl = '{{団体名}} 様\n{{自由:ひとこと}}\n今回のポイント：{{自由}}\n締め'
  const form = formItemsFor({ picked: { M1: { fields: { 本文: tpl } } }, mediaIds: ['M1'], items, settings: [] })
  assert.deepEqual(form.freeItems.map((i) => [i.key, i.label]), [['自由:ひとこと', 'ひとこと'], ['自由:自由記述', '自由記述']])
  assert.deepEqual(form.unknownKeys, [])
  let ctx = buildContext({ values: { 団体名: 'A', '自由:ひとこと': '2026-09-24 に会いました' }, items, settings: [] })
  // 日付のように見えても書式を当てない。未入力の自由記述の行は消える
  assert.equal(renderTemplate(tpl, ctx), 'A 様\n2026-09-24 に会いました\n締め')
  assert.ok(renderSegments('{{自由:ひとこと}}', buildContext({ values: {}, items, settings: [] })).some((s) => s.missing && s.text === '［ひとこと］'))
  ctx = buildContext({ values: { '自由:自由記述': 'x' }, items, settings: [] })
  assert.deepEqual(fileReplacements('{{自由}}', ctx).replacements, { '{{自由}}': 'x' })
})
