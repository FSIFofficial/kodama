/**
 * リクエスト処理の本体。GAS 固有の API には触らず、env 経由で DB・設定・ロックを受け取る。
 *   env = { db, docs, props: { userKey, adminPassword }, auth, withLock(fn), now() }
 *   auth は Google ログイン（FSIF の Access Manager で権限を決める）のアダプタ。無ければ Google ログインは使えない：
 *     verifyIdToken(idToken) → { email, name }（検証できなければ例外）
 *     checkAccess(email) → { allowed, roleKey, name, reason }（Access Manager の実効権限。役割キー admin が管理者）
 *   props.userKey / adminPassword は以前の「利用者キー＋管理者パスワード」方式。USER_KEY を消すと使えなくなる
 *   docs は Google ドキュメントの雛形を扱うアダプタ：readText(fileId) / render({ fileId, replacements, format, fileName })
 *   slides は Google スライドの雛形を扱うアダプタ：readText(fileId) / render({ fileId, replacements, images, fileName })
 *   files はロゴなどの画像を保存・読み出すアダプタ：saveImage({ fileName, mimeType, base64 }) / readImage(fileId)
 *   cache は管理者パスの連続失敗を数える短期キャッシュ：get(key) / put(key, value, seconds) / remove(key)（無ければ制限しない）
 * GAS では Main.gs が SheetDb で env を組み立てる。フロントのモックモードとテストでは MemoryDb を使う。
 */

var ACTIONS = {
  init: { fn: actionInit_ },
  listHistory: { fn: actionListHistory_ },
  getHistory: { fn: actionGetHistory_ },
  saveHistory: { fn: actionSaveHistory_, write: true },
  create: { fn: actionCreate_, write: true },
  bulkCreate: { fn: actionBulkCreate_, write: true },
  verifyAdmin: { fn: actionVerifyAdmin_ },
  whoami: { fn: actionWhoami_ },
  update: { fn: actionUpdate_, write: true, admin: true },
  deactivate: { fn: actionDeactivate_, write: true, admin: true },
  deleteHistory: { fn: actionDeleteHistory_, write: true, admin: true },
  readDocument: { fn: actionReadDocument_ },
  renderDocument: { fn: actionRenderDocument_ },
  uploadImage: { fn: actionUploadImage_ },
  readImage: { fn: actionReadImage_ },
  listLogs: { fn: actionListLogs_ },
  listTemplateRevisions: { fn: actionListTemplateRevisions_ },
};

function handleRequest(req, env) {
  try {
    if (!req || typeof req !== 'object') return fail_('BAD_REQUEST');
    var def = ACTIONS[req.action];
    if (!def) return fail_('UNKNOWN_ACTION');
    var user = authenticate_(req, env);
    if (user.error) return fail_(user.error, user.message);
    req.user = user;
    if (def.admin && !isAdmin_(req, env)) {
      return user.via === 'google'
        ? fail_('ADMIN_REQUIRED', 'この操作には kodama の「管理者」の権限が必要です。FSIF の Access Manager で付けてもらってください')
        : fail_('ADMIN_REQUIRED');
    }
    var payload = req.payload && typeof req.payload === 'object' ? req.payload : {};
    var run = function () { return def.fn(payload, env, req); };
    return { ok: true, data: def.write ? env.withLock(run) : run() };
  } catch (e) {
    if (e && e.appCode) return fail_(e.appCode, e.message);
    return fail_('SERVER_ERROR', String((e && e.message) || e));
  }
}

/**
 * だれからのリクエストかを確かめる。
 * - Google ログイン（idToken）：ID トークンを検証し、Access Manager で kodama を使えるか・役割を確かめる
 * - 以前の方式（key）：利用者キーと照合する（USER_KEY が設定されている間だけ）
 * 返り値：{ via: 'google', email, name, role: 'admin' | 'user' } / { via: 'key' } / { error, message }
 */
function authenticate_(req, env) {
  if (req.idToken) {
    if (!env.auth) return { error: 'SERVER_NOT_CONFIGURED', message: 'Google ログインの設定（GOOGLE_CLIENT_ID・ACCESS_GAS_URL・ACCESS_TOOL_ID・ACCESS_TOOL_KEY）が GAS にありません' };
    var who = env.auth.verifyIdToken(String(req.idToken));
    var email = String(who.email || '').toLowerCase();
    var access = env.auth.checkAccess(email);
    if (!access.allowed) {
      return { error: 'NOT_ALLOWED', message: email + ' では kodama を使えません（' + (access.reason || '付与なし') + '）。FSIF の Access Manager で利用を許可してもらってください' };
    }
    return { via: 'google', email: email, name: str_(access.name || who.name || email).slice(0, 50), role: access.roleKey === 'admin' ? 'admin' : 'user' };
  }
  if (!env.props.userKey || !env.props.adminPassword) {
    return env.auth ? { error: 'UNAUTHORIZED', message: 'Google でログインしてください' } : { error: 'SERVER_NOT_CONFIGURED' };
  }
  if (!safeEqual_(req.key, env.props.userKey)) return { error: 'UNAUTHORIZED' };
  return { via: 'key' };
}

// 管理者か。Google ログインなら Access Manager の役割、以前の方式なら管理者パスワードで決まる
function isAdmin_(req, env) {
  if (req.user && req.user.via === 'google') return req.user.role === 'admin';
  return checkAdminPass_(req, env);
}

function appError_(code, message) {
  var e = new Error(message || code);
  e.appCode = code;
  return e;
}

function fail_(code, message) {
  var res = { ok: false, error: code };
  if (message && message !== code) res.message = message;
  return res;
}

