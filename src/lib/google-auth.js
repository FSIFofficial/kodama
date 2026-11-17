// Google ログイン（Google Identity Services）。ID トークンを GAS に送り、GAS が検証して
// FSIF の Access Manager で「使えるか・管理者か」を確かめる。
// - ID トークン（約1時間で失効）はこのタブの sessionStorage にだけ置く（タブを閉じれば消える）
// - 失効の少し前に Google の自動ログイン（prompt）で取り直す。一度ログインしたブラウザならボタンは要らない
// - ログアウトしたら自動ログインを止める（disableAutoSelect）
// モックモードでは Google を使わず、'mock:admin' / 'mock:user' をトークンの代わりにする。

const STORAGE_KEY = 'kodama-id-token'
const GIS_SRC = 'https://accounts.google.com/gsi/client'
const RENEW_BEFORE_MS = 5 * 60 * 1000
const MIN_REMAINING_MS = 60 * 1000

/** JWT の中身（表示と期限の確認用。検証は GAS が行う） */
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
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStored(token) {
  try {
    if (token) sessionStorage.setItem(STORAGE_KEY, token)
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // 保存できない環境では、開き直すたびにログインする
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
 * onChange(token | null) はトークンが変わるたびに呼ばれる（ログイン・取り直し・失効・ログアウト）。
 * mock が true なら Google を使わない。
 */
export function createGoogleAuth({ clientId, mock, onChange }) {
  let token = null
  let renewTimer = null
  let expiryTimer = null
  let buttonEl = null
  let ready = false

  const clearTimers = () => {
    clearTimeout(renewTimer)
    clearTimeout(expiryTimer)
  }

  const set = (next) => {
    token = next
    writeStored(next)
    clearTimers()
    if (next && !mock) {
      const exp = Number(decodeToken(next).exp) * 1000
      if (exp) {
        renewTimer = setTimeout(() => window.google?.accounts?.id?.prompt(), Math.max(0, exp - Date.now() - RENEW_BEFORE_MS))
        expiryTimer = setTimeout(() => set(null), Math.max(0, exp - Date.now()))
      }
    }
    onChange(next)
  }

  const renderButton = () => {
    if (!buttonEl || !ready || !window.google) return
    window.google.accounts.id.renderButton(buttonEl, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ja', width: 260 })
  }

  return {
    get token() {
      return token
    },
    /** 開いたとき：保存済みのトークンがまだ十分に有効なら使い、なければ自動ログインを試す */
    async start() {
      const stored = readStored()
      if (stored && (mock ? stored.startsWith('mock:') : Number(decodeToken(stored).exp) * 1000 - Date.now() > MIN_REMAINING_MS)) set(stored)
      else writeStored(null)
      if (mock) return
      await loadGis()
      window.google.accounts.id.initialize({
        client_id: clientId,
        auto_select: true,
        use_fedcm_for_prompt: true,
        callback: ({ credential }) => set(credential),
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
      set(`mock:${role}`)
    },
    signOut() {
      if (!mock) window.google?.accounts?.id?.disableAutoSelect()
      set(null)
    },
    /** GAS がトークンを受け付けなかったとき（期限切れなど）。ボタンからログインし直してもらう */
    expire() {
      set(null)
    },
  }
}
