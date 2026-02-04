// app.js（Realtime Database版 + 土日祝日対応 + 31日制御）
// リアルタイム表示 + 送信で追加 + ×で削除
// 名前はモーダル選択方式（select不使用）
// モバイル下固定入力欄対応

import {
  db,
  ref,
  push,
  set,
  onValue,
  off,
  query,
  orderByChild,
  equalTo,
  remove,
} from "./firebase.js";

/* ======================
   DOM
====================== */
const nameInput = document.getElementById("nameInput");      // hidden
const nameButton = document.getElementById("nameButton");

const dateInput = document.getElementById("dateInput");
const contentInput = document.getElementById("contentInput");

const submitBtn = document.getElementById("submitBtn");
const quickHolidayBtn = document.getElementById("quickHolidayBtn");

const currentMonthLabel = document.getElementById("currentMonthLabel");
const prevMonthBtn = document.getElementById("prevMonthBtn");
const nextMonthBtn = document.getElementById("nextMonthBtn");

/* 名前モーダル */
const nameModal = document.getElementById("nameModal");
const nameModalBackdrop = document.getElementById("nameModalBackdrop");
const nameModalClose = document.getElementById("nameModalClose");

/* ======================
   表示中の年月（初期：今月）
====================== */
const now = new Date();
let viewYear = now.getFullYear();
let viewMonth = now.getMonth() + 1; // 0始まり

/* DB */
const POSTS_PATH = "calendar_posts";

/* 祝日キャッシュ */
let holidaysCache = {};

/* 表示中の投稿データ（日付タップ用） */
let currentPosts = [];

/* 名前→フルネームのマッピング */
const NAME_FULL_MAP = {};
document.querySelectorAll(".name-list button").forEach(btn => {
  NAME_FULL_MAP[btn.dataset.name] = btn.textContent.trim();
});

function getFullName(shortName) {
  return NAME_FULL_MAP[shortName] || shortName;
}

/* カレンダー表示用の短縮名マッピング（下の名前だけ表示したい人） */
const CALENDAR_SHORT_MAP = {
  "吉田広司": "広司",
  "きみさん": "喜三次",
};

function getCalendarName(name) {
  return CALENDAR_SHORT_MAP[name] || name;
}

/* ======================
   utils
====================== */
function pad2(n) {
  return String(n).padStart(2, "0");
}

function getYearMonthKey(y, m) {
  return `${y}-${pad2(m)}`;
}

function setMonthLabel(y, m) {
  currentMonthLabel.textContent = `${y}年${m}月`;
}

function getDayFromDateValue(v) {
  const p = v.split("-");
  if (p.length !== 3) return null;
  const d = Number(p[2]);
  return Number.isFinite(d) ? d : null;
}

function getYMFromDateValue(v) {
  const p = v.split("-");
  if (p.length !== 3) return null;
  const y = Number(p[0]);
  const m = Number(p[1]);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  return { y, m };
}

/* 曜日取得（0:日 〜 6:土） */
function getDayOfWeek(y, m, d) {
  return new Date(y, m - 1, d).getDay();
}

/* 曜日名 */
const WEEKDAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];

/* その月の最終日を取得 */
function getLastDayOfMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

/* ======================
   祝日API取得
====================== */
async function fetchHolidays(year) {
  if (holidaysCache[year]) return holidaysCache[year];

  try {
    const res = await fetch(`https://holidays-jp.github.io/api/v1/${year}/date.json`);
    if (!res.ok) throw new Error("祝日API取得失敗");
    const data = await res.json();
    holidaysCache[year] = data;
    return data;
  } catch (err) {
    console.error(err);
    return {};
  }
}

/* 祝日判定 */
function isHoliday(y, m, d, holidays) {
  const key = `${y}-${pad2(m)}-${pad2(d)}`;
  return holidays && holidays[key];
}

/* ======================
   カレンダー描画
====================== */
function clearAllCells() {
  for (let d = 1; d <= 31; d++) {
    const row = document.querySelector(`.entries-row[data-day="${d}"]`);
    if (row) row.innerHTML = "";
  }
  refreshPlaceholders();
}

function refreshPlaceholders() {
  for (let d = 1; d <= 31; d++) {
    const row = document.querySelector(`.entries-row[data-day="${d}"]`);
    const ph = document.querySelector(`.placeholder[data-placeholder-day="${d}"]`);
    if (!row || !ph) continue;
    ph.style.display = row.children.length > 0 ? "none" : "block";
  }
}