// 管理者パスを続けて間違えたら、しばらく受け付けない（総当たり対策）。
// 回数は全体で数える（GAS では接続元を区別できないため）。止まっている間は正しいパスも受け付けない
var ADMIN_MAX_FAILS = 5;
var ADMIN_LOCK_SECONDS = 600;
var ADMIN_FAIL_KEY = 'admin-pass-fails';

function checkAdminPass_(req, env) {
  var cache = env.cache;
  var fails = cache ? Number(cache.get(ADMIN_FAIL_KEY)) || 0 : 0;
  if (fails >= ADMIN_MAX_FAILS) throw appError_('ADMIN_LOCKED', '管理者パスワードを' + ADMIN_MAX_FAILS + '回続けて間違えたため、' + ADMIN_LOCK_SECONDS / 60 + '分間は受け付けません。時間をおいてから入力してください');
  var ok = safeEqual_(req.adminPass, env.props.adminPassword);
  if (cache) {
    if (ok && fails) cache.remove(ADMIN_FAIL_KEY);
    // 空のパス（未入力のまま管理者操作を呼んだ場合）は数えない
    else if (!ok && typeof req.adminPass === 'string' && req.adminPass) cache.put(ADMIN_FAIL_KEY, String(fails + 1), ADMIN_LOCK_SECONDS);
  }
  return ok;
}

function safeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- テーブル操作 ----------

function schemaHeaders_(entity, dynamicKeys) {
  var s = SCHEMA[entity];
  var headers = s.cols.map(function (c) { return c[1]; });
  if (!s.dynamic) return headers;
  var at = headers.indexOf(s.dynamicBefore);
  return headers.slice(0, at).concat(dynamicKeys || [], headers.slice(at));
}

function fixedHeaderMap_(s) {
  var map = {};
  s.cols.forEach(function (c) { map[c[1]] = c[0]; });
  return map;
}

function loadTable_(env, entity) {
  var s = SCHEMA[entity];
  var t = env.db.readTable(s.sheet);
  var headers = t.headers.map(function (h) { return String(h == null ? '' : h).trim(); });
  var fixed = fixedHeaderMap_(s);
  var records = [];
  t.rows.forEach(function (row, index) {
    if (isBlankRow_(row)) return;
    var obj = {};
    if (s.dynamic) obj.values = {};
    headers.forEach(function (h, i) {
      if (!h) return;
      if (fixed[h]) obj[fixed[h]] = normalizeCell_(fixed[h], row[i]);
      else if (s.dynamic) obj.values[h] = normalizeCell_('', row[i]);
    });
    s.cols.forEach(function (c) { if (!(c[0] in obj)) obj[c[0]] = normalizeCell_(c[0], ''); });
    records.push({ index: index, obj: obj });
  });
  var dynamicKeys = s.dynamic ? headers.filter(function (h) { return h && !fixed[h]; }) : [];
  return { entity: entity, schema: s, headers: headers, fixed: fixed, records: records, dynamicKeys: dynamicKeys };
}

