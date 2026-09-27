import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { ArrowLeft, Calendar, FileText, History as HistoryIcon, Plus, Save, Scissors } from 'lucide-preact'
import { COMMON_RANK, DOCUMENT_FORMATS, FREE_KEY, IMAGE_FORMAT, LOGO_KEY, PART_KEY, buildContext, extractPlaceholders, freeLabel, partsMap, unknownParts, driveIdFrom, countText, extractKeys, formatDate, mockValues, placeholderAt, renderSegments, splitXThread } from '../lib/engine.js'
import { Alert, Badge, Button, DocLink, Eyebrow, Label, Modal, Spinner, activeOnly, card, copyText, cx, formatDateTime, inputCls, useApp } from '../ui/ui.jsx'
import { lineDiff } from '../lib/diff.js'
import { Segments } from './Create.jsx'

const ITEM_TYPES = ['短文', '長文', '日付', '選択', '数値', 'URL', '画像']
const SAMPLE_DATE = '2026-09-24'

// セレクトの「＋ 新しく作る…」
const NEW = '__new__'

// 新しい媒体の欄のひな形
const MEDIA_PRESETS = [
  { label: '本文だけ', fields: [{ fieldKey: '本文', label: '本文' }] },
  { label: '件名＋本文（メールなど）', fields: [{ fieldKey: '件名', label: '件名' }, { fieldKey: '本文', label: '本文' }] },
  { label: 'タイトル＋本文（note・HPなど）', fields: [{ fieldKey: 'タイトル', label: 'タイトル' }, { fieldKey: '本文', label: '本文' }] },
  { label: '本文＋ハッシュタグ（Instagramなど）', fields: [{ fieldKey: '本文', label: 'キャプション', limit: 2200 }, { fieldKey: 'ハッシュタグ', label: 'ハッシュタグ' }] },
  { label: 'Xの投稿（280字・スレッド分割）', fields: [{ fieldKey: '本文', label: '投稿本文', limit: 280, countMode: 'X方式', splitRule: 'スレッド分割' }] },
  {
    label: 'CSV 1行（サイトのお知らせデータなど）',
    copyFormat: 'CSV行',
    fields: ['id', 'title', 'date', 'category', 'excerpt', 'content', 'image', 'featured'].map((k) => ({ fieldKey: k, label: k })),
  },
]

// 出力形式の種類：テキスト / 書類（Google ドキュメント）/ 告知画像（Google スライド）
const formatKind = (format) => (format === IMAGE_FORMAT ? 'slides' : DOCUMENT_FORMATS.includes(format) ? 'document' : 'text')

