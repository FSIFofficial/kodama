// 画面の通しテスト（モックモードのビルドを Playwright で操作する）。npm run e2e
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const pageUrl = new URL('../dist/index.html', import.meta.url).href
let browser

before(async () => {
  const built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, env: { ...process.env, ALLOW_MOCK: '1' }, encoding: 'utf8' })
  assert.equal(built.status, 0, built.stderr)
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
})

// 新しいブラウザ（localStorage が空＝モックデータも初期状態）で開く
async function open() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(pageUrl)
  await page.getByText('発信物を、ひとつの入力から。').waitFor()
  const nav = (name) => page.getByRole('button', { name, exact: true }).click()
  const toast = (text) => page.locator('.fixed.bottom-5', { hasText: text }).waitFor()
  return { page, errors, nav, toast, close: () => context.close() }
}

// 団体を選んで、入力して、生成まで
async function generate({ page, nav, toast }, orgName = 'サンプル団体') {
  await nav('新規作成')
  await page.getByRole('button', { name: new RegExp(orgName) }).first().click()
  await page.getByRole('button', { name: '次へ' }).click()
  await page.getByRole('button', { name: '次へ' }).click()
  await page.locator('main input').first().fill('テスト担当')
  for (const el of await page.locator('main input[type=date]').all()) await el.fill('2026-09-24')
  for (const el of await page.locator('main input[type=text], main textarea').all()) if (!(await el.inputValue())) await el.fill('テスト')
  await page.getByRole('button', { name: '文面を生成' }).click()
  await toast('履歴に保存しました')
}

async function adminLogin(page, pass = 'admin') {
  await page.locator('input[type=password]').fill(pass)
  await page.getByRole('button', { name: '確認' }).click()
}

test('資料作成：生成すると出力画面になり、履歴に残る。入力途中は続きから再開できる', async () => {
  const app = await open()
  const { page, nav } = app
  // 途中まで入力して、画面を開き直す
  await nav('新規作成')
  await page.getByRole('button', { name: /サンプル団体/ }).first().click()
  await page.getByRole('button', { name: '次へ' }).click()
  await page.waitForTimeout(600)
  await page.reload()
  await page.getByText('発信物を、ひとつの入力から。').waitFor()
  await nav('新規作成')
  await page.getByText('入力途中の資料があります').waitFor()
  await page.getByRole('button', { name: '続きから' }).click()
  assert.equal(await page.locator('h1').first().innerText(), 'セットとランクを選ぶ')

  await generate(app)
  await page.getByText('公開前に団体名・日付・公開範囲を確認してください。').waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('pg-draft')), null)
  await nav('履歴')
  await page.getByText(/テスト担当 · H001/).waitFor()
  assert.deepEqual(app.errors, [])
  await app.close()
})

test('履歴：作成者で絞り込み、CSV に書き出せる', async () => {
  const app = await open()
  const { page, nav } = app
  await generate(app)
  await nav('履歴')
  await page.getByLabel('作成者').selectOption('テスト担当')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /CSV（1件）/ }).click()])
  const csv = readFileSync(await download.path(), 'utf8')
  assert.ok(csv.startsWith('﻿履歴ID,作成日時,作成者,団体ID,団体名,セット,ランク,団体名'))
  assert.match(csv.split('\r\n')[1], /^H001,.*,テスト担当,O001,サンプル団体,締結告知セット,ゴールド,サンプル団体/)
  await page.getByLabel('期間（から）').fill('2000-01-01')
  await page.getByLabel('期間（まで）').fill('2000-01-02')
  await page.getByText('条件に合う履歴はありません。').waitFor()
  assert.deepEqual(app.errors, [])
  await app.close()
})

test('管理：団体を一括登録すると一覧と操作ログに出る', async () => {
  const app = await open()
  const { page, nav } = app
  await nav('管理')
  await page.getByPlaceholder('名前を入力').fill('テスト太郎')
  await page.getByPlaceholder('名前を入力').blur()
  await page.getByRole('button', { name: /^団体マスタ/ }).click()
  await page.getByRole('button', { name: '一括登録' }).click()
  await page.getByLabel('貼り付け欄').fill('団体名\t団体区分\n一括団体A\t大学\nサンプル団体\t\n一括団体B\t企業')
  await page.getByRole('button', { name: '2件を登録' }).click()
  await page.getByText(/2件を追加しました/).waitFor()
  await page.getByRole('button', { name: '閉じる', exact: true }).first().click()
  await page.getByText('一括団体B').waitFor()
  await page.getByRole('button', { name: /^操作ログ/ }).click()
  await page.getByText('一括追加').first().waitFor()
  assert.equal(await page.locator('table tbody tr', { hasText: 'テスト太郎' }).count(), 2)
  // 追加方法は一番右のタブ
  const tabs = await page.locator('main .flex-wrap.gap-1 > button').allInnerTexts()
  assert.equal(tabs.at(-1).trim(), '追加方法')
  assert.deepEqual(app.errors, [])
  await app.close()
})

