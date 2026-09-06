"use strict";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, onSnapshot, getDocs, writeBatch,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

/* ---------- firebase ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyC4rpZohnKin84JL3qPa39rNegyz5wRr04",
  authDomain: "timeupboss-spv.firebaseapp.com",
  projectId: "timeupboss-spv",
  storageBucket: "timeupboss-spv.firebasestorage.app",
  messagingSenderId: "811677770819",
  appId: "1:811677770819:web:5f8551ef8764acc6c820f6",
  measurementId: "G-HTGBX8FDZM",
};
const fb = initializeApp(firebaseConfig);
const db = getFirestore(fb);
const auth = getAuth(fb);

/* ---------- config ---------- */
const CH_COUNT = 3;
const SOON_MS = 5 * 60 * 1000;
const ONLINE_MS = 90 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // ห้องที่ไม่มีความเคลื่อนไหวเกิน 1 วัน = ลบ
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const DEFAULT_BOSSES = [
  { name: "Echo Berserker Master", min: 60 },
  { name: "Echo Necromancer Master", min: 60 },
  { name: "Echo Gunslinger Master", min: 60 },
  { name: "Echo Paladin Master", min: 60 },
  { name: "Echo Priest Master", min: 60 },
  { name: "Echo Shinobi Master", min: 60 },
  { name: "Echo Weaver Master", min: 60 },
  { name: "Echo Wizard Master", min: 60 },
];

/* ---------- local identity ---------- */
const el = (id) => document.getElementById(id);
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch {} }

function clientId() {
  let id = lsGet("timeupboss.clientId");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
    lsSet("timeupboss.clientId", id);
  }
  return id;
}
const CID = clientId();
const charKey = (code) => `timeupboss.char.${code}`;

/* ---------- state ---------- */
const state = {
  code: null,
  bosses: structuredClone(DEFAULT_BOSSES),
  records: [],
  members: [],
};
let unsubRoom = null, unsubRecords = null, unsubMembers = null, heartbeat = null;
let notifyOn = false;
const notified = new Set();

