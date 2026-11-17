// ビルド：CSS・JS・設定をすべて index.html 1枚にインライン化して dist/ に出力する。
// 画面に埋め込むのは GAS の URL と Google ログインのクライアントID だけ（どちらも秘密ではない。
// 使える人と管理者は、GAS が ID トークンを検証して FSIF の Access Manager に問い合わせて決める）。
//
//   npm run build          本番ビルド（GAS_URL / GOOGLE_CLIENT_ID 必須。ALLOW_MOCK=1 ならモックモードで出力）
//   npm run dev            開発サーバー（http://localhost:5173）。config.local.json が無ければモックモード
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const tmp = join(root, '.build')
const dev = process.argv.includes('--dev')

function loadConfig() {
  let gasUrl = process.env.GAS_URL || ''
  let googleClientId = (process.env.GOOGLE_CLIENT_ID || '').trim()
  const local = join(root, 'config.local.json')
  if (!gasUrl && existsSync(local)) ({ gasUrl = '', googleClientId = '' } = JSON.parse(readFileSync(local, 'utf8')))
  if (gasUrl && !googleClientId) throw new Error('GAS_URL を指定した場合は GOOGLE_CLIENT_ID（Google ログインのクライアントID）も必要です')
  if (!gasUrl && !dev && process.env.ALLOW_MOCK !== '1') {
    throw new Error('GAS_URL が未設定です。モックモードで本番ビルドする場合は ALLOW_MOCK=1 を指定してください')
  }
  return { gasUrl, googleClientId, mock: !gasUrl }
}

async function bundleJs() {
  const result = await build({
    entryPoints: [join(root, 'src/main.jsx')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2020',
    minify: !dev,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.gs': 'text' },
    legalComments: 'none',
    logLevel: 'warning',
  })
  // <script> 内に埋め込むので、閉じタグに見える文字列を無害化する
  return result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
}

function bundleCss() {
  mkdirSync(tmp, { recursive: true })
  const out = join(tmp, 'app.css')
  const bin = join(root, 'node_modules/.bin/tailwindcss')
  execFileSync(bin, ['-i', join(root, 'src/styles.css'), '-o', out, ...(dev ? [] : ['--minify'])], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] })
  return readFileSync(out, 'utf8')
}

async function buildOnce() {
  const started = Date.now()
  const config = loadConfig()
  const [js, css] = await Promise.all([bundleJs(), Promise.resolve().then(bundleCss)])
  const configJson = JSON.stringify(config).replace(/</g, '\\u003c')
  const html = readFileSync(join(root, 'src/index.html'), 'utf8')
    .replace('<!-- APP_CSS -->', () => `<style>${css}</style>`)
    .replace('<!-- APP_CONFIG -->', () => `<script>window.APP_CONFIG=${configJson}</script>`)
    .replace('<!-- APP_JS -->', () => `<script>${js}</script>`)
  rmSync(dist, { recursive: true, force: true })
  mkdirSync(dist, { recursive: true })
  cpSync(join(root, 'public'), dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), html)
  console.log(`built dist/index.html (${Math.round(html.length / 1024)}KB, ${config.mock ? 'モックモード' : 'GAS接続'}) in ${Date.now() - started}ms`)
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }

function serve() {
  const port = Number(process.env.PORT || 5173)
  createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const file = join(dist, path === '/' ? 'index.html' : path)
    if (!file.startsWith(dist) || !existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(readFileSync(file))
  }).listen(port, () => console.log(`dev server: http://localhost:${port}`))
}

try {
  await buildOnce()
} catch (e) {
  console.error(e.message)
  if (!dev) process.exit(1)
}

if (dev) {
  serve()
  let timer
  for (const dir of ['src', 'gas']) {
    watch(join(root, dir), { recursive: true }, () => {
      clearTimeout(timer)
      timer = setTimeout(() => buildOnce().catch((e) => console.error(e.message)), 150)
    })
  }
}