test('管理者パス：5回続けて間違えると受け付けなくなる', async () => {
  const app = await open()
  const { page, nav } = app
  await nav('管理')
  await page.getByRole('button', { name: '管理者パスワードを入力' }).click()
  for (let i = 0; i < 5; i++) {
    await adminLogin(page, `wrong${i}`)
    await page.getByText('管理者パスワードが違います').waitFor()
  }
  await adminLogin(page, 'admin')
  await page.getByText(/5回続けて間違えたため/).waitFor()
  assert.deepEqual(app.errors, [])
  await app.close()
})

test('テンプレートの変更履歴：保存した版との差分を見て、元に戻せる', async () => {
  const app = await open()
  const { page, nav, toast } = app
  await nav('管理')
  await page.getByRole('button', { name: '編集' }).first().click()
  await adminLogin(page)
  const name = page.locator('label', { hasText: 'テンプレ名' }).locator('input')
  const original = await name.inputValue()
  await name.fill('変更後の名前')
  await page.getByRole('button', { name: '保存（管理者）' }).click()
  await toast('テンプレートを更新しました')

  await page.getByRole('button', { name: '編集' }).first().click()
  await page.getByRole('button', { name: '変更履歴' }).click()
  await page.getByText('（履歴の記録開始前）').click()
  await page.getByText(`${original}`, { exact: true }).waitFor()
  await page.getByRole('button', { name: 'この版を編集画面に読み込む' }).click()
  assert.equal(await name.inputValue(), original)
  await page.getByRole('button', { name: '保存（管理者）' }).click()
  await toast('テンプレートを更新しました')
  await page.getByText(original).first().waitFor()
  assert.deepEqual(app.errors, [])
  await app.close()
})

test('テンプレート編集のプレビュー：実際の団体のデータで確認できる', async () => {
  const app = await open()
  const { page, nav } = app
  await nav('管理')
  await page.getByRole('button', { name: '新規追加' }).click()
  await page.locator('main textarea').last().fill('{{団体名}} 様')
  const select = page.getByLabel('プレビューに使うデータ')
  await select.selectOption({ label: 'サンプル株式会社' })
  await page.getByText('団体の登録内容を差し込んだプレビュー').waitFor()
  assert.ok(await page.locator('mark', { hasText: 'サンプル株式会社' }).count())
  assert.deepEqual(app.errors, [])
  await app.close()
})

test('使い方・追加方法のページが開く。スマホ幅で横にはみ出さない', async () => {
  const app = await open()
  const { page, nav } = app
  await nav('使い方')
  await page.getByRole('heading', { name: '使い方', exact: true }).waitFor()
  await nav('管理')
  await page.getByRole('button', { name: '追加方法' }).click()
  await page.getByText('告知画像を Google スライドで追加する').waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await nav('履歴')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.deepEqual(app.errors, [])
  await app.close()
})

test('出力：メールソフト・X で開くボタン、表記チェックで置き換え', async () => {
  const app = await open()
  const { page, nav } = app
  await generate(app)
  // メール（件名＋本文）はメールソフトで開ける
  await page.getByRole('button', { name: 'メールソフトで開く' }).waitFor()
  const body = page.locator('main textarea').first()
  await body.fill(`${await body.inputValue()}\n御社のご協力に感謝します。`)
  await page.getByText('表記チェック').waitFor()
  await page.getByRole('button', { name: '置き換える' }).click()
  assert.match(await body.inputValue(), /貴団体のご協力/)
  assert.equal(await page.getByText('表記チェック').count(), 0)
  // X は1投稿目を投稿画面で開ける
  await page.getByRole('button', { name: /^X/ }).first().click()
  const href = await page.getByRole('link', { name: 'Xで開く' }).getAttribute('href')
  assert.ok(href.startsWith('https://x.com/intent/post?text='))
  // 利用状況に反映される
  await nav('管理')
  await page.getByRole('button', { name: '利用状況' }).click()
  await page.getByRole('heading', { name: '月ごとの作成数' }).waitFor()
  // 履歴一覧はページ移動のたびに裏で読み込み直すので、反映されるまで待つ
  await page.waitForFunction(() => /作成数（全期間）\s*1\s*件/.test(document.querySelector('main').innerText))
  assert.deepEqual(app.errors, [])
  await app.close()
})

