// app.js（全文）
// 通常モード：ローカルだけ（firebase不要）
// 共有モード：ボタン押したら firebase.js を動的importして同期

import { ITEMS } from "./items.js";

const MAPS = [
  { key: "skyline",     label: "スカイライン",       file: "skyline.png" },
  { key: "stormchaser", label: "ストームチェイサー", file: "stormchaser.png" },
  { key: "hammerfall",  label: "ハンマーフォール",   file: "hammerfall.png" },
  { key: "cinderwatch", label: "シンダーウォッチ",   file: "cinderwatch.png" },
  { key: "kzone",       label: "Kゾーン",           file: "kzone.png" }
];

// ======================
// DOM
// ======================
const mapSelect    = document.getElementById("mapSelect");
const mapWrap      = document.getElementById("mapWrap");
const mapImg       = document.getElementById("mapImg");
const drawCanvas   = document.getElementById("drawCanvas");
const pinLayer     = document.getElementById("pinLayer");

const itemGrid     = document.getElementById("itemGrid");
const modeRow      = document.getElementById("modeRow");

const shareBtn     = document.getElementById("shareModeBtn");
const copyLinkBtn  = document.getElementById("copyLinkBtn");
const clearPinsBtn = document.getElementById("clearPinsBtn");
const clearLinesBtn= document.getElementById("clearLinesBtn");


const statusBadge  = document.getElementById("statusBadge");
const roomCodeEl   = document.getElementById("roomCode");
const toastEl = document.getElementById("toast");
let toastTimer = null;

function showToast(msg, ms = 0){
  if(!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
  }, ms);
}

// ======================
// State
// ======================
let mode = null; // null | pen | erase
let selectedItemId = ITEMS[0]?.id ?? "g_grenade";
let currentMapKey  = MAPS[0].key;
// map zoom/pan（スマホピンチ用）
let viewScale = 1;
let viewX = 0;
let viewY = 0;
// local state（通常モードの正、共有モードではDBのミラー）
let localPins = new Map();   // id -> {type,x,y,createdAt}
let localLines = {};         // id -> {points:[{x,y}], createdAt}

// drawing runtime
const ctx = drawCanvas.getContext("2d");
let isDrawing = false;
let currentStroke = [];

// share mode
let shareEnabled = false;
let roomId = "-";
let fb = null;              // firebase module (dynamic import)
let unsubPins = null;
let unsubLines = null;

// drag throttle
let dragRAF = 0;
let pendingDrag = null;

// ======================
// Utils
function applyViewTransform(){
  // mapImg / canvas / pinLayer をまとめて動かす
  // mapWrap直下の3つに transform を当てる
  const t = `translate(${viewX}px, ${viewY}px) scale(${viewScale})`;
  mapImg.style.transform = t;
  drawCanvas.style.transform = t;
  pinLayer.style.transform = t;

  // transformの基準を左上に
  mapImg.style.transformOrigin = "0 0";
  drawCanvas.style.transformOrigin = "0 0";
  pinLayer.style.transformOrigin = "0 0";
}

// ======================
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

function randId(len=8){
  const c = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for(let i=0;i<len;i++) s += c[Math.floor(Math.random()*c.length)];
  return s;
}

function getItemDef(id){
  return ITEMS.find(x => x.id === id) ?? ITEMS[0];
}

function getQuery(){
  const u = new URL(location.href);
  return Object.fromEntries(u.searchParams.entries());
}

function setQuery(params){
  const u = new URL(location.href);
  Object.entries(params).forEach(([k,v]) => u.searchParams.set(k,v));
  history.replaceState(null, "", u.toString());
}

// object-fit: contain の実表示領域
function getMapRect(){
  const wrapRect = mapWrap.getBoundingClientRect();
  const natW = mapImg.naturalWidth || 1;
  const natH = mapImg.naturalHeight || 1;

  const scale = Math.min(wrapRect.width / natW, wrapRect.height / natH);
  const dispW = natW * scale;
  const dispH = natH * scale;

  const left = (wrapRect.width - dispW) / 2;
  const top  = (wrapRect.height - dispH) / 2;

  return { wrapRect, left, top, dispW, dispH };
}

