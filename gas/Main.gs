/**
 * Webアプリの入口。「自分として実行」「全員（匿名ユーザーを含む）」でデプロイする。
 *
 * スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）:
 *   GOOGLE_CLIENT_ID Google ログインのクライアントID（FSIF Portal と共通。ID トークンの aud と照合する）
 *   ACCESS_GAS_URL   FSIF Access Manager の GAS の URL（…/exec）。使える人と役割（admin＝管理者）をここに問い合わせる
 *   ACCESS_TOOL_ID   Access Manager での kodama のツールID
 *   ACCESS_TOOL_KEY  Access Manager の GAS で issueToolKeys を実行して出た、kodama のキー
 *   USER_KEY         （以前の方式・移行期間だけ）利用者キー。消すと Google ログインだけになる
 *   ADMIN_PASSWORD   （以前の方式・移行期間だけ）管理者パスワード
 *   SPREADSHEET_ID  データのスプレッドシートID（スプレッドシートに紐づいたスクリプトなら省略可）
 *   LOGO_FOLDER_ID  団体ロゴなどの画像を保存するフォルダID（一般公開しない。告知画像の {{ロゴ}} はここの画像だけを使う）
 *   OUTPUT_FOLDER_ID 書類・告知画像を出力したときの控えを残すフォルダID（省略時は控えを残さない）
 *   BACKUP_FOLDER_ID スプレッドシートの毎日のバックアップを保存するフォルダID（省略時はバックアップしない）
 *
 * フロントは CORS のプリフライトを避けるため Content-Type: text/plain で JSON 文字列を POST する。
 */
function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'BAD_REQUEST' });
  }
  return json_(handleRequest(req, createEnv_()));
}

// 画面は POST でしか呼ばない。GET で届いたら（POST が途中で GET に変わった場合も）はっきりエラーにする
function doGet() {
  return json_({ ok: false, error: 'USE_POST', message: 'このURLは画面から POST で呼び出します（ブラウザで直接開いた場合や、転送で GET に変わった場合にこの応答になります）' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw appError_('SERVER_NOT_CONFIGURED', 'SPREADSHEET_ID が未設定です');
  return ss;
}

function createEnv_() {
  var props = PropertiesService.getScriptProperties();
  return {
    db: new SheetDb(getSpreadsheet_()),
    docs: new DocsAdapter(props.getProperty('OUTPUT_FOLDER_ID')),
    slides: new SlidesAdapter(props.getProperty('OUTPUT_FOLDER_ID'), new FilesAdapter(props.getProperty('LOGO_FOLDER_ID'))),
    files: new FilesAdapter(props.getProperty('LOGO_FOLDER_ID')),
    cache: CacheService.getScriptCache(),
    auth: createAuth_(props),
    props: {
      userKey: props.getProperty('USER_KEY'),
      adminPassword: props.getProperty('ADMIN_PASSWORD'),
      logoFolderId: props.getProperty('LOGO_FOLDER_ID'),
    },
    withLock: function (fn) {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(20000)) throw appError_('BUSY', 'ほかの保存処理が混み合っています。少し待ってから再度お試しください');
      try {
        return fn();
      } finally {
        lock.releaseLock();
      }
    },
    now: function () { return new Date(); },
  };
}

/**
 * Google ドキュメントの雛形を読み書きするアダプタ。
 * 雛形は「{{団体名}}」のような差し込みを書いた Google ドキュメント（Word ファイルはドライブで Google ドキュメントとして保存しておく）。
 */
function DocsAdapter(outputFolderId) {
  this.outputFolderId = outputFolderId || '';
}

DocsAdapter.prototype.open_ = function (fileId) {
  try {
    return DocumentApp.openById(fileId);
  } catch (e) {
    throw appError_('DOC_NOT_FOUND', '雛形のGoogleドキュメントを開けません（ID：' + fileId + '）。Word ファイルの場合はドライブで「Google ドキュメントとして保存」したものの ID を指定してください');
  }
};

DocsAdapter.prototype.readText = function (fileId) {
  var doc = this.open_(fileId);
  return [doc.getHeader(), doc.getBody(), doc.getFooter()]
    .filter(function (section) { return section; })
    .map(function (section) { return section.getText(); })
    .join('\n');
};

// 雛形を複製して差し込み、PDF / Docx に書き出して base64 で返す
DocsAdapter.prototype.render = function (opts) {
  this.open_(opts.fileId);
  var src = DriveApp.getFileById(opts.fileId);
  var folder = this.outputFolderId ? DriveApp.getFolderById(this.outputFolderId) : null;
  var copy = folder ? src.makeCopy(opts.fileName, folder) : src.makeCopy(opts.fileName);
  try {
    var doc = DocumentApp.openById(copy.getId());
    var escape = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
    [doc.getHeader(), doc.getBody(), doc.getFooter()].forEach(function (section) {
      if (!section) return;
      Object.keys(opts.replacements).forEach(function (token) {
        // 改行はドキュメント内の段落内改行にする
        section.replaceText(escape(token), opts.replacements[token].replace(/\r?\n/g, '\r'));
      });
    });
    doc.saveAndClose();
    var blob;
    var ext;
    if (opts.format === 'PDF') {
      blob = copy.getAs(MimeType.PDF);
      ext = '.pdf';
    } else {
      var url = 'https://docs.google.com/document/d/' + copy.getId() + '/export?format=docx';
      blob = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob();
      ext = '.docx';
    }
    return {
      fileName: opts.fileName + ext,
      mimeType: blob.getContentType(),
      base64: Utilities.base64Encode(blob.getBytes()),
      docUrl: folder ? copy.getUrl() : '',
    };
  } finally {
    if (!folder) copy.setTrashed(true);
  }
};

/**
 * ロゴなどの画像を LOGO_FOLDER_ID のフォルダに保存・読み出すアダプタ。
 * フォルダ外のファイルは読まない（利用者がドライブ上の別のファイルを指定して読み出せないようにする）。
 */
function FilesAdapter(folderId) {
  this.folderId = folderId || '';
}

FilesAdapter.prototype.folder_ = function () {
  if (!this.folderId) throw appError_('SERVER_NOT_CONFIGURED', 'スクリプトプロパティ LOGO_FOLDER_ID（画像の保存先フォルダ）が未設定です');
  return DriveApp.getFolderById(this.folderId);
};

FilesAdapter.prototype.file_ = function (fileId) {
  var file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (e) {
    throw appError_('IMAGE_NOT_FOUND', '画像が見つかりません（ID：' + fileId + '）');
  }
  var folderId = this.folder_().getId();
  var parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folderId) return file;
  throw appError_('IMAGE_NOT_FOUND', '画像は画像フォルダ（LOGO_FOLDER_ID）に保存したものだけ使えます（ID：' + fileId + '）');
};