function isBlankRow_(row) {
  for (var i = 0; i < row.length; i++) if (row[i] !== '' && row[i] !== null && row[i] !== undefined) return false;
  return true;
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function normalizeCell_(prop, v) {
  if (isDate_(v)) {
    if (TIMESTAMP_PROPS[prop]) return v.toISOString();
    return v.getFullYear() + '-' + pad2_(v.getMonth() + 1) + '-' + pad2_(v.getDate());
  }
  if (BOOL_PROPS[prop]) return toBool_(v, prop === 'active');
  if (NUMBER_PROPS[prop]) {
    if (v === '' || v === null || v === undefined) return '';
    var n = Number(v);
    return isFinite(n) ? n : '';
  }
  return v === null || v === undefined ? '' : String(v);
}

// 空欄は「有効」なら TRUE 扱い（手でシートに行を足した場合に備える）、それ以外は FALSE
function toBool_(v, blankValue) {
  if (v === true || v === false) return v;
  if (v === '' || v === null || v === undefined) return blankValue;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'はい' || s === '○';
}

function toRow_(table, obj) {
  return table.headers.map(function (h) {
    var prop = table.fixed[h];
    var v = prop ? obj[prop] : (table.schema.dynamic && obj.values ? obj.values[h] : '');
    if (v === undefined || v === null) return '';
    if (prop && TIMESTAMP_PROPS[prop] && typeof v === 'string' && v) {
      var d = new Date(v);
      return isNaN(d.getTime()) ? v : d;
    }
    return v;
  });
}

function findRecord_(table, keyValue) {
  var prop = table.schema.key;
  for (var i = 0; i < table.records.length; i++) {
    if (String(table.records[i].obj[prop]) === String(keyValue)) return table.records[i];
  }
  return null;
}

function nextId_(prefix, records) {
  var max = 0;
  var re = new RegExp('^' + prefix + '(\\d+)$');
  records.forEach(function (r) {
    var m = re.exec(String(r.obj.id || ''));
    if (m) max = Math.max(max, Number(m[1]));
  });
  var num = String(max + 1);
  while (num.length < 3) num = '0' + num;
  return prefix + num;
}

function hasCol_(s, prop) {
  return s.cols.some(function (c) { return c[0] === prop; });
}

function sortByOrder_(list) {
  return list.slice().sort(function (a, b) {
    var ao = a.order === '' ? Infinity : a.order;
    var bo = b.order === '' ? Infinity : b.order;
    return ao === bo ? 0 : ao < bo ? -1 : 1;
  });
}

// 親に紐づく子シートの行を置き換える
function replaceChildren_(env, childEntity, parentId, rows) {
  var table = loadTable_(env, childEntity);
  var s = table.schema;
  var indices = table.records
    .filter(function (r) { return String(r.obj[s.parentProp]) === String(parentId); })
    .map(function (r) { return r.index; });
  if (indices.length) env.db.deleteRows(s.sheet, indices);
  if (!rows.length) return;
  var fresh = loadTable_(env, childEntity);
  env.db.appendRows(s.sheet, rows.map(function (row) {
    var obj = {};
    s.cols.forEach(function (c) { obj[c[0]] = row[c[0]]; });
    obj[s.parentProp] = parentId;
    return toRow_(fresh, obj);
  }));
}

function ensureOrgColumn_(env, key) {
  var table = loadTable_(env, 'orgs');
  if (table.headers.indexOf(key) >= 0) return;
  env.db.insertColumnBefore(SCHEMA.orgs.sheet, SCHEMA.orgs.dynamicBefore, key);
}

// ---------- 入力値の検証 ----------

function str_(v) { return v === undefined || v === null ? '' : String(v).trim(); }

var EDITABLE_PROPS = {
  templates: ['name', 'setId', 'mediaId', 'rank', 'format', 'fileId'],
  media: ['name', 'order', 'copyFormat'],
  sets: ['name', 'description', 'order'],
  ranks: ['name', 'order'],
  items: ['key', 'label', 'category', 'type', 'options', 'format', 'required', 'defaultValue', 'example', 'order'],
  dateFormats: ['label', 'format', 'order'],
  orgs: ['logoFileId'],
  settings: ['key', 'value', 'description'],
  parts: ['name', 'content', 'description', 'order'],
};

function pickData_(entity, data) {
  var out = {};
  EDITABLE_PROPS[entity].forEach(function (p) {
    if (!(p in data)) return;
    if (BOOL_PROPS[p]) out[p] = toBool_(data[p], false);
    else if (NUMBER_PROPS[p]) out[p] = normalizeCell_(p, data[p]);
    else out[p] = p === 'value' || p === 'description' || p === 'content' ? String(data[p] == null ? '' : data[p]) : str_(data[p]);
  });
  if (entity === 'orgs' && data.values && typeof data.values === 'object') {
    out.values = {};
    Object.keys(data.values).forEach(function (k) { out.values[k] = String(data.values[k] == null ? '' : data.values[k]); });
  }
  return out;
}

function requireText_(value, label) {
  if (!str_(value)) throw appError_('VALIDATION', label + 'を入力してください');
}

function oneOf_(value, list, label) {
  if (list.indexOf(value) < 0) throw appError_('VALIDATION', label + 'は「' + list.join('／') + '」のいずれかにしてください');
}

function validate_(entity, obj, env, table, isCreate) {
  var s = table.schema;
  var duplicate = function (label) {
    if (isCreate && findRecord_(table, obj[s.key])) throw appError_('DUPLICATE', label + '「' + obj[s.key] + '」はすでに登録されています');
  };
  switch (entity) {
    case 'templates': {
      requireText_(obj.name, 'テンプレ名');
      requireText_(obj.setId, 'セット');
      requireText_(obj.mediaId, '媒体');
      requireText_(obj.rank, 'ランク');
      if (!obj.format) obj.format = 'テキスト';
      oneOf_(obj.format, OUTPUT_FORMATS, '出力形式');
      if (isFileFormat_(obj.format)) requireText_(obj.fileId, '雛形ファイルID');
      if (!findRecord_(loadTable_(env, 'sets'), obj.setId)) throw appError_('VALIDATION', 'セットが見つかりません');
      if (!findRecord_(loadTable_(env, 'media'), obj.mediaId)) throw appError_('VALIDATION', '媒体が見つかりません');
      if (obj.rank !== COMMON_RANK && !findRecord_(loadTable_(env, 'ranks'), obj.rank)) throw appError_('VALIDATION', 'ランクが見つかりません');
      break;
    }
    case 'media':
      requireText_(obj.name, '媒体名');
      if (!obj.copyFormat) obj.copyFormat = '通常';
      oneOf_(obj.copyFormat, COPY_FORMATS, 'コピー形式');
      break;
    case 'sets':
      requireText_(obj.name, 'セット名');
      break;
    case 'ranks':
      requireText_(obj.name, 'ランク名');
      if (obj.name === COMMON_RANK) throw appError_('VALIDATION', '「' + COMMON_RANK + '」はランク名に使えません');
      duplicate('ランク');
      break;
    case 'items': {
      requireText_(obj.key, '項目キー');
      if (/[{}:\n\r]/.test(obj.key)) throw appError_('VALIDATION', '項目キーに { } : や改行は使えません');
      var reserved = fixedHeaderMap_(SCHEMA.orgs);
      if (reserved[obj.key]) throw appError_('VALIDATION', '「' + obj.key + '」は団体マスタの予約列名なので使えません');
      if (!obj.label) obj.label = obj.key;
      if (!obj.category) obj.category = '案件';
      if (!obj.type) obj.type = '短文';
      oneOf_(obj.category, ITEM_CATEGORIES, '区分');
      oneOf_(obj.type, ITEM_TYPES, '入力タイプ');
      duplicate('項目キー');
      break;
    }
    case 'dateFormats':
      requireText_(obj.format, '書式');
      if (!obj.label) obj.label = obj.format;
      duplicate('書式');
      break;
    case 'orgs':
      requireText_(obj.values && obj.values['団体名'], '団体名');
      break;
    case 'parts':
      requireText_(obj.name, 'パーツ名');
      if (/[{}:\n\r]/.test(obj.name)) throw appError_('VALIDATION', 'パーツ名に { } : や改行は使えません');
      duplicate('パーツ名');
      break;
    case 'settings':
      requireText_(obj.key, '項目キー');
      if (/[{}:\n\r]/.test(obj.key)) throw appError_('VALIDATION', '項目キーに { } : や改行は使えません');
      duplicate('項目キー');
      break;
  }
}

function childRows_(entity, children) {
  if (entity === 'templates') {
    var fields = children.fields || {};
    return Object.keys(fields).map(function (k) { return { fieldKey: str_(k), content: String(fields[k] == null ? '' : fields[k]) }; })
      .filter(function (r) { return r.fieldKey; });
  }
  if (entity === 'media') {
    return (children.fields || []).map(function (f, i) {
      var countMode = str_(f.countMode) || '通常';
      var splitRule = str_(f.splitRule) || 'なし';
      oneOf_(countMode, COUNT_MODES, '数え方');
      oneOf_(splitRule, SPLIT_RULES, '分割ルール');
      return {
        fieldKey: str_(f.fieldKey), label: str_(f.label) || str_(f.fieldKey), limit: normalizeCell_('limit', f.limit),
        countMode: countMode, splitRule: splitRule, order: f.order === '' || f.order == null ? i + 1 : normalizeCell_('order', f.order),
      };
    }).filter(function (r) { return r.fieldKey; });
  }
  return [];
}

// ---------- action ----------

function actionVerifyAdmin_(payload, env, req) {
  return { valid: isAdmin_(req, env) };
}

// ログインしている人（画面のヘッダーと、管理者かどうかの判定に使う）
function actionWhoami_(payload, env, req) {
  var u = req.user || {};
  return u.via === 'google' ? { email: u.email, name: u.name, role: u.role } : { email: '', name: actorName_(req), role: '' };
}

function actionInit_(payload, env) {
  var all = {};
  ['templates', 'templateFields', 'media', 'mediaFields', 'sets', 'ranks', 'items', 'dateFormats', 'settings'].forEach(function (e) {
    all[e] = loadTable_(env, e).records.map(function (r) { return r.obj; });
  });
  var orgTable = loadTable_(env, 'orgs');
  // 共通パーツはあとから足したシート。本番に無ければ空
  var partTable = loadTableIfExists_(env, 'parts');
  var templates = all.templates.map(function (t) {
    var fields = {};
    all.templateFields.forEach(function (f) { if (f.templateId === t.id) fields[f.fieldKey] = f.content; });
    t.fields = fields;
    return t;
  });
  var media = sortByOrder_(all.media).map(function (m) {
    m.fields = sortByOrder_(all.mediaFields.filter(function (f) { return f.mediaId === m.id; }));
    return m;
  });
  return {
    templates: templates,
    media: media,
    sets: sortByOrder_(all.sets),
    ranks: sortByOrder_(all.ranks),
    items: sortByOrder_(all.items),
    dateFormats: sortByOrder_(all.dateFormats),
    settings: all.settings,
    orgs: orgTable.records.map(function (r) { return r.obj; }),
    orgColumns: orgTable.dynamicKeys,
    parts: partTable ? sortByOrder_(partTable.records.map(function (r) { return r.obj; })) : [],
  };
}

function actionCreate_(payload, env, req) {
  var entity = payload.entity;
  if (!Object.prototype.hasOwnProperty.call(CREATABLE, entity)) throw appError_('BAD_REQUEST', '追加できない種類です: ' + entity);
  var table = withAllColumns_(env, ensureTable_(env, entity)); // あとから足したシート・列は本番に無ければ作る
  var s = table.schema;
  var obj = pickData_(entity, payload.data || {});
  validate_(entity, obj, env, table, true);
  var children = entity === 'templates' && isFileFormat_(obj.format)
    ? fileChildren_(env, obj.format, obj.fileId)
    : CREATABLE[entity] && payload.children ? childRows_(entity, payload.children) : null;
  if (s.idPrefix) obj.id = nextId_(s.idPrefix, table.records);
  if (hasCol_(s, 'active')) obj.active = true;
  if (hasCol_(s, 'updatedAt')) obj.updatedAt = env.now();
  if (entity === 'items' && obj.category === '団体') ensureOrgColumn_(env, obj.key);
  env.db.appendRows(s.sheet, [toRow_(table, obj)]);
  if (children) replaceChildren_(env, CREATABLE[entity], obj[s.key], children);
  if (entity === 'templates') saveTemplateRevision_(env, req, obj, children ? fieldsFromRows_(children) : {});
  writeLogs_(env, req, [{ action: '追加', entity: entity, key: obj[s.key], detail: recordName_(entity, obj) }]);
  return { key: obj[s.key] };
}

function actionUpdate_(payload, env, req) {
  var entity = payload.entity;
  if (!Object.prototype.hasOwnProperty.call(CREATABLE, entity)) throw appError_('BAD_REQUEST', '更新できない種類です: ' + entity);
  var table = withAllColumns_(env, loadTable_(env, entity));
  var s = table.schema;
  var rec = findRecord_(table, payload.key);
  if (!rec) throw appError_('NOT_FOUND', '対象のデータが見つかりません');
  var data = pickData_(entity, payload.data || {});
  delete data[s.key]; // キーは変更不可（履歴やテンプレ本文から参照されるため）
  var obj = JSON.parse(JSON.stringify(rec.obj));
  Object.keys(data).forEach(function (k) {
    if (k === 'values') Object.keys(data.values).forEach(function (vk) { obj.values[vk] = data.values[vk]; });
    else obj[k] = data[k];
  });
  validate_(entity, obj, env, table, false);
  var children = entity === 'templates' && isFileFormat_(obj.format)
    ? fileChildren_(env, obj.format, obj.fileId)
    : CREATABLE[entity] && payload.children ? childRows_(entity, payload.children) : null;
  var changes = diffRecord_(s, rec.obj, obj);
  if (children) changes = changes.concat(diffChildren_(env, CREATABLE[entity], obj[s.key], children));
  var beforeFields = entity === 'templates' ? currentTemplateFields_(env, obj.id) : null;
  // 変更履歴を始める前からあるテンプレートは、変更前の内容も残しておく
  if (entity === 'templates' && !templateRevisions_(env, obj.id).length) saveTemplateRevision_(env, null, rec.obj, beforeFields, rec.obj.updatedAt, '（履歴の記録開始前）');
  if (hasCol_(s, 'updatedAt')) obj.updatedAt = env.now();
  if (entity === 'items' && obj.category === '団体') ensureOrgColumn_(env, obj.key);
  env.db.updateRow(s.sheet, rec.index, toRow_(table, obj));
  if (children) replaceChildren_(env, CREATABLE[entity], obj[s.key], children);
  if (entity === 'templates') saveTemplateRevision_(env, req, obj, children ? fieldsFromRows_(children) : beforeFields);
  writeLogs_(env, req, [{ action: '編集', entity: entity, key: obj[s.key], detail: recordName_(entity, obj) + '：' + (changes.length ? changes.join(' / ') : '変更なし') }]);
  return { key: obj[s.key] };
}

function actionDeactivate_(payload, env, req) {
  var entity = payload.entity;
  if (!Object.prototype.hasOwnProperty.call(CREATABLE, entity) || !hasCol_(SCHEMA[entity], 'active')) throw appError_('BAD_REQUEST', '無効化できない種類です: ' + entity);
  var table = loadTable_(env, entity);
  var rec = findRecord_(table, payload.key);
  if (!rec) throw appError_('NOT_FOUND', '対象のデータが見つかりません');
  var obj = JSON.parse(JSON.stringify(rec.obj));
  obj.active = payload.active === true; // 既定は無効化。active: true を渡すと再度有効にする
  if (hasCol_(table.schema, 'updatedAt')) obj.updatedAt = env.now();
  env.db.updateRow(table.schema.sheet, rec.index, toRow_(table, obj));
  writeLogs_(env, req, [{ action: obj.active ? '有効化' : '無効化', entity: entity, key: payload.key, detail: recordName_(entity, obj) }]);
  return { key: payload.key, active: obj.active };
}

function historyFromRecord_(obj) {
  var values = {};
  try { values = obj.values ? JSON.parse(obj.values) : {}; } catch (e) { values = {}; }
  return {
    id: obj.id, createdAt: obj.createdAt, author: obj.author, orgId: obj.orgId, orgName: obj.orgName,
    setId: obj.setId, rank: obj.rank, values: values, status: obj.status,
  };
}

function actionListHistory_(payload, env) {
  return loadTable_(env, 'history').records
    .map(function (r) { return historyFromRecord_(r.obj); })
    .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0; });
}

