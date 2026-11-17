// モックモード：GAS と同じ Core.gs をブラウザ内で動かす。データはこのブラウザの localStorage のみ。
// ログインは Google の代わりに 'mock:admin'（管理者）/ 'mock:user'（利用者）をトークンにする。
import schema from '../../gas/Schema.gs'
import mockData from '../../gas/MockData.gs'
import core from '../../gas/Core.gs'
import { MemoryDb, createMemoryCache, createMockDocs, createMockFiles, createMockSlides, loadGasCore } from './memory-db.js'

const STORAGE_KEY = 'pg-mock-db'
const FILES_KEY = 'pg-mock-files'

// Access Manager の代わり。モックのトークン 'mock:admin' / 'mock:user' を受け付ける
const MOCK_USERS = {
  admin: { email: 'admin@example.com', name: 'モック 管理者', roleKey: 'admin' },
  user: { email: 'user@example.com', name: 'モック 利用者', roleKey: 'user' },
}

function mockAuth() {
  const byEmail = Object.fromEntries(Object.values(MOCK_USERS).map((u) => [u.email, u]))
  return {
    verifyIdToken(token) {
      const u = MOCK_USERS[String(token).replace(/^mock:/, '')]
      if (!u) {
        const e = new Error('ログインし直してください')
        e.appCode = 'UNAUTHORIZED'
        throw e
      }
      return { email: u.email, name: u.name }
    },
    checkAccess(email) {
      const u = byEmail[email]
      return u ? { allowed: true, roleKey: u.roleKey, name: u.name, reason: '' } : { allowed: false, roleKey: '', name: '', reason: 'メンバー未登録' }
    },
  }
}

export function createMockBackend() {
  const gas = loadGasCore({ schema, mockData, core })
  let db
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) db = MemoryDb.fromJSON(saved)
  } catch {
    db = null
  }
  if (!db) db = new MemoryDb()
  gas.seedTables(db, new Date())

  let fileStore = {}
  try {
    fileStore = JSON.parse(localStorage.getItem(FILES_KEY) || '{}')
  } catch {
    fileStore = {}
  }
  const files = createMockFiles(fileStore)

  const env = {
    db,
    docs: createMockDocs(gas.MOCK_DOCUMENTS),
    slides: createMockSlides(gas.MOCK_DOCUMENTS, files),
    files,
    cache: createMemoryCache(),
    auth: mockAuth(),
    props: {},
    withLock: (fn) => fn(),
    now: () => new Date(),
  }

  return async (body) => {
    // GAS の応答待ちを再現
    await new Promise((r) => setTimeout(r, 250))
    const res = gas.handleRequest(JSON.parse(JSON.stringify(body)), env)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
      localStorage.setItem(FILES_KEY, JSON.stringify(fileStore))
    } catch {
      // 保存できなくてもメモリ上では動く
    }
    return JSON.parse(JSON.stringify(res))
  }
}

export function resetMockData() {
  try {
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(FILES_KEY)
  } catch {
    // noop
  }
}