test('団体の追加：似た名前の団体があれば警告する', async () => {
  const app = await open()
  const { page, nav } = app
  await nav('新規作成')
  await page.getByRole('button', { name: '新規団体を追加' }).click()
  await page.locator('label', { hasText: '団体名' }).locator('input').first().fill('サンプル団体（東京）')
  await page.getByText(/似た名前の団体がすでに登録されています：「サンプル団体」/).waitFor()
  assert.deepEqual(app.errors, [])
  await app.close()
})

test('共通パーツ：登録してテンプレートから差し込める', async () => {
  const app = await open()
  const { page, nav, toast } = app
  await nav('管理')
  await page.getByRole('button', { name: /^共通パーツ/ }).click()
  await page.getByRole('button', { name: '新規追加' }).click()
  await page.locator('label', { hasText: 'パーツ名' }).locator('input').fill('署名ブロック')
  await page.locator('label', { hasText: '内容' }).locator('textarea').fill('――――\n{{署名}}')
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await toast('追加しました')
  await page.getByRole('button', { name: /^テンプレート/ }).click()
  await page.getByRole('button', { name: '新規追加' }).click()
  await page.locator('main textarea').last().fill('本文です\n')
  await page.getByRole('button', { name: '署名ブロック', exact: true }).click()
  assert.match(await page.locator('main textarea').last().inputValue(), /\{\{部品:署名ブロック\}\}/)
  assert.ok(await page.locator('mark', { hasText: 'サンプル運営事務局' }).count())
  assert.deepEqual(app.errors, [])
  await app.close()
})

test('コピー形式「CSV行」：欄を1行の CSV にしてコピーできる', async () => {
  const app = await open()
  const { page, nav, toast } = app
  await nav('管理')
  await page.getByRole('button', { name: '新規追加' }).click()
  await page.locator('label', { hasText: 'テンプレ名' }).locator('input').fill('HPデータ（共通）')
  await page.locator('label', { hasText: /^媒体/ }).locator('select').selectOption('__new__')
  await page.getByPlaceholder('例：告知画像').fill('HPデータ')
  await page.locator('label', { hasText: '欄の構成' }).locator('select').selectOption({ label: 'CSV 1行（サイトのお知らせデータなど）' })
  await page.getByRole('button', { name: '追加して選ぶ' }).click()
  await toast('追加しました')
  const values = ['sample', '{{団体名}} 様とパートナーシップ締結', '{{締結日:YYYY-MM-DD}}', 'パートナー', '概要', '1行目\n{{団体名}}', '/img/sample.png', 'false']
  const boxes = page.locator('main textarea')
  for (let i = 0; i < values.length; i++) await boxes.nth(i).fill(values[i])
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await toast('テンプレートを追加しました')

  await generate(app)
  await page.getByRole('button', { name: 'HPデータ' }).click()
  await page.getByText('CSV 1行（欄を並び順につなげたもの）').waitFor()
  const row = await page.locator('main pre').first().innerText()
  assert.equal(row, 'sample,"サンプル団体 様とパートナーシップ締結",2026-09-24,"パートナー","概要","1行目<br>サンプル団体","/img/sample.png",false')
  assert.deepEqual(app.errors, [])
  await app.close()
})

test('自由記述と、テンプレート編集からの共通パーツ作成', async () => {
  const app = await open()
  const { page, nav, toast } = app
  await nav('管理')
  await page.getByRole('button', { name: '新規追加' }).click()
  await page.locator('label', { hasText: 'テンプレ名' }).locator('input').fill('自由記述テスト')
  const body = page.locator('main textarea').last()
  await body.fill('{{団体名}} 様\n')
  // 自由記述を入れる
  await page.getByRole('button', { name: '自由記述を入れる' }).click()
  await page.getByLabel('自由記述の見出し').fill('先方へのひとこと')
  await page.getByRole('button', { name: '差し込む' }).click()
  assert.match(await body.inputValue(), /\{\{自由:先方へのひとこと\}\}/)
  // 共通パーツをその場で作って差し込む
  await page.getByRole('button', { name: '新しく作る', exact: true }).click()
  await page.getByPlaceholder('例：署名ブロック').fill('結びの挨拶')
  await page.getByLabel('パーツの内容').fill('今後ともよろしくお願いいたします。')
  await page.getByRole('button', { name: '追加して差し込む' }).click()
  await toast('追加しました')
  assert.match(await body.inputValue(), /\{\{部品:結びの挨拶\}\}/)
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await toast('テンプレートを追加しました')
  // 共通パーツの一覧にも出る
  await page.getByRole('button', { name: /^共通パーツ/ }).click()
  await page.getByText('結びの挨拶').first().waitFor()
  assert.deepEqual(app.errors, [])
  await app.close()
})