function actionGetHistory_(payload, env) {
  var rec = findRecord_(loadTable_(env, 'history'), payload.id);
  if (!rec) throw appError_('NOT_FOUND', '履歴が見つかりません');
  var history = historyFromRecord_(rec.obj);
  history.outputs = loadTable_(env, 'historyOutputs').records
    .map(function (r) { return r.obj; })
    .filter(function (o) { return o.historyId === history.id; });
  return history;
}

function actionSaveHistory_(payload, env, req) {
  var h = payload.history || {};
  var google = req && req.user && req.user.via === 'google';
  var table = loadTable_(env, 'history');
  var rec = h.id ? findRecord_(table, h.id) : null;
  if (h.id && !rec) throw appError_('NOT_FOUND', '上書きする履歴が見つかりません');
  var obj = {
    id: rec ? rec.obj.id : nextId_('H', table.records),
    createdAt: rec ? rec.obj.createdAt : env.now(),
    // Google ログインなら作成者はログインしている人（上書きでは最初に作った人のまま）
    author: google ? (rec ? rec.obj.author : req.user.name) : str_(h.author), orgId: str_(h.orgId), orgName: str_(h.orgName), setId: str_(h.setId), rank: str_(h.rank),
    values: JSON.stringify(h.values || {}),
    status: rec ? rec.obj.status : '',
  };
  if (rec) env.db.updateRow(SCHEMA.history.sheet, rec.index, toRow_(table, obj));
  else env.db.appendRows(SCHEMA.history.sheet, [toRow_(table, obj)]);
  var outputs = (payload.outputs || []).map(function (o) {
    return { mediaId: str_(o.mediaId), templateId: str_(o.templateId), fieldKey: str_(o.fieldKey), text: String(o.text == null ? '' : o.text), edited: o.edited === true };
  });
  replaceChildren_(env, 'historyOutputs', obj.id, outputs);
  return { id: obj.id, createdAt: isDate_(obj.createdAt) ? obj.createdAt.toISOString() : obj.createdAt };
}

