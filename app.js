// app.js
// 畑管理PWA 試作1号：勤怠＋作業＋IndexedDB＋同期（写真撮影/スタンプ/IndexedDB保存 追加）

// ============================
// 1. 設定
// ============================
// ★必ず自分の WebアプリURL に書き換えてください
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwUG5v7e7YuUMJ0A8YDtkmOcHbMYKPgoDWYN6tbfjaBVoxGXMx_v6xj9LNuwfi-CoD9/exec';
const API_TOKEN = '6F1c9a7b3d2E4f05a1b9c8d2e7f5A4b3';

const DB_NAME = 'farmCoreDB';
const DB_VERSION = 3; // 写真ストア追加のため更新

const STORE_SHIFTS = 'shifts';
const STORE_TASKS = 'tasks';
const STORE_DAILY_WEATHER = 'dailyWeather';
const STORE_PHOTOS = 'photos';

const TZ_OFFSET_MINUTES = 0; // ここではブラウザのローカル時刻をそのまま使う

// 画面上の状態保持
let currentShiftLocalId = null;
let currentTaskLocalId = null;
let currentWorkerId = null;   // 現在出勤中の作業者ID
let currentWorkerName = null; // 現在出勤中の作業者名（プルダウンの表示名）
let pausedTaskTemplate = null; // 休憩で一時停止した作業のテンプレート

// ============================
// 2. ユーティリティ
// ============================

// URLクエリから畝ID・圃場ID・ハウスIDを初期値として各入力欄に入れる
function applyLocationFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const fieldId = params.get('fieldId') || '';
  const houseId = params.get('houseId') || '';
  const bedId = params.get('bedId') || '';

  // 圃場ID（5. 日別気温・地温入力）
  if (fieldId) {
    const fieldInput = document.getElementById('dailyFieldIdInput');
    if (fieldInput && !fieldInput.value) {
      fieldInput.value = fieldId;
    }
  }

  // ハウスID（ハウスの場合。路地ならQR側で空欄や「ROJI」などを入れる）
  if (houseId) {
    const houseInput = document.getElementById('dailyHouseIdInput');
    if (houseInput && !houseInput.value) {
      houseInput.value = houseId;
    }
  }

  // 畝ID（「3. 作業操作」の入力欄。日別気温・地温保存時にも共用）
  if (bedId) {
    const bedInput = document.getElementById('bedIdInput');
    if (bedInput && !bedInput.value) {
      bedInput.value = bedId;
    }
  }
}

function log(message) {
  const area = document.getElementById('log');
  const time = new Date().toLocaleTimeString();
  area.textContent += `[${time}] ${message}\n`;
  area.scrollTop = area.scrollHeight;
}

// ============================
// マスタ読込（JSONP）
// ============================
function clearSelectKeepFirst(selectEl) {
  if (!selectEl) return;
  while (selectEl.options.length > 1) {
    selectEl.remove(1);
  }
}

function workerIdOf(w) {
  if (!w) return '';
  const v = (w.id ?? w.workerId ?? w.worker_id ?? w.code ?? w.value ?? '');
  return (v === null || v === undefined) ? '' : String(v);
}
function workerLabelOf(w) {
  if (!w) return '';
  return String(w.label ?? w.displayName ?? w.workerName ?? w.name ?? workerIdOf(w) ?? '');
}

function taskIdOf(t) {
  if (!t) return '';
  const v = (t.id ?? t.taskId ?? t.task_id ?? t.code ?? t.value ?? '');
  return (v === null || v === undefined) ? '' : String(v);
}
function taskLabelOf(t) {
  if (!t) return '';
  return String(t.name ?? t.label ?? t.taskName ?? t.title ?? taskIdOf(t) ?? '');
}

function weatherIdOf(w) {
  if (!w) return '';
  const v = (w.id ?? w.weatherId ?? w.weather_id ?? w.code ?? w.value ?? '');
  return (v === null || v === undefined) ? '' : String(v);
}
function weatherLabelOf(w) {
  if (!w) return '';
  return String(w.name ?? w.label ?? w.weatherName ?? w.title ?? weatherIdOf(w) ?? '');
}

function loadMastersViaJsonp() {
  return new Promise((resolve, reject) => {
    const callbackName = '__cbMasters_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    const timeoutMs = 15000;
    let done = false;
    let script = null;
    let timer = null;

    const cleanup = () => {
      try { delete window[callbackName]; } catch (e) { window[callbackName] = undefined; }
      if (script && script.parentNode) script.parentNode.removeChild(script);
      if (timer) clearTimeout(timer);
    };

    window[callbackName] = (data) => {
      done = true;
      try {
        resolve(data);
      } finally {
        cleanup();
      }
    };

    const src =
      WEB_APP_URL
      + '?type=masters'
      + '&token=' + encodeURIComponent(API_TOKEN)
      + '&callback=' + encodeURIComponent(callbackName)
      + '&_=' + Date.now();

    script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onerror = () => {
      if (done) return;
      cleanup();
      reject(new Error('masters script load failed: ' + src));
    };

    timer = setTimeout(() => {
      if (done) return;
      cleanup();
      reject(new Error('masters timeout: ' + src));
    }, timeoutMs);

    document.head.appendChild(script);
  });
}