FilesAdapter.prototype.saveImage = function (opts) {
  var blob = Utilities.newBlob(Utilities.base64Decode(opts.base64), opts.mimeType, opts.fileName);
  return this.folder_().createFile(blob).getId();
};

FilesAdapter.prototype.getBlob = function (fileId) {
  return this.file_(fileId).getBlob();
};

FilesAdapter.prototype.readImage = function (fileId) {
  var blob = this.getBlob(fileId);
  return { mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
};

/**
 * Google スライドの雛形から告知画像を作るアダプタ。
 * テキストの {{項目}} は差し込み、{{ロゴ}} などの画像用の差し込みを書いた図形は画像に置き換え、スライドごとに PNG で書き出す。
 */
function SlidesAdapter(outputFolderId, files) {
  this.outputFolderId = outputFolderId || '';
  this.files = files;
}

SlidesAdapter.prototype.open_ = function (fileId) {
  try {
    return SlidesApp.openById(fileId);
  } catch (e) {
    throw appError_('DOC_NOT_FOUND', '雛形のGoogleスライドを開けません（ID：' + fileId + '）。PowerPoint の場合はドライブで「Google スライドとして保存」したものの ID を指定してください');
  }
};

// 図形・表・グループの中の文字を集める
function slideTexts_(elements, out) {
  elements.forEach(function (el) {
    var type = el.getPageElementType();
    if (type === SlidesApp.PageElementType.SHAPE) {
      out.push(el.asShape().getText().asString().replace(/\n$/, ''));
    } else if (type === SlidesApp.PageElementType.TABLE) {
      var table = el.asTable();
      for (var r = 0; r < table.getNumRows(); r++) {
        for (var c = 0; c < table.getNumColumns(); c++) {
          try {
            out.push(table.getCell(r, c).getText().asString().replace(/\n$/, ''));
          } catch (e) {
            // 結合セルは読み飛ばす
          }
        }
      }
    } else if (type === SlidesApp.PageElementType.GROUP) {
      slideTexts_(el.asGroup().getChildren(), out);
    }
  });
  return out;
}

SlidesAdapter.prototype.readText = function (fileId) {
  return this.open_(fileId).getSlides()
    .map(function (slide) { return slideTexts_(slide.getPageElements(), []).filter(String).join('\n'); })
    .join('\n---\n');
};

// 画像用の差し込みを書いた図形を画像に置き換える（画像が無ければ差し込みを消す）
SlidesAdapter.prototype.replaceImages_ = function (elements, images) {
  var self = this;
  elements.forEach(function (el) {
    var type = el.getPageElementType();
    if (type === SlidesApp.PageElementType.GROUP) {
      self.replaceImages_(el.asGroup().getChildren(), images);
      return;
    }
    if (type !== SlidesApp.PageElementType.SHAPE) return;
    var shape = el.asShape();
    var text = shape.getText().asString();
    Object.keys(images).forEach(function (token) {
      if (text.indexOf(token) < 0) return;
      if (images[token]) shape.replaceWithImage(self.files.getBlob(images[token]));
      else shape.getText().replaceAllText(token, '');
    });
  });
};

SlidesAdapter.prototype.render = function (opts) {
  this.open_(opts.fileId);
  var src = DriveApp.getFileById(opts.fileId);
  var folder = this.outputFolderId ? DriveApp.getFolderById(this.outputFolderId) : null;
  var copy = folder ? src.makeCopy(opts.fileName, folder) : src.makeCopy(opts.fileName);
  var self = this;
  try {
    var pres = SlidesApp.openById(copy.getId());
    var slideIds = pres.getSlides().map(function (slide) {
      self.replaceImages_(slide.getPageElements(), opts.images);
      return slide.getObjectId();
    });
    Object.keys(opts.replacements).forEach(function (token) {
      pres.replaceAllText(token, opts.replacements[token]);
    });
    pres.saveAndClose();
    var token = ScriptApp.getOAuthToken();
    var images = slideIds.map(function (pageId, i) {
      var url = 'https://docs.google.com/presentation/d/' + copy.getId() + '/export/png?pageid=' + pageId;
      var blob = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token } }).getBlob();
      return {
        fileName: opts.fileName + (slideIds.length > 1 ? '_' + (i + 1) : '') + '.png',
        mimeType: 'image/png',
        base64: Utilities.base64Encode(blob.getBytes()),
      };
    });
    return { images: images, docUrl: folder ? copy.getUrl() : '' };
  } finally {
    if (!folder) copy.setTrashed(true);
  }
};