/* ---------- helpers ---------- */
function pad(n) { return String(n).padStart(2, "0"); }
function fmtClock(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function fmtDateTime(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? fmtClock(d) : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${fmtClock(d)}`;
}
function fmtCountdown(ms) {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const body = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return neg ? `+${body}` : body;
}
function localInputValue(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function randomCode() {
  let s = "";
  const a = crypto.getRandomValues(new Uint32Array(6));
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[a[i] % CODE_ALPHABET.length];
  return s;
}
function roomLink(code) {
  return `${location.origin}${location.pathname}?room=${code}`;
}

/* ---------- firestore paths ---------- */
const roomRef = (code) => doc(db, "rooms", code);
const recordsCol = (code) => collection(db, "rooms", code, "records");
const recordRef = (code, id) => doc(db, "rooms", code, "records", id);
const membersCol = (code) => collection(db, "rooms", code, "members");
const memberRef = (code, cid) => doc(db, "rooms", code, "members", cid);
const roomsCol = () => collection(db, "rooms");

function touchRoom(code) {
  if (code) updateDoc(roomRef(code), { lastActivity: Date.now() }).catch(() => {});
}

// ลบห้องที่เงียบเกิน ROOM_TTL_MS (รวม subcollection records/members)
async function sweepOldRooms() {
  try {
    const cutoff = Date.now() - ROOM_TTL_MS;
    const qs = await getDocs(roomsCol());
    for (const rd of qs.docs) {
      const d = rd.data();
      const last = d.lastActivity || d.createdAt || 0;
      if (last >= cutoff) continue;
      for (const sub of ["records", "members"]) {
        const ss = await getDocs(collection(db, "rooms", rd.id, sub));
        if (!ss.empty) {
          const b = writeBatch(db);
          ss.forEach((x) => b.delete(x.ref));
          await b.commit();
        }
      }
      await deleteDoc(rd.ref);
      console.info("swept room", rd.id);
    }
  } catch (e) {
    console.warn("sweepOldRooms failed", e);
  }
}

/* ---------- lobby ---------- */
el("createForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const roomName = el("createRoomName").value.trim();
  const charName = el("createCharName").value.trim();
  if (!roomName || !charName) return;
  el("lobbyMsg").textContent = "กำลังสร้างห้อง...";
  try {
    let code;
    for (let i = 0; i < 5; i++) {
      code = randomCode();
      const snap = await getDoc(roomRef(code));
      if (!snap.exists()) break;
      code = null;
    }
    if (!code) throw new Error("สุ่มรหัสไม่สำเร็จ ลองใหม่");
    await setDoc(roomRef(code), {
      name: roomName,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      bosses: DEFAULT_BOSSES,
    });
    lsSet(charKey(code), charName);
    goToRoom(code);
  } catch (err) {
    el("lobbyMsg").textContent = "ผิดพลาด: " + err.message;
  }
});

el("joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = el("joinCode").value.trim().toUpperCase();
  const charName = el("joinCharName").value.trim();
  if (code.length !== 6 || !charName) { el("lobbyMsg").textContent = "กรอกรหัส 6 ตัว + ชื่อ"; return; }
  el("lobbyMsg").textContent = "กำลังเข้าห้อง...";
  const snap = await getDoc(roomRef(code));
  if (!snap.exists()) { el("lobbyMsg").textContent = "ไม่พบห้องรหัสนี้"; return; }
  lsSet(charKey(code), charName);
  goToRoom(code);
});

function goToRoom(code) {
  history.pushState({}, "", roomLink(code));
  boot();
}

/* ---------- name gate ---------- */
el("nameForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = new URLSearchParams(location.search).get("room");
  const name = el("gateCharName").value.trim();
  if (!code || !name) return;
  lsSet(charKey(code), name);
  boot();
});
el("gateBack").addEventListener("click", () => {
  history.pushState({}, "", location.pathname);
  boot();
});

/* ---------- enter / leave room ---------- */
async function enterRoom(code) {
  const charName = lsGet(charKey(code));

  // มีรหัสห้องใน URL แต่ยังไม่มีชื่อ → ขึ้นฟอร์มกรอกชื่อทันที ไม่ต้องรอ getDoc
  if (!charName) {
    el("gateRoomName").textContent = `รหัส ${code}`;
    el("gateMsg").textContent = "กำลังตรวจห้อง...";
    show("nameGate");
    getDoc(roomRef(code)).then((s) => {
      if (s.exists()) {
        el("gateRoomName").textContent = `“${s.data().name || code}” (${code})`;
        el("gateMsg").textContent = "";
      } else {
        el("gateMsg").textContent = "⚠️ ไม่พบห้องรหัสนี้ — เช็ครหัสอีกครั้ง";
      }
    }).catch((e) => { el("gateMsg").textContent = "ตรวจห้องไม่ได้: " + e.message; });
    return;
  }

  const snap = await getDoc(roomRef(code));
  if (!snap.exists()) {
    alert("ไม่พบห้องรหัส " + code);
    history.replaceState({}, "", location.pathname);
    boot();
    return;
  }

  state.code = code;
  el("rmName").textContent = snap.data().name || "ห้อง";
  el("rmCode").textContent = code;
  el("roomMeta").classList.remove("hidden");
  fillChannels();
  show("room");
  renderMembers();

  // live listeners (attach first — must not depend on member write succeeding)
  unsubRoom = onSnapshot(roomRef(code), (d) => {
    if (!d.exists()) return;
    const data = d.data();
    el("rmName").textContent = data.name || "ห้อง";
    state.bosses = Array.isArray(data.bosses) && data.bosses.length ? data.bosses : structuredClone(DEFAULT_BOSSES);
    fillBosses();
    renderBossList();
  }, (err) => rulesError("room", err));
  unsubRecords = onSnapshot(recordsCol(code), (qs) => {
    state.records = qs.docs.map((x) => ({ id: x.id, ...x.data() }));
    renderRecords();
  }, (err) => rulesError("records", err));
  unsubMembers = onSnapshot(membersCol(code), (qs) => {
    state.members = qs.docs.map((x) => ({ id: x.id, ...x.data() }));
    renderMembers();
  }, (err) => rulesError("members", err));

  // join as member + heartbeat (non-blocking)
  setDoc(memberRef(code, CID), { name: charName, joinedAt: Date.now(), lastSeen: Date.now() }, { merge: true })
    .catch((err) => rulesError("join", err));
  touchRoom(code);
  clearInterval(heartbeat);
  let beats = 0;
  heartbeat = setInterval(() => {
    updateDoc(memberRef(code, CID), { lastSeen: Date.now() }).catch(() => {});
    if (++beats % 10 === 0) touchRoom(code); // bump lastActivity ~ทุก 5 นาที
  }, HEARTBEAT_MS);
}

function rulesError(where, err) {
  console.error(`[Firestore ${where}]`, err);
  el("rmName").textContent = "⚠️ อ่านข้อมูลห้องไม่ได้ — ตรวจ Firestore Rules";
}

function leaveRoom() {
  if (state.code) deleteDoc(memberRef(state.code, CID)).catch(() => {});
  teardown();
  history.pushState({}, "", location.pathname);
  boot();
}
function teardown() {
  unsubRoom?.(); unsubRecords?.(); unsubMembers?.();
  unsubRoom = unsubRecords = unsubMembers = null;
  clearInterval(heartbeat); heartbeat = null;
  state.code = null;
  state.records = [];
  state.members = [];
  notified.clear();
  el("roomMeta").classList.add("hidden");
}
el("leaveRoom").addEventListener("click", leaveRoom);
window.addEventListener("beforeunload", () => {
  if (state.code) deleteDoc(memberRef(state.code, CID)).catch(() => {});
});
window.addEventListener("popstate", boot);

el("copyLink").addEventListener("click", async () => {
  if (!state.code) return;
  const link = roomLink(state.code);
  try {
    await navigator.clipboard.writeText(link);
    el("copyLink").textContent = "✓ คัดลอกแล้ว";
    setTimeout(() => (el("copyLink").textContent = "📋 คัดลอกลิงก์"), 1500);
  } catch {
    prompt("คัดลอกลิงก์นี้:", link);
  }
});

/* ---------- screen switch ---------- */
function show(id) {
  ["lobby", "nameGate", "room"].forEach((s) => el(s).classList.toggle("hidden", s !== id));
}

/* ---------- selects ---------- */
function fillChannels() {
  const sel = el("chSelect");
  if (sel.options.length) return;
  for (let i = 1; i <= CH_COUNT; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `CH ${i}`;
    sel.appendChild(o);
  }
}
function fillBosses() {
  const sel = el("bossSelect");
  const prev = sel.value;
  sel.innerHTML = "";
  state.bosses.forEach((b) => {
    const o = document.createElement("option");
    o.value = b.name;
    o.textContent = `${b.name} (${b.min}m)`;
    o.dataset.min = b.min;
    sel.appendChild(o);
  });
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  syncRespawnFromBoss();
}
function syncRespawnFromBoss() {
  const opt = el("bossSelect").selectedOptions[0];
  if (opt) el("respawnMin").value = opt.dataset.min;
}
el("bossSelect").addEventListener("change", syncRespawnFromBoss);

/* ---------- members ---------- */
function renderMembers() {
  const now = Date.now();
  // optimistic: always include self even if snapshot ยังไม่มา / เขียนไม่ผ่าน
  const map = new Map(state.members.map((m) => [m.id, m]));
  if (state.code && !map.has(CID)) {
    map.set(CID, { id: CID, name: lsGet(charKey(state.code)) || "คุณ", joinedAt: 0, lastSeen: now });
  }
  const list = [...map.values()].sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  el("memberCount").textContent = list.length;
  el("memberList").innerHTML = "";
  list.forEach((m) => {
    const online = m.id === CID || now - (m.lastSeen || 0) < ONLINE_MS;
    const li = document.createElement("li");
    li.innerHTML = `<span class="dot ${online ? "on" : "off"}"></span>${escapeHtml(m.name || "?")}${m.id === CID ? ' <span class="bmin">(คุณ)</span>' : ""}`;
    el("memberList").appendChild(li);
  });
}

/* ---------- boss manager ---------- */
function renderBossList() {
  const ul = el("bossList");
  ul.innerHTML = "";
  state.bosses.forEach((b, i) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = b.name;
    const min = document.createElement("span");
    min.className = "bmin";
    min.textContent = `${b.min} นาที`;
    const del = document.createElement("button");
    del.className = "icon-btn";
    del.textContent = "✕";
    del.title = "ลบ";
    del.addEventListener("click", () => {
      const next = state.bosses.filter((_, j) => j !== i);
      updateDoc(roomRef(state.code), { bosses: next }).catch((e) => alert(e.message));
    });
    const right = document.createElement("span");
    right.style.cssText = "display:flex;align-items:center;gap:10px";
    right.append(min, del);
    li.append(label, right);
    ul.appendChild(li);
  });
}
el("bossForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = el("newBossName").value.trim();
  const min = Number(el("newBossMin").value);
  if (!name || !min || min <= 0) return;
  const next = state.bosses.slice();
  const idx = next.findIndex((b) => b.name.toLowerCase() === name.toLowerCase());
  if (idx >= 0) next[idx] = { name: next[idx].name, min };
  else next.push({ name, min });
  updateDoc(roomRef(state.code), { bosses: next })
    .then(() => { el("newBossName").value = ""; el("newBossMin").value = ""; })
    .catch((err) => alert(err.message));
});
el("resetBosses").addEventListener("click", () => {
  if (!confirm("คืนค่ารายชื่อบอสเป็นค่าเริ่มต้น (ทั้งห้อง)?")) return;
  updateDoc(roomRef(state.code), { bosses: DEFAULT_BOSSES }).catch((e) => alert(e.message));
});

/* ---------- records ---------- */
document.querySelectorAll('input[name="timeMode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const manual = document.querySelector('input[name="timeMode"]:checked').value === "manual";
    el("manualWrap").classList.toggle("hidden", !manual);
    if (manual && !el("manualTime").value) el("manualTime").value = localInputValue(new Date());
  });
});

el("killForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.code) return;
  const mode = document.querySelector('input[name="timeMode"]:checked').value;
  let deathTs;
  if (mode === "manual") {
    if (!el("manualTime").value) { alert("ใส่เวลาที่บอสตาย"); return; }
    deathTs = new Date(el("manualTime").value).getTime();
    if (Number.isNaN(deathTs)) { alert("เวลาไม่ถูกต้อง"); return; }
  } else {
    deathTs = Date.now();
  }
  const mins = Number(el("respawnMin").value);
  if (!mins || mins <= 0) { alert("ใส่เวลา respawn เป็นนาที"); return; }

  const by = lsGet(charKey(state.code)) || "?";
  try {
    await addDoc(recordsCol(state.code), {
      ch: Number(el("chSelect").value),
      boss: el("bossSelect").value,
      deathTs,
      respawnMin: mins,
      respawnTs: deathTs + mins * 60000,
      note: el("note").value.trim(),
      by,
      createdAt: Date.now(),
    });
    el("note").value = "";
    touchRoom(state.code);
  } catch (err) {
    alert("บันทึกไม่สำเร็จ: " + err.message);
  }
});

function sortedRecords() {
  const now = Date.now();
  return [...state.records].sort((a, b) => {
    const au = a.respawnTs <= now, bu = b.respawnTs <= now;
    if (au !== bu) return au ? 1 : -1;
    if (!au) return a.respawnTs - b.respawnTs;
    return b.respawnTs - a.respawnTs;
  });
}

function renderRecords() {
  const list = sortedRecords();
  el("emptyMsg").classList.toggle("hidden", list.length > 0);
  el("recordBody").innerHTML = "";
  const now = Date.now();

  list.forEach((r) => {
    const up = r.respawnTs <= now;
    const soon = !up && r.respawnTs - now <= SOON_MS;
    const tr = document.createElement("tr");
    if (up) tr.className = "row-up";
    const status = up
      ? `<span class="badge up">เกิดแล้ว</span>`
      : soon
        ? `<span class="badge soon">ใกล้เกิด</span>`
        : `<span class="badge cooldown">คูลดาวน์</span>`;
    tr.innerHTML = `
      <td>CH ${r.ch}</td>
      <td>${escapeHtml(r.boss)}${r.note ? ` <span class="bmin">· ${escapeHtml(r.note)}</span>` : ""}</td>
      <td>${fmtDateTime(r.deathTs)}</td>
      <td>${fmtDateTime(r.respawnTs)}</td>
      <td class="countdown">${fmtCountdown(r.respawnTs - now)}</td>
      <td>${status}</td>
      <td class="bmin">${escapeHtml(r.by || "")}</td>
      <td><button class="icon-btn" title="ลบ">✕</button></td>
    `;
    tr.querySelector("button").addEventListener("click", () => {
      deleteDoc(recordRef(state.code, r.id)).catch((e) => alert(e.message));
    });
    el("recordBody").appendChild(tr);

    if (notifyOn && up && !notified.has(r.id)) {
      notified.add(r.id);
      try { new Notification("บอสเกิดแล้ว!", { body: `CH ${r.ch} — ${r.boss}` }); } catch {}
    }
  });
}

el("clearExpired").addEventListener("click", async () => {
  if (!state.code) return;
  const now = Date.now();
  const dead = state.records.filter((r) => r.respawnTs <= now);
  if (!dead.length) return;
  const batch = writeBatch(db);
  dead.forEach((r) => batch.delete(recordRef(state.code, r.id)));
  await batch.commit().catch((e) => alert(e.message));
});
el("clearAll").addEventListener("click", async () => {
  if (!state.code || !confirm("ล้างข้อมูลบอสทั้งหมดในห้องนี้?")) return;
  const snap = await getDocs(recordsCol(state.code));
  const batch = writeBatch(db);
  snap.forEach((d) => batch.delete(d.ref));
  await batch.commit().catch((e) => alert(e.message));
});

el("notifyBtn").addEventListener("click", async () => {
  if (!("Notification" in window)) { alert("เบราว์เซอร์ไม่รองรับการแจ้งเตือน"); return; }
  const perm = await Notification.requestPermission();
  notifyOn = perm === "granted";
  el("notifyBtn").textContent = notifyOn ? "🔔 แจ้งเตือน: เปิด" : "🔔 เปิดแจ้งเตือน";
});

/* ---------- tick ---------- */
setInterval(() => {
  el("liveClock").textContent = fmtClock(new Date());
  if (state.code) renderRecords();
}, 1000);
el("liveClock").textContent = fmtClock(new Date());

/* ---------- boot ---------- */
function boot() {
  teardown();
  const code = new URLSearchParams(location.search).get("room");
  if (code) {
    enterRoom(code.toUpperCase());
  } else {
    show("lobby");
    el("lobbyMsg").textContent = "";
    sweepOldRooms();
  }
}

/* ---------- auth gate ---------- */
let started = false;
onAuthStateChanged(auth, (user) => {
  if (user && !started) { started = true; boot(); }
});
signInAnonymously(auth).catch((e) => {
  show("lobby");
  el("lobbyMsg").textContent =
    "เข้าระบบไม่ได้: " + e.message + " — เปิด Anonymous ใน Firebase Console → Authentication";
});
