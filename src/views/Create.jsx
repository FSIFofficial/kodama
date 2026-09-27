import { useEffect, useMemo, useState } from 'preact/hooks'
import { ArrowLeft, ArrowRight, Check, FileText, History as HistoryIcon, Plus, Search, Sparkles } from 'lucide-preact'
import { COMMON_RANK, LOGO_KEY, buildContext, fileReplacements, formItemsFor, generateOutputs, isFileTemplate, isImageTemplate, pickTemplates, renderSegments, splitXThread } from '../lib/engine.js'
import { Alert, Badge, Button, Eyebrow, ImageUpload, ItemInput, Label, Spinner, StoredImage, activeOnly, card, cx, downloadBase64, formatDateTime, inputCls, useApp } from '../ui/ui.jsx'
import { findSimilarOrgs } from '../lib/similar.js'
import { clearDraft, readAuthor, readDraft, saveAuthor, saveDraft } from '../lib/storage.js'
import { Output } from './Output.jsx'

const STEPS = ['団体', 'セット・ランク', '案件情報', '出力']
const TITLES = ['団体を選ぶ', 'セットとランクを選ぶ', '案件情報を入力', '生成結果']

// メールの宛先：入力値のうち、項目キーか表示名に「メール」を含み、メールアドレスの形をしたもの（団体の項目を優先）
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function recipientEmail(values, items) {
  const candidates = items
    .filter((i) => /メール|mail/i.test(`${i.key}${i.label || ''}`))
    .sort((a, b) => (a.category === '団体' ? 0 : 1) - (b.category === '団体' ? 0 : 1))
  for (const i of candidates) {
    const v = String(values[i.key] ?? '').trim()
    if (EMAIL_RE.test(v)) return v
  }
  return ''
}

// 団体の二重登録を防ぐ警告（登録は止めない）
export function SimilarOrgsAlert({ orgs }) {
  return (
    <Alert>
      似た名前の団体がすでに登録されています：
      {orgs.slice(0, 5).map((o) => `「${o.values['団体名']}」（${o.id}${o.active === false ? '・無効' : ''}）`).join('、')}
      {orgs.length > 5 && ` ほか${orgs.length - 5}件`}。同じ団体なら新しく追加せず、一覧から選んでください。
    </Alert>
  )
}

// 履歴出力の行 → { [mediaId]: { templateId, fields } }
function outputsFromRows(rows) {
  const out = {}
  for (const r of rows) {
    out[r.mediaId] ??= { templateId: r.templateId, fields: {} }
    out[r.mediaId].fields[r.fieldKey] = r.text
  }
  return out
}