function actionDeleteHistory_(payload, env, req) {
  var table = loadTable_(env, 'history');
  var rec = findRecord_(table, payload.id);
  if (!rec) throw appError_('NOT_FOUND', '履歴が見つかりません');
  replaceChildren_(env, 'historyOutputs', rec.obj.id, []);
  env.db.deleteRows(SCHEMA.history.sheet, [rec.index]);
  writeLogs_(env, req, [{ action: '削除', entity: 'history', key: rec.obj.id, detail: [rec.obj.orgName, rec.obj.author, rec.obj.createdAt].filter(String).join(' / ') }]);
  return { id: rec.obj.id };
}

var MAX_BULK_ROWS = 500;

// 団体の一括登録（追加なので利用者も可）。rows は [{ values: { 団体名: '...', ... } }]。
// 団体名が空の行、すでに登録済み（無効のものを含む）・同じ一括登録内で重複する団体名の行は飛ばす
function actionBulkCreate_(payload, env, req) {
  if (payload.entity !== 'orgs') throw appError_('BAD_REQUEST', '一括登録できるのは団体だけです');
  var rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) throw appError_('VALIDATION', '登録する行がありません');
  if (rows.length > MAX_BULK_ROWS) throw appError_('VALIDATION', '一度に登録できるのは' + MAX_BULK_ROWS + '件までです');
  var table = loadTable_(env, 'orgs');
  var names = {};
  table.records.forEach(function (r) { names[str_(r.obj.values['団体名'])] = true; });
  var records = table.records.slice();
  var created = [];
  var skipped = [];
  var out = [];
  rows.forEach(function (row, i) {
    var obj = pickData_('orgs', { values: (row && row.values) || {} });
    obj.values = obj.values || {};
    Object.keys(obj.values).forEach(function (k) { obj.values[k] = obj.values[k].trim(); });
    var name = obj.values['団体名'] || '';
    if (!name) return skipped.push({ row: i + 1, name: '', reason: '団体名が空です' });
    if (names[name]) return skipped.push({ row: i + 1, name: name, reason: 'すでに登録されています' });
    names[name] = true;
    obj.id = nextId_('O', records);
    obj.logoFileId = '';
    obj.active = true;
    obj.updatedAt = env.now();
    records.push({ obj: obj });
    out.push(toRow_(table, obj));
    created.push({ id: obj.id, name: name });
  });
  if (out.length) env.db.appendRows(SCHEMA.orgs.sheet, out);
  writeLogs_(env, req, created.map(function (c) { return { action: '一括追加', entity: 'orgs', key: c.id, detail: c.name }; }));
  var known = {};
  table.dynamicKeys.forEach(function (k) { known[k] = true; });
  var ignored = {};
  rows.forEach(function (row) { Object.keys((row && row.values) || {}).forEach(function (k) { if (!known[k]) ignored[k] = true; }); });
  return { created: created, skipped: skipped, ignoredColumns: Object.keys(ignored) };
}