function applyMastersToPullDown(data) {
  if (!data) throw new Error('masters empty');
  if (data.error) throw new Error('masters error: ' + data.error);

  const workers = Array.isArray(data.workers) ? data.workers : [];
  const tasks   = Array.isArray(data.tasks) ? data.tasks : [];

  // 天候は、サーバ側のキー揺れに備えて複数候補を許容
  const weathers =
    Array.isArray(data.weathers) ? data.weathers :
    Array.isArray(data.weather)  ? data.weather  :
    Array.isArray(data.weatherTypes) ? data.weatherTypes :
    [];

  const workerSelect  = document.getElementById('workerSelect');
  const taskSelect    = document.getElementById('taskTypeSelect');
  const weatherSelect = document.getElementById('weatherTypeSelect');

  // いったん「現在の選択値」を退避（再描画後に復元するため）
  const prevWorkerValue  = workerSelect  ? String(workerSelect.value  || '') : '';
  const prevTaskValue    = taskSelect    ? String(taskSelect.value    || '') : '';
  const prevWeatherValue = weatherSelect ? String(weatherSelect.value || '') : '';

  clearSelectKeepFirst(workerSelect);
  clearSelectKeepFirst(taskSelect);
  clearSelectKeepFirst(weatherSelect);

  workers.forEach((w) => {
    const id = workerIdOf(w);
    const label = workerLabelOf(w);
    if (!id) return;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label || id;
    workerSelect.appendChild(opt);
  });

  tasks.forEach((t) => {
    const id = taskIdOf(t);
    const label = taskLabelOf(t);
    if (!id) return;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label || id;
    taskSelect.appendChild(opt);
  });

  weathers.forEach((w) => {
    const id = weatherIdOf(w);
    const label = weatherLabelOf(w);
    if (!id) return;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label || id;
    weatherSelect.appendChild(opt);
  });

  // マスタ作り直し後に、可能なら元の選択を復元
  if (prevWorkerValue)  setSelectValueIfExists(workerSelect,  prevWorkerValue);
  if (prevTaskValue)    setSelectValueIfExists(taskSelect,    prevTaskValue);
  if (prevWeatherValue) setSelectValueIfExists(weatherSelect, prevWeatherValue);

  log(`マスタ反映完了 workers=${workers.length} tasks=${tasks.length} weathers=${weathers.length}`);
}

async function initMasters() {
  log('masters 読込開始…');
  const data = await loadMastersViaJsonp();
  console.log('[masters] raw:', data);
  applyMastersToPullDown(data);

  // ★マスタ反映が終わった後に「自動復帰」を実行
  try {
    await restoreCurrentStateFromIndexedDB();
    log('自動復帰：完了');
  } catch (e) {
    log('自動復帰：失敗 ' + (e && e.message ? e.message : e));
  }

  // 画面表示を更新（復帰結果を反映）
  updateStatuses();
}

function formatDateForSheet(date) {
  const y = date.getFullYear();
  const m = ('0' + (date.getMonth() + 1)).slice(-2);
  const d = ('0' + date.getDate()).slice(-2);
  return `${y}/${m}/${d}`;
}

function formatTime(date) {
  const hh = ('0' + date.getHours()).slice(-2);
  const mm = ('0' + date.getMinutes()).slice(-2);
  const ss = ('0' + date.getSeconds()).slice(-2);
  return `${hh}:${mm}:${ss}`;
}

function setSelectValueIfExists(selectEl, value) {
  if (!selectEl) return false;
  const v = String(value || '').trim();
  if (!v) return false;
  const exists = Array.from(selectEl.options).some(o => String(o.value) === v);
  if (!exists) return false;
  selectEl.value = v;
  return true;
}

function setSelectByTextIfExists(selectEl, text) {
  if (!selectEl) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  const opt = Array.from(selectEl.options).find(o => String(o.textContent || '').trim() === t);
  if (!opt) return false;
  selectEl.value = opt.value;
  return true;
}

async function getAllRecords(storeName) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const records = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return records;
}

