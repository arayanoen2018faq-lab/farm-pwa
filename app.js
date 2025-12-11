// app.js
// 畑管理PWA 試作1号：勤怠＋作業＋IndexedDB＋同期

// ============================
// 1. 設定
// ============================

// ★必ず自分の WebアプリURL に書き換えてください
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwUG5v7e7YuUMJ0A8YDtkmOcHbMYKPgoDWYN6tbfjaBVoxGXMx_v6xj9LNuwfi-CoD9/exec';

const DB_NAME = 'farmCoreDB';
const DB_VERSION = 2;
const STORE_SHIFTS = 'shifts';
const STORE_TASKS = 'tasks';
const STORE_DAILY_WEATHER = 'dailyWeather';

const TZ_OFFSET_MINUTES = 0; // ここではブラウザのローカル時刻をそのまま使う

// 画面上の状態保持
let currentShiftLocalId = null;
let currentTaskLocalId = null;
let currentWorkerId = null;       // 現在出勤中の作業者ID
let currentWorkerName = null;     // 現在出勤中の作業者名（プルダウンの表示名）
let pausedTaskTemplate = null;    // 休憩で一時停止した作業のテンプレート

// ============================
// 2. ユーティリティ
// ============================

// URLクエリから畝ID・圃場ID・ハウスIDを初期値として各入力欄に入れる
function applyLocationFromUrl() {
  const params = new URLSearchParams(window.location.search);

  const fieldId = params.get('fieldId') || '';
  const houseId = params.get('houseId') || '';
  const bedId   = params.get('bedId')   || '';

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
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function createLocalRecord(type, data) {
  const now = new Date().toISOString();
  const prefix = type === 'kintai'
    ? 'shift-'
    : type === 'sagyo'
      ? 'task-'
      : 'daily-';
  const localId = prefix + Date.now();
  return {
    localId,
    type,            // "kintai" / "sagyo" / "dailyWeather"
    serverId: null,  // 同期後に サーバ側ID を入れる想定（今は未使用）
    isSynced: false,
    data,
    createdAt: now,
    updatedAt: now
  };
}

// 勤怠保存
async function saveKintaiLocal(data) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(STORE_SHIFTS, 'readwrite');
  const store = tx.objectStore(STORE_SHIFTS);

  const record = createLocalRecord('kintai', data);
  store.put(record);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      db.close();
      resolve(record.localId);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
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
    tx.oncomplete = () => {
      db.close();
      resolve(record.localId);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
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
    tx.oncomplete = () => {
      db.close();
      resolve(record.localId);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// 勤怠の更新（退勤時刻など）
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
  record.updatedAt = new Date().toISOString();
  store.put(record);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// 作業の更新（終了時刻など）
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
  record.updatedAt = new Date().toISOString();
  store.put(record);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// 未同期レコード取得（インデックスは使わず、全件から絞り込み）
async function getUnsynced(storeName) {
  const db = await openFarmCoreDB();
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);

  const records = await new Promise((resolve, reject) => {
    const req = store.getAll();              // ここで全件取得
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  db.close();
  // isSynced === false のものだけ返す
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

    // 取得
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
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
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
      type: 'kintai',
      records: unsyncedShifts.map(r => {
        const data = Object.assign({}, r.data);
        data.localId = r.localId; // どのレコードか識別用
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

      // サーバIDは使っていないので null を入れて同期済みにする
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
      type: 'sagyo',
      records: unsyncedTasks.map(r => {
        const data = Object.assign({}, r.data);
        data.localId = r.localId;
        return data;
      })
    };

    const localIds = unsyncedTasks.map(r => r.localId);

    try {
      await fetch(WEB_APP_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
      });

      log('作業データをWebアプリへ送信しました（no-cors）');

      const serverIds = localIds.map(() => null);
      await markSynced(STORE_TASKS, localIds, serverIds);
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

  log('同期完了');
}


// ============================
// 5. 画面イベント（勤怠）
// ============================

function updateStatuses() {
  document.getElementById('shiftStatus').textContent =
    currentShiftLocalId ? `出勤中（${currentShiftLocalId}）` : '未出勤';

  document.getElementById('taskStatus').textContent =
    currentTaskLocalId ? `作業中（${currentTaskLocalId}）` : '作業なし';
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
    // ここから下は内部用（シート側に列がなければ無視されます）
    __startISO: startISO,              // 出勤時刻（ISO文字列）
    __breakTotalMs: 0,                 // 休憩累計ミリ秒
    __breakCurrentStartISO: null       // 進行中の休憩の開始時刻（なければ null）
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

    // 退勤時刻をセット
    data['退勤時刻'] = formatTime(now);

    const startISO = data['__startISO'];
    let breakTotalMs = data['__breakTotalMs'] || 0;

    // もし「休憩開始」したまま「休憩終了」を押さずに退勤した場合、
    // 退勤時刻までを休憩時間として加算する
    const breakCurrentISO = data['__breakCurrentStartISO'];
    if (breakCurrentISO) {
      const breakStart = new Date(breakCurrentISO);
      breakTotalMs += (now - breakStart);
      data['__breakCurrentStartISO'] = null;
      data['__breakTotalMs'] = breakTotalMs;
    }

    // 実働時間を計算（開始時刻が記録されている場合のみ）
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

  // 状態リセット
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

  // 1) 作業中なら、この時刻で一旦「作業終了」にし、再開用テンプレートを残す
  if (currentTaskLocalId) {
    await updateTaskLocal(currentTaskLocalId, (record) => {
      const data = record.data;

      // この時刻でいったん終了
      data['終了時刻'] = formatTime(now);

      // 休憩後に自動再開するためのテンプレートを保存
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

    // いまは「作業なし」の状態にする
    currentTaskLocalId = null;
    updateStatuses();
  }

  // 2) 勤怠側の「休憩開始」を記録し、休憩時間の計測を開始
  await updateShiftLocal(currentShiftLocalId, (record) => {
    const data = record.data;

    // すでに休憩中なら二重開始を防止
    if (data['__breakCurrentStartISO']) {
      return;
    }

    data['__breakCurrentStartISO'] = now.toISOString();

    const old = data['休憩詳細'] || '';
    data['休憩詳細'] = old + `開始:${formatTime(now)};`;
  });

  log('休憩開始を記録');
}

async function onBreakEnd() {
  if (!currentShiftLocalId) {
    alert('出勤していません');
    return;
  }

  const now = new Date();

  // 1) 勤怠側の休憩終了と休憩累計の更新
  await updateShiftLocal(currentShiftLocalId, (record) => {
    const data = record.data;

    const startISO = data['__breakCurrentStartISO'];
    let totalMs = data['__breakTotalMs'] || 0;

    if (startISO) {
      const startDate = new Date(startISO);
      totalMs += (now - startDate);           // 今回の休憩ぶんを足し込む
      data['__breakTotalMs'] = totalMs;
      data['__breakCurrentStartISO'] = null;

      const minutes = Math.round(totalMs / 60000);
      data['休憩合計分'] = minutes;
    }

    const old = data['休憩詳細'] || '';
    data['休憩詳細'] = old + `終了:${formatTime(now)};`;
  });

  log('休憩終了を記録');

  // 2) 休憩前に一時停止していた作業があれば、自動で再開する
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
      機械作業フラグ: t.機械作業フラグ ?? false,
      メモ: t.メモ || ''
    };

    const newLocalId = await saveSagyoLocal(data);
    currentTaskLocalId = newLocalId;
    pausedTaskTemplate = null;   // 再開済みなのでクリア

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

  // 手動で新しい作業を開始したので、「休憩からの自動再開」テンプレートは不要
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
    勤怠ID: currentShiftLocalId,    // いまの勤怠と紐付け
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
  const dateInput        = document.getElementById('dailyDateInput');

  const fieldIdInput     = document.getElementById('dailyFieldIdInput');
  const houseIdInput     = document.getElementById('dailyHouseIdInput');
  // 畝IDは「作業操作」セクションの入力を共用
  const bedIdInput       = document.getElementById('bedIdInput');

  const maxTempIn        = document.getElementById('dailyMaxTempInput');
  const minTempIn        = document.getElementById('dailyMinTempInput');
  const maxSoilIn        = document.getElementById('dailyMaxSoilInput');
  const minSoilIn        = document.getElementById('dailyMinSoilInput');

  const illumIn          = document.getElementById('dailyIlluminationInput');
  const co2In            = document.getElementById('dailyCo2Input');
  const soilMoistureIn   = document.getElementById('dailySoilMoistureInput');
  const ecIn             = document.getElementById('dailyEcInput');

  const methodIn         = document.getElementById('dailyMethodInput');
  const memoIn           = document.getElementById('dailyMemoInput');

  const dateValue = dateInput.value; // "YYYY-MM-DD"
  if (!dateValue) {
    alert('日付を入力してください');
    return;
  }

  const data = {
    // 日付・環境値
    date:          dateValue,
    maxTemp:       maxTempIn.value,
    minTemp:       minTempIn.value,
    maxSoil:       maxSoilIn.value,
    minSoil:       minSoilIn.value,
    illumination:  illumIn.value,
    co2:           co2In.value,
    soilMoisture:  soilMoistureIn.value,
    ec:            ecIn.value,
    method:        methodIn.value,
    memo:          memoIn.value,
    // 位置情報（圃場・ハウス・畝）
    fieldId:       fieldIdInput.value,
    houseId:       houseIdInput.value,
    bedId:         bedIdInput ? bedIdInput.value : ''
  };

  const localId = await saveDailyWeatherLocal(data);

  log(
    `日別環境データを保存（localId=${localId}, date=${dateValue}, ` +
    `fieldId=${data.fieldId}, houseId=${data.houseId}, bedId=${data.bedId}）`
  );

  // 日付と位置情報は残し、数値とメモだけクリアする
  maxTempIn.value       = '';
  minTempIn.value       = '';
  maxSoilIn.value       = '';
  minSoilIn.value       = '';
  illumIn.value         = '';
  co2In.value           = '';
  soilMoistureIn.value  = '';
  ecIn.value            = '';
  methodIn.value        = '';
  memoIn.value          = '';
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

  document.getElementById('btnSync').addEventListener('click', () => {
    syncAll().catch(err => log('同期エラー: ' + err));
  });

  document.getElementById('btnSaveDailyWeather').addEventListener('click', () => {
    onSaveDailyWeather().catch(err => log('日別気温・地温保存エラー: ' + err));
  });

  updateOnlineStatus();
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);

  // URLの ?fieldId= / ?houseId= / ?bedId= を入力欄に反映
  applyLocationFromUrl();

  updateStatuses();
  log('アプリ初期化完了');
});