export function Create({ seed }) {
  const { api, data, reload, notify, adminCall, loadHistory } = useApp()
  const firstSet = activeOnly(data.sets)[0]
  const firstRank = activeOnly(data.ranks)[0]
  const [step, setStep] = useState(1)
  const [orgId, setOrgId] = useState('')
  const [orgValues, setOrgValues] = useState({})
  const [caseValues, setCaseValues] = useState({})
  const [setId, setSetId] = useState(seed.setId || firstSet?.id || '')
  const [rank, setRank] = useState(firstRank?.name || '')
  const [mediaIds, setMediaIds] = useState(null)
  const [author, setAuthor] = useState(readAuthor())
  const [updateMaster, setUpdateMaster] = useState(false)
  const [outputs, setOutputs] = useState(null)
  const [original, setOriginal] = useState(null)
  const [editedBefore, setEditedBefore] = useState({})
  const [historyId, setHistoryId] = useState('')
  const [ownHistory, setOwnHistory] = useState(false)
  const [busy, setBusy] = useState(seed.historyId ? 'loading' : '')
  const [generation, setGeneration] = useState(0) // 生成し直したら出力画面を作り直す

  const itemsByKey = useMemo(() => Object.fromEntries(data.items.map((i) => [i.key, i])), [data.items])
  const org = data.orgs.find((o) => o.id === orgId)

  // 入力途中の自動保存。新しく作り始めたときに前回の下書きがあれば「続きから」を出す
  const [draft, setDraft] = useState(() => (seed.historyId || seed.rebuildFrom ? null : readDraft()))
  const restoreDraft = () => {
    const d = draft
    setDraft(null)
    const o = data.orgs.find((x) => x.id === d.orgId)
    if (!o) return notify('下書きの団体が見つかりません（無効化された可能性があります）', 'error')
    setOrgId(d.orgId)
    setOrgValues(d.orgValues || { ...o.values })
    setCaseValues(d.caseValues || {})
    if (d.setId && data.sets.some((x) => x.id === d.setId)) setSetId(d.setId)
    if (d.rank && data.ranks.some((x) => x.name === d.rank)) setRank(d.rank)
    setMediaIds(Array.isArray(d.mediaIds) ? d.mediaIds : null)
    setStep(Math.min(Math.max(Number(d.step) || 1, 1), 3))
  }
  const discardDraft = () => {
    clearDraft()
    setDraft(null)
  }
  useEffect(() => {
    // 下書きの確認中（STEP 1 のまま）は前回の下書きを残しておく。出力画面（STEP 4）は履歴に保存済み
    if ((draft && step === 1) || step > 3 || busy === 'loading' || !orgId) return
    const timer = setTimeout(() => saveDraft({ orgId, orgValues, caseValues, setId, rank, mediaIds, step, savedAt: new Date().toISOString() }), 400)
    return () => clearTimeout(timer)
  }, [orgId, orgValues, caseValues, setId, rank, mediaIds, step, draft, busy])

  // 履歴から開く（出力画面を再表示）／作り直す（入力画面へ）
  useEffect(() => {
    const id = seed.historyId || seed.rebuildFrom
    if (!id) return
    setBusy('loading')
    api
      .call('getHistory', { id })
      .then((h) => {
        const orgV = {}
        const caseV = {}
        for (const [k, v] of Object.entries(h.values || {})) (itemsByKey[k]?.category === '団体' ? orgV : caseV)[k] = v
        setOrgId(h.orgId)
        setOrgValues(orgV)
        setCaseValues(caseV)
        setSetId(h.setId)
        setRank(h.rank)
        setMediaIds([...new Set(h.outputs.map((o) => o.mediaId))])
        if (seed.historyId) {
          const outs = outputsFromRows(h.outputs)
          setOutputs(outs)
          setOriginal(JSON.parse(JSON.stringify(outs)))
          setEditedBefore(Object.fromEntries(h.outputs.map((o) => [`${o.mediaId}/${o.fieldKey}`, o.edited])))
          setHistoryId(h.id)
          setGeneration((g) => g + 1)
          setStep(4)
        } else {
          setStep(3)
        }
      })
      .catch((e) => notify(e.message, 'error'))
      .finally(() => setBusy(''))
  }, [])

  const picked = useMemo(() => pickTemplates(data.templates, setId, rank), [data.templates, setId, rank])
  const availableMedia = data.media.filter((m) => m.active !== false && picked[m.id])
  const selectedMedia = (mediaIds ?? availableMedia.map((m) => m.id)).filter((id) => picked[id])
  const form = useMemo(() => formItemsFor({ picked, mediaIds: selectedMedia, items: activeOnly(data.items), settings: data.settings, parts: data.parts }), [picked, selectedMedia.join(), data.items, data.settings, data.parts])

  const values = { ...orgValues, ...caseValues }
  // {{ロゴ}} は団体マスタのロゴ画像。文面のプレビューでは目印の文字にする
  const ctx = buildContext({ values: { ...values, [LOGO_KEY]: org?.logoFileId ? '［ロゴ画像］' : '' }, items: data.items, settings: data.settings, parts: data.parts })
  const missingRequired = [...form.orgItems, ...form.caseItems].filter((i) => i.required && !String(values[i.key] ?? '').trim())
  const orgChanged = org && form.orgItems.some((i) => (orgValues[i.key] ?? '') !== (org.values[i.key] ?? ''))

  const selectOrg = (o) => {
    setOrgId(o.id)
    setOrgValues({ ...o.values })
    setUpdateMaster(false)
  }

  // 案件項目の初期値を入れる（未入力のものだけ）
  const fillDefaults = () => {
    setCaseValues((cur) => {
      const next = { ...cur }
      for (const i of form.caseItems) if (next[i.key] === undefined && i.defaultValue !== '') next[i.key] = i.defaultValue
      return next
    })
  }

  const canNext = step === 1 ? Boolean(org) : step === 2 ? Boolean(setId && rank && selectedMedia.length) : !missingRequired.length && author.trim()

  const next = () => {
    if (step === 2) fillDefaults()
    setDraft(null) // 下書きを使わずに進めたら、新しい入力で上書きする
    setStep(step + 1)
  }

  const historyPayload = (outs, base, editedFlags) => ({
    history: { author: author.trim(), orgId, orgName: values['団体名'] || org?.values['団体名'] || '', setId, rank, values },
    outputs: Object.entries(outs).flatMap(([mediaId, o]) =>
      Object.entries(o.fields).map(([fieldKey, text]) => ({
        mediaId, templateId: o.templateId, fieldKey, text,
        edited: Boolean(editedFlags[`${mediaId}/${fieldKey}`]) || text !== (base?.[mediaId]?.fields[fieldKey] ?? text),
      })),
    ),
  })

  const generate = async () => {
    saveAuthor(author.trim())
    setBusy('generate')
    try {
      if (updateMaster && orgChanged) {
        const done = await adminCall('update', { entity: 'orgs', key: orgId, data: { values: orgValues } })
        if (done) {
          await reload()
          notify('団体マスタを更新しました')
        }
      }
      const outs = generateOutputs({ picked, mediaIds: selectedMedia, media: data.media, ctx })
      setOutputs(outs)
      setOriginal(JSON.parse(JSON.stringify(outs)))
      setEditedBefore({})
      setGeneration((g) => g + 1)
      setStep(4)
      // 生成したら履歴に自動保存。この画面で作った履歴なら上書き、履歴から作り直した場合は新規
      const payload = historyPayload(outs, outs, {})
      if (ownHistory) payload.history.id = historyId
      const saved = await api.call('saveHistory', payload)
      setHistoryId(saved.id)
      setOwnHistory(true)
      clearDraft()
      notify('履歴に保存しました')
      loadHistory().catch(() => {})
    } catch (e) {
      notify(`履歴の保存に失敗しました：${e.message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  const saveEdits = async (outs) => {
    setBusy('save')
    try {
      const payload = historyPayload(outs, original, editedBefore)
      payload.history.id = historyId || undefined
      const saved = await api.call('saveHistory', payload)
      setHistoryId(saved.id)
      setOriginal(JSON.parse(JSON.stringify(outs)))
      setEditedBefore(Object.fromEntries(payload.outputs.map((o) => [`${o.mediaId}/${o.fieldKey}`, o.edited])))
      notify('修正した文面で履歴を上書きしました')
      loadHistory().catch(() => {})
      return true
    } catch (e) {
      notify(e.message, 'error')
      return false
    } finally {
      setBusy('')
    }
  }

  // 書類・告知画像：雛形の差し込みを画面側で解決して GAS に渡し、書き出したファイルを受け取る。
  // 書類はそのままダウンロードし、告知画像は画面で確認できるように画像の一覧を返す
  const renderFile = async (mediaId, format) => {
    const t = data.templates.find((x) => x.id === outputs[mediaId]?.templateId)
    if (!t) return notify('テンプレートが見つかりません', 'error')
    const orgName = values['団体名'] || org?.values['団体名'] || ''
    const image = isImageTemplate(t)
    try {
      const { replacements, images } = fileReplacements(t.fields['本文'] ?? '', ctx, { logoFileId: org?.logoFileId, withImages: image })
      const res = await api.call('renderDocument', { templateId: t.id, format, replacements, images, fileName: [t.name, orgName].filter(Boolean).join('_') })
      if (image) {
        notify('告知画像を作成しました')
        return res.images
      }
      downloadBase64(res)
      notify(`${format}を出力しました`)
    } catch (e) {
      notify(e.message, 'error')
    }
  }

  if (busy === 'loading') {
    return (
      <div class="flex items-center justify-center gap-2 py-32 text-sm text-slate-500">
        <Spinner /> 履歴を読み込んでいます…
      </div>
    )
  }

  return (
    <section>
      {step < 4 && (
        <>
          <div class="mb-8 flex items-center justify-between">
            <div>
              <Eyebrow>NEW BROADCAST / STEP {step} OF 4</Eyebrow>
              <h1 class="mt-2 text-2xl font-bold">{TITLES[step - 1]}</h1>
            </div>
          </div>
          <Stepper step={step} />
          {draft && step === 1 && <DraftBanner draft={draft} onRestore={restoreDraft} onDiscard={discardDraft} />}
        </>
      )}

      {step === 1 && <StepOrg orgId={orgId} onSelect={selectOrg} />}
      {step === 2 && (
        <StepSet
          setId={setId}
          rank={rank}
          picked={picked}
          availableMedia={availableMedia}
          selected={selectedMedia}
          onSet={(id) => {
            setSetId(id)
            setMediaIds(null)
          }}
          onRank={(r) => {
            setRank(r)
            setMediaIds(null)
          }}
          onToggle={(id, on) => setMediaIds(on ? [...selectedMedia, id] : selectedMedia.filter((m) => m !== id))}
        />
      )}
      {step === 3 && (
        <StepDetails
          form={form}
          values={values}
          org={org}
          orgValues={orgValues}
          setOrgValues={setOrgValues}
          caseValues={caseValues}
          setCaseValues={setCaseValues}
          orgChanged={orgChanged}
          updateMaster={updateMaster}
          setUpdateMaster={setUpdateMaster}
          author={author}
          setAuthor={setAuthor}
          missingRequired={missingRequired}
          picked={picked}
          mediaIds={selectedMedia}
          ctx={ctx}
        />
      )}
      {step === 4 && outputs && (
        <Output
          key={generation}
          outputs={outputs}
          original={original}
          mediaIds={Object.keys(outputs)}
          meta={{ orgName: values['団体名'] || org?.values['団体名'], setName: data.sets.find((s) => s.id === setId)?.name, rank, historyId, author, mailTo: recipientEmail(values, data.items) }}
          saving={busy === 'save' || busy === 'generate'}
          onSave={saveEdits}
          onBack={() => setStep(3)}
          onChange={setOutputs}
          onDownload={renderFile}
        />
      )}

      {step < 4 && (
        <div class="mt-8 flex justify-between">
          <Button variant="outline" icon={ArrowLeft} onClick={() => setStep(Math.max(1, step - 1))} disabled={step === 1}>戻る</Button>
          {step < 3 ? (
            <Button iconEnd={ArrowRight} onClick={next} disabled={!canNext}>次へ</Button>
          ) : (
            <Button icon={busy === 'generate' ? Spinner : Sparkles} onClick={generate} disabled={!canNext || Boolean(busy)}>文面を生成</Button>
          )}
        </div>
      )}
    </section>
  )
}

function DraftBanner({ draft, onRestore, onDiscard }) {
  const { data } = useApp()
  const org = data.orgs.find((o) => o.id === draft.orgId)
  const name = draft.orgValues?.['団体名'] || org?.values['団体名'] || draft.orgId
  const setName = data.sets.find((s) => s.id === draft.setId)?.name
  return (
    <div class="mb-6 flex flex-col gap-3 rounded-2xl border border-[#bcd8f5] bg-[#eef7ff] p-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-start gap-3">
        <HistoryIcon class="mt-0.5 size-5 shrink-0 text-[#1261af]" />
        <div class="text-sm">
          <p class="font-bold text-[#12233f]">入力途中の資料があります</p>
          <p class="mt-0.5 text-slate-600">
            {[name, setName, draft.rank, `STEP ${draft.step}`].filter(Boolean).join(' · ')}
            {draft.savedAt && <span class="ml-2 text-xs text-slate-400">{formatDateTime(draft.savedAt)} に自動保存</span>}
          </p>
        </div>
      </div>
      <div class="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" onClick={onDiscard}>破棄する</Button>
        <Button size="sm" onClick={onRestore}>続きから</Button>
      </div>
    </div>
  )
}

function Stepper({ step }) {
  return (
    <div class="mb-8 flex gap-2">
      {STEPS.map((label, i) => (
        <div key={label} class="flex flex-1 items-center gap-2">
          <div class={cx('flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold', step > i ? 'bg-[#1261af] text-white' : 'bg-white text-slate-400 ring-1 ring-[#dce5f2]')}>
            {step > i + 1 ? <Check class="size-4" /> : i + 1}
          </div>
          <span class="hidden text-xs font-medium text-slate-500 sm:block">{label}</span>
          {i < STEPS.length - 1 && <div class="h-px flex-1 bg-[#dce5f2]" />}
        </div>
      ))}
    </div>
  )
}

// ---------- STEP 1 団体 ----------

function StepOrg({ orgId, onSelect }) {
  const { data } = useApp()
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const orgs = activeOnly(data.orgs).filter((o) => Object.values(o.values).some((v) => String(v).includes(query)))
  return (
    <div class="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div class={`${card} p-5`}>
        <div class="flex items-center justify-between gap-3">
          <h2 class="font-bold">登録済みの団体</h2>
          <Button variant="outline" size="sm" icon={Plus} onClick={() => setAdding(!adding)}>新規団体を追加</Button>
        </div>
        <div class="relative mt-5">
          <Search class="absolute top-3 left-3 size-4 text-slate-400" />
          <input value={query} onInput={(e) => setQuery(e.currentTarget.value)} placeholder="団体名などで検索" class="h-10 w-full rounded-lg border border-[#dce5f2] pl-9 text-sm outline-none focus:ring-2 focus:ring-blue-200" />
        </div>
        <div class="mt-4 grid gap-2">
          {orgs.map((o) => (
            <button key={o.id} onClick={() => onSelect(o)} class={cx('rounded-xl border p-4 text-left transition', orgId === o.id ? 'border-[#3b8dd9] bg-[#eef7ff]' : 'border-[#e7edf5] hover:border-blue-200')}>
              <p class="font-semibold">{o.values['団体名'] || '（団体名なし）'}</p>
              <p class="mt-1 text-xs text-slate-500">{[o.id, o.values['団体区分']].filter(Boolean).join(' · ')}</p>
            </button>
          ))}
          {!orgs.length && <p class="py-6 text-center text-sm text-slate-500">該当する団体がありません。「新規団体を追加」から登録できます。</p>}
        </div>
      </div>
      {adding ? (
        <OrgForm
          onSaved={(o) => {
            setAdding(false)
            onSelect(o)
          }}
        />
      ) : (
        <div class="h-fit rounded-2xl bg-[#102c56] p-6 text-white">
          <FileText class="size-7 text-blue-200" />
          <h3 class="mt-6 font-bold">団体マスタ</h3>
          <p class="mt-2 text-sm leading-6 text-blue-100">登録した団体情報は管理用スプレッドシートに保存され、次回から誰でも呼び出せます。登録済みの情報を直す場合は管理画面から（管理者のみ）。</p>
        </div>
      )}
    </div>
  )
}

export function OrgForm({ onSaved }) {
  const { api, data, reload, notify } = useApp()
  const orgItems = activeOnly(data.items).filter((i) => i.category === '団体')
  const [values, setValues] = useState(() => Object.fromEntries(orgItems.map((i) => [i.key, i.defaultValue || ''])))
  const [logoFileId, setLogoFileId] = useState('')
  const [busy, setBusy] = useState(false)
  const missing = orgItems.filter((i) => (i.required || i.key === '団体名') && !String(values[i.key] || '').trim())
  const similar = findSimilarOrgs(values['団体名'], data.orgs)
  const save = async () => {
    setBusy(true)
    try {
      const { key } = await api.call('create', { entity: 'orgs', data: { values, logoFileId } })
      const d = await reload()
      notify('団体を追加しました')
      onSaved(d.orgs.find((o) => o.id === key))
    } catch (e) {
      notify(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class={`${card} h-fit p-5`}>
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 class="font-bold">新規団体を追加</h2>
          <p class="mt-1 text-xs leading-5 text-slate-500">団体マスタに登録され、発信物の共通情報として再利用できます。</p>
        </div>
        <Badge>共通情報</Badge>
      </div>
      <div class="mt-5 grid gap-3">
        {orgItems.map((i) => (
          <Label key={i.key} label={i.label || i.key} required={i.required || i.key === '団体名'}>
            <ItemInput item={i} value={values[i.key]} onInput={(v) => setValues({ ...values, [i.key]: v })} />
          </Label>
        ))}
        <Label label="ロゴ画像" hint="告知画像の {{ロゴ}} に入ります（PNG・JPEG・GIF、5MBまで）">
          <ImageUpload value={logoFileId} onChange={setLogoFileId} />
        </Label>
        {similar.length > 0 && <SimilarOrgsAlert orgs={similar} />}
        <Button class="mt-2" onClick={save} disabled={busy || missing.length > 0}>{busy && <Spinner />}保存</Button>
      </div>
    </div>
  )
}

// ---------- STEP 2 セット・ランク ----------

function StepSet({ setId, rank, picked, availableMedia, selected, onSet, onRank, onToggle }) {
  const { data } = useApp()
  return (
    <div class="grid gap-6 md:grid-cols-2">
      <div class={`${card} p-6`}>
        <h2 class="font-bold">セット</h2>
        <div class="mt-4 grid gap-3">
          {activeOnly(data.sets).map((s) => (
            <label key={s.id} class={cx('flex cursor-pointer items-start gap-3 rounded-xl border p-4', setId === s.id ? 'border-[#3b8dd9] bg-[#eef7ff]' : 'border-[#e7edf5]')}>
              <input type="radio" class="mt-1 accent-[#1261af]" checked={setId === s.id} onChange={() => onSet(s.id)} />
              <span>
                <span class="block font-medium">{s.name}</span>
                {s.description && <span class="mt-1 block text-xs text-slate-500">{s.description}</span>}
              </span>
            </label>
          ))}
        </div>
        <Label label="ランク" class="mt-6">
          <select value={rank} onChange={(e) => onRank(e.currentTarget.value)} class={inputCls}>
            {activeOnly(data.ranks).map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
          </select>
        </Label>
      </div>
      <div class={`${card} p-6`}>
        <h2 class="font-bold">作成する媒体 <span class="text-sm font-normal text-slate-400">（不要なものは外せます）</span></h2>
        <div class="mt-4 grid gap-2">
          {availableMedia.map((m) => {
            const t = picked[m.id]
            return (
              <label key={m.id} class="flex cursor-pointer items-center gap-3 rounded-xl border border-[#e7edf5] p-3 text-sm hover:border-blue-200">
                <input type="checkbox" checked={selected.includes(m.id)} onChange={(e) => onToggle(m.id, e.currentTarget.checked)} class="size-4 accent-[#1261af]" />
                <span class="flex-1">
                  <span class="block font-medium">{m.name}</span>
                  <span class="block text-xs text-slate-500">{t.name}</span>
                </span>
                {isFileTemplate(t) && <Badge tone="green">{t.format}</Badge>}
                <Badge tone={t.rank === COMMON_RANK ? 'gray' : 'blue'}>{t.rank === COMMON_RANK ? '共通' : `${t.rank}専用`}</Badge>
              </label>
            )
          })}
          {!availableMedia.length && <p class="py-6 text-center text-sm text-slate-500">このセットとランクで使えるテンプレートがありません。管理画面から追加してください。</p>}
        </div>
      </div>
    </div>
  )
}

// ---------- STEP 3 案件情報 ----------

function StepDetails({ form, values, org, orgValues, setOrgValues, caseValues, setCaseValues, orgChanged, updateMaster, setUpdateMaster, author, setAuthor, missingRequired, picked, mediaIds, ctx }) {
  const { isAdmin } = useApp()
  return (
    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(380px,0.95fr)]">
      <div class="space-y-6">
        <div class={`${card} p-6`}>
          <Label label="作成者名" required hint="記録用です。このブラウザに記憶され、次回から自動で入ります。">
            <input value={author} onInput={(e) => setAuthor(e.currentTarget.value)} class={cx(inputCls, 'max-w-xs')} />
          </Label>
        </div>

        {form.orgItems.length > 0 && (
          <div class={`${card} p-6`}>
            <div class="flex items-start justify-between gap-3">
              <div>
                <h2 class="font-bold">団体情報</h2>
                <p class="mt-1 text-xs text-slate-500">団体マスタから自動入力しています。ここでの修正は今回の資料だけに反映されます。</p>
              </div>
              <Badge>{org?.id}</Badge>
            </div>
            <div class="mt-5 grid gap-4 md:grid-cols-2">
              {form.orgItems.map((i) => (
                <Label key={i.key} label={i.label || i.key} required={i.required} class={i.type === '長文' ? 'md:col-span-2' : ''}>
                  <ItemInput item={i} value={orgValues[i.key]} onInput={(v) => setOrgValues({ ...orgValues, [i.key]: v })} />
                </Label>
              ))}
            </div>
            {form.usesLogo && (
              <div class="mt-5 flex items-center gap-3 rounded-xl bg-[#f6f8fc] p-3 text-sm">
                {org?.logoFileId ? (
                  <>
                    <StoredImage fileId={org.logoFileId} class="size-12" />
                    <span>告知画像にはこのロゴが入ります。</span>
                  </>
                ) : (
                  <span class="text-amber-800">この団体はロゴ画像が未登録です。告知画像のロゴの位置は空になります（管理画面の団体マスタで登録できます）。</span>
                )}
              </div>
            )}
            {orgChanged && (
              <label class="mt-5 flex items-center gap-2 rounded-xl bg-[#f6f8fc] p-3 text-sm">
                <input type="checkbox" class="size-4 accent-[#1261af]" checked={updateMaster} onChange={(e) => setUpdateMaster(e.currentTarget.checked)} />
                <span>
                  修正内容を団体マスタにも反映する
                  <span class="ml-1 text-xs text-slate-500">（管理者のみ。{isAdmin ? '管理者として認証済み' : '生成時にパスワードを確認します'}）</span>
                </span>
              </label>
            )}
          </div>
        )}

        <div class={`${card} p-6`}>
          <h2 class="font-bold">案件情報</h2>
          <p class="mt-1 text-xs text-slate-500">選んだテンプレートで使われている項目だけを表示しています。</p>
          <div class="mt-5 grid gap-4 md:grid-cols-2">
            {form.caseItems.map((i) => (
              <Label key={i.key} label={i.label || i.key} required={i.required} class={i.type === '長文' ? 'md:col-span-2' : ''}>
                <ItemInput item={i} value={caseValues[i.key]} onInput={(v) => setCaseValues({ ...caseValues, [i.key]: v })} />
              </Label>
            ))}
            {!form.caseItems.length && !form.freeItems.length && <p class="text-sm text-slate-500">入力が必要な案件項目はありません。</p>}
          </div>
          {form.freeItems.length > 0 && (
            <div class="mt-6 border-t border-[#edf1f7] pt-5">
              <p class="text-sm font-semibold">自由記述</p>
              <p class="mt-1 text-xs text-slate-500">テンプレートの「自由記述」の場所に、この資料だけの文章を書きます。空欄なら、その行は出力されません。</p>
              <div class="mt-3 grid gap-4">
                {form.freeItems.map((i) => (
                  <Label key={i.key} label={i.label}>
                    <ItemInput item={i} value={caseValues[i.key]} onInput={(v) => setCaseValues({ ...caseValues, [i.key]: v })} />
                  </Label>
                ))}
              </div>
            </div>
          )}
          {form.settingKeys.length > 0 && <p class="mt-5 text-xs text-slate-400">共通設定から自動で入る項目：{form.settingKeys.join('、')}</p>}
        </div>

        {form.unknownParts.length > 0 && (
          <Alert>テンプレートで使っている共通パーツが登録されていません（空欄で出力されます）：{form.unknownParts.join('、')}。管理画面の「共通パーツ」で登録してください。</Alert>
        )}
        {form.unknownKeys.length > 0 && (
          <Alert>テンプレートに未登録の項目があります（空欄で出力されます）：{form.unknownKeys.join('、')}。管理画面の「入力項目」で登録してください。</Alert>
        )}
        {missingRequired.length > 0 && <Alert tone="blue">必須項目が未入力です：{missingRequired.map((i) => i.label || i.key).join('、')}</Alert>}
      </div>

      <Preview picked={picked} mediaIds={mediaIds} ctx={ctx} />
    </div>
  )
}

// 右側のリアルタイムプレビュー。差し込んだ値を緑、未入力を黄色で示す
function Preview({ picked, mediaIds, ctx }) {
  const { data } = useApp()
  const [active, setActive] = useState(mediaIds[0])
  const current = mediaIds.includes(active) ? active : mediaIds[0]
  const media = data.media.find((m) => m.id === current)
  const template = picked[current]
  if (!media || !template) return null
  const fieldDefs = media.fields.length ? media.fields : Object.keys(template.fields).map((k) => ({ fieldKey: k, label: k }))
  return (
    <div class="h-fit self-start rounded-2xl border border-[#9bdcc5] bg-[#f0fff9] p-5 shadow-sm lg:sticky lg:top-6">
      <div class="flex items-center justify-between border-b border-[#cdeee1] pb-4">
        <div>
          <p class="text-xs font-bold tracking-[0.18em] text-[#16866b]">PREVIEW</p>
          <h2 class="mt-1 font-bold text-[#17483e]">入力内容を反映した文面</h2>
        </div>
        <span class="flex items-center gap-2 text-xs text-[#31816f]">
          <span class="size-2 rounded-full bg-[#42c99e]" />入力内容
        </span>
      </div>
      <div class="mt-3 flex flex-wrap gap-1">
        {mediaIds.map((id) => (
          <button key={id} onClick={() => setActive(id)} class={cx('rounded-lg px-3 py-1.5 text-xs font-semibold', id === current ? 'bg-white text-[#08745a] shadow-sm' : 'text-[#31816f] hover:bg-white/60')}>
            {data.media.find((m) => m.id === id)?.name}
          </button>
        ))}
      </div>
      <div class="mt-3 max-h-[640px] space-y-4 overflow-auto rounded-xl border border-[#b7e8d7] bg-white p-5 text-sm leading-7 text-slate-700">
        {fieldDefs.map((f) => {
          const segments = renderSegments(template.fields[f.fieldKey] ?? '', ctx)
          if (f.splitRule === 'スレッド分割') {
            const posts = splitXThread(segments.map((s) => (s.missing ? '' : s.text)).join(''), { limit: Number(f.limit) || undefined })
            return (
              <div key={f.fieldKey}>
                <p class="text-xs font-bold text-slate-400">{f.label}（{posts.length}投稿）</p>
                <div class="mt-1 whitespace-pre-wrap"><Segments segments={segments} /></div>
              </div>
            )
          }
          return (
            <div key={f.fieldKey}>
              <p class="text-xs font-bold text-slate-400">{f.label}</p>
              <div class="mt-1 whitespace-pre-wrap"><Segments segments={segments} /></div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function Segments({ segments }) {
  return segments.map((s, i) =>
    s.missing ? (
      <mark key={i} class="rounded bg-amber-100 px-0.5 text-amber-800">{s.text}</mark>
    ) : s.key ? (
      <mark key={i} class="bg-transparent font-bold text-[#08745a] underline decoration-[#42c99e] decoration-2 underline-offset-4">{s.text}</mark>
    ) : (
      <span key={i}>{s.text}</span>
    ),
  )
}