// ============================
// 3. IndexedDB
// ============================
function openFarmCoreDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_SHIFTS)) {
        const store = db.createObjectStore(STORE_SHIFTS, { keyPath: 'localId' });
        store.createIndex('isSynced', 'isSynced', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_TASKS)) {
        const store = db.createObjectStore(STORE_TASKS, { keyPath: 'localId' });
        store.createIndex('isSynced', 'isSynced', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_DAILY_WEATHER)) {
        const store = db.createObjectStore(STORE_DAILY_WEATHER, { keyPath: 'localId' });
        store.createIndex('isSynced', 'isSynced', { unique: false });
      }

      // 写真ストア（Blobを保存）
      if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
        const store = db.createObjectStore(STORE_PHOTOS, { keyPath: 'localId' });
        store.createIndex('isSynced', 'isSynced', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function createLocalRecord(type, data) {
  const now = new Date().toISOString();
  const prefix =
    type === 'kintai' ? 'shift-' :
    type === 'sagyo' ? 'task-' :
    type === 'dailyWeather' ? 'daily-' :
    type === 'photo' ? 'photo-' :
    'rec-';

  const localId = prefix + Date.now();
  return { localId, type, serverId: null, isSynced: false, data, createdAt: now, updatedAt: now };
}

// 勤怠保存
async function saveKintaiLocal(data) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(STORE_SHIFTS, 'readwrite');
  const store = tx.objectStore(STORE_SHIFTS);
  const record = createLocalRecord('kintai', data);
  store.put(record);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve(record.localId); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// 作業保存
async function saveSagyoLocal(data) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(STORE_TASKS, 'readwrite');
  const store = tx.objectStore(STORE_TASKS);
  const record = createLocalRecord('sagyo', data);
  store.put(record);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve(record.localId); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// 日別気温・地温保存
async function saveDailyWeatherLocal(data) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(STORE_DAILY_WEATHER, 'readwrite');
  const store = tx.objectStore(STORE_DAILY_WEATHER);
  const record = createLocalRecord('dailyWeather', data);
  store.put(record);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve(record.localId); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// 写真保存（Blobを含む）
async function savePhotoLocal(meta, blob) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(STORE_PHOTOS, 'readwrite');
  const store = tx.objectStore(STORE_PHOTOS);

  const record = createLocalRecord('photo', { meta: meta || {} });

  // Blobはrecord直下に置く（そのままIndexedDBに保存可能）
  record.blob = blob;
  record.mimeType = (meta && meta.mimeType) ? meta.mimeType : 'image/jpeg';

  store.put(record);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve(record.localId); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// 勤怠の更新
async function updateShiftLocal(localId, updater) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(STORE_SHIFTS, 'readwrite');
  const store = tx.objectStore(STORE_SHIFTS);

  const record = await new Promise((resolve, reject) => {
    const req = store.get(localId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  if (!record) {
    db.close();
    throw new Error('勤怠レコードが見つかりません: ' + localId);
  }

  updater(record);

  // ★更新が入ったら「再同期対象」に戻す
  record.isSynced = false;
  record.serverId = null;

  record.updatedAt = new Date().toISOString();
  store.put(record);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// 作業の更新
async function updateTaskLocal(localId, updater) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(STORE_TASKS, 'readwrite');
  const store = tx.objectStore(STORE_TASKS);

  const record = await new Promise((resolve, reject) => {
    const req = store.get(localId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  if (!record) {
    db.close();
    throw new Error('作業レコードが見つかりません: ' + localId);
  }

  updater(record);

  // ★更新が入ったら「再同期対象」に戻す
  record.isSynced = false;
  record.serverId = null;

  record.updatedAt = new Date().toISOString();
  store.put(record);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// 作業レコード取得
async function getTaskLocal(localId) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(STORE_TASKS, 'readonly');
  const store = tx.objectStore(STORE_TASKS);

  const record = await new Promise((resolve, reject) => {
    const req = store.get(localId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  db.close();
  return record || null;
}

// 写真レコード取得
async function getPhotoLocal(localId) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(STORE_PHOTOS, 'readonly');
  const store = tx.objectStore(STORE_PHOTOS);

  const record = await new Promise((resolve, reject) => {
    const req = store.get(localId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  db.close();
  return record || null;
}

// 未同期レコード取得（全件取得後に絞り込み）
async function getUnsynced(storeName) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);

  const records = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  db.close();
  return records.filter(r => !r.isSynced);
}

// 同期済みフラグ更新
async function markSynced(storeName, localIds, serverIds) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);

  for (let i = 0; i < localIds.length; i++) {
    const localId = localIds[i];
    const serverId = serverIds[i] || null;

    const record = await new Promise((resolve, reject) => {
      const req = store.get(localId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    if (record) {
      record.isSynced = true;
      record.serverId = serverId;
      record.updatedAt = new Date().toISOString();
      store.put(record);
    }
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}


// ============================
// 自動復帰（IndexedDBから「未退勤」「未終了」を探す）
// ※貼り付け場所：markSynced の直後、// 4. 同期処理 の前
// ============================

async function countUnsynced_(storeName) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);

  const records = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  db.close();

  const unsynced = records.filter(r => !r || r.isSynced !== true);
  return { total: records.length, unsynced: unsynced.length, sample: unsynced[0] || null };
}


async function getAllRecords(storeName) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);

  const records = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  db.close();
  return records;
}

function pickLatest(records) {
  if (!records || records.length === 0) return null;
  const sorted = records.slice().sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
    const tb = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
    return tb - ta;
  });
  return sorted[0] || null;
}

async function restoreCurrentStateFromIndexedDB() {
  // 1) 未退勤の勤怠（退勤時刻が空）を探す
  const shifts = await getAllRecords(STORE_SHIFTS);
  const activeShifts = shifts.filter(r => {
    const d = r && r.data ? r.data : null;
    if (!d) return false;
    const out = String(d['退勤時刻'] || '').trim();
    return out === '';
  });

  const shiftRec = pickLatest(activeShifts);

  if (!shiftRec) {
    currentShiftLocalId = null;
    currentWorkerId = null;
    currentWorkerName = null;
    currentTaskLocalId = null;

    const workerSelect = document.getElementById('workerSelect');
    if (workerSelect) workerSelect.disabled = false;

    updateStatuses();
    log('自動復帰: 未退勤の勤怠なし');
    return;
  }

  currentShiftLocalId = shiftRec.localId;

  const sd = shiftRec.data || {};
  currentWorkerId = String(sd['作業者ID'] || '').trim() || null;
  currentWorkerName = String(sd['作業者名'] || '').trim() || null;

  // マスタ反映後なら、作業者プルダウンを合わせる（存在すれば）
  const workerSelect = document.getElementById('workerSelect');
  if (workerSelect && currentWorkerId) {
    setSelectValueIfExists(workerSelect, currentWorkerId);
    workerSelect.disabled = true; // 出勤中は作業者のすり替えを防止
  }

  // 2) 未終了の作業（終了時刻が空）を探す（勤怠IDが一致するものだけ）
  const tasks = await getAllRecords(STORE_TASKS);
  const activeTasks = tasks.filter(r => {
    const d = r && r.data ? r.data : null;
    if (!d) return false;
    const end = String(d['終了時刻'] || '').trim();
    const kintaiId = String(d['勤怠ID'] || '').trim();
    return end === '' && kintaiId === currentShiftLocalId;
  });

  const taskRec = pickLatest(activeTasks);
  currentTaskLocalId = taskRec ? taskRec.localId : null;

  // 作業があれば、畝ID入力と作業種別プルダウンも復元
  if (taskRec && taskRec.data) {
    const td = taskRec.data;

    // 畝ID（URLがあっても、入力欄が空なら復元）
    const bedId = String(td['畝ID'] || '').trim();
    const bedInput = document.getElementById('bedIdInput');
    if (bedInput && bedId && !String(bedInput.value || '').trim()) {
      bedInput.value = bedId;
    }

    // 作業種別
    const taskSelect = document.getElementById('taskTypeSelect');
    const typeId = String(td['作業種別ID'] || '').trim();
    const typeName = String(td['作業種別名'] || td['作業種別'] || '').trim();

    let ok = false;
    if (typeId) ok = setSelectValueIfExists(taskSelect, typeId);
    if (!ok && typeName) ok = setSelectByTextIfExists(taskSelect, typeName);

    if (!ok && (typeId || typeName)) {
      log(`作業種別の復元に失敗: 作業種別ID=${typeId} 作業種別名=${typeName}`);
    }
  }

  updateStatuses();

  if (currentTaskLocalId) {
    log(`自動復帰: 出勤中 かつ 作業中 を復帰しました（shift=${currentShiftLocalId}, task=${currentTaskLocalId}）`);
  } else {
    log(`自動復帰: 出勤中（作業なし）を復帰しました（shift=${currentShiftLocalId}）`);
  }
}

// ============================
// 4. 同期処理（no-cors 版）
// ============================
async function syncAll() {
  log('同期開始…');

  // 1) 勤怠の同期
  const unsyncedShifts = await getUnsynced(STORE_SHIFTS);
  if (unsyncedShifts.length > 0) {
    log(`未同期の勤怠: ${unsyncedShifts.length}件`);

    const payload = {
      token: API_TOKEN,
      type: 'kintai',
      records: unsyncedShifts.map(r => {
        const data = Object.assign({}, r.data);
        data.localId = r.localId;
        return data;
      })
    };

    const localIds = unsyncedShifts.map(r => r.localId);

    try {
      await fetch(WEB_APP_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
      });

      log('勤怠データをWebアプリへ送信しました（no-cors）');

      const serverIds = localIds.map(() => null);
      await markSynced(STORE_SHIFTS, localIds, serverIds);
    } catch (err) {
      log('勤怠同期エラー: ' + err);
    }
  } else {
    log('未同期の勤怠はありません');
  }

  // 2) 作業の同期
const unsyncedTasks = await getUnsynced(STORE_TASKS);
if (unsyncedTasks.length > 0) {
  log(`未同期の作業: ${unsyncedTasks.length}件`);

  const payload = {
    token: API_TOKEN,
    type: 'sagyo',
    records: unsyncedTasks.map(r => {
  const data = Object.assign({}, r.data);

  // 送信時のID
  data.localId = r.localId;

  // 互換用（あなたのログで見ているキー）
  if (!String(data['ローカル作業ID'] || '').trim()) data['ローカル作業ID'] = r.localId;
  if (!String(data.taskLocalId || '').trim()) data.taskLocalId = r.localId;

  // ★ここが本丸：作業種別（表示用）が空なら、作業種別名から補完
  if (!String(data['作業種別'] || '').trim()) {
    const name = String(data['作業種別名'] || '').trim();
    data['作業種別'] = name;
  }

  return data;
})

  };

  const localIds = unsyncedTasks.map(r => r.localId);

  // ===== デバッグログ：送信前に中身を確認 =====
  try {
    const first = payload.records[0] || {};
    const keys = [
      '作業者ID','作業者名','勤怠ID','畝ID','作業種別','作業種別名','作業種別ID',
      '開始時刻','終了時刻','メモ','ローカル作業ID','taskLocalId','localId'
    ];
    const pick = {};
    for (const k of keys) pick[k] = (k in first) ? first[k] : '(なし)';
    log('作業送信payload（先頭レコード要約）:\n' + JSON.stringify(pick, null, 2));
  } catch (e) {
    log('作業payloadログ出力失敗: ' + (e && e.message ? e.message : e));
  }
  // ===========================================

  try {
    await fetch(WEB_APP_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });

    // no-cors ではサーバ応答が読めないので、ここは「送信呼び出し完了」までしか保証できません
    log('作業データをWebアプリへ送信しました（no-cors / 応答は確認不可）');

    // ★デバッグ中は同期済みにしない（作業ログに届くまで再送できるようにする）
    // const serverIds = localIds.map(() => null);
    // await markSynced(STORE_TASKS, localIds, serverIds);

    log('デバッグ中のため、作業は同期済みにしません（再送可能）');
  } catch (err) {
    log('作業同期エラー: ' + err);
  }
} else {
  log('未同期の作業はありません');
}


  // 3) 日別気温・地温の同期
  const unsyncedDailyWeather = await getUnsynced(STORE_DAILY_WEATHER);
  if (unsyncedDailyWeather.length > 0) {
    log(`未同期の日別気温・地温: ${unsyncedDailyWeather.length}件`);

    const payload = {
      token: API_TOKEN,
      type: 'dailyWeather',
      records: unsyncedDailyWeather.map(r => {
        const data = Object.assign({}, r.data);
        data.localId = r.localId;
        return data;
      })
    };

    const localIds = unsyncedDailyWeather.map(r => r.localId);

    try {
      await fetch(WEB_APP_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
      });

      log('日別気温・地温データをWebアプリへ送信しました（no-cors）');

      const serverIds = localIds.map(() => null);
      await markSynced(STORE_DAILY_WEATHER, localIds, serverIds);
    } catch (err) {
      log('日別気温・地温同期エラー: ' + err);
    }
  } else {
    log('未同期の日別気温・地温はありません');
  }

  // 4) 写真の同期
  const unsyncedPhotos = await getUnsynced(STORE_PHOTOS);
  if (unsyncedPhotos.length > 0) {
    log(`未同期の写真: ${unsyncedPhotos.length}件`);

    const records = [];
    for (const r of unsyncedPhotos) {
      const meta = (r.data && r.data.meta) ? r.data.meta : {};
      const blob = r.blob;
      if (!blob) continue;

      const base64 = await blobToBase64(blob);
      records.push({
        localId: r.localId,
        ...meta,
        mimeType: r.mimeType || meta.mimeType || 'image/jpeg',
        base64: base64
      });
    }

    const payload = { token: API_TOKEN, type: 'photos', records };
    const localIds = unsyncedPhotos.map(r => r.localId);

    try {
      await fetch(WEB_APP_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
      });

      log('写真データをWebアプリへ送信しました（no-cors）');

      const serverIds = localIds.map(() => null);
      await markSynced(STORE_PHOTOS, localIds, serverIds);
    } catch (err) {
      log('写真同期エラー: ' + err);
    }
  } else {
    log('未同期の写真はありません');
  }

  log('同期完了');
}

// ============================
// 4.5 作業写真（開始/終了）：撮影・スタンプ・IndexedDB保存
// ============================
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function setImgPreview(imgEl, blob) {
  if (!imgEl) return;
  if (imgEl.dataset && imgEl.dataset.objUrl) {
    try { URL.revokeObjectURL(imgEl.dataset.objUrl); } catch (e) {}
    imgEl.dataset.objUrl = '';
  }
  const url = URL.createObjectURL(blob);
  if (imgEl.dataset) imgEl.dataset.objUrl = url;
  imgEl.src = url;
  imgEl.style.display = 'block';
}

function hideImgPreview(imgEl) {
  if (!imgEl) return;
  if (imgEl.dataset && imgEl.dataset.objUrl) {
    try { URL.revokeObjectURL(imgEl.dataset.objUrl); } catch (e) {}
    imgEl.dataset.objUrl = '';
  }
  imgEl.src = '';
  imgEl.style.display = 'none';
}

function setPhotoStatus(text) {
  const el = document.getElementById('photoStatus');
  if (el) el.textContent = text;
}

function readCurrentLocationInputs() {
  const fieldId = (document.getElementById('dailyFieldIdInput')?.value || '').trim();
  const houseId = (document.getElementById('dailyHouseIdInput')?.value || '').trim();
  const bedId = (document.getElementById('bedIdInput')?.value || '').trim();
  return { fieldId, houseId, bedId };
}

async function pickImageFileFromCamera() {
  // 1) getUserMedia が使える場合は、直接カメラを起動して撮影
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      const blob = await capturePhotoWithGetUserMedia();
      return blob;
    } catch (e) {
      log('getUserMedia撮影に失敗（フォールバックします）: ' + (e && e.message ? e.message : e));
    }
  }

  // 2) フォールバック：従来の file input
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) {
        reject(new Error('画像が選択されませんでした'));
        return;
      }
      resolve(file);
    };
    input.click();
  });
}