// ---------- Google ログイン（FSIF Access Manager で権限を決める） ----------

var ID_TOKEN_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
var AUTH_CACHE_SECONDS = 300; // ID トークンの検証結果・Access Manager の権限を覚えておく秒数

/** 4つのスクリプトプロパティがそろっていれば Google ログインのアダプタを返す（無ければ null） */
function createAuth_(props) {
  var clientId = props.getProperty('GOOGLE_CLIENT_ID');
  var accessUrl = props.getProperty('ACCESS_GAS_URL');
  var toolId = props.getProperty('ACCESS_TOOL_ID');
  var toolKey = props.getProperty('ACCESS_TOOL_KEY');
  if (!clientId || !accessUrl || !toolId || !toolKey) return null;
  var cache = CacheService.getScriptCache();
  var digest = function (text) {
    return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
  };
  return {
    // tokeninfo で署名・期限を確かめ、aud（クライアントID）・iss・メールの確認済みを照合する
    verifyIdToken: function (idToken) {
      var key = 'idt:' + digest(idToken);
      var hit = cache.get(key);
      if (hit) return JSON.parse(hit);
      var fail = function () { return appError_('UNAUTHORIZED', 'Google のログインが切れています。ログインし直してください'); };
      var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) throw fail();
      var info = JSON.parse(res.getContentText());
      var exp = Number(info.exp);
      if (info.aud !== clientId || ID_TOKEN_ISSUERS.indexOf(info.iss) < 0 || !(exp * 1000 > Date.now()) || String(info.email_verified) !== 'true') throw fail();
      var who = { email: String(info.email || '').toLowerCase(), name: String(info.name || '').slice(0, 100) };
      var ttl = Math.min(AUTH_CACHE_SECONDS, Math.floor(exp - Date.now() / 1000));
      if (ttl > 0) cache.put(key, JSON.stringify(who), ttl);
      return who;
    },
    // Access Manager の実効権限を問い合わせる。問い合わせできなければ通さない
    checkAccess: function (email) {
      var key = 'acc:' + email;
      var hit = cache.get(key);
      if (hit) return JSON.parse(hit);
      var body;
      try {
        var res = UrlFetchApp.fetch(accessUrl, {
          method: 'post',
          contentType: 'text/plain;charset=utf-8',
          payload: JSON.stringify({ action: 'checkAccess', payload: { toolId: toolId, key: toolKey, email: email } }),
          followRedirects: true,
          muteHttpExceptions: true,
        });
        body = JSON.parse(res.getContentText());
      } catch (e) {
        throw appError_('ACCESS_UNAVAILABLE', 'Access Manager に問い合わせできませんでした。少し待ってからもう一度お試しください');
      }
      if (!body.ok) throw appError_('ACCESS_UNAVAILABLE', 'Access Manager に問い合わせできませんでした：' + ((body.error && body.error.message) || '不明なエラー'));
      var d = body.data;
      var access = { allowed: !!d.allowed, roleKey: String(d.roleKey || ''), name: String(d.name || ''), reason: String(d.reason || '') };
      cache.put(key, JSON.stringify(access), AUTH_CACHE_SECONDS);
      return access;
    },
  };
}