/* 日付ヘッダーに曜日・祝日を追加 + 31日の表示制御 */
async function updateDateHeaders(y, m) {
  const holidays = await fetchHolidays(y);
  const lastDay = getLastDayOfMonth(y, m);

  for (let d = 1; d <= 31; d++) {
    const dateCell = document.querySelector(`.date-cell[data-day="${d}"]`);
    if (!dateCell) continue;

    // 対応するコンテンツセルを取得
    const contentCell = dateCell.closest('.date-column')
      ?.nextElementSibling
      ?.querySelector(`.content-cell:nth-child(${d <= 15 ? d : d - 15})`);

    // 31日がない月は非表示
    if (d === 31 && lastDay < 31) {
      dateCell.style.display = 'none';
      if (contentCell) contentCell.style.display = 'none';
      continue;
    } else {
      dateCell.style.display = '';
      if (contentCell) contentCell.style.display = '';
    }

    const dow = getDayOfWeek(y, m, d);
    const weekdayName = WEEKDAY_NAMES[dow];
    const holiday = isHoliday(y, m, d, holidays);

    // 既存の日付表示を更新
    let dateText = `${d}日（${weekdayName}）`;
    if (holiday) {
      dateText += `<br><span class="holiday-name">${holiday}</span>`;
    }

    dateCell.innerHTML = dateText;

    // CSSクラス追加
    dateCell.classList.remove("saturday", "sunday", "holiday");
    if (holiday || dow === 0) {
      dateCell.classList.add("holiday");
    } else if (dow === 6) {
      dateCell.classList.add("saturday");
    }
  }
}

/* カレンダーセル用：名前の頭1文字だけ表示 */
function createEntryItem({ name }) {
  const item = document.createElement("span");
  item.className = "entry-item";
  const displayName = getCalendarName(name);
  item.textContent = displayName.charAt(0);
  return item;
}

/* モーダル用：フルネーム＋内容＋削除ボタン */
function createDetailItem({ id, name, text }) {
  const item = document.createElement("div");
  item.className = "detail-entry";

  const strong = document.createElement("strong");
  strong.textContent = getFullName(name);

  const sep = document.createTextNode("：");

  const span = document.createElement("span");
  span.textContent = text;

  const del = document.createElement("button");
  del.className = "delete-btn";
  del.textContent = "×";
  del.addEventListener("click", async () => {
    await remove(ref(db, `${POSTS_PATH}/${id}`));
  });

  item.append(strong, sep, span, del);
  return item;
}

/* ======================
   Realtime Database 購読
====================== */
let currentQueryRef = null;
let currentCallback = null;

function unsubscribeMonth() {
  if (currentQueryRef && currentCallback) {
    off(currentQueryRef, "value", currentCallback);
  }
  currentQueryRef = null;
  currentCallback = null;
}

function subscribeMonth(y, m) {
  unsubscribeMonth();
  clearAllCells();

  const ym = getYearMonthKey(y, m);
  setMonthLabel(y, m);

  // 曜日・祝日ヘッダー更新
  updateDateHeaders(y, m);

  const qref = query(
    ref(db, POSTS_PATH),
    orderByChild("ym"),
    equalTo(ym)
  );

  const cb = (snap) => {
    clearAllCells();

    const data = snap.val();
    if (!data) {
      currentPosts = [];
      refreshPlaceholders();
      if (openDetailDay !== null && dayDetailModal.classList.contains("is-open")) {
        renderDayDetail();
      }
      return;
    }

    const posts = Object.entries(data).map(([id, v]) => ({
      id,
      day: Number(v.day),
      name: String(v.name),
      text: String(v.text),
      createdAt: Number(v.createdAt || 0),
    }));

    posts.sort((a, b) =>
      a.day !== b.day ? a.day - b.day : a.createdAt - b.createdAt
    );

    currentPosts = posts;

    posts.forEach(p => {
      if (p.day < 1 || p.day > 31) return;
      const row = document.querySelector(`.entries-row[data-day="${p.day}"]`);
      if (!row) return;
      row.appendChild(createEntryItem(p));
    });

    refreshPlaceholders();

    if (openDetailDay !== null && dayDetailModal.classList.contains("is-open")) {
      renderDayDetail();
    }
  };

  onValue(qref, cb);
  currentQueryRef = qref;
  currentCallback = cb;
}