async function capturePhotoWithGetUserMedia() {
  return new Promise(async (resolve, reject) => {
    let stream = null;

    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.right = '0';
    overlay.style.bottom = '0';
    overlay.style.background = 'rgba(0,0,0,0.7)';
    overlay.style.zIndex = '9999';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.padding = '12px';

    const panel = document.createElement('div');
    panel.style.background = '#fff';
    panel.style.borderRadius = '10px';
    panel.style.padding = '10px';
    panel.style.width = '100%';
    panel.style.maxWidth = '420px';
    panel.style.boxSizing = 'border-box';

    const video = document.createElement('video');
    video.style.width = '100%';
    video.style.borderRadius = '8px';
    video.setAttribute('playsinline', '');
    video.autoplay = true;
    video.muted = true;

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    btnRow.style.marginTop = '10px';

    const btnShot = document.createElement('button');
    btnShot.textContent = '撮影';
    btnShot.className = 'primary';
    btnShot.style.flex = '1';

    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'キャンセル';
    btnCancel.className = 'secondary';
    btnCancel.style.flex = '1';

    btnRow.appendChild(btnShot);
    btnRow.appendChild(btnCancel);

    panel.appendChild(video);
    panel.appendChild(btnRow);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const cleanup = () => {
      try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      stream = null;
      try { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); } catch (e) {}
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
      video.srcObject = stream;
      try { await video.play(); } catch (e) {}
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }

    btnCancel.onclick = () => {
      cleanup();
      reject(new Error('撮影をキャンセルしました'));
    };

    btnShot.onclick = async () => {
      try {
        const w = video.videoWidth || 1280;
        const h = video.videoHeight || 720;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.drawImage(video, 0, 0, w, h);

        canvas.toBlob((blob) => {
          cleanup();
          if (!blob) {
            reject(new Error('撮影画像の生成に失敗しました'));
            return;
          }
          resolve(blob);
        }, 'image/jpeg', 0.92);
      } catch (e) {
        cleanup();
        reject(e);
      }
    };
  });
}

