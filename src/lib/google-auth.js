// ログイン。Google でログインする（またはポータルから引き継ぐ）と、GAS が7日もつセッションを出す。
// - セッションはこのブラウザの localStorage に置く（タブを閉じても、別のタブでもログインしたまま）
// - ポータルの「開く」から来たときは、URL の #fsif_ticket=…（引換券）でログインする（Google の画面は出ない）
// - 使えるかどうか・管理者かは、GAS が毎回 FSIF の Access Manager に確かめる（役割を外せば最大5分で使えなくなる）
// - ログアウトしたら自動ログインを止める（disableAutoSelect）。ポータルのログアウトとは別
// 古い GAS（startSession が無い）のときは、以前と同じく Google の ID トークン（約1時間）をそのまま使う。
// モックモードでは Google を使わず、'mock:admin' / 'mock:user' を ID トークンの代わりにする。

const STORAGE_KEY = 'kodama-session'
const TICKET_PARAM = 'fsif_ticket'
const GIS_SRC = 'https://accounts.google.com/gsi/client'
const MIN_REMAINING_MS = 60 * 1000

/** JWT の中身（古い GAS のときの期限の確認用。検証は GAS が行う） */
export function decodeToken(token) {
  try {
    const part = token.split('.')[1] ?? ''
    const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    const json = decodeURIComponent(Array.from(bin, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''))
    return JSON.parse(json)
  } catch {
    return {}
  }
}

function readStored() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    return s && s.token && Date.parse(s.expiresAt) - Date.now() > MIN_REMAINING_MS ? s : null
  } catch {
    return null
  }
}

function writeStored(s) {
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 保存できない環境では、開き直すたびにログインする
  }
}

/** URL の #fsif_ticket=…（ポータルからの引換券）を取り出し、URL からは消す */
export function takeTicket() {
  try {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''))
    const ticket = hash.get(TICKET_PARAM)
    if (!ticket) return ''
    hash.delete(TICKET_PARAM)
    const rest = hash.toString()
    history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''))
    return ticket
  } catch {
    return ''
  }
}

function loadGis() {
  if (window.google?.accounts?.id) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = GIS_SRC
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Google ログインを読み込めませんでした'))
    document.head.appendChild(s)
  })
}

/**
 * onChange(token | null)：ログイン状態が変わるたびに呼ばれる（ログイン・失効・ログアウト）
 * onError(error)：ログインを始められなかったとき（使えないアカウントなど）
 * startSession(cred)：GAS にセッションを頼む（api.startSession）。cred は { idToken } か { ticket }
 */
export function createGoogleAuth({ clientId, mock, onChange, onError, startSession }) {
  let token = null
  let expiryTimer = null
  let buttonEl = null
  let ready = false

  const set = (next) => {
    token = next ? next.token : null
    writeStored(next)
    clearTimeout(expiryTimer)
    if (next) expiryTimer = setTimeout(() => set(null), Math.min(Math.max(0, Date.parse(next.expiresAt) - Date.now()), 2_000_000_000))
    onChange(token)
  }

  // Google の ID トークンか引換券で、セッションを始める
  const begin = async (cred) => {
    try {
      const r = await startSession(cred)
      if (r?.session) return set({ token: r.session, expiresAt: r.expiresAt })
      // 古い GAS：ID トークンをそのまま使う（約1時間）
      if (cred.idToken) {
        const exp = Number(decodeToken(cred.idToken).exp) * 1000
        set({ token: cred.idToken, expiresAt: new Date(exp || Date.now() + 3600_000).toISOString() })
      }
    } catch (e) {
      if (e.code === 'NOT_ALLOWED' && !mock) window.google?.accounts?.id?.disableAutoSelect()
      // 引換券がだめでも、ふつうのログインで入れる。使えないアカウントのときだけ知らせる
      if (cred.idToken || e.code === 'NOT_ALLOWED') onError?.(e)
    }
  }

  const renderButton = () => {
    if (!buttonEl || !ready || !window.google) return
    window.google.accounts.id.renderButton(buttonEl, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ja', width: 260 })
  }

  return {
    get token() {
      return token
    },
    /** 開いたとき：ポータルからの引換券 → 保存済みのセッション → Google の自動ログイン の順に試す */
    async start() {
      const ticket = takeTicket()
      if (ticket) await begin({ ticket })
      if (!token) {
        const stored = readStored()
        if (stored) set(stored)
      }
      if (mock) return
      await loadGis()
      window.google.accounts.id.initialize({
        client_id: clientId,
        auto_select: true,
        use_fedcm_for_prompt: true,
        callback: ({ credential }) => void begin({ idToken: credential }),
      })
      ready = true
      renderButton()
      if (!token) window.google.accounts.id.prompt()
    },
    /** ログインボタンを描く要素（ログイン画面が渡す） */
    mountButton(el) {
      buttonEl = el
      renderButton()
    },
    /** モックモードのログイン（利用者・管理者を選ぶ） */
    mockSignIn(role) {
      return begin({ idToken: `mock:${role}` })
    },
    signOut() {
      if (!mock) window.google?.accounts?.id?.disableAutoSelect()
      set(null)
    },
    /** GAS がセッションを受け付けなかったとき（期限切れなど）。ボタンからログインし直してもらう */
    expire() {
      set(null)
    },
  }
}
