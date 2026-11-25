/**
 * FsifSession.gs — FSIF のツール共通：ログインを保つセッションと、ポータルからの引き継ぎ（引換券）
 * kodama・CBED 運営ページ・KPI ダッシュボード・quiz manager で同じ内容（直すときは全部そろえる）。
 *
 * - セッション：Google でログインした人（またはポータルから引き継いだ人）に、この GAS が署名した文字列を渡す（7日）。
 *   画面はそれを localStorage に置き、以後の呼び出しに付ける。GAS は署名と期限だけを確かめる（保存場所は要らない）。
 *   使えるかどうかは、これまでどおり毎回 Access Manager に確かめる（5分キャッシュ）。役割を外せば最大5分で使えなくなる。
 * - 引換券：ポータルでツールの「開く」を押すと、Access Manager の GAS が出す（60秒・一度だけ）。
 *   ACCESS_TOOL_KEY（Access Manager がこのツールに出したキー）で署名を確かめるので、新しい設定は要らない。
 *
 * スクリプトプロパティ
 *   SESSION_SECRET  セッションの署名に使う。最初に使うときに自動で作る。消すか書き換えると全員ログアウトになる
 *   ACCESS_TOOL_ID / ACCESS_TOOL_KEY  引換券の確認に使う（Access Manager につなぐときに設定済みのもの）
 */
var FSIF_SESSION_DAYS = 7
var FSIF_TICKET_REUSE_SEC = 300 // 使った引換券を覚えておく秒数（有効期限の60秒より長く）

function fsifB64_(text) {
  return Utilities.base64EncodeWebSafe(text, Utilities.Charset.UTF_8)
}

function fsifUnb64_(text) {
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(text)).getDataAsString('UTF-8')
}

function fsifSign_(text, key) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, key, Utilities.Charset.UTF_8))
}

function fsifSafeEqual_(a, b) {
  a = String(a)
  b = String(b)
  if (a.length !== b.length) return false
  var diff = 0
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** 「頭.中身.署名」を確かめて中身（JSON）を返す。だめなら null */
function fsifOpen_(token, head, key) {
  var parts = String(token || '').split('.')
  if (parts.length !== 3 || parts[0] !== head || !key) return null
  if (!fsifSafeEqual_(parts[2], fsifSign_(head + '.' + parts[1], key))) return null
  try {
    return JSON.parse(fsifUnb64_(parts[1]))
  } catch (e) {
    return null
  }
}

function fsifSessionSecret_() {
  var props = PropertiesService.getScriptProperties()
  var secret = props.getProperty('SESSION_SECRET')
  if (secret) return secret
  var lock = LockService.getScriptLock()
  lock.waitLock(10000)
  try {
    secret = props.getProperty('SESSION_SECRET')
    if (!secret) {
      secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '')
      props.setProperty('SESSION_SECRET', secret)
    }
    return secret
  } finally {
    lock.releaseLock()
  }
}

/** ログインできた人にセッションを出す → { session, expiresAt（ISO） } */
function fsifIssueSession_(user) {
  var exp = Date.now() + FSIF_SESSION_DAYS * 86400000
  var body = fsifB64_(JSON.stringify({ e: String(user.email || '').toLowerCase(), n: String(user.name || '').slice(0, 100), x: exp }))
  return { session: 's1.' + body + '.' + fsifSign_('s1.' + body, fsifSessionSecret_()), expiresAt: new Date(exp).toISOString() }
}

/** セッションを確かめる → { email, name }。期限切れ・改ざんは null */
function fsifVerifySession_(token) {
  var p = fsifOpen_(token, 's1', fsifSessionSecret_())
  if (!p || !p.e || !(Number(p.x) > Date.now())) return null
  return { email: String(p.e).toLowerCase(), name: String(p.n || '') }
}

/**
 * ポータルからの引換券を確かめる → { email, name }。だめなら null。
 * このツール宛て・60秒以内・まだ使っていない、の3つを確かめる（使ったものは覚えておき、二度目は通さない）。
 */
function fsifRedeemTicket_(ticket) {
  var props = PropertiesService.getScriptProperties()
  var toolId = props.getProperty('ACCESS_TOOL_ID')
  var p = fsifOpen_(ticket, 't1', props.getProperty('ACCESS_TOOL_KEY'))
  if (!p || !toolId || String(p.t) !== String(toolId) || !p.e || !p.j || !(Number(p.x) > Date.now())) return null
  var cache = CacheService.getScriptCache()
  var used = 'fsif-tkt:' + p.j
  if (cache.get(used)) return null
  cache.put(used, '1', FSIF_TICKET_REUSE_SEC)
  return { email: String(p.e).toLowerCase(), name: String(p.n || '') }
}

/** 全員をログアウトさせる（漏れたときなど）。エディタから実行する */
function resetAllSessions() {
  PropertiesService.getScriptProperties().deleteProperty('SESSION_SECRET')
  console.log('SESSION_SECRET を消しました。次に使うときに作り直され、今のセッションはすべて使えなくなります')
}
