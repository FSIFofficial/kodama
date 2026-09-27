// テンプレートエンジン：差し込み、日付書式、ランク別テンプレ選択、X分割・X文字数計算

export const COMMON_RANK = '共通'
export const DEFAULT_DATE_FORMAT = 'YYYY年M月D日'
export const X_LIMIT = 280
export const X_URL_WEIGHT = 23
// Google ドキュメントの雛形に差し込んで書き出す出力形式
export const DOCUMENT_FORMATS = ['PDF', 'Docx']

export const isDocumentTemplate = (t) => DOCUMENT_FORMATS.includes(t?.format)
// Google スライドの雛形に差し込んで PNG で書き出す出力形式
export const IMAGE_FORMAT = '画像'
export const isImageTemplate = (t) => t?.format === IMAGE_FORMAT
// 雛形ファイル（ドキュメント / スライド）から作るテンプレ
export const isFileTemplate = (t) => isDocumentTemplate(t) || isImageTemplate(t)
// 告知画像で、図形を団体マスタのロゴ画像に置き換える差し込み。入力項目ではなく組み込み
export const LOGO_KEY = 'ロゴ'

// 共通パーツ：{{部品:署名ブロック}} で、管理画面の「共通パーツ」に登録した文章を差し込む。
// パーツの中にも {{団体名}} などの差し込みや別のパーツを書ける（5段まで）
export const PART_KEY = '部品'
const PART_RE = /\{\{\s*部品\s*:\s*([^{}]+?)\s*\}\}/g

// parts: { [パーツ名]: 内容 }。登録の無いパーツはそのまま残す（プレビューで未入力として目立たせる）
export function expandParts(text, parts = {}, depth = 0) {
  return String(text ?? '').replace(PART_RE, (m, name) => {
    if (!Object.prototype.hasOwnProperty.call(parts, name)) return m
    return depth < 5 ? expandParts(parts[name], parts, depth + 1) : ''
  })
}

// 使っているのに登録の無いパーツ名
export function unknownParts(texts, parts = {}) {
  const names = []
  for (const text of texts) {
    for (const m of String(text ?? '').matchAll(PART_RE)) {
      if (!Object.prototype.hasOwnProperty.call(parts, m[1]) && !names.includes(m[1])) names.push(m[1])
    }
  }
  return names
}

// 自由記述：{{自由:見出し}} は入力項目に登録しなくても、資料を作るときにその見出しの入力欄が出る（団体ごとに変えたい一文などに使う）。
// {{自由}} だけなら見出しは「自由記述」。入力値は values['自由:見出し'] に入る
export const FREE_KEY = '自由'
export const FREE_DEFAULT_LABEL = '自由記述'
export const freeLabel = (format) => String(format || '').trim() || FREE_DEFAULT_LABEL
export const freeValueKey = (format) => `${FREE_KEY}:${freeLabel(format)}`

// Google ドライブの URL でも ID でも受け付けて ID を返す
export function driveIdFrom(input) {
  const s = String(input || '').trim()
  const m = /\/d\/([a-zA-Z0-9_-]{10,})/.exec(s) || /[?&]id=([a-zA-Z0-9_-]{10,})/.exec(s)
  return m ? m[1] : s
}

// {{項目名}} または {{項目名:書式}}
const PLACEHOLDER_RE = /\{\{\s*([^{}:]+?)\s*(?::\s*([^{}]*?)\s*)?\}\}/g

export function extractPlaceholders(text) {
  const found = []
  for (const m of String(text ?? '').matchAll(PLACEHOLDER_RE)) {
    found.push({ key: m[1], format: m[2] || '', raw: m[0], start: m.index, end: m.index + m[0].length })
  }
  return found
}

