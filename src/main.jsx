import { render } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { BookOpen, Check, History as HistoryIcon, Home as HomeIcon, LogOut, Plus, RefreshCw, Settings, ShieldCheck, X } from 'lucide-preact'
import { checkInitData, createApi } from './lib/api.js'
import { createGoogleAuth } from './lib/google-auth.js'
import { resetMockData } from './lib/mock-backend.js'
import { AppContext, Alert, Button, Spinner, cx } from './ui/ui.jsx'
import { Home } from './views/Home.jsx'
import { Create } from './views/Create.jsx'
import { HistoryView } from './views/History.jsx'
import { Admin } from './views/Admin.jsx'
import { Usage } from './views/Guide.jsx'

const config = window.APP_CONFIG || { mock: true }

// ログイン（Google。モックモードでは利用者・管理者を選ぶ）。トークンが変わったら App に知らせる
let onTokenChange = () => {}
const auth = createGoogleAuth({ clientId: config.googleClientId, mock: Boolean(config.mock), onChange: (t) => onTokenChange(t) })
const api = createApi(config, { getIdToken: () => auth.token, onAuthError: () => auth.expire() })

function App() {
  const [token, setToken] = useState(auth.token)
  // ログインしている人 { email, name, role }。権限は GAS が Access Manager に問い合わせて決める
  const [me, setMe] = useState(null)
  const [authError, setAuthError] = useState('')
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [view, setView] = useState('home')
  const [seed, setSeed] = useState({ id: 0 })
  const [toast, setToast] = useState(null)
  const [history, setHistory] = useState(null)
  const toastTimer = useRef(null)
  const isAdmin = me?.role === 'admin'

  useEffect(() => {
    onTokenChange = setToken
    auth.start().catch((e) => setAuthError(e.message))
  }, [])

  const notify = useCallback((message, tone = 'ok') => {
    clearTimeout(toastTimer.current)
    setToast({ message, tone })
    toastTimer.current = setTimeout(() => setToast(null), tone === 'error' ? 6000 : 2500)
  }, [])

  // 読み込みが重なったとき、遅れて返ってきた古い応答で新しいデータを上書きしないよう、最後に始めた読み込みだけを反映する
  const dataSeq = useRef(0)
  const historySeq = useRef(0)

  const reload = useCallback(async () => {
    const n = ++dataSeq.current
    const d = checkInitData(await api.call('init'))
    if (n === dataSeq.current) setData(d)
    return d
  }, [])

  const loadHistory = useCallback(async () => {
    const n = ++historySeq.current
    const res = await api.call('listHistory')
    const list = Array.isArray(res) ? res : []
    if (n === historySeq.current) setHistory(list)
    return list
  }, [])

  // ログインしたら、だれか（権限）を確かめてからデータを読む。ログアウト・失効したら画面のデータも消す
  useEffect(() => {
    if (!token) {
      // ログアウト・失効したら、次にログインする人のためにホームに戻す
      setMe(null)
      setData(null)
      setHistory(null)
      setView('home')
      return
    }
    let alive = true
    setAuthError('')
    setLoadError('')
    api
      .whoami()
      .then((who) => {
        if (!alive) return
        setMe(who)
        reload().catch((e) => setLoadError(e.message))
        loadHistory().catch(() => setHistory([]))
      })
      .catch((e) => {
        if (!alive) return
        setAuthError(e.message)
        // 使えないアカウントなら、別のアカウントでログインし直せるようにする
        if (e.code === 'NOT_ALLOWED') auth.signOut()
      })
    return () => {
      alive = false
    }
  }, [token])

  // 管理者でなければ知らせて止める（権限は Access Manager で付ける）
  const requireAdmin = useCallback(() => {
    if (isAdmin) return Promise.resolve(true)
    notify('この操作には kodama の「管理者」の権限が必要です（FSIF の Access Manager で付けてもらってください）', 'error')
    return Promise.resolve(false)
  }, [isAdmin])

  // 管理者操作の共通処理
  const adminCall = useCallback(
    async (action, payload) => {
      if (!(await requireAdmin())) return null
      return api.call(action, payload)
    },
    [requireAdmin],
  )

  // スプレッドシートの内容を読み込み直して最新にする（ページの再読み込みは不要）。
  // ボタンから押したときは結果を知らせ、ページ移動やタブに戻ったときは裏で静かに行う
  const [refreshing, setRefreshing] = useState(false)
  const lastRefresh = useRef(Date.now())
  const refresh = useCallback(async ({ quiet = false } = {}) => {
    setRefreshing(true)
    lastRefresh.current = Date.now()
    try {
      await Promise.all([reload(), loadHistory()])
      if (!quiet) notify('最新のデータに更新しました')
    } catch (e) {
      if (!quiet) notify(e.message, 'error')
    } finally {
      setRefreshing(false)
    }
  }, [])

  // ページ移動のたびに裏で最新にする
  const go = (next) => {
    setView(next)
    refresh({ quiet: true })
  }

  // スプレッドシートなど別のタブから戻ってきたときも最新にする（30秒以内に更新済みなら省略）
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && data && Date.now() - lastRefresh.current > 30000) refresh({ quiet: true })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [data])

  const startCreate = (preset = {}) => {
    setSeed({ ...preset, id: Date.now() })
    go('create')
  }

  const ctx = { api, me, data, reload, notify, requireAdmin, adminCall, isAdmin, history, loadHistory, setHistory, startCreate, setView: go, refreshing }

  if (!token || !me) return <LoginScreen error={authError} checking={Boolean(token) && !authError} />

  const nav = [
    ['home', 'ホーム', HomeIcon, () => go('home')],
    ['create', '新規作成', Plus, () => startCreate()],
    ['history', '履歴', HistoryIcon, () => go('history')],
    ['admin', '管理', Settings, () => go('admin')],
    ['guide', '使い方', BookOpen, () => go('guide')],
  ]

  return (
    <AppContext.Provider value={ctx}>
      <div class="min-h-screen bg-[#f6f8fc] text-[#12233f]">
        <header class="border-b border-[#dce5f2] bg-white">
          <div class="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-5 py-4 lg:px-10">
            <button onClick={() => go('home')} class="flex items-center gap-3 text-left">
              <span class="flex size-9 items-center justify-center rounded-xl bg-[#102c56] text-base font-bold text-white">k</span>
              <span>
                <span class="block text-[17px] font-bold tracking-tight">kodama</span>
                <span class="hidden text-xs text-slate-500 sm:block">FSIF｜発信物ジェネレーター</span>
              </span>
            </button>
            <div class="flex items-center gap-2">
              {data && (
                <button
                  onClick={() => refresh()}
                  disabled={refreshing}
                  title="スプレッドシートから最新のデータを読み込み直します"
                  aria-label="最新に更新"
                  class="flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium text-slate-500 hover:bg-[#f3f6fb] hover:text-slate-700 disabled:opacity-60"
                >
                  <RefreshCw class={cx('size-4', refreshing && 'animate-spin')} />
                  <span class="hidden md:inline">{refreshing ? '更新中…' : '最新に更新'}</span>
                </button>
              )}
              <span class="hidden items-center gap-1.5 text-xs text-slate-500 lg:flex" title={me.email}>
                <span class="max-w-40 truncate font-medium text-slate-700">{me.name}</span>
                {isAdmin ? (
                  <span class="flex items-center gap-1 rounded-full bg-[#effcf6] px-2 py-0.5 font-bold text-[#17634f]">
                    <ShieldCheck class="size-3.5" />
                    管理者
                  </span>
                ) : (
                  <span class="rounded-full bg-[#f3f6fb] px-2 py-0.5">利用者</span>
                )}
              </span>
              <button
                onClick={() => auth.signOut()}
                title="ログアウト"
                aria-label="ログアウト"
                class="flex items-center gap-1 rounded-xl px-2 py-2 text-sm text-slate-500 hover:bg-[#f3f6fb] hover:text-slate-700"
              >
                <LogOut class="size-4" />
              </button>
              <nav class="flex items-center gap-1 rounded-xl bg-[#f3f6fb] p-1 text-sm font-medium">
                {nav.map(([key, label, Icon, onClick]) => (
                  <button key={key} onClick={onClick} aria-label={label} class={cx('flex items-center gap-1 rounded-lg px-3 py-2', view === key ? 'bg-white text-[#1261af] shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
                    <Icon class="size-4" />
                    <span class="hidden sm:inline">{label}</span>
                  </button>
                ))}
              </nav>
            </div>
          </div>
        </header>

        <main class="mx-auto max-w-[1440px] px-5 py-8 lg:px-10">
          {loadError ? (
            <div class="mx-auto max-w-xl py-16">
              <Alert tone="red">
                <p class="font-bold">データを読み込めませんでした</p>
                <p class="mt-1">{loadError}</p>
              </Alert>
              <Button class="mt-4" onClick={() => location.reload()}>再読み込み</Button>
            </div>
          ) : !data ? (
            <div class="flex flex-col items-center justify-center gap-3 py-32 text-slate-500">
              <Spinner class="size-6 text-[#1261af]" />
              <p class="text-sm">データを読み込んでいます…</p>
              <p class="text-xs text-slate-400">しばらく使われていないと、最初の読み込みに数秒かかることがあります</p>
            </div>
          ) : (
            <>
              {view === 'home' && <Home />}
              {view === 'create' && <Create key={seed.id} seed={seed} />}
              {view === 'history' && <HistoryView />}
              {view === 'admin' && <Admin />}
              {view === 'guide' && <Usage />}
            </>
          )}
        </main>

        <footer class="mx-auto flex max-w-[1440px] flex-wrap items-center gap-3 px-5 pb-8 text-xs text-slate-400 lg:px-10">
          {api.mock ? (
            <>
              <span>モックモード｜データはこのブラウザにのみ保存されます</span>
              <button
                class="underline"
                onClick={() => {
                  if (confirm('モックデータを初期状態に戻しますか？')) {
                    resetMockData()
                    location.reload()
                  }
                }}
              >
                モックデータを初期化
              </button>
            </>
          ) : (
            <span>データは管理用スプレッドシートに保存されます。使える人と管理者は FSIF の Access Manager で決まります。</span>
          )}
        </footer>

        {toast && (
          <div class={cx('fixed bottom-5 left-1/2 z-50 flex max-w-[90vw] -translate-x-1/2 items-center gap-2 rounded-full px-5 py-3 text-sm font-medium text-white shadow-xl', toast.tone === 'error' ? 'bg-red-700' : 'bg-[#102c56]')}>
            {toast.tone === 'error' ? <X class="size-4" /> : <Check class="size-4" />}
            {toast.message}
            <button onClick={() => setToast(null)} aria-label="閉じる">
              <X class="size-4" />
            </button>
          </div>
        )}

      </div>
    </AppContext.Provider>
  )
}

/** ログイン画面（Google でログイン。モックモードでは利用者・管理者を選ぶ） */
function LoginScreen({ error, checking }) {
  const buttonRef = useRef(null)
  useEffect(() => {
    if (buttonRef.current) auth.mountButton(buttonRef.current)
  }, [checking, error])
  return (
    <div class="flex min-h-screen items-center justify-center bg-[#f6f8fc] px-5 text-[#12233f]">
      <div class="w-full max-w-sm rounded-2xl border border-[#dce5f2] bg-white p-7 shadow-sm">
        <div class="flex items-center gap-3">
          <span class="flex size-10 items-center justify-center rounded-xl bg-[#102c56] text-lg font-bold text-white">k</span>
          <span>
            <span class="block text-lg font-bold tracking-tight">kodama</span>
            <span class="block text-xs text-slate-500">FSIF｜発信物ジェネレーター</span>
          </span>
        </div>
        <p class="mt-6 text-sm leading-relaxed text-slate-600">FSIF Portal と同じ Google アカウントでログインしてください。使える人と管理者は FSIF の Access Manager で決まります。</p>
        {error && (
          <div class="mt-4">
            <Alert tone="red">{error}</Alert>
          </div>
        )}
        <div class="mt-6">
          {checking ? (
            <p class="flex items-center gap-2 text-sm text-slate-500">
              <Spinner class="size-4 text-[#1261af]" />
              確認しています…
            </p>
          ) : config.mock ? (
            <div class="flex flex-col gap-2">
              <p class="text-xs text-slate-500">モックモード：Google の代わりに、使う権限を選びます</p>
              <Button onClick={() => auth.mockSignIn('user')}>利用者としてはじめる</Button>
              <Button variant="outline" onClick={() => auth.mockSignIn('admin')}>
                管理者としてはじめる
              </Button>
            </div>
          ) : (
            <div ref={buttonRef} class="flex min-h-11 justify-center" aria-label="Google でログイン" />
          )}
        </div>
      </div>
    </div>
  )
}

render(<App />, document.getElementById('app'))