/** GASエディタから手動実行：Access Manager につながるか確かめる（メールアドレスを書き換えて実行） */
function testAccessLink() {
  var auth = createAuth_(PropertiesService.getScriptProperties());
  if (!auth) return Logger.log('Google ログインの設定がそろっていません：GOOGLE_CLIENT_ID・ACCESS_GAS_URL・ACCESS_TOOL_ID・ACCESS_TOOL_KEY');
  Logger.log(JSON.stringify(auth.checkAccess('ここにメールアドレス')));
}

/** GASエディタから手動実行：全シートとヘッダーを作成し、空のシートにモックデータを投入する */
function setup() {
  var seeded = seedTables(new SheetDb(getSpreadsheet_()), new Date());
  var props = PropertiesService.getScriptProperties();
  ['GOOGLE_CLIENT_ID', 'ACCESS_GAS_URL', 'ACCESS_TOOL_ID', 'ACCESS_TOOL_KEY'].forEach(function (k) {
    if (!props.getProperty(k)) Logger.log('スクリプトプロパティ ' + k + ' が未設定です（Google ログインに必要）');
  });
  Logger.log('モックデータを投入したシート: ' + (seeded.length ? seeded.join(', ') : 'なし（既存データを保持）'));
}

// ---------- 毎日の自動処理（バックアップ・操作ログの整理） ----------

var BACKUP_KEEP = 30; // バックアップを残す数（古いものからゴミ箱へ）
var LOG_KEEP_ROWS = 3000; // 操作ログのシートに残す行数（古い行は「操作ログ（過去分）」へ）

/** GASエディタから一度だけ手動実行：毎日 3〜4時に dailyMaintenance が動くようにする（何度実行しても1つだけ） */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyMaintenance') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyMaintenance').timeBased().everyDays(1).atHour(3).create();
  Logger.log('毎日 3〜4時に dailyMaintenance を実行するよう設定しました');
}

/** 毎日の自動処理。GASエディタから手動で実行してもよい */
function dailyMaintenance() {
  var ss = getSpreadsheet_();
  backupSpreadsheet_(ss);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) {
    Logger.log('ほかの保存処理が混み合っていたため、操作ログの整理は次回にします');
    return;
  }
  try {
    Logger.log('操作ログを過去分シートに移した行数: ' + archiveLogs(new SheetDb(ss), LOG_KEEP_ROWS));
  } finally {
    lock.releaseLock();
  }
}

// スプレッドシートを BACKUP_FOLDER_ID のフォルダに丸ごとコピーし、古いバックアップを BACKUP_KEEP 個まで減らす
function backupSpreadsheet_(ss) {
  var folderId = PropertiesService.getScriptProperties().getProperty('BACKUP_FOLDER_ID');
  if (!folderId) {
    Logger.log('スクリプトプロパティ BACKUP_FOLDER_ID が未設定のため、バックアップは省略しました');
    return;
  }
  var folder = DriveApp.getFolderById(folderId);
  var prefix = 'バックアップ_' + ss.getName() + '_';
  var name = prefix + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd_HHmm');
  DriveApp.getFileById(ss.getId()).makeCopy(name, folder);
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getName().indexOf(prefix) === 0) files.push(f);
  }
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); });
  Logger.log('バックアップを作成しました: ' + name + '（保存数 ' + Math.min(files.length, BACKUP_KEEP) + '）');
}
