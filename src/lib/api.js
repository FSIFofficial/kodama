// GAS クライアント。Google ログインの ID トークンを全リクエストに付ける。
// 使えるか・管理者かは GAS が FSIF の Access Manager に問い合わせて決める（画面側では判断しない）。
import { createMockBackend } from './mock-backend.js'

const MESSAGES = {
  UNAUTHORIZED: 'Google のログインが切れています。ログインし直してください。',
  NOT_ALLOWED: 'このアカウントでは kodama を使えません。FSIF の Access Manager で利用を許可してもらってください。',
  ACCESS_UNAVAILABLE: '権限を確認できませんでした（Access Manager に問い合わせできませんでした）。少し待ってからもう一度お試しください。',
  ADMIN_REQUIRED: 'この操作には kodama の「管理者」の権限が必要です。FSIF の Access Manager で付けてもらってください。',
  SERVER_NOT_CONFIGURED: 'GAS のスクリプトプロパティ（GOOGLE_CLIENT_ID・ACCESS_GAS_URL・ACCESS_TOOL_ID・ACCESS_TOOL_KEY）が未設定です。',
  SHEET_MISSING: 'スプレッドシートにシートがありません。GAS エディタで setup() を実行してください。',
  BUSY: 'ほかの保存処理が混み合っています。少し待ってから再度お試しください。',
  NOT_FOUND: '対象のデータが見つかりません。',
  NETWORK: '通信に失敗しました。ネットワーク接続を確認して、もう一度お試しください。',
  BAD_RESPONSE: 'サーバーから想定外の応答がありました。GAS のデプロイ設定を確認してください。',
  // 画面からの POST が途中で GET に変わり、doGet の応答が返ってきたとき
  USE_POST: 'GAS に正しく届きませんでした。Google に複数のアカウントでログインしているとこうなることがあります。シークレットウィンドウ（または使うアカウントだけでログインしたブラウザ）で開き直してください。直らない場合は GitHub の Secrets の GAS_URL が現在のウェブアプリの URL（末尾 /exec）か確認してください。',
}

// init の応答に必ず入っている一覧。欠けていたら GAS 以外の応答（doGet など）が返ってきている
const INIT_LISTS = ['templates', 'media', 'sets', 'ranks', 'items', 'dateFormats', 'settings', 'orgs', 'orgColumns']
// あとから足した一覧。古い GAS の応答には無いので空で補う
const OPTIONAL_LISTS = ['parts']

export function checkInitData(d) {
  if (!d || typeof d !== 'object' || INIT_LISTS.some((k) => !Array.isArray(d[k]))) throw new ApiError('USE_POST')
  for (const k of OPTIONAL_LISTS) if (!Array.isArray(d[k])) d[k] = []
  return d
}

export class ApiError extends Error {
  constructor(code, detail) {
    super(detail || MESSAGES[code] || `エラーが発生しました（${code}）`)
    this.code = code
  }
}

/**
 * getIdToken：いまの ID トークン（無ければ空）
 * onAuthError：GAS がトークンを受け付けなかったとき（期限切れ）。ログイン画面に戻す
 */
export function createApi(config, { getIdToken, onAuthError } = {}) {
  const mock = config.mock ? createMockBackend() : null

  async function send(body) {
    if (mock) return mock(body)
    let res
    try {
      res = await fetch(config.gasUrl, {
        method: 'POST',
        // text/plain にして CORS のプリフライトを避ける
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
      })
    } catch {
      throw new ApiError('NETWORK')
    }
    try {
      return await res.json()
    } catch {
      throw new ApiError('BAD_RESPONSE')
    }
  }

  async function call(action, payload = {}) {
    const res = await send({ action, idToken: getIdToken?.() || '', payload })
    if (!res || typeof res !== 'object') throw new ApiError('BAD_RESPONSE')
    if (!res.ok) {
      if (res.error === 'UNAUTHORIZED') onAuthError?.()
      // USE_POST は画面側の説明（対処法つき）を出す
      throw new ApiError(res.error, res.error === 'USE_POST' ? '' : res.message)
    }
    return res.data
  }

  return {
    mock: Boolean(mock),
    call,
    /** ログインしている人 { email, name, role: 'admin' | 'user' } */
    whoami: () => call('whoami'),
  }
}