// ---------- 操作ログ ----------

var LOG_VALUE_MAX = 80;

function recordName_(entity, obj) {
  if (entity === 'orgs') return (obj.values && obj.values['団体名']) || obj.id;
  return obj.name || obj.label || obj[SCHEMA[entity].key] || '';
}

function logValue_(v) {
  var s = v === true ? 'TRUE' : v === false ? 'FALSE' : String(v == null ? '' : v);
  s = s.replace(/\r?\n/g, '⏎');
  return '「' + (s.length > LOG_VALUE_MAX ? s.slice(0, LOG_VALUE_MAX) + '…' : s) + '」';
}

// 変わった列を「表示名：「前」→「後」」の形で並べる
function diffRecord_(s, before, after) {
  var out = [];
  s.cols.forEach(function (c) {
    var p = c[0];
    if (p === 'updatedAt' || p === 'values' || !(p in after)) return;
    if (String(before[p]) !== String(after[p])) out.push(c[1] + '：' + logValue_(before[p]) + '→' + logValue_(after[p]));
  });
  if (s.dynamic) {
    Object.keys(after.values || {}).forEach(function (k) {
      var b = before.values && k in before.values ? before.values[k] : '';
      if (String(b) !== String(after.values[k])) out.push(k + '：' + logValue_(b) + '→' + logValue_(after.values[k]));
    });
  }
  return out;
}

function diffChildren_(env, childEntity, parentId, rows) {
  var s = SCHEMA[childEntity];
  var current = loadTable_(env, childEntity).records
    .map(function (r) { return r.obj; })
    .filter(function (o) { return String(o[s.parentProp]) === String(parentId); });
  if (childEntity === 'templateFields') {
    var before = {};
    current.forEach(function (o) { before[o.fieldKey] = o.content; });
    var after = {};
    rows.forEach(function (r) { after[r.fieldKey] = r.content; });
    var out = [];
    Object.keys(after).forEach(function (k) {
      if (!(k in before)) out.push('欄「' + k + '」を追加');
      else if (before[k] !== after[k]) out.push('欄「' + k + '」を変更');
    });
    Object.keys(before).forEach(function (k) { if (!(k in after)) out.push('欄「' + k + '」を削除'); });
    return out;
  }
  var cols = s.cols.map(function (c) { return c[0]; }).filter(function (p) { return p !== s.parentProp; });
  var sig = function (list) { return JSON.stringify(list.map(function (o) { return cols.map(function (p) { return String(o[p] == null ? '' : o[p]); }); })); };
  return sig(current) === sig(rows) ? [] : ['欄の構成を変更'];
}

// 操作ログ・テンプレート履歴に残す名前。Google ログインならアカウントの名前（メール）、以前の方式なら画面が送る作成者名
function actorName_(req) {
  if (!req) return 'GASエディタ';
  if (req.user && req.user.via === 'google') return (req.user.name + '（' + req.user.email + '）').slice(0, 100);
  return str_(req.actor).slice(0, 50) || '（名前未入力）';
}