export function TemplateEditor({ mode, template, onClose }) {
  const { api, data, adminCall, reload, notify, history } = useApp()
  const firstMedia = activeOnly(data.media)[0]
  const [meta, setMeta] = useState(() => ({
    name: template ? (mode === 'create' ? `${template.name}（コピー）` : template.name) : '',
    setId: template?.setId || activeOnly(data.sets)[0]?.id || '',
    mediaId: template?.mediaId || firstMedia?.id || '',
    rank: template?.rank || COMMON_RANK,
    format: template?.format || 'テキスト',
    fileId: template?.fileId || '',
  }))
  const [fields, setFields] = useState(() => ({ ...(template?.fields || {}) }))
  const [focus, setFocus] = useState(null) // { fieldKey, start, end }
  const [datePicker, setDatePicker] = useState(null) // { key, replace?: placeholder }
  const [unknownPrompt, setUnknownPrompt] = useState(null)
  const [quickCreate, setQuickCreate] = useState(null) // 'sets' | 'media' | 'ranks'
  const [showRevisions, setShowRevisions] = useState(false)
  const [freePrompt, setFreePrompt] = useState(false)
  const [busy, setBusy] = useState(false)
  const refs = useRef({})
  const pendingCaret = useRef(null)

  // isDocument は雛形ファイル（ドキュメント・スライド）から作るテンプレ全般。isSlides は告知画像
  const isSlides = meta.format === IMAGE_FORMAT
  const isDocument = formatKind(meta.format) !== 'text'
  const fileLabel = isSlides ? 'Google スライド' : 'Google ドキュメント'
  const media = data.media.find((m) => m.id === meta.mediaId)
  const fieldDefs = useMemo(() => {
    if (isDocument) return [{ fieldKey: '本文', label: '雛形の内容' }]
    const defs = media?.fields?.length ? [...media.fields] : [{ fieldKey: '本文', label: '本文' }]
    for (const k of Object.keys(fields)) if (!defs.some((d) => d.fieldKey === k)) defs.push({ fieldKey: k, label: `${k}（この媒体に無い欄）`, orphan: true })
    return defs
  }, [media, fields, isDocument])

  const items = activeOnly(data.items)
  const itemsByKey = Object.fromEntries(data.items.map((i) => [i.key, i]))
  const settingKeys = data.settings.map((s) => s.key)
  // プレビューに使うデータ：入力例（既定）／実際の団体（団体情報はマスタ、案件情報は入力例）／過去の履歴の入力値
  const [previewSource, setPreviewSource] = useState('')
  const previewValues = useMemo(() => {
    const base = mockValues(data.items)
    const [kind, id] = previewSource.split(':')
    if (kind === 'org') {
      const o = data.orgs.find((x) => x.id === id)
      if (o) {
        const orgKeys = data.items.filter((i) => i.category === '団体').map((i) => i.key)
        return { ...base, ...Object.fromEntries(orgKeys.map((k) => [k, o.values[k] ?? ''])), ...o.values, [LOGO_KEY]: o.logoFileId ? '［ロゴ画像］' : '' }
      }
    }
    if (kind === 'history') {
      const h = (history || []).find((x) => x.id === id)
      if (h) {
        const o = data.orgs.find((x) => x.id === h.orgId)
        return { ...base, ...h.values, [LOGO_KEY]: o?.logoFileId ? '［ロゴ画像］' : '' }
      }
    }
    return base
  }, [previewSource, data.items, data.orgs, history])
  const ctx = buildContext({ values: previewValues, items: data.items, settings: data.settings, parts: data.parts })

  useEffect(() => {
    if (!pendingCaret.current) return
    const { fieldKey, pos } = pendingCaret.current
    const el = refs.current[fieldKey]
    if (el) {
      el.focus()
      el.setSelectionRange(pos, pos)
    }
    pendingCaret.current = null
  })

  const activeKey = focus?.fieldKey && fieldDefs.some((d) => d.fieldKey === focus.fieldKey) ? focus.fieldKey : fieldDefs[fieldDefs.length > 1 ? 1 : 0]?.fieldKey

  // カーソル位置に挿入（範囲選択中なら置き換え）。書類の場合は Google ドキュメントに貼り付けるためにコピーする
  const insert = (text, range) => {
    if (isDocument) return copyText(text.trim(), notify)
    const key = activeKey
    const cur = fields[key] ?? ''
    const start = range?.start ?? (focus?.fieldKey === key ? focus.start : cur.length)
    const end = range?.end ?? (focus?.fieldKey === key ? focus.end : cur.length)
    setFields({ ...fields, [key]: cur.slice(0, start) + text + cur.slice(end) })
    pendingCaret.current = { fieldKey: key, pos: start + text.length }
    setFocus({ fieldKey: key, start: start + text.length, end: start + text.length })
  }

  const trackCaret = (fieldKey) => (e) => {
    const el = e.currentTarget
    setFocus({ fieldKey, start: el.selectionStart, end: el.selectionEnd })
    // 挿入済みの日付項目をクリックしたら書式を選び直せるようにする
    if (e.type === 'click') {
      const p = placeholderAt(el.value, el.selectionStart)
      if (p && itemsByKey[p.key]?.type === '日付') setDatePicker({ key: p.key, replace: p, fieldKey })
    }
  }

  const clickItem = (item) => {
    if (item.type === '日付') setDatePicker({ key: item.key })
    else insert(`{{${item.key}}}`)
  }

  const chooseDateFormat = (fmt) => {
    const token = fmt ? `{{${datePicker.key}:${fmt}}}` : `{{${datePicker.key}}}`
    if (datePicker.replace) {
      const cur = fields[datePicker.fieldKey] ?? ''
      setFields({ ...fields, [datePicker.fieldKey]: cur.slice(0, datePicker.replace.start) + token + cur.slice(datePicker.replace.end) })
    } else insert(token)
    setDatePicker(null)
  }

  const usedKeys = extractKeys(Object.values(fields))
  const unknownKeys = usedKeys.filter((k) => !itemsByKey[k] && !settingKeys.includes(k) && k !== LOGO_KEY && k !== PART_KEY && k !== FREE_KEY)
  // テンプレートで使っている自由記述の見出し
  const usedFree = [...new Set(Object.values(fields).flatMap((t) => extractPlaceholders(t).filter((p) => p.key === FREE_KEY).map((p) => freeLabel(p.format))))]
  const missingParts = unknownParts(Object.values(fields), partsMap(data.parts))
  const usedParts = [...Object.values(fields).join('\n').matchAll(/\{\{\s*部品\s*:\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1])

  const save = async (skipUnknownCheck) => {
    if (!skipUnknownCheck && unknownKeys.length) {
      setUnknownPrompt(unknownKeys.map((k) => ({ key: k, register: true, category: '案件', type: '短文' })))
      return
    }
    setBusy(true)
    try {
      const cleaned = Object.fromEntries(Object.entries(fields).filter(([k, v]) => fieldDefs.some((d) => d.fieldKey === k && !d.orphan) || v.trim()))
      const payload = { entity: 'templates', data: meta, children: { fields: cleaned } }
      if (mode === 'edit') {
        if (!(await adminCall('update', { ...payload, key: template.id }))) return
      } else {
        await api.call('create', payload)
      }
      await reload()
      notify(mode === 'edit' ? 'テンプレートを更新しました' : 'テンプレートを追加しました')
      onClose()
    } catch (e) {
      notify(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const registerUnknown = async (rows) => {
    setBusy(true)
    try {
      for (const r of rows.filter((x) => x.register)) {
        await api.call('create', { entity: 'items', data: { key: r.key, label: r.key, category: r.category, type: r.type, order: '' } })
      }
      await reload()
      setUnknownPrompt(null)
    } catch (e) {
      notify(e.message, 'error')
      return
    } finally {
      setBusy(false)
    }
    await save(true)
  }

  const [loadingDoc, setLoadingDoc] = useState(false)
  const loadDocument = async () => {
    setLoadingDoc(true)
    try {
      const { text } = await api.call('readDocument', { fileId: meta.fileId, format: meta.format })
      setFields({ 本文: text })
      notify('雛形を読み込みました')
    } catch (e) {
      notify(e.message, 'error')
    } finally {
      setLoadingDoc(false)
    }
  }

  const canSave = meta.name.trim() && meta.setId && meta.mediaId && meta.rank && !busy && (!isDocument || (meta.fileId && fields['本文']))
  const activeDef = fieldDefs.find((d) => d.fieldKey === activeKey)

  return (
    <section>
      <div class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <button onClick={onClose} class="mb-3 flex items-center gap-1 text-sm font-semibold text-[#1261af]">
            <ArrowLeft class="size-4" /> テンプレート一覧に戻る
          </button>
          <Eyebrow>TEMPLATE / {mode === 'edit' ? `EDIT ${template.id}` : 'NEW'}</Eyebrow>
          <h1 class="mt-2 text-2xl font-bold">{mode === 'edit' ? 'テンプレートを編集' : 'テンプレートを追加'}</h1>
        </div>
        <div class="flex flex-wrap gap-2">
          {mode === 'edit' && <Button variant="outline" icon={HistoryIcon} onClick={() => setShowRevisions(true)}>変更履歴</Button>}
          <Button variant="outline" onClick={onClose}>キャンセル</Button>
          <Button icon={busy ? Spinner : Save} onClick={() => save(false)} disabled={!canSave}>{mode === 'edit' ? '保存（管理者）' : '追加'}</Button>
        </div>
      </div>

      <div class="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.9fr)]">
        <div class="space-y-6">
          <div class={`${card} grid gap-4 p-6 md:grid-cols-2`}>
            <Label label="テンプレ名" required class="md:col-span-2">
              <input value={meta.name} onInput={(e) => setMeta({ ...meta, name: e.currentTarget.value })} class={inputCls} />
            </Label>
            <Label label="セット" required>
              <select value={meta.setId} onChange={(e) => (e.currentTarget.value === NEW ? setQuickCreate('sets') : setMeta({ ...meta, setId: e.currentTarget.value }))} class={inputCls}>
                {data.sets.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active === false ? '（無効）' : ''}</option>)}
                <option value={NEW}>＋ 新しいセットを作る…</option>
              </select>
            </Label>
            <Label label="媒体" required>
              <select value={meta.mediaId} onChange={(e) => (e.currentTarget.value === NEW ? setQuickCreate('media') : setMeta({ ...meta, mediaId: e.currentTarget.value }))} class={inputCls}>
                {data.media.map((m) => <option key={m.id} value={m.id}>{m.name}{m.active === false ? '（無効）' : ''}</option>)}
                <option value={NEW}>＋ 新しい媒体を作る…</option>
              </select>
            </Label>
            <Label label="ランク" required hint="「共通」はランク専用のテンプレートがない場合に使われます">
              <select value={meta.rank} onChange={(e) => (e.currentTarget.value === NEW ? setQuickCreate('ranks') : setMeta({ ...meta, rank: e.currentTarget.value }))} class={inputCls}>
                <option value={COMMON_RANK}>{COMMON_RANK}</option>
                {data.ranks.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
                <option value={NEW}>＋ 新しいランクを作る…</option>
              </select>
            </Label>
            <Label label="出力形式" hint="PDF・Docx は Google ドキュメント、画像は Google スライドの雛形に差し込んで書き出します">
              <select
                value={meta.format}
                onChange={(e) => {
                  const format = e.currentTarget.value
                  // テキストと書類を切り替えたら本文は引き継がない
                  if (formatKind(format) !== formatKind(meta.format)) setFields({})
                  setMeta({ ...meta, format })
                }}
                class={inputCls}
              >
                <option>テキスト</option>
                {DOCUMENT_FORMATS.map((f) => <option key={f}>{f}</option>)}
                <option value={IMAGE_FORMAT}>画像（告知画像）</option>
              </select>
            </Label>
          </div>

          {isDocument && (
            <div class={`${card} p-6`}>
              <h2 class="font-bold">雛形の {fileLabel}</h2>
              <ol class="mt-2 list-decimal space-y-1 pl-5 text-xs leading-5 text-slate-500">
                <li>
                  {isSlides
                    ? 'Google スライドで告知画像のデザインを作る（PowerPoint はドライブにアップロードして「Google スライドとして保存」）'
                    : 'Word ファイルはドライブにアップロードし、「ファイル → Google ドキュメントとして保存」で変換する'}
                </li>
                <li>差し込みたい箇所に {'{{団体名}}'} のように書く（下の項目をクリックするとコピーできます）</li>
                {isSlides && <li>ロゴを入れたい位置に図形を置き、その中に {'{{ロゴ}}'} と書く（図形がロゴ画像に置き換わります）</li>}
                <li>{isSlides ? 'スライド' : 'ドキュメント'}の URL を貼り付けて「読み込む」</li>
              </ol>
              <div class="mt-4 flex gap-2">
                <input
                  value={meta.fileId}
                  onInput={(e) => {
                    setMeta({ ...meta, fileId: driveIdFrom(e.currentTarget.value) })
                    setFields({})
                  }}
                  placeholder={isSlides ? "https://docs.google.com/presentation/d/…" : "https://docs.google.com/document/d/…"}
                  class={cx(inputCls, 'mt-0 font-mono')}
                />
                <Button variant="outline" icon={loadingDoc ? Spinner : FileText} onClick={loadDocument} disabled={!meta.fileId || loadingDoc}>読み込む</Button>
              </div>
              <div class="mt-3 flex flex-wrap items-center gap-3">
                <DocLink fileId={meta.fileId} kind={isSlides ? 'presentation' : 'document'} />
                <p class="text-xs text-slate-400">雛形の文面や{isSlides ? 'デザイン' : '書式'}は {fileLabel} で直します。直したら「読み込む」を押して保存すると、差し込み項目とプレビューに反映されます。</p>
              </div>
            </div>
          )}

          <div class={`${card} p-6`}>
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 class="font-bold">項目を差し込む</h2>
                <p class="mt-1 text-xs text-slate-500">
                  {isDocument ? `クリックで {{項目名}} をコピーします。雛形の ${fileLabel}に貼り付けてください。` : `クリックで「${activeDef?.label || '本文'}」のカーソル位置に挿入します。`}日付は書式を選べます。
                </p>
              </div>
              {!isDocument && <Button variant="outline" size="sm" icon={Scissors} onClick={() => insert('\n---\n')} title="X のスレッドで次の投稿に分ける区切りを入れます">X区切り</Button>}
            </div>
            {[['団体', '団体情報'], ['案件', '案件情報']].map(([cat, title]) => (
              <div key={cat} class="mt-4">
                <p class="text-xs font-bold text-slate-400">{title}</p>
                <div class="mt-2 flex flex-wrap gap-1.5">
                  {items.filter((i) => i.category === cat).map((i) => (
                    <button key={i.key} onClick={() => clickItem(i)} class={cx('inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium', usedKeys.includes(i.key) ? 'border-[#9bdcc5] bg-[#effcf6] text-[#17634f]' : 'border-[#dce5f2] bg-white text-slate-600 hover:border-[#3b8dd9]')}>
                      {i.type === '日付' && <Calendar class="size-3" />}
                      {i.label || i.key}
                    </button>
                  ))}
                  {cat === '団体' && isSlides && (
                    <button onClick={() => insert(`{{${LOGO_KEY}}}`)} class={cx('inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium', usedKeys.includes(LOGO_KEY) ? 'border-[#9bdcc5] bg-[#effcf6] text-[#17634f]' : 'border-[#dce5f2] bg-white text-slate-600 hover:border-[#3b8dd9]')} title="図形の中に書くと、団体マスタのロゴ画像に置き換わります">
                      ロゴ画像
                    </button>
                  )}
                </div>
              </div>
            ))}
            <div class="mt-4">
              <p class="text-xs font-bold text-slate-400">共通設定</p>
              <div class="mt-2 flex flex-wrap gap-1.5">
                {data.settings.map((s) => (
                  <button key={s.key} onClick={() => insert(`{{${s.key}}}`)} class={cx('rounded-lg border px-2.5 py-1 text-xs font-medium', usedKeys.includes(s.key) ? 'border-[#9bdcc5] bg-[#effcf6] text-[#17634f]' : 'border-[#dce5f2] bg-white text-slate-600 hover:border-[#3b8dd9]')}>
                    {s.key}
                  </button>
                ))}
              </div>
            </div>
            <div class="mt-4">
              <p class="text-xs font-bold text-slate-400">共通パーツ <span class="font-normal">（署名ブロックなど、よく使う文章のまとまり）</span></p>
              <div class="mt-2 flex flex-wrap gap-1.5">
                {activeOnly(data.parts).map((p) => (
                  <button key={p.name} onClick={() => insert(`{{${PART_KEY}:${p.name}}}`)} title={p.content} class={cx('rounded-lg border px-2.5 py-1 text-xs font-medium', usedParts.includes(p.name) ? 'border-[#9bdcc5] bg-[#effcf6] text-[#17634f]' : 'border-dashed border-[#b9c9e0] bg-white text-slate-600 hover:border-[#3b8dd9]')}>
                    {p.name}
                  </button>
                ))}
                <button onClick={() => setQuickCreate('parts')} class="inline-flex items-center gap-1 rounded-lg border border-dashed border-[#9fc3e8] bg-[#f1f8ff] px-2.5 py-1 text-xs font-medium text-[#1261af] hover:border-[#3b8dd9]">
                  <Plus class="size-3" />新しく作る
                </button>
              </div>
            </div>
            <div class="mt-4">
              <p class="text-xs font-bold text-slate-400">自由記述 <span class="font-normal">（項目に登録せず、資料を作るたびに団体ごとの文章を書く場所）</span></p>
              <div class="mt-2 flex flex-wrap gap-1.5">
                {usedFree.map((label) => (
                  <button key={label} onClick={() => insert(label === '自由記述' ? `{{${FREE_KEY}}}` : `{{${FREE_KEY}:${label}}}`)} class="rounded-lg border border-[#9bdcc5] bg-[#effcf6] px-2.5 py-1 text-xs font-medium text-[#17634f]">
                    {label}
                  </button>
                ))}
                <button onClick={() => setFreePrompt(true)} class="inline-flex items-center gap-1 rounded-lg border border-dashed border-[#9fc3e8] bg-[#f1f8ff] px-2.5 py-1 text-xs font-medium text-[#1261af] hover:border-[#3b8dd9]">
                  <Plus class="size-3" />自由記述を入れる
                </button>
              </div>
            </div>
          </div>

          <div class={`${card} space-y-5 p-6`}>
            {isDocument && (
              <div>
                <span class="text-sm font-semibold">雛形の内容（読み込み結果{isSlides ? '。--- はスライドの区切り' : ''}）</span>
                <div class="mt-2 max-h-[420px] min-h-24 overflow-auto rounded-xl border border-[#dce5f2] bg-[#f9fbfe] p-3 font-mono text-sm leading-6 whitespace-pre-wrap text-slate-600">
                  {fields['本文'] || '「読み込む」を押すと、雛形の本文がここに表示されます。'}
                </div>
              </div>
            )}
            {!isDocument && fieldDefs.map((d) => (
              <div key={d.fieldKey}>
                <div class="flex items-center justify-between gap-2">
                  <span class={cx('text-sm font-semibold', activeKey === d.fieldKey && 'text-[#1261af]')}>{d.label}</span>
                  <span class="flex gap-1">
                    {d.splitRule === 'スレッド分割' && <Badge>--- で投稿を分割</Badge>}
                    {d.limit ? <Badge tone="gray">上限 {d.limit}（{d.countMode}）</Badge> : null}
                  </span>
                </div>
                <textarea
                  ref={(el) => (refs.current[d.fieldKey] = el)}
                  value={fields[d.fieldKey] ?? ''}
                  onInput={(e) => {
                    setFields({ ...fields, [d.fieldKey]: e.currentTarget.value })
                    trackCaret(d.fieldKey)(e)
                  }}
                  onClick={trackCaret(d.fieldKey)}
                  onKeyUp={trackCaret(d.fieldKey)}
                  onFocus={trackCaret(d.fieldKey)}
                  class={cx('mt-2 w-full rounded-xl border p-3 font-mono text-sm leading-6 outline-none focus:ring-2 focus:ring-blue-100', d.orphan ? 'border-amber-200' : 'border-[#dce5f2] focus:border-[#3b8dd9]', (fields[d.fieldKey] || '').includes('\n') || d.fieldKey === '本文' ? 'min-h-[260px]' : 'min-h-12')}
                />
              </div>
            ))}
            {unknownKeys.length > 0 && <Alert>未登録の項目：{unknownKeys.join('、')}（保存時に登録を確認します）</Alert>}
            {missingParts.length > 0 && <Alert>登録されていない（または無効の）共通パーツ：{missingParts.join('、')}。管理画面の「共通パーツ」で登録してください。</Alert>}
          </div>
        </div>

        <TemplatePreview fieldDefs={fieldDefs} fields={fields} ctx={ctx} source={previewSource} onSource={setPreviewSource} history={history} />
      </div>

      {datePicker && (
        <Modal title={`「${itemsByKey[datePicker.key]?.label || datePicker.key}」の書式`} onClose={() => setDatePicker(null)}>
          <div class="grid gap-2">
            <button onClick={() => chooseDateFormat('')} class={cx('flex items-center justify-between rounded-xl border p-3 text-left text-sm hover:border-[#3b8dd9]', datePicker.replace && !datePicker.replace.format ? 'border-[#3b8dd9] bg-[#eef7ff]' : 'border-[#e7edf5]')}>
              <span>項目の標準書式（{itemsByKey[datePicker.key]?.format || 'YYYY年M月D日'}）</span>
              <span class="text-slate-500">{formatDate(SAMPLE_DATE, itemsByKey[datePicker.key]?.format || undefined)}</span>
            </button>
            {activeOnly(data.dateFormats).map((f) => (
              <button key={f.format} onClick={() => chooseDateFormat(f.format)} class={cx('flex items-center justify-between rounded-xl border p-3 text-left text-sm hover:border-[#3b8dd9]', datePicker.replace?.format === f.format ? 'border-[#3b8dd9] bg-[#eef7ff]' : 'border-[#e7edf5]')}>
                <span class="font-mono">{f.format}</span>
                <span class="text-slate-500">{formatDate(SAMPLE_DATE, f.format)}</span>
              </button>
            ))}
          </div>
          <p class="mt-3 text-xs text-slate-400">書式の候補は管理画面の「日付書式」で追加できます。</p>
        </Modal>
      )}

      {quickCreate && (
        <QuickCreateModal
          kind={quickCreate}
          fileFormat={isDocument}
          onClose={() => setQuickCreate(null)}
          onCreated={(key) => {
            if (quickCreate === 'parts') insert(`{{${PART_KEY}:${key}}}`)
            else setMeta({ ...meta, [{ sets: 'setId', media: 'mediaId', ranks: 'rank' }[quickCreate]]: key })
            setQuickCreate(null)
          }}
        />
      )}

      {freePrompt && (
        <FreeTextModal
          onClose={() => setFreePrompt(false)}
          onInsert={(label) => {
            insert(label ? `{{${FREE_KEY}:${label}}}` : `{{${FREE_KEY}}}`)
            setFreePrompt(false)
          }}
        />
      )}

      {showRevisions && (
        <RevisionsModal
          templateId={template.id}
          current={{ ...meta, fields }}
          onClose={() => setShowRevisions(false)}
          onRestore={(t) => {
            setMeta({ ...meta, ...Object.fromEntries(['name', 'setId', 'mediaId', 'rank', 'format', 'fileId'].map((k) => [k, t[k] ?? meta[k]])) })
            setFields({ ...(t.fields || {}) })
            setShowRevisions(false)
            notify('この版の内容を読み込みました。「保存（管理者）」を押すと、この内容に戻ります')
          }}
        />
      )}

      {unknownPrompt && <UnknownItemsModal rows={unknownPrompt} busy={busy} onCancel={() => setUnknownPrompt(null)} onSubmit={registerUnknown} />}
    </section>
  )
}

function TemplatePreview({ fieldDefs, fields, ctx, source, onSource, history }) {
  const { data } = useApp()
  const kind = source.split(':')[0]
  return (
    <div class="h-fit self-start rounded-2xl border border-[#9bdcc5] bg-[#f0fff9] p-5 shadow-sm xl:sticky xl:top-6">
      <p class="text-xs font-bold tracking-[0.18em] text-[#16866b]">PREVIEW / {kind === 'org' ? 'ORGANIZATION' : kind === 'history' ? 'HISTORY' : 'MOCK DATA'}</p>
      <h2 class="mt-1 font-bold text-[#17483e]">{kind === 'org' ? '団体の登録内容を差し込んだプレビュー' : kind === 'history' ? '過去の入力値を差し込んだプレビュー' : '入力例を差し込んだプレビュー'}</h2>
      <label class="mt-3 block text-xs font-medium text-[#31816f]">
        差し込むデータ
        <select value={source} onChange={(e) => onSource(e.currentTarget.value)} aria-label="プレビューに使うデータ" class="mt-1 h-9 w-full rounded-lg border border-[#b7e8d7] bg-white px-2 text-sm text-slate-700">
          <option value="">入力例（入力項目の「入力例」）</option>
          <optgroup label="団体（団体情報はマスタ、案件情報は入力例）">
            {activeOnly(data.orgs).map((o) => <option key={o.id} value={`org:${o.id}`}>{o.values['団体名'] || o.id}</option>)}
          </optgroup>
          {history?.length > 0 && (
            <optgroup label="履歴（そのとき入力した値）">
              {history.slice(0, 50).map((h) => <option key={h.id} value={`history:${h.id}`}>{[formatDateTime(h.createdAt), h.orgName, h.id].filter(Boolean).join(' · ')}</option>)}
            </optgroup>
          )}
        </select>
      </label>
      <div class="mt-4 max-h-[760px] space-y-5 overflow-auto rounded-xl border border-[#b7e8d7] bg-white p-5 text-sm leading-7 text-slate-700">
        {fieldDefs.map((d) => {
          const segments = renderSegments(fields[d.fieldKey] ?? '', ctx)
          const text = segments.map((s) => (s.missing ? '' : s.text)).join('')
          if (d.splitRule === 'スレッド分割') {
            const limit = Number(d.limit) || undefined
            const posts = splitXThread(text, { limit })
            return (
              <div key={d.fieldKey}>
                <p class="text-xs font-bold text-slate-400">{d.label}（{posts.length}投稿）</p>
                <div class="mt-2 grid gap-2">
                  {posts.map((p, i) => (
                    <div key={i} class={cx('rounded-lg border p-3', p.over ? 'border-red-200 bg-red-50' : 'border-[#e7edf5]')}>
                      <p class={cx('text-right text-xs', p.over ? 'font-bold text-red-600' : 'text-slate-400')}>{i + 1}　{p.count} / {limit || 280}</p>
                      <p class="whitespace-pre-wrap">{p.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            )
          }
          const count = countText(text, d.countMode)
          return (
            <div key={d.fieldKey}>
              <p class="flex justify-between text-xs font-bold text-slate-400">
                <span>{d.label}</span>
                <span class={cx(d.limit && count > d.limit && 'text-red-600')}>{count}{d.limit ? ` / ${d.limit}` : '文字'}</span>
              </p>
              <div class="mt-1 whitespace-pre-wrap"><Segments segments={segments} /></div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function UnknownItemsModal({ rows: initial, busy, onCancel, onSubmit }) {
  const [rows, setRows] = useState(initial)
  const set = (i, prop, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [prop]: v } : r)))
  const small = 'h-9 rounded-lg border border-[#dce5f2] bg-white px-2 text-sm'
  return (
    <Modal
      title="新しい項目として登録しますか？"
      onClose={onCancel}
      wide
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>戻る</Button>
          <Button onClick={() => onSubmit(rows)} disabled={busy}>{busy && <Spinner />}登録して保存</Button>
        </>
      }
    >
      <p class="mb-4 text-sm text-slate-500">テンプレートに入力項目・共通設定のどちらにもない名前があります。登録しない項目は、生成時に空欄になります。</p>
      <div class="grid gap-2">
        {rows.map((r, i) => (
          <div key={r.key} class="flex flex-wrap items-center gap-3 rounded-xl border border-[#e7edf5] p-3">
            <label class="flex min-w-40 flex-1 items-center gap-2 text-sm font-semibold">
              <input type="checkbox" class="size-4 accent-[#1261af]" checked={r.register} onChange={(e) => set(i, 'register', e.currentTarget.checked)} />
              {`{{${r.key}}}`}
            </label>
            <select value={r.category} onChange={(e) => set(i, 'category', e.currentTarget.value)} disabled={!r.register} class={small}>
              <option value="案件">区分：案件</option>
              <option value="団体">区分：団体</option>
            </select>
            <select value={r.type} onChange={(e) => set(i, 'type', e.currentTarget.value)} disabled={!r.register} class={small}>
              {ITEM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        ))}
      </div>
    </Modal>
  )
}

// テンプレ編集の途中で、セット・媒体・ランクを新しく作る（追加なので利用者も可）
function QuickCreateModal({ kind, fileFormat, onClose, onCreated }) {
  const { api, data, reload, notify } = useApp()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [preset, setPreset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const title = { sets: '新しいセット', media: '新しい媒体', ranks: '新しいランク', parts: '新しい共通パーツ' }[kind]
  const nextOrder = (list) => Math.max(0, ...list.map((x) => Number(x.order) || 0)) + 1

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      let payload
      if (kind === 'sets') payload = { entity: 'sets', data: { name, description, order: nextOrder(data.sets) } }
      else if (kind === 'ranks') payload = { entity: 'ranks', data: { name, order: nextOrder(data.ranks) } }
      else if (kind === 'parts') payload = { entity: 'parts', data: { name, content, description, order: nextOrder(data.parts || []) } }
      else {
        // 書類・告知画像の媒体は「本文」欄ひとつ（雛形の内容を写す欄）
        const fields = fileFormat ? [{ fieldKey: '本文', label: '内容' }] : MEDIA_PRESETS[preset].fields
        payload = { entity: 'media', data: { name, order: nextOrder(data.media), copyFormat: (!fileFormat && MEDIA_PRESETS[preset].copyFormat) || '通常' }, children: { fields: fields.map((f, i) => ({ countMode: '通常', splitRule: 'なし', limit: '', ...f, order: i + 1 })) } }
      }
      const { key } = await api.call('create', payload)
      await reload()
      notify(`${title.replace('新しい', '')}「${name}」を追加しました`)
      onCreated(key)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`${title}を作る`}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>キャンセル</Button>
          <Button icon={busy ? Spinner : Plus} onClick={save} disabled={busy || !name.trim()}>{kind === 'parts' ? '追加して差し込む' : '追加して選ぶ'}</Button>
        </>
      }
    >
      <div class="grid gap-4">
        <Label label={{ sets: 'セット名', media: '媒体名', ranks: 'ランク名', parts: 'パーツ名' }[kind]} required hint={kind === 'ranks' ? `登録後は変更できません。「${COMMON_RANK}」は使えません。` : kind === 'parts' ? '{{部品:パーツ名}} として差し込まれます。登録後は名前を変えられません。' : ''}>
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} class={inputCls} placeholder={{ sets: '例：Orbit利用開始セット', media: '例：告知画像', ranks: '例：プラチナ', parts: '例：署名ブロック' }[kind]} />
        </Label>
        {kind === 'parts' && (
          <>
            <Label label="内容" hint="{{団体名}} や {{署名}} などの差し込みも書けます。あとから直すと、このパーツを使うすべてのテンプレートに反映されます（管理者）。">
              <textarea value={content} onInput={(e) => setContent(e.currentTarget.value)} class={cx(inputCls, 'h-32 py-2')} aria-label="パーツの内容" />
            </Label>
            <Label label="説明">
              <input value={description} onInput={(e) => setDescription(e.currentTarget.value)} class={inputCls} />
            </Label>
          </>
        )}
        {kind === 'sets' && (
          <Label label="説明">
            <input value={description} onInput={(e) => setDescription(e.currentTarget.value)} class={inputCls} />
          </Label>
        )}
        {kind === 'media' &&
          (fileFormat ? (
            <p class="text-xs text-slate-500">書類・告知画像の媒体として作ります（雛形の内容を入れる欄がひとつ）。</p>
          ) : (
            <Label label="欄の構成" hint="出力画面の入力欄とコピーの単位です。細かい設定はあとで管理画面の「媒体」で変えられます（管理者）。">
              <select value={preset} onChange={(e) => setPreset(Number(e.currentTarget.value))} class={inputCls}>
                {MEDIA_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
              </select>
            </Label>
          ))}
        {error && <Alert tone="red">{error}</Alert>}
      </div>
    </Modal>
  )
}

// 自由記述を入れる：見出し（資料を作る画面の入力欄の名前）を決めて {{自由:見出し}} を差し込む
function FreeTextModal({ onClose, onInsert }) {
  const [label, setLabel] = useState('')
  const invalid = /[{}:\n]/.test(label)
  return (
    <Modal
      title="自由記述を入れる"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>キャンセル</Button>
          <Button icon={Plus} onClick={() => onInsert(label.trim())} disabled={invalid}>差し込む</Button>
        </>
      }
    >
      <div class="grid gap-3">
        <p class="text-sm text-slate-600">入力項目に登録しなくても、資料を作るときにこの場所の文章を書く欄が出ます。団体ごとに変えたい一文（ひとこと、特記事項など）に使います。</p>
        <Label label="見出し" hint="資料を作る画面で入力欄の名前になります。同じテンプレートに複数入れるときは見出しを変えてください。空欄なら「自由記述」。">
          <input value={label} onInput={(e) => setLabel(e.currentTarget.value)} class={inputCls} placeholder="例：先方へのひとこと" aria-label="自由記述の見出し" />
        </Label>
        {invalid && <p class="text-sm text-red-600">見出しに { } : や改行は使えません。</p>}
      </div>
    </Modal>
  )
}

// テンプレートの変更履歴。版を選ぶと、いま編集中の内容との差分を出し、編集画面に読み込める（保存は管理者）
const META_LABELS = [['name', 'テンプレ名'], ['setId', 'セット'], ['mediaId', '媒体'], ['rank', 'ランク'], ['format', '出力形式'], ['fileId', '雛形ファイルID']]

function RevisionsModal({ templateId, current, onClose, onRestore }) {
  const { api, data, notify } = useApp()
  const [revisions, setRevisions] = useState(null)
  const [selected, setSelected] = useState(0)
  useEffect(() => {
    api.call('listTemplateRevisions', { templateId }).then(setRevisions).catch((e) => {
      setRevisions([])
      notify(e.message, 'error')
    })
  }, [])
  const rev = revisions?.[selected]
  const t = rev?.template || {}
  const nameOf = (k, v) => (k === 'setId' ? data.sets : k === 'mediaId' ? data.media : null)?.find((x) => x.id === v)?.name || v
  const metaChanges = rev ? META_LABELS.filter(([k]) => String(t[k] ?? '') !== String(current[k] ?? '')) : []
  const fieldKeys = rev ? [...new Set([...Object.keys(t.fields || {}), ...Object.keys(current.fields || {})])] : []
  const changedFields = fieldKeys.filter((k) => (t.fields?.[k] ?? '') !== (current.fields?.[k] ?? ''))
  return (
    <Modal
      title="変更履歴"
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>閉じる</Button>
          <Button onClick={() => onRestore(t)} disabled={!rev || (!metaChanges.length && !changedFields.length)}>この版を編集画面に読み込む</Button>
        </>
      }
    >
      {revisions === null ? (
        <p class="flex items-center gap-2 py-8 text-sm text-slate-500"><Spinner /> 読み込み中…</p>
      ) : !revisions.length ? (
        <p class="py-8 text-sm text-slate-500">まだ変更履歴はありません。このテンプレートを保存すると、保存するたびの内容が残ります。</p>
      ) : (
        <div class="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
          <div class="max-h-[60vh] space-y-1 overflow-auto">
            {revisions.map((r, i) => (
              <button key={i} onClick={() => setSelected(i)} class={cx('w-full rounded-lg border px-3 py-2 text-left text-sm', i === selected ? 'border-[#3b8dd9] bg-[#eef7ff]' : 'border-[#e7edf5] hover:border-blue-200')}>
                <span class="block font-medium">{formatDateTime(r.at)}</span>
                <span class="block text-xs text-slate-500">{r.actor}{i === 0 && '（最新）'}</span>
              </button>
            ))}
          </div>
          <div class="min-w-0 space-y-4 text-sm">
            <p class="text-xs text-slate-500">
              <span class="mr-1 rounded bg-red-50 px-1 text-red-700">赤</span>がこの版にだけある行、<span class="mx-1 rounded bg-[#effcf6] px-1 text-[#17634f]">緑</span>がいま編集中の内容にだけある行です。
            </p>
            {!metaChanges.length && !changedFields.length && <Alert tone="green">いま編集中の内容と同じです。</Alert>}
            {metaChanges.length > 0 && (
              <div class="rounded-xl border border-[#edf1f7] p-3">
                {metaChanges.map(([k, label]) => (
                  <p key={k} class="text-xs">
                    <span class="font-bold text-slate-500">{label}</span>：
                    <span class="rounded bg-red-50 px-1 text-red-700">{nameOf(k, t[k]) || '（空）'}</span> →{' '}
                    <span class="rounded bg-[#effcf6] px-1 text-[#17634f]">{nameOf(k, current[k]) || '（空）'}</span>
                  </p>
                ))}
              </div>
            )}
            {changedFields.map((k) => (
              <div key={k}>
                <p class="text-xs font-bold text-slate-400">欄「{k}」</p>
                <pre class="mt-1 max-h-80 overflow-auto rounded-xl border border-[#edf1f7] bg-white p-2 font-mono text-xs leading-5 whitespace-pre-wrap">
                  {lineDiff(t.fields?.[k] ?? '', current.fields?.[k] ?? '').map((d, i) => (
                    <div key={i} class={cx('px-1', d.type === 'del' && 'bg-red-50 text-red-700', d.type === 'add' && 'bg-[#effcf6] text-[#17634f]', d.type === 'same' && 'text-slate-500')}>
                      {d.type === 'del' ? '− ' : d.type === 'add' ? '＋ ' : '　 '}{d.text || ' '}
                    </div>
                  ))}
                </pre>
              </div>
            ))}
            <p class="text-xs text-slate-400">「この版を編集画面に読み込む」を押しても、保存するまでは変わりません。書類・告知画像は雛形ファイルそのものは戻らないので、必要なら Google ドキュメント／スライドの「版の履歴」も戻してください。</p>
          </div>
        </div>
      )}
    </Modal>
  )
}