/* ======================
   送信
====================== */
async function handleSubmit() {
  const name = nameInput.value;
  const dateVal = dateInput.value;
  const text = contentInput.value.trim();

  if (!name) return alert("名前を選択");
  if (!dateVal) return alert("日付を選択");
  if (!text) return alert("内容を入力");

  const ymObj = getYMFromDateValue(dateVal);
  const day = getDayFromDateValue(dateVal);
  if (!ymObj || !day) return alert("日付がおかしい");

  const { y, m } = ymObj;
  const lastDay = getLastDayOfMonth(y, m);

  if (day < 1 || day > lastDay) {
    return alert(`${m}月は${lastDay}日までです`);
  }

  await set(push(ref(db, POSTS_PATH)), {
    ym: getYearMonthKey(y, m),
    day,
    name,
    text,
    createdAt: Date.now(),
  });

  contentInput.value = "";

  if (y !== viewYear || m !== viewMonth) {
    viewYear = y;
    viewMonth = m;
    subscribeMonth(viewYear, viewMonth);
  }
}

/* ======================
   名前モーダル
====================== */
nameButton.addEventListener("click", () => {
  nameModal.classList.add("is-open");
});

function closeNameModal() {
  nameModal.classList.remove("is-open");
}

nameModalBackdrop.addEventListener("click", closeNameModal);
nameModalClose.addEventListener("click", closeNameModal);

document.querySelectorAll(".name-list button").forEach(btn => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.name;
    nameInput.value = name;
    nameButton.textContent = name;
    closeNameModal();
  });
});

/* ======================
   日付詳細モーダル
====================== */
const dayDetailModal = document.getElementById("dayDetailModal");
const dayDetailBackdrop = document.getElementById("dayDetailBackdrop");
const dayDetailClose = document.getElementById("dayDetailClose");
const dayDetailTitle = document.getElementById("dayDetailTitle");
const dayDetailList = document.getElementById("dayDetailList");

let openDetailDay = null;

function openDayDetail(day) {
  openDetailDay = day;
  renderDayDetail();
  dayDetailModal.classList.add("is-open");
}

function renderDayDetail() {
  if (openDetailDay === null) return;
  const dayPosts = currentPosts.filter(p => p.day === openDetailDay);

  if (dayPosts.length === 0 && dayDetailModal.classList.contains("is-open")) {
    closeDayDetail();
    return;
  }

  dayDetailTitle.textContent = `${viewMonth}月${openDetailDay}日`;
  dayDetailList.innerHTML = "";

  dayPosts.forEach(p => {
    dayDetailList.appendChild(createDetailItem(p));
  });
}

function closeDayDetail() {
  openDetailDay = null;
  dayDetailModal.classList.remove("is-open");
}

dayDetailBackdrop.addEventListener("click", closeDayDetail);
dayDetailClose.addEventListener("click", closeDayDetail);

/* 日付セル・コンテンツセルのクリックで詳細モーダルを開く */
for (let d = 1; d <= 31; d++) {
  const dateCell = document.querySelector(`.date-cell[data-day="${d}"]`);
  const contentCell = dateCell?.closest('.date-column')
    ?.nextElementSibling
    ?.querySelector(`.content-cell:nth-child(${d <= 15 ? d : d - 15})`);

  if (dateCell) {
    dateCell.style.cursor = "pointer";
    dateCell.addEventListener("click", () => openDayDetail(d));
  }
  if (contentCell) {
    contentCell.addEventListener("click", () => openDayDetail(d));
  }
}

/* ======================
   月切り替え
====================== */
prevMonthBtn.addEventListener("click", () => {
  viewMonth--;
  if (viewMonth === 0) {
    viewMonth = 12;
    viewYear--;
  }
  subscribeMonth(viewYear, viewMonth);
});

nextMonthBtn.addEventListener("click", () => {
  viewMonth++;
  if (viewMonth === 13) {
    viewMonth = 1;
    viewYear++;
  }
  subscribeMonth(viewYear, viewMonth);
});

/* ======================
   events
====================== */
submitBtn.addEventListener("click", handleSubmit);

quickHolidayBtn.addEventListener("click", () => {
  contentInput.value = contentInput.value
    ? `${contentInput.value}、やすみ`
    : "やすみ";
  contentInput.focus();
});

contentInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    handleSubmit();
  }
});

/* ======================
   start
====================== */
subscribeMonth(viewYear, viewMonth);