async function decodeImageToBitmap(fileOrBlob) {
  // EXIFの向きを反映できる環境では反映させる
  if (window.createImageBitmap) {
    try {
      const bmp = await createImageBitmap(fileOrBlob, { imageOrientation: 'from-image' });
      return { kind: 'bitmap', bmp };
    } catch (e) {}
  }

  const img = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileOrBlob);
    const i = new Image();
    i.onload = () => {
      try { URL.revokeObjectURL(url); } catch (e) {}
      resolve(i);
    };
    i.onerror = () => {
      try { URL.revokeObjectURL(url); } catch (e) {}
      reject(new Error('画像の読み込みに失敗しました'));
    };
    i.src = url;
  });

  return { kind: 'img', img };
}

function drawStampedImageToBlob(decoded, stampLines, opts) {
  const maxSide = (opts && opts.maxSide) ? opts.maxSide : 1600;
  const jpegQuality = (opts && opts.jpegQuality) ? opts.jpegQuality : 0.9;

  let srcW = 0, srcH = 0;
  if (decoded.kind === 'bitmap') {
    srcW = decoded.bmp.width;
    srcH = decoded.bmp.height;
  } else {
    srcW = decoded.img.naturalWidth || decoded.img.width;
    srcH = decoded.img.naturalHeight || decoded.img.height;
  }

  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const dstW = Math.max(1, Math.round(srcW * scale));
  const dstH = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = dstW;
  canvas.height = dstH;

  const ctx = canvas.getContext('2d', { alpha: false });

  // 画像描画
  if (decoded.kind === 'bitmap') {
    ctx.drawImage(decoded.bmp, 0, 0, dstW, dstH);
  } else {
    ctx.drawImage(decoded.img, 0, 0, dstW, dstH);
  }

  // スタンプ描画（左下）
  const padding = 10;
  const margin = 10;
  const fontSize = 18;
  const lineHeight = Math.round(fontSize * 1.3);

  ctx.font = `${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'top';

  const lines = Array.isArray(stampLines) ? stampLines.filter(Boolean) : [];
  const measuredWidths = lines.map(l => ctx.measureText(l).width);

  const boxW = Math.min(dstW - margin * 2, Math.ceil(Math.max(0, ...measuredWidths) + padding * 2));
  const boxH = Math.min(dstH - margin * 2, Math.ceil(lines.length * lineHeight + padding * 2));

  const x = margin;
  const y = dstH - margin - boxH;

  // 背景
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y, boxW, boxH);

  // 文字
  ctx.fillStyle = '#ffffff';
  const textX = x + padding;
  let textY = y + padding;

  for (const line of lines) {
    ctx.fillText(line, textX, textY, boxW - padding * 2);
    textY += lineHeight;
  }

  // JPEGで保存（容量を抑える）
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('画像の生成に失敗しました'));
        return;
      }
      resolve(blob);
    }, 'image/jpeg', jpegQuality);
  });
}

async function refreshPhotoUi() {
  const startImg = document.getElementById('photoStartPreview');
  const endImg = document.getElementById('photoEndPreview');

  if (!currentTaskLocalId) {
    setPhotoStatus('作業なし');
    hideImgPreview(startImg);
    hideImgPreview(endImg);
    return;
  }

  const taskRec = await getTaskLocal(currentTaskLocalId);
  if (!taskRec || !taskRec.data) {
    setPhotoStatus('作業情報取得失敗');
    hideImgPreview(startImg);
    hideImgPreview(endImg);
    return;
  }

  const data = taskRec.data;
  const startLocalId = data['開始写真LocalId'] || '';
  const endLocalId = data['終了写真LocalId'] || '';

  if (!startLocalId && !endLocalId) {
    setPhotoStatus('未撮影');
    hideImgPreview(startImg);
    hideImgPreview(endImg);
    return;
  }

  if (startLocalId) {
    const p = await getPhotoLocal(startLocalId);
    if (p && p.blob) setImgPreview(startImg, p.blob);
  } else {
    hideImgPreview(startImg);
  }

  if (endLocalId) {
    const p = await getPhotoLocal(endLocalId);
    if (p && p.blob) setImgPreview(endImg, p.blob);
  } else {
    hideImgPreview(endImg);
  }

  if (startLocalId && endLocalId) {
    setPhotoStatus('開始/終了 撮影済み');
  } else if (startLocalId) {
    setPhotoStatus('開始のみ 撮影済み');
  } else {
    setPhotoStatus('終了のみ 撮影済み');
  }
}

async function takeTaskPhoto(kind) {
  // kind: 'start' / 'end'
  if (!currentShiftLocalId || !currentWorkerId) {
    alert('出勤していません（写真撮影は出勤後に行ってください）');
    return;
  }
  if (!currentTaskLocalId) {
    alert('作業中ではありません（写真は作業開始後、作業終了前に撮影してください）');
    return;
  }

  // クリックイベントの流れの中で即クリック（iOS対策）
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';

  input.onchange = async () => {
    try {
      const file = input.files && input.files[0];
      if (!file) return;

      const taskRec = await getTaskLocal(currentTaskLocalId);
      if (!taskRec || !taskRec.data) {
        alert('作業情報が取得できませんでした');
        return;
      }

      const now = new Date();
      const taskData = taskRec.data;
      const loc = readCurrentLocationInputs();

      const stampLines = [
        `日時: ${formatDateForSheet(now)} ${formatTime(now)}`,
        `作業者: ${taskData['作業者名'] || currentWorkerName || ''}`,
        `畝ID: ${taskData['畝ID'] || loc.bedId || ''}`,
        `作業: ${taskData['作業種別名'] || ''}`
      ];
      if (loc.fieldId) stampLines.push(`圃場ID: ${loc.fieldId}`);
      if (loc.houseId) stampLines.push(`ハウスID: ${loc.houseId}`);

      const decoded = await decodeImageToBitmap(file);
      const stampedBlob = await drawStampedImageToBlob(decoded, stampLines, { maxSide: 1600, jpegQuality: 0.9 });

      const meta = {
        kind: kind,
        taskLocalId: currentTaskLocalId,
        shiftLocalId: currentShiftLocalId,
        workerId: currentWorkerId,
        workerName: currentWorkerName,
        bedId: taskData['畝ID'] || loc.bedId || '',
        taskTypeId: taskData['作業種別ID'] || '',
        taskTypeName: taskData['作業種別名'] || '',
        takenAtISO: now.toISOString(),
        stampText: stampLines.join('\n'),
        mimeType: 'image/jpeg',
        originalName: file.name || '',
        originalType: file.type || '',
        originalSize: file.size || 0
      };

      const photoLocalId = await savePhotoLocal(meta, stampedBlob);

      await updateTaskLocal(currentTaskLocalId, (record) => {
        const d = record.data;
        if (kind === 'start') {
          d['開始写真LocalId'] = photoLocalId;
          d['開始写真あり'] = true;
          d['開始写真URL'] = '';
        } else {
          d['終了写真LocalId'] = photoLocalId;
          d['終了写真あり'] = true;
          d['終了写真URL'] = '';
        }
      });

      log(`写真を保存（kind=${kind}, photoLocalId=${photoLocalId}, taskLocalId=${currentTaskLocalId}）`);
      await refreshPhotoUi();

    } catch (err) {
      log('写真撮影エラー: ' + err);
      alert('写真の保存に失敗しました');
    } finally {
      input.value = '';
    }
  };

  input.click();
}

// ============================
// 5. 画面イベント（勤怠）
// ============================
function updateStatuses() {
  document.getElementById('shiftStatus').textContent = currentShiftLocalId ? `出勤中（${currentShiftLocalId}）` : '未出勤';
  document.getElementById('taskStatus').textContent = currentTaskLocalId ? `作業中（${currentTaskLocalId}）` : '作業なし';

  // 写真UIも追随
  refreshPhotoUi().catch(err => log('写真UI更新エラー: ' + err));
}

async function onClockIn() {
  const workerSelect = document.getElementById('workerSelect');
  const workerId = workerSelect.value;
  const workerLabel = workerSelect.options[workerSelect.selectedIndex].text;

  if (!workerId) {
    alert('作業者を選択してください');
    return;
  }
  if (currentShiftLocalId) {
    alert('すでに出勤中です');
    return;
  }

  const now = new Date();
  const startISO = now.toISOString();

  const data = {
    勤怠ID: '',
    作業者ID: workerId,
    作業者名: workerLabel,
    日付: formatDateForSheet(now),
    出勤時刻: formatTime(now),
    退勤時刻: '',
    休憩合計分: 0,
    休憩詳細: '',
    実働分: 0,
    メモ: '',
    __startISO: startISO,
    __breakTotalMs: 0,
    __breakCurrentStartISO: null
  };

  const localId = await saveKintaiLocal(data);

  currentShiftLocalId = localId;
  currentWorkerId = workerId;
  currentWorkerName = workerLabel;

  updateStatuses();
  log(`出勤を保存（localId=${localId}）`);
}

async function onClockOut() {
  if (!currentShiftLocalId) {
    alert('出勤していません');
    return;
  }

  const now = new Date();

  await updateShiftLocal(currentShiftLocalId, (record) => {
    const data = record.data;
    data['退勤時刻'] = formatTime(now);

    const startISO = data['__startISO'];
    let breakTotalMs = data['__breakTotalMs'] || 0;
    const breakCurrentISO = data['__breakCurrentStartISO'];

    if (breakCurrentISO) {
      const breakStart = new Date(breakCurrentISO);
      breakTotalMs += (now - breakStart);
      data['__breakCurrentStartISO'] = null;
      data['__breakTotalMs'] = breakTotalMs;
    }

    if (startISO) {
      const startDate = new Date(startISO);
      const workMs = (now - startDate) - breakTotalMs;
      const breakMinutes = Math.max(0, Math.round(breakTotalMs / 60000));
      const workMinutes = Math.max(0, Math.round(workMs / 60000));
      data['休憩合計分'] = breakMinutes;
      data['実働分'] = workMinutes;
    }
  });

  log(`退勤を更新（localId=${currentShiftLocalId}）`);

  currentShiftLocalId = null;
  currentTaskLocalId = null;
  currentWorkerId = null;
  currentWorkerName = null;
  pausedTaskTemplate = null;

  updateStatuses();
}

async function onBreakStart() {
  if (!currentShiftLocalId) {
    alert('出勤していません');
    return;
  }

  const now = new Date();

  if (currentTaskLocalId) {
    await updateTaskLocal(currentTaskLocalId, (record) => {
      const data = record.data;
      data['終了時刻'] = formatTime(now);

      pausedTaskTemplate = {
        畝ID: data['畝ID'],
        圃場ID: data['圃場ID'],
        圃場名: data['圃場名'],
        作物ID: data['作物ID'],
        作物名: data['作物名'],
        作型: data['作型'],
        栽培区分: data['栽培区分'],
        ロットID: data['ロットID'],
        作業種別ID: data['作業種別ID'],
        作業種別名: data['作業種別名'],
        天候: data['天候'],
        気温: data['気温'],
        地温: data['地温'],
        メモ: data['メモ'],
        機械作業フラグ: data['機械作業フラグ']
      };
    });

    log(`休憩開始に伴い、進行中の作業を一時停止しました（localId=${currentTaskLocalId}）`);
    currentTaskLocalId = null;
    updateStatuses();
  }

  await updateShiftLocal(currentShiftLocalId, (record) => {
    const data = record.data;
    if (data['__breakCurrentStartISO']) return;

    data['__breakCurrentStartISO'] = now.toISOString();
    const old = data['休憩詳細'] || '';
    data['休憩詳細'] = old + `開始:${formatTime(now)};;`;
  });

  log('休憩開始を記録');
}

async function onBreakEnd() {
  if (!currentShiftLocalId) {
    alert('出勤していません');
    return;
  }

  const now = new Date();

  await updateShiftLocal(currentShiftLocalId, (record) => {
    const data = record.data;

    const startISO = data['__breakCurrentStartISO'];
    let totalMs = data['__breakTotalMs'] || 0;

    if (startISO) {
      const startDate = new Date(startISO);
      totalMs += (now - startDate);
      data['__breakTotalMs'] = totalMs;
      data['__breakCurrentStartISO'] = null;
      const minutes = Math.round(totalMs / 60000);
      data['休憩合計分'] = minutes;
    }

    const old = data['休憩詳細'] || '';
    data['休憩詳細'] = old + `終了:${formatTime(now)};;`;
  });

  log('休憩終了を記録');

  if (!currentTaskLocalId && pausedTaskTemplate && currentWorkerId && currentShiftLocalId) {
    const t = pausedTaskTemplate;

    const data = {
      作業ID: '',
      勤怠ID: currentShiftLocalId,
      作業者ID: currentWorkerId,
      作業者名: currentWorkerName,
      作業日: formatDateForSheet(now),
      開始時刻: formatTime(now),
      終了時刻: '',
      畝ID: t.畝ID || '',
      圃場ID: t.圃場ID || '',
      圃場名: t.圃場名 || '',
      作物ID: t.作物ID || '',
      作物名: t.作物名 || '',
      作型: t.作型 || '',
      栽培区分: t.栽培区分 || '',
      ロットID: t.ロットID || '',
      作業種別ID: t.作業種別ID || '',
      作業種別名: t.作業種別名 || '',
      天候: t.天候 || '',
      気温: t.気温 ?? null,
      地温: t.地温 ?? null,
      開始写真URL: '',
      終了写真URL: '',
      開始写真あり: false,
      終了写真あり: false,
      開始写真LocalId: '',
      終了写真LocalId: '',
      機械作業フラグ: t.機械作業フラグ ?? false,
      メモ: t.メモ || ''
    };

    const newLocalId = await saveSagyoLocal(data);
    currentTaskLocalId = newLocalId;
    pausedTaskTemplate = null;

    updateStatuses();
    log(`休憩終了に伴い、作業を自動再開しました（localId=${newLocalId}）`);
  }
}

// ============================
// 6. 画面イベント（作業）
// ============================
async function onTaskStart() {
  if (!currentShiftLocalId) {
    alert('出勤していません');
    return;
  }
  if (!currentWorkerId) {
    alert('作業者情報が取得できません。いったん退勤して、出勤からやり直してください。');
    return;
  }
  if (currentTaskLocalId) {
    alert('すでに作業中です。先に「作業終了」を押してください。');
    return;
  }

  pausedTaskTemplate = null;

  const bedId = document.getElementById('bedIdInput').value.trim();
  const taskTypeSelect = document.getElementById('taskTypeSelect');
  const taskTypeId = taskTypeSelect.value;
  const taskTypeName = taskTypeSelect.options[taskTypeSelect.selectedIndex].text;
  const memo = document.getElementById('taskMemo').value;

  if (!bedId) {
    alert('畝IDを入力してください（本番ではQRになります）');
    return;
  }
  if (!taskTypeId) {
    alert('作業種別を選択してください');
    return;
  }

  const now = new Date();

  const data = {
    作業ID: '',
    勤怠ID: currentShiftLocalId,
    作業者ID: currentWorkerId,
    作業者名: currentWorkerName,
    作業日: formatDateForSheet(now),
    開始時刻: formatTime(now),
    終了時刻: '',
    畝ID: bedId,
    圃場ID: '',
    圃場名: '',
    作物ID: '',
    作物名: '',
    作型: '',
    栽培区分: '',
    ロットID: '',
    作業種別ID: taskTypeId,
    作業種別名: taskTypeName,
    天候: '',
    気温: null,
    地温: null,
    開始写真URL: '',
    終了写真URL: '',
    開始写真あり: false,
    終了写真あり: false,
    開始写真LocalId: '',
    終了写真LocalId: '',
    機械作業フラグ: false,
    メモ: memo
  };

  const localId = await saveSagyoLocal(data);
  currentTaskLocalId = localId;

  updateStatuses();
  log(`作業開始を保存（localId=${localId}）`);
}

async function onTaskEnd() {
  if (!currentTaskLocalId) {
    alert('進行中の作業はありません');
    return;
  }

  const now = new Date();

  await updateTaskLocal(currentTaskLocalId, (record) => {
    record.data['終了時刻'] = formatTime(now);
  });

  log(`作業終了を更新（localId=${currentTaskLocalId}）`);
  currentTaskLocalId = null;

  updateStatuses();
}

// ============================
// 7. 日別気温・地温（保存のみ）
// ============================
async function onSaveDailyWeather() {
  const dateInput = document.getElementById('dailyDateInput');
  const fieldIdInput = document.getElementById('dailyFieldIdInput');
  const houseIdInput = document.getElementById('dailyHouseIdInput');
  const bedIdInput = document.getElementById('bedIdInput');

  const maxTempIn = document.getElementById('dailyMaxTempInput');
  const minTempIn = document.getElementById('dailyMinTempInput');
  const maxSoilIn = document.getElementById('dailyMaxSoilInput');
  const minSoilIn = document.getElementById('dailyMinSoilInput');
  const illumIn = document.getElementById('dailyIlluminationInput');
  const co2In = document.getElementById('dailyCo2Input');
  const soilMoistureIn = document.getElementById('dailySoilMoistureInput');
  const ecIn = document.getElementById('dailyEcInput');
  const methodIn = document.getElementById('dailyMethodInput');
  const memoIn = document.getElementById('dailyMemoInput');

  const dateValue = dateInput.value;
  if (!dateValue) {
    alert('日付を入力してください');
    return;
  }

  const data = {
    date: dateValue,
    maxTemp: maxTempIn.value,
    minTemp: minTempIn.value,
    maxSoil: maxSoilIn.value,
    minSoil: minSoilIn.value,
    illumination: illumIn.value,
    co2: co2In.value,
    soilMoisture: soilMoistureIn.value,
    ec: ecIn.value,
    method: methodIn.value,
    memo: memoIn.value,
    fieldId: fieldIdInput.value,
    houseId: houseIdInput.value,
    bedId: bedIdInput ? bedIdInput.value : ''
  };

  const localId = await saveDailyWeatherLocal(data);

  log(`日別環境データを保存（localId=${localId}, date=${dateValue}, fieldId=${data.fieldId}, houseId=${data.houseId}, bedId=${data.bedId}）`);

  maxTempIn.value = '';
  minTempIn.value = '';
  maxSoilIn.value = '';
  minSoilIn.value = '';
  illumIn.value = '';
  co2In.value = '';
  soilMoistureIn.value = '';
  ecIn.value = '';
  methodIn.value = '';
  memoIn.value = '';
}

async function restoreRunningStateFromIndexedDB() {
  // 1) 「退勤していない勤怠」を探す（最新）
  const shifts = await getAllRecords(STORE_SHIFTS);
  const openShifts = shifts.filter(r => {
    const d = r && r.data ? r.data : {};
    return String(d['退勤時刻'] || '').trim() === '';
  });
  openShifts.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));

  if (openShifts.length > 0) {
    const s = openShifts[0];
    const sd = s.data || {};
    currentShiftLocalId = s.localId || null;
    currentWorkerId = String(sd['作業者ID'] || '').trim() || null;
    currentWorkerName = String(sd['作業者名'] || '').trim() || null;
  } else {
    currentShiftLocalId = null;
    currentWorkerId = null;
    currentWorkerName = null;
  }

  // 2) 「終了時刻が空の作業」を探す（最新）
  const tasks = await getAllRecords(STORE_TASKS);
  const openTasks = tasks.filter(r => {
    const d = r && r.data ? r.data : {};
    return String(d['終了時刻'] || '').trim() === '';
  });
  openTasks.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));

  if (openTasks.length > 0) {
    const t = openTasks[0];
    const td = t.data || {};
    currentTaskLocalId = t.localId || null;

    // 勤怠IDが作業側に入っているので、それも優先して復元
    const shiftIdFromTask = String(td['勤怠ID'] || '').trim();
    if (shiftIdFromTask) currentShiftLocalId = shiftIdFromTask;

    // 畝IDは入力欄にも戻す（URLがあっても上書きしない）
    const bedId = String(td['畝ID'] || '').trim();
    const bedInput = document.getElementById('bedIdInput');
    if (bedInput && bedId && !String(bedInput.value || '').trim()) {
      bedInput.value = bedId;
    }

    // 作業種別をプルダウンに復元（マスタが入ってからでないと option が無いので注意）
    const taskSelect = document.getElementById('taskTypeSelect');
    const typeId = String(td['作業種別ID'] || '').trim();
    const typeName = String(td['作業種別名'] || td['作業種別'] || '').trim();

    let ok = false;
    if (typeId) ok = setSelectValueIfExists(taskSelect, typeId);
    if (!ok && typeName) ok = setSelectByTextIfExists(taskSelect, typeName);

    // 復元できないときはログに残す（原因調査用）
    if (!ok && (typeId || typeName)) {
      log(`作業種別の復元に失敗: 作業種別ID=${typeId} 作業種別名=${typeName}`);
    }
  } else {
    currentTaskLocalId = null;
  }
}

// ============================
// 8. 初期化
// ============================
function updateOnlineStatus() {
  const span = document.getElementById('onlineStatus');
  span.textContent = navigator.onLine ? 'オンライン' : 'オフライン';
}

window.addEventListener('load', () => {
  document.getElementById('btnClockIn').addEventListener('click', () => {
    onClockIn().catch(err => log('出勤エラー: ' + err));
  });
  document.getElementById('btnClockOut').addEventListener('click', () => {
    onClockOut().catch(err => log('退勤エラー: ' + err));
  });
  document.getElementById('btnBreakStart').addEventListener('click', () => {
    onBreakStart().catch(err => log('休憩開始エラー: ' + err));
  });
  document.getElementById('btnBreakEnd').addEventListener('click', () => {
    onBreakEnd().catch(err => log('休憩終了エラー: ' + err));
  });
  document.getElementById('btnTaskStart').addEventListener('click', () => {
    onTaskStart().catch(err => log('作業開始エラー: ' + err));
  });
  document.getElementById('btnTaskEnd').addEventListener('click', () => {
    onTaskEnd().catch(err => log('作業終了エラー: ' + err));
  });

  // 写真ボタン
  document.getElementById('btnPhotoStart').addEventListener('click', () => {
    takeTaskPhoto('start').catch(err => log('開始写真エラー: ' + err));
  });
  document.getElementById('btnPhotoEnd').addEventListener('click', () => {
    takeTaskPhoto('end').catch(err => log('終了写真エラー: ' + err));
  });

  document.getElementById('btnSync').addEventListener('click', () => {
    syncAll().catch(err => log('同期エラー: ' + err));
  });

  document.getElementById('btnSaveDailyWeather').addEventListener('click', () => {
    onSaveDailyWeather().catch(err => log('日別気温・地温保存エラー: ' + err));
  });

  updateOnlineStatus();
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);

    applyLocationFromUrl();
  updateStatuses();

    initMasters().catch(err => {
    log('masters 読込失敗: ' + err);
    alert('masters の読み込みに失敗しました。F12 Console を確認してください。');
  });

  log('アプリ初期化完了');
});