// あとから足したシート（操作ログ・テンプレート履歴）は、本番に無ければ作ってから読む
function ensureTable_(env, entity) {
  var table = loadTableIfExists_(env, entity);
  if (table && table.headers.length) return table;
  env.db.ensureSheet(SCHEMA[entity].sheet, schemaHeaders_(entity));
  return loadTable_(env, entity);
}

// あとから足した列（媒体の「コピー形式」など）が本番のシートに無ければ、末尾に足してから読み直す。
// 無いまま書き込むとその値が捨てられるため、追加・更新の前に呼ぶ
function withAllColumns_(env, table) {
  var s = table.schema;
  var missing = s.cols.filter(function (c) { return table.headers.indexOf(c[1]) < 0; });
  if (!missing.length) return table;
  env.db.ensureSheet(s.sheet, schemaHeaders_(table.entity, table.dynamicKeys));
  return loadTable_(env, table.entity);
}

function loadTableIfExists_(env, entity) {
  try {
    return loadTable_(env, entity);
  } catch (e) {
    if (e && e.appCode === 'SHEET_MISSING') return null;
    throw e;
  }
}

// 操作ログに書く。記録に失敗しても本来の操作は取り消さない。
// actor は画面が送る作成者名（本人確認ではなく記録用）。GAS エディタから直接呼んだ場合は req が無い
function writeLogs_(env, req, entries) {
  if (!entries.length) return;
  try {
    var s = SCHEMA.logs;
    var table = ensureTable_(env, 'logs');
    var actor = actorName_(req);
    var role = !req ? '' : req.user && req.user.via === 'google' ? (req.user.role === 'admin' ? '管理者' : '利用者') : safeEqual_(req.adminPass, env.props.adminPassword) ? '管理者' : '利用者';
    var at = env.now();
    env.db.appendRows(s.sheet, entries.map(function (e) {
      return toRow_(table, { at: at, actor: actor, role: role, action: e.action, entity: ENTITY_LABELS[e.entity] || e.entity, key: String(e.key == null ? '' : e.key), detail: String(e.detail || '').slice(0, 2000) });
    }));
  } catch (err) {
    // ログのシートが壊れていても本来の操作は成功させる
  }
}

// 新しい順に返す。操作ログのシートがまだ無ければ空
function actionListLogs_(payload, env) {
  var limit = Math.min(Math.max(Number(payload.limit) || 300, 1), 2000);
  var table = loadTableIfExists_(env, 'logs');
  if (!table) return [];
  // 同じ時刻の行は後に書いたものを先にする
  return table.records
    .map(function (r, i) { return { obj: r.obj, i: i }; })
    .sort(function (a, b) { return a.obj.at < b.obj.at ? 1 : a.obj.at > b.obj.at ? -1 : b.i - a.i; })
    .map(function (x) { return x.obj; })
    .slice(0, limit);
}

// ---------- テンプレートの変更履歴 ----------

var TEMPLATE_META_PROPS = ['name', 'setId', 'mediaId', 'rank', 'format', 'fileId'];

function fieldsFromRows_(rows) {
  var out = {};
  rows.forEach(function (r) { out[r.fieldKey] = r.content; });
  return out;
}

function currentTemplateFields_(env, templateId) {
  return fieldsFromRows_(loadTable_(env, 'templateFields').records
    .map(function (r) { return r.obj; })
    .filter(function (o) { return String(o.templateId) === String(templateId); }));
}

function templateRevisions_(env, templateId) {
  var table = loadTableIfExists_(env, 'templateRevisions');
  if (!table) return [];
  return table.records
    .map(function (r, i) { return { obj: r.obj, i: i }; })
    .filter(function (x) { return String(x.obj.templateId) === String(templateId); });
}

// 保存した時点の内容を1行で残す。記録に失敗しても保存そのものは成功させる
function saveTemplateRevision_(env, req, t, fields, at, actor) {
  try {
    var snapshot = { fields: fields || {} };
    TEMPLATE_META_PROPS.forEach(function (p) { snapshot[p] = t[p] == null ? '' : t[p]; });
    var table = ensureTable_(env, 'templateRevisions');
    env.db.appendRows(SCHEMA.templateRevisions.sheet, [toRow_(table, {
      templateId: t.id, at: at || env.now(), actor: actor || actorName_(req), snapshot: JSON.stringify(snapshot),
    })]);
  } catch (err) {
    // 変更履歴のシートが壊れていてもテンプレートの保存は成功させる
  }
}

// 新しい順。元に戻すときは画面が内容を編集画面に読み込み、管理者が update で保存する
function actionListTemplateRevisions_(payload, env) {
  requireText_(payload.templateId, 'テンプレID');
  return templateRevisions_(env, str_(payload.templateId))
    .sort(function (a, b) { return a.obj.at < b.obj.at ? 1 : a.obj.at > b.obj.at ? -1 : b.i - a.i; })
    .slice(0, 100)
    .map(function (x) {
      var snapshot = {};
      try { snapshot = JSON.parse(x.obj.snapshot || '{}'); } catch (e) { snapshot = {}; }
      return { at: x.obj.at, actor: x.obj.actor, template: snapshot };
    });
}

// ---------- 操作ログの整理（毎日の自動処理から呼ぶ） ----------

var LOG_ARCHIVE_SHEET = '操作ログ（過去分）';