function clientToNorm(clientX, clientY){
  const { wrapRect, left, top, dispW, dispH } = getMapRect();

  // mapWrap内の座標
  let lx = clientX - wrapRect.left;
  let ly = clientY - wrapRect.top;

  // 追加：ズーム変換を戻す（ワールド座標へ）
  lx = (lx - viewX) / viewScale;
  ly = (ly - viewY) / viewScale;

  // object-fit: contain の実表示領域へ
  const x = (lx - left) / dispW;
  const y = (ly - top ) / dispH;

  return { x: clamp(x,0,1), y: clamp(y,0,1) };
}


function normToPx(nx, ny){
  const { left, top, dispW, dispH } = getMapRect();
  return { x: left + nx * dispW, y: top + ny * dispH };
}

function resizeCanvas(){
  const r = mapWrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  drawCanvas.width  = Math.floor(r.width * dpr);
  drawCanvas.height = Math.floor(r.height * dpr);
  drawCanvas.style.width  = `${r.width}px`;
  drawCanvas.style.height = `${r.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  redrawLines();
  redrawPins();
}

function setStatus(text, kind="normal"){
  statusBadge.textContent = text;
  if(kind === "share"){
    statusBadge.style.borderColor = "rgba(67,209,159,.65)";
    statusBadge.style.color = "rgba(233,238,252,.95)";
  }else if(kind === "error"){
    statusBadge.style.borderColor = "rgba(255,107,138,.65)";
    statusBadge.style.color = "rgba(233,238,252,.95)";
  }else{
    statusBadge.style.borderColor = "";
    statusBadge.style.color = "";
  }
}

// ======================
// Local cache (map別)
// ======================
function cacheKeyPins(){ return `bb_local_pins_${currentMapKey}`; }
function cacheKeyLines(){ return `bb_local_lines_${currentMapKey}`; }

function storeLocalCache(){
  try{
    localStorage.setItem(cacheKeyPins(), JSON.stringify(Object.fromEntries(localPins)));
    localStorage.setItem(cacheKeyLines(), JSON.stringify(localLines));
  }catch{}
}

function loadLocalCache(){
  try{
    const p = JSON.parse(localStorage.getItem(cacheKeyPins()) || "{}");
    const l = JSON.parse(localStorage.getItem(cacheKeyLines()) || "{}");
    localPins = new Map(Object.entries(p));
    localLines = l;
  }catch{
    localPins = new Map();
    localLines = {};
  }
}

// ======================
// Render
// ======================
function redrawPins(){
  pinLayer.innerHTML = "";

  for (const [id, data] of localPins.entries()){
    const def = getItemDef(data.type);

    const el = document.createElement("div");
    el.className = "pin";
    el.dataset.pinId = id;
  // 保存されてるサイズを反映（全ピン共通）
const s = data.size || 54;
el.style.setProperty("--pin-size", s + "px");
  
    // マップ上は画像だけ
   if (data.type === "g_smoke") {
  el.innerHTML = `
    <div class="smoke-circle"></div>
    <img class="smoke-icon" src="${def.icon}" alt="smoke">
  `;
} else {
  el.innerHTML = `<img class="icon" src="${def.icon}" alt="${def.label}">`;
}



    positionPinEl(el, data.x, data.y);
    attachPinDragAndErase(el);

    pinLayer.appendChild(el);
  }
}


function positionPinEl(el, nx, ny){
  const pos = normToPx(nx, ny);
  el.style.left = `${pos.x}px`;
  el.style.top  = `${pos.y}px`;
}

function redrawLines(){
  const r = mapWrap.getBoundingClientRect();
  ctx.clearRect(0,0,r.width,r.height);

  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(122,162,255,0.9)";

  const all = Object.entries(localLines)
    .sort((a,b)=>(a[1].createdAt||0)-(b[1].createdAt||0));

  for(const [id, line] of all){
    const pts = line.points || [];
    if(pts.length < 2) continue;

    ctx.beginPath();
    for(let i=0;i<pts.length;i++){
      const p = pts[i];
      const pos = normToPx(p.x, p.y);
      if(i===0) ctx.moveTo(pos.x, pos.y);
      else ctx.lineTo(pos.x, pos.y);
    }
    ctx.stroke();
  }
}

function drawPreviewStroke(pts){
  if(pts.length < 2) return;

  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(233,238,252,0.85)";

  ctx.beginPath();
  for(let i=0;i<pts.length;i++){
    const p = pts[i];
    const pos = normToPx(p.x, p.y);
    if(i===0) ctx.moveTo(pos.x, pos.y);
    else ctx.lineTo(pos.x, pos.y);
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(122,162,255,0.9)";
}

// ======================
// Geometry: line hit test
// ======================
function distPointToSegment(px, py, ax, ay, bx, by){
  const abx = bx-ax, aby = by-ay;
  const apx = px-ax, apy = py-ay;
  const ab2 = abx*abx + aby*aby;
  if(ab2 === 0) return Math.hypot(px-ax, py-ay);
  let t = (apx*abx + apy*aby) / ab2;
  t = clamp(t, 0, 1);
  const cx = ax + t*abx;
  const cy = ay + t*aby;
  return Math.hypot(px-cx, py-cy);
}

function findNearestLineId(normX, normY){
  // 閾値：マップの大きさに依存しないよう「正規化座標」で判定
  // 0.02 くらいが指で消しやすい（必要なら調整）
  const threshold = 0.02;

  let bestId = null;
  let bestD = Infinity;

  for(const [id, line] of Object.entries(localLines)){
    const pts = line.points || [];
    for(let i=0;i<pts.length-1;i++){
      const a = pts[i], b = pts[i+1];
      const d = distPointToSegment(normX, normY, a.x, a.y, b.x, b.y);
      if(d < bestD){
        bestD = d;
        bestId = id;
      }
    }
  }

  if(bestD <= threshold) return bestId;
  return null;
}

// ======================
// Data layer (local / firebase)
// ======================
function pinsPath(mapKey){ return `rooms/${roomId}/maps/${mapKey}/pins`; }
function linesPath(mapKey){ return `rooms/${roomId}/maps/${mapKey}/lines`; }

async function addPin(type, x, y){
if (type === "g_smoke") {
    showToast("スモーク：ホイール / ひれで拡大縮小できるロー");
  }
  const data = {
  type, x, y,
  size: 54,            // ←全ピン共通の初期サイズ（好きに）
  createdAt: Date.now()
};



  if(!shareEnabled){
    const id = "p_" + randId(10);
    localPins.set(id, data);
    storeLocalCache();
    redrawPins();
    return;
  }

  const newRef = fb.push(fb.ref(fb.db, pinsPath(currentMapKey)));
  await fb.set(newRef, data);
}

async function updatePin(id, x, y){
  if(!shareEnabled){
    const cur = localPins.get(id);
    if(!cur) return;
    localPins.set(id, { ...cur, x, y });
    storeLocalCache();
    return;
  }
  await fb.update(fb.ref(fb.db, `${pinsPath(currentMapKey)}/${id}`), { x, y });
}

async function deletePin(id){
  if(!shareEnabled){
    localPins.delete(id);
    storeLocalCache();
    redrawPins();
    return;
  }
  await fb.remove(fb.ref(fb.db, `${pinsPath(currentMapKey)}/${id}`));
}

async function clearPins(){
  if(!shareEnabled){
    localPins.clear();
    storeLocalCache();
    redrawPins();
    return;
  }
  await fb.remove(fb.ref(fb.db, pinsPath(currentMapKey)));
}

async function addLine(points){
  const data = { points, createdAt: Date.now() };

  if(!shareEnabled){
    const id = "l_" + randId(10);
    localLines[id] = data;
    storeLocalCache();
    redrawLines();
    return;
  }

  const newRef = fb.push(fb.ref(fb.db, linesPath(currentMapKey)));
  await fb.set(newRef, data);
}

async function deleteLineById(lineId){
  if(!lineId) return;

  if(!shareEnabled){
    delete localLines[lineId];
    storeLocalCache();
    redrawLines();
    return;
  }
  await fb.remove(fb.ref(fb.db, `${linesPath(currentMapKey)}/${lineId}`));
}

async function clearLines(){
  if(!shareEnabled){
    localLines = {};
    storeLocalCache();
    redrawLines();
    return;
  }
  await fb.remove(fb.ref(fb.db, linesPath(currentMapKey)));
}

// ======================
// Pin interaction (drag / erase)
// ======================
function attachPinDragAndErase(el){
  let dragging = false;

  // =========================
  // PC：ホイールでスモーク拡大縮小
  // =========================
  el.addEventListener("wheel", (e) => {
    const id = el.dataset.pinId;
    const p = localPins.get(id);
if (!p) return;


    e.preventDefault();

    let s = p.size || 90;
    s += (e.deltaY < 0) ? 10 : -10;
    s = Math.max(40, Math.min(300, s));

    p.size = s;
    localPins.set(id, p);
    storeLocalCache?.();

    el.style.setProperty("--pin-size", s + "px");
  }, { passive: false });

  // =========================
  // スマホ：ピンチでスモーク拡大縮小
  // =========================
  let pinchStartDist = null;
  let pinchStartSize = null;
  let pointers = new Map(); // pointerId -> {x,y}

  el.addEventListener("pointerdown", (e) => {
    const id = el.dataset.pinId;

    // 消すモード
    if(mode === "erase"){
  e.preventDefault();
  deletePin(id);
  return;
}
    // スモークならピンチ用にポインタ保存
    const pinData = localPins.get(id);
    if (pinData?.type === "g_smoke") {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2) {
        const pts = Array.from(pointers.values());
        pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        pinchStartSize = pinData.size || 90;
      }
    }

    // 動かすモードじゃなければドラッグしない
   // 消すモード中はドラッグしない（削除の誤操作防止）
if(mode === "erase") return;


    e.preventDefault();
    dragging = true;
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener("pointermove", (e) => {
    const id = el.dataset.pinId;
    const pinData = localPins.get(id);

    // ===== スモークのピンチ拡大縮小（2本指の時だけ） =====
    if (pinData?.type === "g_smoke" && pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2 && pinchStartDist) {
        const pts = Array.from(pointers.values());
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);

        let scale = d / pinchStartDist;
        let newSize = pinchStartSize * scale;
        newSize = Math.max(40, Math.min(300, newSize));

        pinData.size = newSize;
        localPins.set(id, pinData);
        storeLocalCache();

        el.style.width = newSize + "px";
        el.style.height = newSize + "px";
      }
    }

    // ===== ピン移動（ドラッグ中だけ）=====
    // 消すモード中は動かさない
    if (!dragging || mode === "erase") return;

    const p = clientToNorm(e.clientX, e.clientY);

    // 見た目を即追従
    positionPinEl(el, p.x, p.y);

    // ローカル状態も更新（共有でもヌルヌル）
    const cur = localPins.get(id);
    if (cur) localPins.set(id, { ...cur, x: p.x, y: p.y });
  });

  el.addEventListener("pointerup", (e) => {
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch {}

    // ピンチ用ポインタ掃除
    if (pointers.has(e.pointerId)) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) {
        pinchStartDist = null;
        pinchStartSize = null;
      }
    }

    // ドラッグが終わった時だけDBへ送信（共有モード用）
    if (shareEnabled && mode !== "erase") {
      const id = el.dataset.pinId;
      const cur = localPins.get(id);
      if (cur) updatePin(id, cur.x, cur.y);
    }
  });

  el.addEventListener("pointercancel", (e) => {
    dragging = false;

    // ピンチ用ポインタ掃除
    if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);
    if (pointers.size < 2) {
      pinchStartDist = null;
      pinchStartSize = null;
    }

    // キャンセル時も最後に送っておく（共有モード用）
    if (shareEnabled && mode !== "erase") {
      const id = el.dataset.pinId;
      const cur = localPins.get(id);
      if (cur) updatePin(id, cur.x, cur.y);
    }
  });

　
  el.addEventListener("pointercancel", (e) => {
    dragging = false;
    if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);
    if (pointers.size < 2) {
      pinchStartDist = null;
      pinchStartSize = null;
    }
  });
}


// ======================
// Map interaction
// ======================
mapWrap.addEventListener("pointerdown", (e) => {
// ===== Pinch zoom on mapWrap (focal zoom) =====
let zPointers = new Map(); // pointerId -> {x,y}
let zStartDist = null;
let zStartScale = 1;
let zStartX = 0, zStartY = 0;
let zWorldCX = 0, zWorldCY = 0; // ズーム基準点（ワールド座標）

function getPinchCenter(){
  const pts = Array.from(zPointers.values());
  return {
    cx: (pts[0].x + pts[1].x) / 2,
    cy: (pts[0].y + pts[1].y) / 2,
  };
}

mapWrap.addEventListener("pointerdown", (e) => {
  zPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (zPointers.size === 2) {
    const pts = Array.from(zPointers.values());
    zStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);

    zStartScale = viewScale;
    zStartX = viewX;
    zStartY = viewY;

    const { cx, cy } = getPinchCenter();
    const rect = mapWrap.getBoundingClientRect();
    const localX = cx - rect.left;
    const localY = cy - rect.top;

    zWorldCX = (localX - viewX) / viewScale;
    zWorldCY = (localY - viewY) / viewScale;
  }
});

mapWrap.addEventListener("pointermove", (e) => {
  if (!zPointers.has(e.pointerId)) return;
  zPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (zPointers.size === 2 && zStartDist) {
    e.preventDefault();

    const pts = Array.from(zPointers.values());
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);

    let nextScale = zStartScale * (d / zStartDist);
    nextScale = Math.max(0.8, Math.min(3.0, nextScale));

    const { cx, cy } = getPinchCenter();
    const rect = mapWrap.getBoundingClientRect();
    const localX = cx - rect.left;
    const localY = cy - rect.top;

    viewScale = nextScale;
    viewX = localX - zWorldCX * viewScale;
    viewY = localY - zWorldCY * viewScale;

    applyViewTransform();
  }
}, { passive: false });

mapWrap.addEventListener("pointerup", (e) => {
  zPointers.delete(e.pointerId);
  if (zPointers.size < 2) zStartDist = null;
});

mapWrap.addEventListener("pointercancel", (e) => {
  zPointers.delete(e.pointerId);
  if (zPointers.size < 2) zStartDist = null;
});

  // ピン触った時は置かない
  if(e.target.closest(".pin")) return;

  // ペン中は置かない
  if(mode === "pen") return;


  // if(mode === "erase") return;

  const p = clientToNorm(e.clientX, e.clientY);
  addPin(selectedItemId, p.x, p.y);
});


// ======================
// Drawing interaction
// ======================
drawCanvas.addEventListener("pointerdown", (e) => {
  if(mode === "erase"){
    // 線の近くをタップしたらその線を消す
    const p = clientToNorm(e.clientX, e.clientY);
    const id = findNearestLineId(p.x, p.y);
    deleteLineById(id);
    return;
  }
  isDrawing = true;
  currentStroke = [];
  drawCanvas.setPointerCapture(e.pointerId);

  const p = clientToNorm(e.clientX, e.clientY);
  currentStroke.push(p);
});

drawCanvas.addEventListener("pointermove", (e) => {
  if(!isDrawing || mode !== "pen") return;

  const p = clientToNorm(e.clientX, e.clientY);

  // 点が近すぎるなら間引き（軽くする）
  const last = currentStroke[currentStroke.length - 1];
  const dx = p.x - last.x;
  const dy = p.y - last.y;
  if((dx*dx + dy*dy) < 0.00002) return;

  currentStroke.push(p);

  // 既存線 + プレビュー
  redrawLines();
  drawPreviewStroke(currentStroke);
});

drawCanvas.addEventListener("pointerup", async (e) => {
  if(!isDrawing || mode !== "pen") return;

  isDrawing = false;
  try{ drawCanvas.releasePointerCapture(e.pointerId); }catch{}

  if(currentStroke.length >= 2){
    await addLine(currentStroke);
  }
  currentStroke = [];
});

// ======================
// Share mode (dynamic firebase)
// ======================
shareBtn.addEventListener("click", async () => {
  if(shareEnabled) return;

  // room 準備（URLに無ければ作る）
  const q = getQuery();
  if(!q.room){
    roomId = randId(6);
    setQuery({ room: roomId });
  }else{
    roomId = q.room;
  }
  roomCodeEl.textContent = roomId;

  setStatus("共有モード起動中…", "share");

  try{
    fb = await import("./firebase.js");

    shareEnabled = true;
    copyLinkBtn.disabled = false;
    shareBtn.disabled = true;
    shareBtn.textContent = "共有モードON";
    setStatus("共有モード", "share");

    // 共有開始時：今のローカル状態を “このマップだけ” DBに上書き
    await uploadLocalToRoomForCurrentMap();

    // listener開始
    await bindRealtimeListenersForCurrentMap();

  }catch(err){
    console.error(err);
    shareEnabled = false;
    fb = null;
    setStatus("共有モード失敗（firebase.js/設定/配置）", "error");
    shareBtn.disabled = false;
    shareBtn.textContent = "共有モード";
  }
});

copyLinkBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href);
});

// ======================
// Clear buttons
// ======================
clearPinsBtn.addEventListener("click", async () => {
  await clearPins();
});

clearLinesBtn.addEventListener("click", async () => {
  await clearLines();
});

// ======================
// Firebase helpers
// ======================
async function uploadLocalToRoomForCurrentMap(){
  // 現在マップの状態をDBへ反映
  // pins: Map -> object
  const pinsObj = Object.fromEntries(localPins);
  await fb.set(fb.ref(fb.db, pinsPath(currentMapKey)), pinsObj);
  await fb.set(fb.ref(fb.db, linesPath(currentMapKey)), localLines);
}

async function bindRealtimeListenersForCurrentMap(){
  // 既存解除
  if(unsubPins) unsubPins();
  if(unsubLines) unsubLines();

  const pRef = fb.ref(fb.db, pinsPath(currentMapKey));
  const lRef = fb.ref(fb.db, linesPath(currentMapKey));

  const offPins = fb.onValue(pRef, (snap) => {
    const val = snap.val() || {};
    localPins = new Map(Object.entries(val));
    storeLocalCache(); // ローカルにも残す（オフライン対策）
    redrawPins();
  });
  unsubPins = () => offPins();

  const offLines = fb.onValue(lRef, (snap) => {
    localLines = snap.val() || {};
    storeLocalCache();
    redrawLines();
  });
  unsubLines = () => offLines();
}

// ======================
// Map change handling
// ======================
async function onMapChanged(){
  // 通常モード：ローカルキャッシュをマップ別で読み直し
  storeLocalCache(); // 今のマップを保存
  loadLocalCache();  // 新しいマップを読込

  redrawPins();
  redrawLines();

  if(shareEnabled){
    // 共有モード中：マップ切替したらそのマップのDBを購読
    await bindRealtimeListenersForCurrentMap();
  }
}

// ======================
// UI init
// ======================
function initMapSelect(){
  mapSelect.innerHTML = "";
  for(const m of MAPS){
    const opt = document.createElement("option");
    opt.value = m.key;
    opt.textContent = m.label;
    mapSelect.appendChild(opt);
  }
  mapSelect.value = currentMapKey;

  mapSelect.addEventListener("change", async () => {
    currentMapKey = mapSelect.value;
    loadMapImage();
    await onMapChanged();
  });
}

function initItems(){
  itemGrid.innerHTML = "";
  for(const it of ITEMS){
    const el = document.createElement("div");
    el.className = "item";
    el.dataset.itemId = it.id;

    el.innerHTML = `
      <img class="icon" src="${it.icon}" alt="${it.label}">
      <span class="label">${it.label}</span>
    `;

    el.addEventListener("click", () => {
      selectedItemId = it.id;
      document.querySelectorAll(".item").forEach(x => x.classList.remove("active"));
      el.classList.add("active");
    });

    itemGrid.appendChild(el);
  }

  const first = itemGrid.querySelector(`.item[data-item-id="${selectedItemId}"]`);
  if(first) first.classList.add("active");
}

function initModes(){
  modeRow.querySelectorAll(".pill").forEach(btn => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.mode;
      mode = (mode === next) ? null : next;

      modeRow.querySelectorAll(".pill").forEach(x => x.classList.remove("active"));
      if(mode) btn.classList.add("active");
           if(mode === "erase"){
        showToast("消すモード中：うごかｃたかったらかいじょｃロー",999999); // 実質ずっと表示
      }else{
        // 消すモードを抜けたら消す
        if(toastEl){
          toastEl.classList.remove("show");
        }
      }
    });
  });
}


function loadMapImage(){
  const m = MAPS.find(x => x.key === currentMapKey) ?? MAPS[0];
  mapImg.src = m.file;
  mapImg.onerror = () => console.log("画像が見つからない:", m.file);
}

// ======================
// Boot
// ======================
(function boot(){
  // room表示（URLにroomが付いてるなら表示だけしておく）
  const q = getQuery();
  if(q.room){
    roomId = q.room;
    roomCodeEl.textContent = roomId;
  }else{
    roomCodeEl.textContent = "-";
  }

  setStatus("通常モード", "normal");
  copyLinkBtn.disabled = true;

  initMapSelect();
  initItems();
  initModes();

  // 初期キャッシュ読込
  loadLocalCache();

  loadMapImage();

  mapImg.addEventListener("load", () => resizeCanvas());
  window.addEventListener("resize", resizeCanvas);

  redrawPins();
  redrawLines();
})();
