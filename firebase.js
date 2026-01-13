// firebase.js（Realtime Database / CDN版）

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  set,
  onValue,
  off,
  query,
  orderByChild,
  equalTo,
  remove,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

// ======================
// Firebase 設定（もう埋まってるのでOK）
// ======================
const firebaseConfig = {
  apiKey: "AIzaSyD9-XkgpLnl3AjnLkIJ_8w0ZpbpfV3JsCE",
  authDomain: "karenda-289f3.firebaseapp.com",
  databaseURL: "https://karenda-289f3-default-rtdb.firebaseio.com",
  projectId: "karenda-289f3",
  storageBucket: "karenda-289f3.firebasestorage.app",
  messagingSenderId: "1057343778692",
  appId: "1:1057343778692:web:45ba7bd9c5a7f3e347f7d1",
  measurementId: "G-4QQ8ZH2J83",
};

// ======================
// init
// ======================
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ======================
// app.js 用に export
// ======================
export {
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
};