// 複数テキストから項目キーを出現順・重複なしで取り出す
export function extractKeys(texts) {
  const keys = []
  for (const text of texts) {
    for (const { key } of extractPlaceholders(text)) if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

// カーソル位置にある {{ }} を返す（テンプレ編集で書式を変更するため）
export function placeholderAt(text, pos) {
  return extractPlaceholders(text).find((p) => pos > p.start && pos < p.end) || null
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

export function parseDate(value) {
  if (value instanceof Date && !isNaN(value)) return { y: value.getFullYear(), m: value.getMonth() + 1, d: value.getDate() }
  const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/.exec(String(value ?? '').trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const check = new Date(Date.UTC(y, mo - 1, d))
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  return { y, m: mo, d }
}

export function formatDate(value, format = DEFAULT_DATE_FORMAT) {
  const p = parseDate(value)
  if (!p) return String(value ?? '')
  const w = WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]
  const pad = (n) => String(n).padStart(2, '0')
  return (format || DEFAULT_DATE_FORMAT).replace(/YYYY|MM|M|DD|D|曜/g, (t) => ({ YYYY: String(p.y), MM: pad(p.m), M: String(p.m), DD: pad(p.d), D: String(p.d), 曜: w })[t])
}

// items: { [項目キー]: 入力項目 }, settings: { [項目キー]: 値 }
export function resolveValue(key, format, { values = {}, items = {}, settings = {} }) {
  if (key === FREE_KEY) {
    const v = values[freeValueKey(format)]
    return v === undefined || v === null || v === '' ? null : String(v)
  }
  const item = items[key]
  let v = values[key]
  if ((v === undefined || v === null || v === '') && !item && key in settings) v = settings[key]
  if (v === undefined || v === null || v === '') return null
  v = String(v)
  if ((item?.type === '日付' || format) && parseDate(v)) return formatDate(v, format || item?.format || DEFAULT_DATE_FORMAT)
  return v
}

// プレビューで差し込み部分を強調するため、文字列を区切って返す
// { text } は地の文、{ text, key } は差し込み値、{ text, key, missing: true } は未入力
export function renderSegments(template, ctx) {
  const text = expandParts(template, ctx.parts)
  const segments = []
  let last = 0
  for (const p of extractPlaceholders(text)) {
    if (p.start > last) segments.push({ text: text.slice(last, p.start) })
    const v = resolveValue(p.key, p.format, ctx)
    const label = p.key === FREE_KEY ? freeLabel(p.format) : p.key
    segments.push(v === null ? { text: `［${label}］`, key: p.key, missing: true } : { text: v, key: p.key })
    last = p.end
  }
  if (last < text.length) segments.push({ text: text.slice(last) })
  return segments
}

// 出力用。差し込みがすべて未入力の行は「今回のポイント：」のような見出しごと消し、
// 空行が3行以上続いたら詰める
export function renderTemplate(template, ctx) {
  const lines = []
  for (const line of expandParts(template, ctx.parts).split('\n')) {
    const segments = renderSegments(line, ctx)
    const inserted = segments.filter((s) => s.key)
    if (inserted.length && inserted.every((s) => s.missing)) continue
    lines.push(segments.map((s) => (s.missing ? '' : s.text)).join(''))
  }
  return tidy(lines.join('\n'))
}

// 書類用。雛形ドキュメント側では行を消せないので、未入力は空にするだけで行も空行もそのまま残す
export function renderDocumentText(template, ctx) {
  return renderSegments(template, ctx).map((s) => (s.missing ? '' : s.text)).join('')
}

// 書類の差し込み表：{ '{{団体名}}': 'サンプル団体', '{{締結日:M/D}}': '9/24', ... }（未入力は空文字）
export function documentReplacements(template, ctx) {
  return fileReplacements(template, ctx).replacements
}

// 画像を入れる差し込みか（{{ロゴ}} と、入力タイプ「画像」の項目）
const isImageToken = (key, ctx) => key === LOGO_KEY || ctx.items?.[key]?.type === '画像'

// 雛形ファイル用の差し込み表。images は告知画像で図形を置き換える画像のファイルID（書類では空欄にする）
export function fileReplacements(template, ctx, { logoFileId = '', withImages = false } = {}) {
  const replacements = {}
  const images = {}
  for (const p of extractPlaceholders(template)) {
    // 共通パーツは雛形の {{部品:名前}} をパーツの内容（差し込み済み）で置き換える
    if (p.key === PART_KEY) {
      const part = ctx.parts?.[p.format]
      replacements[p.raw] = part === undefined ? '' : renderDocumentText(part, ctx)
      continue
    }
    if (isImageToken(p.key, ctx)) {
      const id = p.key === LOGO_KEY ? logoFileId : driveIdFrom(ctx.values?.[p.key])
      if (withImages) images[p.raw] = id || ''
      else replacements[p.raw] = ''
      continue
    }
    replacements[p.raw] = resolveValue(p.key, p.format, ctx) ?? ''
  }
  return { replacements, images }
}

export function tidy(text) {
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

// セット×ランクから媒体ごとのテンプレを選ぶ。ランク専用を優先し、なければ「共通」
export function pickTemplates(templates, setId, rank) {
  const picked = {}
  for (const t of templates) {
    if (!t.active || t.setId !== setId) continue
    const current = picked[t.mediaId]
    if (t.rank === rank && (!current || current.rank !== rank)) picked[t.mediaId] = t
    else if (t.rank === COMMON_RANK && !current) picked[t.mediaId] = t
  }
  return picked
}

// ---------- 文字数 ----------

const URL_RE = /https?:\/\/[^\s　]+/g

// X（twitter-text v3）の重み：Latin 等は1、それ以外（日本語・絵文字など）は2
function xWeight(cp) {
  return cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037) ? 1 : 2
}

function weigh(text) {
  let total = 0
  for (const ch of text) total += xWeight(ch.codePointAt(0))
  return total
}

// URL は長さに関係なく一律23
export function countX(text) {
  const s = String(text ?? '').normalize('NFC')
  let total = 0
  let last = 0
  for (const m of s.matchAll(URL_RE)) {
    total += weigh(s.slice(last, m.index)) + X_URL_WEIGHT
    last = m.index + m[0].length
  }
  return total + weigh(s.slice(last))
}

export function countPlain(text) {
  return [...String(text ?? '')].length
}

export function countText(text, mode) {
  return mode === 'X方式' ? countX(text) : countPlain(text)
}

// ---------- X スレッド分割 ----------

// 単独行の --- で分割
export function splitBySeparator(text) {
  const parts = [[]]
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '---') parts.push([])
    else parts[parts.length - 1].push(line)
  }
  return parts.map((lines) => lines.join('\n').trim()).filter(Boolean)
}

// 上限を超えた投稿を、改行・句点の位置で分割（それでも長い場合は文字単位）
function fitPost(text, limit, count) {
  if (count(text) <= limit) return [text]
  const pieces = text.match(/[^\n。！？!?]*(?:[。！？!?]+|\n|$)/g).filter(Boolean)
  const posts = []
  let cur = ''
  const flush = () => {
    if (cur.trim()) posts.push(cur.trim())
    cur = ''
  }
  for (const piece of pieces) {
    if (count(cur + piece) <= limit) {
      cur += piece
      continue
    }
    flush()
    if (count(piece.trim()) <= limit) {
      cur = piece
      continue
    }
    for (const ch of piece) {
      if (count(cur + ch) > limit) flush()
      cur += ch
    }
  }
  flush()
  return posts
}

export function splitXThread(text, { limit = X_LIMIT, numbering = false } = {}) {
  const chunks = splitBySeparator(text)
  let reserve = 0
  let posts = []
  for (;;) {
    posts = chunks.flatMap((c) => fitPost(c, limit - reserve, countX))
    if (!numbering) break
    const need = countX(`\n(${posts.length}/${posts.length})`)
    if (need <= reserve) break
    reserve = need
  }
  const n = posts.length
  return posts.map((p, i) => {
    const t = numbering && n > 1 ? `${p}\n(${i + 1}/${n})` : p
    const c = countX(t)
    return { text: t, count: c, over: c > limit }
  })
}

// ---------- 生成 ----------

export function buildContext({ values, items, settings, parts = [] }) {
  return {
    values,
    items: Object.fromEntries(items.map((i) => [i.key, i])),
    settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
    parts: partsMap(parts),
  }
}

// 有効な共通パーツ → { [パーツ名]: 内容 }
export function partsMap(parts = []) {
  return Object.fromEntries(parts.filter((p) => p.active !== false).map((p) => [p.name, p.content ?? '']))
}

// 媒体ごとに、媒体欄の定義に沿って文面を作る
// 戻り値: { [mediaId]: { templateId, fields: { [欄キー]: 文面 } } }
export function generateOutputs({ picked, mediaIds, media, ctx }) {
  const out = {}
  for (const mediaId of mediaIds) {
    const t = picked[mediaId]
    const m = media.find((x) => x.id === mediaId)
    if (!t || !m) continue
    const fields = {}
    const keys = m.fields.length ? m.fields.map((f) => f.fieldKey) : Object.keys(t.fields)
    const render = isFileTemplate(t) ? renderDocumentText : renderTemplate
    for (const key of keys) fields[key] = render(t.fields[key] ?? '', ctx)
    out[mediaId] = { templateId: t.id, fields }
  }
  return out
}

// 入力フォームに出す項目：選んだテンプレで使われている {{ }} だけ
export function formItemsFor({ picked, mediaIds, items, settings, parts = [] }) {
  const map = partsMap(parts)
  const raw = mediaIds.flatMap((id) => Object.values(picked[id]?.fields || {}))
  const texts = raw.map((t) => expandParts(t, map))
  const keys = extractKeys(texts).filter((k) => k !== PART_KEY && k !== FREE_KEY)
  // 自由記述の見出し（出てきた順・重複なし）。入力フォームでは長文の欄として出す
  const freeItems = []
  for (const text of texts) {
    for (const p of extractPlaceholders(text)) {
      if (p.key !== FREE_KEY) continue
      const key = freeValueKey(p.format)
      if (!freeItems.some((i) => i.key === key)) freeItems.push({ key, label: freeLabel(p.format), type: '長文', category: '案件', free: true, required: false, defaultValue: '', example: '' })
    }
  }
  const byKey = Object.fromEntries(items.map((i) => [i.key, i]))
  const settingKeys = new Set(settings.map((s) => s.key))
  const used = keys.filter((k) => byKey[k]).map((k) => byKey[k]).sort((a, b) => (a.order === '' ? Infinity : a.order) - (b.order === '' ? Infinity : b.order))
  return {
    orgItems: used.filter((i) => i.category === '団体'),
    caseItems: used.filter((i) => i.category !== '団体'),
    settingKeys: keys.filter((k) => !byKey[k] && settingKeys.has(k)),
    unknownKeys: keys.filter((k) => !byKey[k] && !settingKeys.has(k) && k !== LOGO_KEY),
    usesLogo: keys.includes(LOGO_KEY),
    unknownParts: unknownParts(raw, map),
    freeItems,
  }
}

// テンプレ編集プレビュー用のモック値
export function mockValues(items) {
  const today = new Date()
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return {
    ...Object.fromEntries(
      items.map((i) => [i.key, i.example || i.defaultValue || (i.type === '日付' ? iso : i.type === '数値' ? '1' : i.type === 'URL' ? 'https://example.com' : `（${i.label || i.key}）`)]),
    ),
    [LOGO_KEY]: '［ロゴ画像］',
  }
}