/** 操作ログを新しい keep 行だけ残し、古い行を「操作ログ（過去分）」シートに移す。移した行数を返す */
function archiveLogs(db, keep) {
  var env = { db: db };
  var table = loadTableIfExists_(env, 'logs');
  if (!table) return 0;
  var old = table.records.slice(0, Math.max(table.records.length - keep, 0));
  if (!old.length) return 0;
  db.ensureSheet(LOG_ARCHIVE_SHEET, schemaHeaders_('logs'));
  var archive = db.readTable(LOG_ARCHIVE_SHEET);
  var archiveTable = { schema: SCHEMA.logs, fixed: fixedHeaderMap_(SCHEMA.logs), headers: archive.headers.map(function (h) { return String(h).trim(); }) };
  db.appendRows(LOG_ARCHIVE_SHEET, old.map(function (r) { return toRow_(archiveTable, r.obj); }));
  db.deleteRows(SCHEMA.logs.sheet, old.map(function (r) { return r.index; }));
  return old.length;
}

// ---------- 書類（PDF / Docx）と告知画像 ----------

function isDocumentFormat_(format) {
  return DOCUMENT_FORMATS.indexOf(format) >= 0;
}

// 雛形ファイル（Google ドキュメント / スライド）から作る出力形式
function isFileFormat_(format) {
  return isDocumentFormat_(format) || format === IMAGE_FORMAT;
}

function adapter_(env, name, label) {
  if (!env[name]) throw appError_('DOCS_UNAVAILABLE', label + 'に対応していない環境です');
  return env[name];
}

function templateAdapter_(env, format) {
  return format === IMAGE_FORMAT ? adapter_(env, 'slides', '告知画像の出力') : adapter_(env, 'docs', '書類の出力');
}

// 雛形の本文を読んで「本文」欄に写す。画面はこれを使って入力フォームとプレビューを作る
function fileChildren_(env, format, fileId) {
  return [{ fieldKey: '本文', content: templateAdapter_(env, format).readText(fileId) }];
}

// 画面からの { '{{団体名}}': '...' } のうち、差し込みの形をしたものだけを受け付ける
function tokenMap_(src) {
  var out = {};
  if (!src || typeof src !== 'object') return out;
  Object.keys(src).forEach(function (k) {
    if (/^\{\{[^{}]+\}\}$/.test(k)) out[k] = String(src[k] == null ? '' : src[k]);
  });
  return out;
}

function actionReadDocument_(payload, env) {
  requireText_(payload.fileId, '雛形ファイルID');
  return { text: templateAdapter_(env, payload.format).readText(str_(payload.fileId)) };
}

// replacements は画面側で解決済みの { '{{団体名}}': 'サンプル団体', '{{締結日:M/D}}': '9/24', ... }
// 告知画像では images に { '{{ロゴ}}': 画像のファイルID } を渡すと、その差し込みを書いた図形が画像に置き換わる
function actionRenderDocument_(payload, env) {
  var rec = findRecord_(loadTable_(env, 'templates'), payload.templateId);
  if (!rec) throw appError_('NOT_FOUND', 'テンプレートが見つかりません');
  var t = rec.obj;
  if (!isFileFormat_(t.format) || !t.fileId) throw appError_('VALIDATION', 'このテンプレートはファイルの出力に対応していません');
  var fileName = str_(payload.fileName).replace(/[\\/:*?"<>|]/g, '_') || t.name;
  var replacements = tokenMap_(payload.replacements);
  if (t.format === IMAGE_FORMAT) {
    return adapter_(env, 'slides', '告知画像の出力').render({ fileId: t.fileId, replacements: replacements, images: tokenMap_(payload.images), fileName: fileName });
  }
  var format = payload.format || t.format;
  oneOf_(format, DOCUMENT_FORMATS, '出力形式');
  return adapter_(env, 'docs', '書類の出力').render({ fileId: t.fileId, replacements: replacements, format: format, fileName: fileName });
}

var IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif'];
var MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// ロゴなどの画像を LOGO_FOLDER_ID のフォルダに保存し、ファイルIDを返す（追加なので利用者も可）
function actionUploadImage_(payload, env) {
  oneOf_(str_(payload.mimeType), IMAGE_MIME_TYPES, '画像の形式');
  var base64 = str_(payload.base64);
  requireText_(base64, '画像');
  if (base64.length * 3 / 4 > MAX_IMAGE_BYTES) throw appError_('VALIDATION', '画像は5MB以下にしてください');
  var fileName = str_(payload.fileName).replace(/[\\/:*?"<>|]/g, '_') || 'image';
  return { fileId: adapter_(env, 'files', '画像の保存').saveImage({ fileName: fileName, mimeType: str_(payload.mimeType), base64: base64 }) };
}

// 保存した画像を画面に表示するために読み出す（LOGO_FOLDER_ID 内のファイルだけ）
function actionReadImage_(payload, env) {
  requireText_(payload.fileId, '画像のファイルID');
  return adapter_(env, 'files', '画像の読み出し').readImage(str_(payload.fileId));
}

// ---------- 初期化 ----------

/** 全シートとヘッダーを用意し、空のシートにだけモックデータを入れる（既存データは消さない） */
function seedTables(db, now) {
  var orgKeys = MOCK_DATA.items.filter(function (i) { return i.category === '団体'; }).map(function (i) { return i.key; });
  var env = { db: db };
  var seeded = [];
  Object.keys(SCHEMA).forEach(function (entity) {
    var s = SCHEMA[entity];
    db.ensureSheet(s.sheet, schemaHeaders_(entity, orgKeys));
    var table = loadTable_(env, entity);
    var mock = MOCK_DATA[entity] || [];
    if (table.records.length || !mock.length) return;
    db.appendRows(s.sheet, mock.map(function (o) {
      var copy = JSON.parse(JSON.stringify(o));
      if (hasCol_(s, 'updatedAt') && !copy.updatedAt) copy.updatedAt = now;
      return toRow_(table, copy);
    }));
    seeded.push(s.sheet);
  });
  return seeded;
}
