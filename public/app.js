// وصل — منطق الواجهة واتصالات WebRTC (شبكة نظير-لنظير بين كل المشاركين)
"use strict";

// خوادم الاتصال: تُحدَّث من الخادم (/api/config) لتشمل TURN إن ضُبط في إعدادات النشر
let ICE_CONFIG = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};
const CONNECT_TIMEOUT = 20000; // بعدها نعرض «تعذر الاتصال» مع زر إعادة المحاولة

// نجلب إعدادات الاتصال مرة واحدة مبكراً (عند فتح الصفحة) فلا ينتظرها زر الدخول
let iceConfigPromise = null;
function loadIceConfig() {
  return (iceConfigPromise ||= fetchIceConfig());
}
async function fetchIceConfig() {
  try {
    const r = await fetch("/api/config");
    if (r.ok) {
      const c = await r.json();
      if (Array.isArray(c.iceServers) && c.iceServers.length) ICE_CONFIG = { iceServers: c.iceServers };
    }
  } catch {}
}
// رمز الحلقة: عشوائي (abc-defg-hij) أو اسم غرفة ثابتة (sahaba-juz-amma) — مطابق لما في الخادم
const ROOM_RE = /^(?!.*-r[1-9]$)(?!(?:api|healthz)$)[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const COLORS = ["#2f8f6b", "#4f6d7a", "#3f6f8f", "#6b7d4a", "#8a5a3c", "#4a7c74", "#7a6a4f", "#5b6770"];
const REACTIONS = ["👍", "👏", "🤲", "❤️", "🌟", "✅"];
const GRADES = {
  excellent: { label: "ممتاز", stars: 3, title: "ما شاء الله! تسميع ممتاز", note: "أتقنت الحفظ، بارك الله فيك" },
  vgood: { label: "جيد جداً", stars: 2, title: "أحسنت! جيد جداً", note: "قريب من الإتقان، واصل" },
  good: { label: "جيد", stars: 1, title: "جيد، واصل التقدّم", note: "راجع المقطع مرة أخرى" },
  review: { label: "يحتاج مراجعة", stars: 0, title: "تحتاج مراجعة", note: "لا بأس، راجع وستتقنه بإذن الله" },
};

const $ = (id) => document.getElementById(id);

// وضع العرض: ملف HTML واحد يعمل بدون خادم (لا يمكن للآخرين الانضمام)
const DEMO = !!window.HALAQATI_DEMO;

// معرّف المشارك محفوظ لهذه النافذة فقط: يبقى بعد التحديث (فلا يعود من أُخرج بالتحديث)، ويختلف بين النوافذ
// معرّف الجهاز: ثابت في هذا المتصفح حتى بعد إغلاقه — به يبقى المشرف مشرفاً ويُعرف الممنوع
function deviceId() {
  try {
    let id = localStorage.getItem("wasl:did");
    if (!id) localStorage.setItem("wasl:did", (id = uid()));
    return id;
  } catch {
    return uid();
  }
}
// مفاتيح الإشراف المحفوظة: { رمز الحلقة: مفتاح }
const AKEYS = "wasl:akeys";
function getAdminKey(code) {
  try {
    return JSON.parse(localStorage.getItem(AKEYS) || "{}")[code] || null;
  } catch {
    return null;
  }
}
function saveAdminKey(code, key) {
  try {
    const all = JSON.parse(localStorage.getItem(AKEYS) || "{}");
    if (key) all[code] = key;
    else delete all[code];
    localStorage.setItem(AKEYS, JSON.stringify(all));
  } catch {}
}

function tabCid() {
  try {
    let id = sessionStorage.getItem("wasl:cid");
    if (!id) sessionStorage.setItem("wasl:cid", (id = uid()));
    return id;
  } catch {
    return uid();
  }
}

// نافذة تأكيد مرتبة في وسط الشاشة بدل نافذة المتصفح. ترجع وعداً بنعم/لا
function askConfirm({ title, text, ok = "حذف", icon: ic = "trash", danger = true }) {
  return new Promise((resolve) => {
    const modal = $("confirmModal");
    $("confirmTitle").textContent = title;
    $("confirmText").textContent = text || "";
    $("confirmText").hidden = !text;
    $("confirmOk").textContent = ok;
    $("confirmOk").className = `btn ${danger ? "btn-danger-solid" : "btn-primary"}`;
    $("confirmIcon").className = `confirm-icon${danger ? "" : " calm"}`;
    $("confirmIcon").innerHTML = icon(ic);
    modal.hidden = false;
    $("confirmCancel").focus();
    const done = (answer) => {
      modal.hidden = true;
      modal.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
      resolve(answer);
    };
    const onClick = (e) => {
      if (e.target.closest("#confirmOk")) done(true);
      else if (e.target.closest("[data-cancel]")) done(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(false);
      }
    };
    modal.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey, true);
  });
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const state = {
  code: null, // رمز الحلقة الرئيسية
  room: null, // الغرفة الحالية: الحلقة الرئيسية أو إحدى غرفها الفرعية (abc-defg-hij-r2)
  cid: tabCid(), // معرّف ثابت لهذا المشارك يبقى عند التنقل بين الغرف وتحديث الصفحة
  did: deviceId(),
  breakout: null, // حالة الغرف الفرعية المفتوحة
  name: "",
  myId: null,
  stream: null, // الكاميرا والميكروفون
  screenStream: null,
  micOn: true,
  camOn: true,
  hand: false,
  role: "student", // teacher (منشئ الغرفة) | admin (مشرف يعيّنه المعلّم) | student — يقرّره الخادم
  pinned: null, // معرّف البلاطة المثبتة، أو "none" لإلغاء التثبيت التلقائي
  handAt: 0, // وقت رفع اليد — لترتيب طابور التسميع
  reciter: null, // معرّف الطالب الذي يُسمّع الآن
  stars: {}, // نجوم كل طالب في هذه الحلقة: { معرّف: عدد }
  sessionStars: 0,
  es: null,
  peers: new Map(), // id -> { id, name, pc, stream, pendingIce, mic, cam, hand, screen, tile }
  localTile: null,
  joinedAt: 0,
  audioCtx: null,
  meters: new Map(), // tile -> analyser
  recorder: null,
  recDest: null, // مزج كل الأصوات للتسجيل
};

/* ---------- أدوات عامة ---------- */

function toast(text, ms = 2600) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), ms);
}

function icon(name, cls = "") {
  return `<svg class="i ${cls}"><use href="#i-${name}"/></svg>`;
}

// تلميح يظهر فوق أزرار التحكم بدل تلميح المتصفح
function setTip(el, text) {
  el.dataset.tip = text;
  el.setAttribute("aria-label", text);
  el.removeAttribute("title");
}

// المعلّم والمشرف لهم صلاحيات إدارة الحلقة
const isStaff = (role) => role === "teacher" || role === "admin";
const ROLE_LABEL = { teacher: "المعلّم", admin: "مشرف" };
// في القوائم نوضّح أن المعلّم هو المستضيف
const ROLE_LONG = { teacher: "المعلّم / المستضيف", admin: "مشرف" };

// مفاتيح المعلّم للغرف التي أنشأتها على هذا الجهاز
const KEYS = "wasl:keys";
function getKey(code) {
  try {
    return JSON.parse(localStorage.getItem(KEYS) || "{}")[code] || null;
  } catch {
    return null;
  }
}
function saveKey(code, key) {
  try {
    const all = JSON.parse(localStorage.getItem(KEYS) || "{}");
    all[code] = key;
    localStorage.setItem(KEYS, JSON.stringify(all));
  } catch {}
}
function teacherLink(code) {
  const key = getKey(code);
  return key && !DEMO ? `${linkFor(code)}#k=${key}` : null;
}

// الخادم ينشئ الغرفة ويعطي منشئها مفتاح المعلّم
async function createRoom(slug) {
  if (DEMO) {
    const code = slug ? `${slug}-${genCode().slice(0, 3)}` : genCode();
    saveKey(code, "demo");
    return code;
  }
  const r = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(slug ? { slug } : {}),
  });
  if (!r.ok) throw new Error("create_failed");
  const { code, key } = await r.json();
  saveKey(code, key);
  return code;
}

function formatDuration(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} دقيقة`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} ساعة و${m} دقيقة` : `${h} ساعة`;
}

function ensureAudio() {
  try {
    state.audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    state.audioCtx.resume();
  } catch {
    state.audioCtx = null;
  }
}

function colorFor(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

// الحرف الأول من الاسم، بعد تجاوز الألقاب و«ال» التعريف: «الشيخ عبدالرحمن» ← ع
function initial(name) {
  const words = name.replace(" (أنت)", "").trim().split(/\s+/).filter(Boolean);
  const titles = ["الشيخ", "شيخ", "الأستاذ", "الاستاذ", "أستاذ", "استاذ", "المعلم", "المعلّم", "د.", "أ."];
  const word = words.find((w) => !titles.includes(w)) || words[0] || "؟";
  const chars = [...word];
  const start = chars.length > 3 && chars[0] === "ا" && chars[1] === "ل" ? 2 : 0;
  return chars[start].toUpperCase();
}

function genCode() {
  const letters = "abcdefghijkmnopqrstuvwxyz";
  const part = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => letters[b % letters.length]).join("");
  return `${part(3)}-${part(4)}-${part(3)}`;
}

// يقبل الرمز وحده أو الرابط كاملاً
function parseCode(input) {
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  s = s.slice(s.lastIndexOf("/") + 1);
  if (ROOM_RE.test(s)) return s;
  const plain = s.replace(/[^a-z]/g, "");
  if (plain.length === 10 && !/[0-9]/.test(s)) return `${plain.slice(0, 3)}-${plain.slice(3, 7)}-${plain.slice(7)}`;
  return null;
}

function timeNow() {
  return new Date().toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
}

function show(viewId) {
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== viewId;
}

// في الملف التجريبي (بدون خادم) نستخدم # حتى يفتح الرابط الغرفة بدل أن يبحث عنه المتصفح في Google
function linkFor(code) {
  return DEMO ? `${location.href.split("#")[0]}#${code}` : `${location.origin}/${code}`;
}

function meetingLink() {
  return linkFor(state.code);
}

/* ---------- التنقل ---------- */

function route() {
  // رابط المعلّم: /رمز#k=المفتاح — نحفظ المفتاح ثم نزيله من شريط العنوان
  if (!DEMO && location.hash.startsWith("#k=")) {
    const code = parseCode(location.pathname.slice(1));
    if (code) saveKey(code, decodeURIComponent(location.hash.slice(3)));
    history.replaceState({}, "", location.pathname);
  }
  const path = DEMO ? decodeURIComponent(location.hash.slice(1)) : location.pathname.slice(1);
  const code = parseCode(path);
  if (code && path === code) {
    state.code = code;
    openLobby();
  } else {
    stopMedia();
    show("home");
    renderUpcoming();
    renderTerms();
  }
}

function goTo(code) {
  if (DEMO) {
    const target = code ? `#${code}` : "";
    if (location.hash === target || (!code && !location.hash)) route();
    else location.hash = code || ""; // يستدعي route عبر hashchange
    return;
  }
  history.pushState({}, "", code ? `/${code}` : "/");
  route();
}

window.addEventListener("hashchange", () => {
  if (!DEMO) return;
  if (state.joinedAt) leave(false);
  route();
});

window.addEventListener("popstate", () => {
  if (state.es) leave(false);
  route();
});

/* ---------- الصفحة الرئيسية ---------- */

$("newMeetingBtn").addEventListener("click", async () => {
  $("newMeetingBtn").disabled = true;
  try {
    goTo(await createRoom());
  } catch {
    $("homeError").textContent = "تعذر إنشاء الحلقة، تأكد من الاتصال وحاول مرة أخرى";
  }
  $("newMeetingBtn").disabled = false;
});

$("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = parseCode($("joinCode").value);
  if (!code) {
    $("homeError").textContent = "رمز غير صالح. الصق رابط الحلقة أو رمزها مثل: abc-defg-hij";
    return;
  }
  $("homeError").textContent = "";
  goTo(code);
});

function elapsed(ms) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

setInterval(() => {
  $("homeClock").textContent = timeNow();
  $("roomClock").textContent = timeNow();
  if (state.joinedAt) $("roomElapsed").textContent = elapsed(Date.now() - state.joinedAt);
}, 1000);

$("joinCode").addEventListener("input", () => {
  $("joinBtn").disabled = !$("joinCode").value.trim();
});
$("homeClock").textContent = $("roomClock").textContent = timeNow();

/* ---------- الوسائط ---------- */

// الجوال يلتقط بدقة أقل (أخف على المعالج والبطارية والإنترنت)، والكمبيوتر بدقة أعلى
const IS_PHONE = matchMedia("(hover: none) and (pointer: coarse)").matches;
const CAM_CONSTRAINTS = IS_PHONE
  ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } }
  : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
const MIC_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

async function getMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("المتصفح لا يدعم الكاميرا هنا. افتح الموقع عبر HTTPS أو localhost.");
  }
  const attempts = [{ video: CAM_CONSTRAINTS, audio: MIC_CONSTRAINTS }, { audio: MIC_CONSTRAINTS }, { video: true }];
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      // تلميح للمتصفح أن الصوت كلام (تلاوة)، فيعطيه أولوية الوضوح
      for (const t of stream.getAudioTracks()) if ("contentHint" in t) t.contentHint = "speech";
      return stream;
    } catch (err) {
      if (err.name === "NotAllowedError") break;
    }
  }
  return new MediaStream(); // بدون كاميرا أو ميكروفون — يمكنه المشاهدة فقط
}

function stopMedia() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.screenStream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.screenStream = null;
}

const camTrack = () => state.stream?.getVideoTracks()[0] || null;
const micTrack = () => state.stream?.getAudioTracks()[0] || null;

function outgoingTrack(kind) {
  if (kind === "video") return state.screenStream?.getVideoTracks()[0] || camTrack();
  return micTrack();
}

function syncToggleButtons() {
  for (const id of ["lobbyMic", "micBtn"]) {
    $(id).classList.toggle("off", !state.micOn);
    setTip($(id), state.micOn ? "كتم الميكروفون" : "تشغيل الميكروفون");
  }
  for (const id of ["lobbyCam", "camBtn"]) {
    $(id).classList.toggle("off", !state.camOn);
    setTip($(id), state.camOn ? "إيقاف الكاميرا" : "تشغيل الكاميرا");
  }
  $("previewOff").hidden = state.camOn && !!camTrack();
  $("shareBtn").classList.toggle("active", !!state.screenStream);
  $("shareLabel").textContent = state.screenStream ? "إيقاف مشاركة الشاشة" : "مشاركة الشاشة";
  $("handBtn").classList.toggle("on", state.hand);
  if (state.joinedAt) {
    $("micBtn").classList.toggle("locked", !micAllowed());
    $("camBtn").classList.toggle("locked", !camAllowed());
  }
}

/* ---------- المايك والكاميرا بإذن ---------- */

// الطالب يفتح المايك أو الكاميرا فقط إن لم يُقفلا، أو أذن له المعلّم، أو كان دوره في التسميع
const allowed = (kind, cid, id, role) => {
  const c = state.controls;
  if (isStaff(role) || !c?.[`${kind}Lock`]) return true;
  if (c[`${kind}Allow`]?.includes(cid)) return true;
  return kind === "mic" && !!id && state.reciter === id;
};
const micAllowed = () => allowed("mic", state.cid, state.myId, state.role);
const camAllowed = () => allowed("cam", state.cid, state.myId, state.role);

// نطبّق الأقفال عندي (أغلق ما ليس مسموحاً) وعند الاستقبال (لا نسمع ولا نرى من لم يُؤذن له)
function enforceLocks() {
  if (!state.joinedAt) return;
  if (state.micOn && !micAllowed()) setMic(false, true);
  if (state.camOn && !camAllowed()) setCam(false, true);
  for (const p of state.peers.values()) {
    const mic = allowed("mic", p.cid, p.id, p.role);
    const cam = allowed("cam", p.cid, p.id, p.role);
    for (const t of p.stream.getAudioTracks()) t.enabled = mic;
    for (const t of p.stream.getVideoTracks()) if (!p.screen) t.enabled = cam;
    p.blockedMic = !mic;
    p.blockedCam = !cam && !p.screen;
    updatePeerTile(p);
  }
  syncToggleButtons();
}

function setMic(on, forced) {
  if (on && !micAllowed()) return toast("المايك بإذن المعلّم — ارفع يدك ليسمح لك أو ينادي دورك");
  if (forced) toast("أُغلق المايك: الفتح بإذن المعلّم");
  if (on && !micTrack()) return toast("لا يوجد ميكروفون متاح");
  state.micOn = on;
  if (micTrack()) micTrack().enabled = on;
  syncToggleButtons();
  updateLocalTile();
  broadcastState();
}

function setCam(on, forced) {
  if (on && !camAllowed()) return toast("الكاميرا بإذن المعلّم");
  if (forced) toast("أُغلقت الكاميرا: الفتح بإذن المعلّم");
  if (on && !camTrack()) return toast("لا توجد كاميرا متاحة");
  state.camOn = on;
  if (camTrack()) camTrack().enabled = on;
  syncToggleButtons();
  updateLocalTile();
  broadcastState();
}

/* ---------- شاشة ما قبل الدخول ---------- */

async function openLobby() {
  show("lobby");
  $("lobbyCode").textContent = state.code;
  $("lobbyError").textContent = "";
  $("nameInput").value = localStorage.getItem("halaqati:name") || "";
  $("hostBadge").hidden = !getKey(state.code);
  $("hostLinkBtn").hidden = !teacherLink(state.code);
  if (!state.stream) {
    try {
      state.stream = await getMedia();
    } catch (err) {
      $("lobbyError").textContent = err.message;
      state.stream = new MediaStream();
    }
  }
  state.micOn = !!micTrack() && state.micOn;
  state.camOn = !!camTrack() && state.camOn;
  $("previewVideo").srcObject = state.stream;
  syncToggleButtons();
  if (!micTrack() && !camTrack()) {
    $("lobbyError").textContent = "لم نتمكن من الوصول للكاميرا أو الميكروفون. يمكنك الدخول للاستماع فقط.";
  }
  populateDevices();
  startLobbyMeter();
  $("previewName").textContent = $("nameInput").value;
  refreshLobbyPeers();
  $("nameInput").focus();
}

$("nameInput").addEventListener("input", () => {
  $("previewName").textContent = $("nameInput").value;
});

// من في الحلقة الآن؟ يُعرض قبل الدخول
async function refreshLobbyPeers() {
  if (DEMO || $("lobby").hidden || !state.code) return;
  let info = { count: 0, names: [] };
  try {
    info = await (await fetch(`/api/rooms/${state.code}/peers`)).json();
  } catch {}
  const { count, names } = info;
  $("inRoomAvatars").innerHTML = "";
  for (const n of names.slice(0, 4)) {
    const a = document.createElement("span");
    a.textContent = initial(n);
    a.style.background = colorFor(n);
    $("inRoomAvatars").appendChild(a);
  }
  $("inRoomText").textContent =
    count === 0 ? "لا يوجد أحد في الحلقة بعد"
    : count === 1 ? `${names[0]} في الحلقة الآن`
    : count === 2 ? `${names[0]} و${names[1]} في الحلقة الآن`
    : `${names[0]} و${count - 1} آخرون في الحلقة الآن`;
}
setInterval(refreshLobbyPeers, 4000);

let lobbyAnalyser = null;

function startLobbyMeter() {
  ensureAudio();
  lobbyAnalyser = null;
  if (!state.audioCtx || !micTrack()) return;
  try {
    const src = state.audioCtx.createMediaStreamSource(new MediaStream([micTrack()]));
    lobbyAnalyser = state.audioCtx.createAnalyser();
    lobbyAnalyser.fftSize = 512;
    src.connect(lobbyAnalyser);
  } catch {}
}

/* ---------- اختيار الكاميرا والميكروفون ---------- */

async function populateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {}
  for (const sel of document.querySelectorAll(".dev-select")) {
    const kind = sel.dataset.kind;
    const isAudio = kind === "audioinput";
    const list = devices.filter((d) => d.kind === kind && d.deviceId);
    sel.innerHTML = "";
    if (!list.length) {
      sel.add(new Option(isAudio ? "لا يوجد ميكروفون" : "لا توجد كاميرا", ""));
      sel.disabled = true;
      continue;
    }
    sel.disabled = false;
    list.forEach((d, i) => sel.add(new Option(d.label || `${isAudio ? "ميكروفون" : "كاميرا"} ${i + 1}`, d.deviceId)));
    const current = (isAudio ? micTrack() : camTrack())?.getSettings?.().deviceId;
    if (current && list.some((d) => d.deviceId === current)) sel.value = current;
  }
}

async function switchDevice(kind, deviceId) {
  const isAudio = kind === "audioinput";
  let fresh;
  try {
    fresh = await navigator.mediaDevices.getUserMedia(
      isAudio ? { audio: { deviceId: { exact: deviceId } } } : { video: { ...CAM_CONSTRAINTS, deviceId: { exact: deviceId } } }
    );
  } catch {
    return toast("تعذر تشغيل هذا الجهاز");
  }
  const track = isAudio ? fresh.getAudioTracks()[0] : fresh.getVideoTracks()[0];
  const old = isAudio ? micTrack() : camTrack();
  state.stream ||= new MediaStream();
  if (old) {
    state.stream.removeTrack(old);
    old.stop();
  } else if (isAudio) {
    state.micOn = true;
  } else {
    state.camOn = true;
  }
  track.enabled = isAudio ? state.micOn : state.camOn;
  state.stream.addTrack(track);
  $("previewVideo").srcObject = state.stream;
  if (isAudio || !state.screenStream) {
    for (const { pc } of state.peers.values()) {
      const t = pc.getTransceivers().find((x) => x.receiver.track.kind === (isAudio ? "audio" : "video"));
      t?.sender.replaceTrack(track).catch(() => {});
    }
  }
  if (isAudio) {
    startLobbyMeter();
    if (state.localTile) watchLevel(new MediaStream([track]), state.localTile);
    addToRecording(new MediaStream([track]));
  }
  syncToggleButtons();
  updateLocalTile();
  broadcastState();
  populateDevices();
}

document.addEventListener("change", (e) => {
  const sel = e.target.closest?.(".dev-select");
  if (sel?.value) switchDevice(sel.dataset.kind, sel.value);
});

$("lobbyCopy").addEventListener("click", () => copyText(meetingLink(), "تم نسخ رابط الحلقة"));
$("hostLinkBtn").addEventListener("click", () => copyText(teacherLink(state.code), "تم نسخ رابط المعلّم — احتفظ به ولا ترسله للطلاب"));

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    prompt("انسخ النص:", text);
  }
}

$("lobbyMic").addEventListener("click", () => setMic(!state.micOn));
$("lobbyCam").addEventListener("click", () => setCam(!state.camOn));
$("backHomeBtn").addEventListener("click", () => goTo(null));
$("nameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") join();
});
$("joinNowBtn").addEventListener("click", join);

/* ---------- الإشارة (Signaling) ---------- */

// إرسال إشارة مع إعادة المحاولة: إن انقطعت الشبكة لحظة الإرسال (عرض أو جواب أو مسار اتصال)
// لا تضيع الرسالة فيتعلّق الاتصال، بل نعيدها حتى تصل أو يغادر المشارك
function signal(type, data, to) {
  if (!state.myId || DEMO) return;
  const room = state.room;
  const body = JSON.stringify({ from: state.myId, token: state.token, to, type, data });
  const send = async (attempt) => {
    if (state.room !== room || !state.joinedAt || (to && !state.peers.has(to))) return;
    let retry = false;
    try {
      const r = await fetch(`/api/rooms/${room}/signal`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      // 404: قد نكون في منتصف استئناف الجلسة؛ 5xx: الخادم مشغول أو يعيد التشغيل
      retry = r.status === 404 || r.status >= 500;
    } catch {
      retry = true;
    }
    if (retry && attempt < 8) setTimeout(() => send(attempt + 1), Math.min(4000, 500 * 2 ** attempt));
  };
  send(0);
}

function myStatus() {
  return {
    name: state.name,
    mic: state.micOn,
    cam: state.camOn && !!camTrack(),
    hand: state.hand,
    screen: !!state.screenStream,
    recording: !!state.recorder,
    role: state.role,
    handAt: state.handAt,
  };
}

function broadcastState(to) {
  signal("state", myStatus(), to);
}

function join() {
  const name = $("nameInput").value.trim();
  if (!name) {
    $("lobbyError").textContent = "اكتب اسمك أولاً";
    $("nameInput").focus();
    return;
  }
  state.name = name.slice(0, 40);
  // دور مبدئي حتى يؤكده الخادم
  state.role = getKey(state.code) ? "teacher" : "student";
  try {
    localStorage.setItem("halaqati:name", state.name);
  } catch {}
  ensureAudio();

  if (DEMO) {
    state.myId = "demo";
    state.room = state.code;
    enterRoom();
    toast("وضع العرض: انشر الموقع حتى ينضم الطلاب");
    return;
  }

  $("joinNowBtn").disabled = true;
  state.room = state.code;
  loadIceConfig().then(() => connect(state.room));
}

// الاتصال بغرفة (الرئيسية أو فرعية) عبر قناة الأحداث
// resume: { rid, rtoken } للعودة بنفس الهوية بعد انقطاع لحظي، دون هدم اتصالات الصوت والصورة
function connect(roomId, resume) {
  const params = new URLSearchParams({ name: state.name, cid: state.cid, did: state.did });
  const key = getKey(state.code);
  if (key) params.set("key", key);
  const akey = getAdminKey(state.code);
  if (akey) params.set("akey", akey);
  if (resume?.rid && resume?.rtoken) {
    params.set("rid", resume.rid);
    params.set("rtoken", resume.rtoken);
  }
  // القناة: أحداث مستمرة (SSE)، وإن حجبتها الشبكة ننتقل تلقائياً للاستطلاع (polling)
  const handlers = {};
  const ch = state.usePoll ? pollChannel(roomId, params, handlers) : sseChannel(roomId, params, handlers);
  state.es = ch;

  // أحداث قناة قديمة (بعد الانتقال لغرفة أخرى) نتجاهلها
  const on = (name, fn) => (handlers[name] = (e) => ch === state.es && fn(e));
  const es = ch;

  on("welcome", (e) => {
    const { id, token, role, peers, breakout, controls, resumed } = JSON.parse(e.data);
    state.reconnects = 0;
    if (resumed && state.joinedAt && id === state.myId) return resumeSession({ token, role, peers, breakout, controls });
    // عند إعادة الاتصال التلقائي نبدأ من جديد
    for (const p of [...state.peers.values()]) removePeer(p.id, true);
    state.myId = id;
    state.token = token;
    state.role = role;
    state.controls = controls || { locked: false, chatOff: false };
    if (!state.joinedAt) enterRoom();
    applyRole();
    enforceLocks();
    if (applyBreakout(breakout)) return; // انتقلنا لغرفة أخرى
    for (const p of peers) createPeer(p.id, p.name, true, p.cid, p.role);
    broadcastState();
    layoutGrid();
  });

  on("peer-joined", (e) => {
    const { id, name, cid, role } = JSON.parse(e.data);
    createPeer(id, name, false, cid, role);
    broadcastState(id);
    toast(`انضم ${name}`);
  });

  on("breakout", (e) => applyBreakout(JSON.parse(e.data)));
  on("role", (e) => {
    const { cid, role } = JSON.parse(e.data);
    if (cid === state.cid) {
      const was = state.role;
      state.role = role;
      applyRole();
      if (role === "admin" && was !== "admin") toast("عيّنك المعلّم مشرفاً: تقدر تكتم الطلاب وتخرجهم وتدير الدخول والتسميع وغرف المراجعة");
      if (role === "student" && was === "admin") toast("أُلغي إشرافك، عدت طالباً");
    } else {
      for (const p of state.peers.values()) if (p.cid === cid) p.role = role;
      tuneSenders();
      repaintTiles();
      renderPeople();
      layoutGrid();
    }
  });
  // أوامر المعلّم أو المشرف لي
  on("moderate", (e) => {
    const { action, by } = JSON.parse(e.data);
    if (action === "mute" && state.micOn) {
      setMic(false);
      toast(`كتم ${by} الميكروفون`);
    } else if (action === "camOff" && state.camOn) {
      setCam(false);
      toast(`أوقف ${by} الكاميرا`);
    } else if (action === "lowerHand" && state.hand) {
      setHand(false);
      toast(`أنزل ${by} يدك`);
    }
  });
  on("kicked", (e) => {
    const { by, ban } = JSON.parse(e.data);
    leave();
    $("leftSummary").textContent = ban ? `أخرجك ${by} من الحلقة ومنعك من العودة` : `أخرجك ${by} من الحلقة — تستطيع العودة متى شئت`;
  });
  on("controls", (e) => {
    const c = JSON.parse(e.data);
    const was = state.controls || {};
    state.controls = c;
    if (was.locked !== c.locked) toast(c.locked ? `صار دخول القادمين الجدد بإذن ${c.by === state.name ? "منك" : "المعلّم"}` : "صار الدخول للحلقة مفتوحاً");
    if (was.chatOff !== c.chatOff) toast(c.chatOff ? `أوقف ${c.by} دردشة الطلاب` : `فعّل ${c.by} الدردشة`);
    if (!!was.micLock !== !!c.micLock) toast(c.micLock ? "المايك صار بإذن المعلّم — ارفع يدك إذا تبي تتكلم" : "صار بإمكان الجميع فتح المايك");
    if (!!was.camLock !== !!c.camLock) toast(c.camLock ? "الكاميرا صارت بإذن المعلّم" : "صار بإمكان الجميع فتح الكاميرا");
    if (c.cid === state.cid && (c.changed === "allowMic" || c.changed === "allowCam")) {
      const what = c.changed === "allowMic" ? "المايك" : "الكاميرا";
      toast(c.on ? `أذن لك ${c.by} بفتح ${what}` : `سحب ${c.by} إذن ${what}`);
    }
    applyControls();
    enforceLocks();
  });
  on("notice", (e) => toast(JSON.parse(e.data).text));
  on("knocks", (e) => renderKnocks(JSON.parse(e.data).knocks || []));
  // المشرف يحفظ مفتاحه ليبقى مشرفاً كلما عاد (ويُمسح عند إلغاء الإشراف)
  on("adminKey", (e) => {
    const { code, key } = JSON.parse(e.data);
    saveAdminKey(code, key);
  });
  // أنهى المعلّم الحلقة للجميع
  on("ended", (e) => {
    const { by } = JSON.parse(e.data);
    leave();
    $("leftSummary").textContent = `أنهى ${by} الحلقة. جزاكم الله خيراً`;
  });
  on("presence", (e) => {
    state.presence = JSON.parse(e.data);
    renderRoomsStrip();
    if (!$("panel").hidden) renderPeople();
  });
  on("announce", (e) => {
    const { text, name } = JSON.parse(e.data);
    showAnnounce(name, text);
  });

  on("peer-left", (e) => {
    const { id } = JSON.parse(e.data);
    const p = state.peers.get(id);
    if (p) toast(`غادر ${p.name}`);
    removePeer(id);
  });

  on("signal", (e) => handleSignal(JSON.parse(e.data)).catch(() => {}));

  handlers.error = (fatal) => {
    if (es !== state.es) return;
    if (!state.joinedAt || fatal) {
      es.close();
      state.es = null;
      $("joinNowBtn").disabled = false;
      if (state.joinedAt) {
        toast("انقطع الاتصال بالحلقة… جارٍ إعادة الدخول");
        const resume = { rid: state.myId, rtoken: state.token };
        setTimeout(() => !state.es && state.joinedAt && connect(roomId, resume), 1500);
      } else {
        explainJoinError(fatal);
      }
    } else {
      toast("ضعف الاتصال… جارٍ إعادة الوصل");
    }
  };
}

// قناة الأحداث المستمرة. إن لم تصل رسالة الترحيب خلال ثوانٍ (شبكة أو وسيط يحبسها) ننتقل للاستطلاع
const WELCOME_TIMEOUT = 7000;
function sseChannel(roomId, params, handlers) {
  const es = new EventSource(`/api/rooms/${roomId}/events?${params}`);
  let welcomed = false;
  let pid = null;
  let token = null;
  // عند المغادرة نخبر الخادم صراحةً، فيختفي المشارك من الغرفة القديمة فوراً حتى لو تأخر إغلاق الاتصال
  const ch = {
    close() {
      es.close();
      if (pid) sendLeave(roomId, pid, token);
    },
  };
  const resumeOf = () => (pid ? { rid: pid, rtoken: token } : params.get("rid") ? { rid: params.get("rid"), rtoken: params.get("rtoken") } : null);
  const fallback = () => {
    if (welcomed || state.es !== ch) return;
    es.close();
    state.usePoll = true;
    connect(roomId, resumeOf());
  };
  const timer = setTimeout(fallback, WELCOME_TIMEOUT);
  for (const name of ["welcome", "peer-joined", "peer-left", "signal", "breakout", "role", "announce", "moderate", "kicked", "controls", "notice", "presence", "knocks", "adminKey", "ended"]) {
    es.addEventListener(name, (e) => {
      if (name === "welcome") {
        welcomed = true;
        ({ id: pid, token } = JSON.parse(e.data));
        clearTimeout(timer);
      }
      handlers[name]?.(e);
    });
  }
  es.onerror = () => {
    if (state.es !== ch) return;
    // قبل الترحيب نجرّب الاستطلاع مباشرة بدل إظهار خطأ
    if (!welcomed) {
      clearTimeout(timer);
      return fallback();
    }
    // انقطاع بعد الدخول: نغلق القناة ونعود بنفس الهوية بعد مهلة تتضاعف (1، 2، 4… حتى 8 ثوانٍ)
    es.close();
    handlers.error?.(false);
    const delay = Math.min(8000, 1000 * 2 ** (state.reconnects || 0));
    state.reconnects = (state.reconnects || 0) + 1;
    const resume = resumeOf();
    setTimeout(() => {
      if (state.es === ch && state.joinedAt) connect(roomId, resume);
    }, delay);
  };
  return ch;
}

// عدنا بنفس الهوية: نُبقي اتصالات الصوت والصورة كما هي، ونضيف من دخل ونحذف من خرج أثناء الانقطاع
function resumeSession({ token, role, peers, breakout, controls }) {
  state.token = token;
  state.role = role;
  state.controls = controls || state.controls;
  const ids = new Set(peers.map((p) => p.id));
  for (const p of [...state.peers.values()]) if (!ids.has(p.id)) removePeer(p.id, true);
  for (const p of peers) if (!state.peers.has(p.id)) createPeer(p.id, p.name, false, p.cid, p.role);
  applyRole();
  if (applyBreakout(breakout)) return;
  enforceLocks();
  broadcastState();
  layoutGrid();
  for (const p of state.peers.values()) {
    const st = p.pc.connectionState;
    if (st === "failed" || st === "disconnected") retryPeer(p);
  }
  toast("عاد الاتصال");
}

function sendLeave(roomId, pid, token) {
  const body = JSON.stringify({ from: pid, token });
  if (!navigator.sendBeacon?.(`/api/rooms/${roomId}/leave`, new Blob([body], { type: "application/json" }))) {
    fetch(`/api/rooms/${roomId}/leave`, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  }
}

// الاستطلاع الطويل: طلب ينتظر حتى تصل أحداث جديدة ثم يُعاد فوراً
function pollChannel(roomId, params, handlers) {
  let pid = null;
  let token = null;
  let ack = 0;
  let closed = false;
  let fails = 0;
  let ctrl = null;
  const ch = {
    close() {
      closed = true;
      ctrl?.abort();
      if (pid) sendLeave(roomId, pid, token);
    },
  };
  (async () => {
    while (!closed) {
      ctrl = new AbortController();
      const q = pid ? new URLSearchParams({ pid, ack, token }) : params;
      let r;
      try {
        r = await fetch(`/api/rooms/${roomId}/poll?${q}`, { signal: ctrl.signal, cache: "no-store" });
      } catch {
        if (closed) return;
        if (++fails >= 4) return handlers.error?.(true);
        handlers.error?.(false);
        await new Promise((res) => setTimeout(res, 1500));
        continue;
      }
      if (closed) return;
      const body = await r.json().catch(() => null);
      if (!r.ok || !body || !Array.isArray(body.events)) {
        // 403: ممتلئة، 410: انتهت الجلسة، وغير JSON: الرابط ليس خادم وصل
        return handlers.error?.(body ? body.error || true : "no_server");
      }
      fails = 0;
      pid = body.pid;
      for (const ev of body.events) {
        if (ev.seq <= ack) continue;
        ack = ev.seq;
        if (closed) return;
        if (ev.event === "welcome") token = JSON.parse(ev.data).token;
        handlers[ev.event]?.({ data: ev.data });
      }
    }
  })();
  return ch;
}

/* ---------- الدخول بإذن ---------- */

// الطالب: يرسل طلب دخول وينتظر في صفحة التجهيز حتى يقبله المعلّم أو المشرف
let knock = null;
async function startKnock() {
  $("lobbyError").textContent = "";
  $("joinNowBtn").disabled = true;
  let r;
  try {
    r = await fetch(`/api/rooms/${state.code}/knock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: state.name, cid: state.cid, did: state.did }) });
  } catch {
    return knockDone("تعذر إرسال طلب الدخول، حاول مرة أخرى.");
  }
  const body = await r.json().catch(() => ({}));
  if (body.status === "admitted") return knockDone(null, true);
  if (body.error === "kicked") return knockDone("منعك المعلّم من العودة لهذه الحلقة. اطلب منه السماح لك.");
  if (body.error === "no_staff") return knockDone("الدخول لهذه الحلقة بإذن المعلّم، ولا يوجد معلّم فيها الآن. حاول بعد قليل.");
  if (!body.kid) return knockDone("تعذر إرسال طلب الدخول، حاول مرة أخرى.");
  knock = { kid: body.kid, ktoken: body.ktoken };
  $("knockWait").hidden = false;
  $("joinNowBtn").textContent = "بانتظار إذن المعلّم…";
  $("knockWait").scrollIntoView({ block: "center", behavior: "smooth" });
  pollKnock();
}

async function pollKnock() {
  const k = knock;
  if (!k) return;
  let status = "pending";
  try {
    const r = await fetch(`/api/rooms/${state.code}/knock?${new URLSearchParams(k)}`, { cache: "no-store" });
    status = (await r.json()).status;
  } catch {}
  if (knock !== k) return;
  if (status === "admitted") return knockDone(null, true);
  if (status === "denied") return knockDone("اعتذر المعلّم عن إدخالك الآن.");
  if (status === "gone") return knockDone("انتهى طلب الدخول، أرسله مرة أخرى.");
  setTimeout(pollKnock, 2000);
}

function knockDone(message, admitted) {
  knock = null;
  $("knockWait").hidden = true;
  $("joinNowBtn").textContent = "دخول الحلقة";
  $("joinNowBtn").disabled = false;
  if (message) $("lobbyError").textContent = message;
  if (admitted) {
    toast("سمح لك المعلّم بالدخول");
    join();
  }
}

$("knockCancel").addEventListener("click", () => {
  if (knock) {
    fetch(`/api/rooms/${state.code}/knock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cancel: true, ...knock }) }).catch(() => {});
  }
  knockDone("أُلغي طلب الدخول.");
});

// المعلّم والمشرف: بطاقة بطلبات الدخول مع سماح أو رفض
let knownKnocks = new Set();
function renderKnocks(list) {
  const card = $("knockCard");
  card.hidden = !list.length || !isStaff(state.role);
  $("knockAll").hidden = list.length < 2;
  const ul = $("knockList");
  ul.innerHTML = "";
  for (const k of list) {
    if (!knownKnocks.has(k.kid)) {
      toast(`${k.name} يطلب الدخول`);
      navigator.vibrate?.(20);
    }
    const li = document.createElement("li");
    li.innerHTML = `<span class="mini"></span><b></b><button class="btn btn-sm" type="button" data-deny>رفض</button><button class="btn btn-sm btn-primary" type="button" data-allow>سماح</button>`;
    li.querySelector(".mini").textContent = initial(k.name);
    li.querySelector(".mini").style.background = colorFor(k.name);
    li.querySelector("b").textContent = k.name;
    li.querySelector("[data-allow]").addEventListener("click", () => moderate("admit", { kid: k.kid, allow: true }));
    li.querySelector("[data-deny]").addEventListener("click", () => moderate("admit", { kid: k.kid, allow: false }));
    ul.appendChild(li);
  }
  knownKnocks = new Set(list.map((k) => k.kid));
}
$("knockAll").addEventListener("click", () => moderate("admit", { all: true, allow: true }));

// سبب واضح لتعذّر الدخول
async function explainJoinError(reason) {
  let msg = "تعذر الاتصال بالخادم، أو أن الحلقة ممتلئة.";
  if (reason === "room_full") msg = "الحلقة ممتلئة (25 مشاركاً).";
  else if (reason === "locked") return startKnock();
  else if (reason === "kicked") msg = "منعك المعلّم من العودة لهذه الحلقة. اطلب منه السماح لك.";
  else {
    const ok = await fetch("/healthz", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => j && j.ok)
      .catch(() => false);
    if (!ok) msg = "هذا الرابط لا يعمل عليه خادم «وصل»، لذلك لن يلتقي المشاركون. افتح رابط الخدمة الصحيح من Render.";
  }
  $("lobbyError").textContent = msg;
}

const isClosed = (peer) => !peer || peer.pc.signalingState === "closed";

async function handleSignal({ from, type, data }) {
  let peer = state.peers.get(from);
  switch (type) {
    case "offer":
      peer ||= createPeer(from, "ضيف", false);
      await onOffer(peer, data);
      break;
    case "answer":
      if (isClosed(peer) || peer.pc.signalingState !== "have-local-offer") return;
      await peer.pc.setRemoteDescription(data);
      flushIce(peer);
      break;
    case "ice":
      if (isClosed(peer)) return;
      if (peer.pc.remoteDescription) peer.pc.addIceCandidate(data).catch(() => {});
      else peer.pendingIce.push(data);
      break;
    case "state":
      if (!peer) return;
      if (data.hand && !peer.hand) {
        peer.handAt = Date.now();
        const pos = handQueue().length + 1;
        toast(isStaff(state.role) ? `✋ ${data.name} يرفع يده — رقم ${pos} في الطابور` : `✋ ${data.name} يرفع يده`);
      }
      if (!data.hand) peer.handAt = 0;
      if (data.hand && !peer.hand) setTimeout(maybeAutoRecite, 0);
      Object.assign(peer, {
        name: String(data.name || peer.name).slice(0, 40),
        mic: !!data.mic,
        cam: !!data.cam,
        hand: !!data.hand,
        screen: !!data.screen,
        recording: !!data.recording,
      });
      updatePeerTile(peer);
      layoutGrid();
      updateRecBanner();
      renderPeople();
      break;
    case "chat":
      if (!peer) break;
      if (data.private) {
        addMessage(`${peer.name} (خاص)`, String(data.text || "").slice(0, 500), false, true, peer);
      } else addMessage(peer.name, String(data.text || "").slice(0, 500));
      break;
    case "reaction":
      if (peer) floatReaction(peer.tile, data.emoji);
      break;
    case "recite":
      if (!isStaff(peer?.role)) return;
      setReciter(typeof data.id === "string" ? data.id : null);
      break;
    case "grade":
      if (!isStaff(peer?.role) || !GRADES[data.grade]) return;
      receiveGrade(String(data.to), String(data.cid || ""), data.grade, Math.max(0, Number(data.total) || 0));
      break;
  }
}

/* ---------- اتصالات WebRTC ---------- */

function createPeer(id, name, initiator, cid, role) {
  if (state.peers.has(id)) return state.peers.get(id);
  const pc = new RTCPeerConnection(ICE_CONFIG);
  const peer = {
    id, cid: cid || id, name, pc, initiator, restarts: 0, connTimer: 0,
    stream: new MediaStream(),
    pendingIce: [],
    mic: true, cam: false, hand: false, screen: false, role: role || "student",
    tile: null,
  };
  state.peers.set(id, peer);
  peer.tile = createTile(id, false);
  updatePeerTile(peer);

  pc.ontrack = (e) => {
    // بث واحد ثابت لكل مشارك: نستبدل المسار داخله بدل إنشاء بث جديد كل مرة
    for (const t of peer.stream.getTracks()) if (t.kind === e.track.kind && t !== e.track) peer.stream.removeTrack(t);
    if (!peer.stream.getTracks().includes(e.track)) peer.stream.addTrack(e.track);
    const video = peer.tile.querySelector("video");
    if (video.srcObject !== peer.stream) video.srcObject = peer.stream;
    playVideo(video);
    enforceLocks();
    if (e.track.kind === "audio") {
      watchLevel(peer.stream, peer.tile);
      addToRecording(peer.stream);
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) signal("ice", e.candidate, id);
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "connected") {
      setConn(peer, "ok");
    } else if (st === "failed") {
      // نحاول إعادة الاتصال تلقائياً مرتين، ثم نعرض زر إعادة المحاولة
      if (peer.restarts < 2) {
        peer.restarts++;
        setConn(peer, "pending");
        if (peer.initiator) makeOffer(peer, true);
      } else {
        setConn(peer, "failed");
      }
    } else if (st === "disconnected") {
      setConn(peer, "pending");
      // انقطاع مؤقت (تبدّل شبكة الجوال مثلاً): إن استمر ثانيتين ونصف نعيد البحث عن مسار جديد فوراً
      clearTimeout(peer.discTimer);
      peer.discTimer = setTimeout(() => {
        if (pc.connectionState === "disconnected" && peer.initiator && !isClosed(peer)) makeOffer(peer, true);
      }, 2500);
    }
  };
  setConn(peer, "pending");

  if (initiator) {
    for (const kind of ["audio", "video"]) {
      pc.addTransceiver(outgoingTrack(kind) || kind, { direction: "sendrecv" });
    }
    makeOffer(peer);
  }
  renderPeople();
  layoutGrid();
  return peer;
}

async function makeOffer(peer, iceRestart = false) {
  try {
    if (isClosed(peer)) return;
    const offer = await peer.pc.createOffer({ iceRestart });
    if (isClosed(peer)) return;
    await peer.pc.setLocalDescription(offer);
    signal("offer", peer.pc.localDescription, peer.id);
    tuneSenders();
  } catch (err) {
    console.error("offer failed", err);
  }
}

async function onOffer(peer, sdp) {
  const { pc } = peer;
  if (isClosed(peer)) return;
  await pc.setRemoteDescription(sdp);
  for (const t of pc.getTransceivers()) {
    if (isClosed(peer)) return;
    const kind = t.receiver.track.kind;
    t.direction = "sendrecv";
    await t.sender.replaceTrack(outgoingTrack(kind));
  }
  if (isClosed(peer)) return;
  const answer = await pc.createAnswer();
  if (isClosed(peer)) return;
  await pc.setLocalDescription(answer);
  signal("answer", pc.localDescription, peer.id);
  flushIce(peer);
  tuneSenders();
}

function flushIce(peer) {
  for (const c of peer.pendingIce.splice(0)) peer.pc.addIceCandidate(c).catch(() => {});
}

function removePeer(id, silent) {
  const peer = state.peers.get(id);
  if (!peer) return;
  clearTimeout(peer.connTimer);
  clearTimeout(peer.discTimer);
  clearTimeout(peer.stuckTimer);
  disposeTile(peer.tile);
  peer.pc.close();
  state.peers.delete(id);
  if (state.reciter === id) setReciter(null);
  // عند الإزالة الجماعية (انتقال/مغادرة) لا نعدّل جودة اتصالات ستُغلق حالاً
  if (!silent) tuneSenders();
  if (!silent) {
    renderPeople();
    layoutGrid();
    updateRecBanner();
  }
}

// حالة الاتصال بمشارك: pending (جارٍ) / ok / failed (تعذر، مع زر إعادة المحاولة)
function setConn(peer, status) {
  const tile = peer.tile;
  if (!tile) return;
  clearTimeout(peer.connTimer);
  tile.classList.toggle("conn-pending", status === "pending");
  tile.classList.toggle("conn-failed", status === "failed");
  if (status === "ok") peer.restarts = 0;
  if (status === "pending") {
    // إن تعلّق الاتصال (رسالة ضاعت أثناء انقطاع) نعيد التفاوض تلقائياً بعد 7 ثوانٍ قبل إظهار الخطأ
    clearTimeout(peer.stuckTimer);
    peer.stuckTimer = setTimeout(() => {
      if (!isClosed(peer) && peer.pc.connectionState !== "connected" && peer.initiator) makeOffer(peer, true);
    }, 7000);
    peer.connTimer = setTimeout(() => {
      if (!isClosed(peer) && peer.pc.connectionState !== "connected") setConn(peer, "failed");
    }, CONNECT_TIMEOUT);
  }
}

function retryPeer(peer) {
  if (isClosed(peer)) return;
  peer.restarts = 0;
  setConn(peer, "pending");
  makeOffer(peer, true); // إعادة تفاوض الاتصال من جهتنا
  // إن بقي الاتصال قائماً أثناء إعادة التفاوض فلن يصل حدث «connected» جديد
  setTimeout(() => {
    if (!isClosed(peer) && peer.pc.connectionState === "connected") setConn(peer, "ok");
  }, 2500);
}

function replaceOutgoingVideo() {
  const track = outgoingTrack("video");
  for (const { pc } of state.peers.values()) {
    const t = pc.getTransceivers().find((x) => x.receiver.track.kind === "video");
    t?.sender.replaceTrack(track).catch(() => {});
  }
  tuneSenders();
}

// كل مشارك يرسل نسخة من صورته لكل الآخرين، فكلما زاد العدد خفّضنا جودة كل نسخة
// حتى يبقى مجموع ما يرفعه الجهاز معقولاً (حتى 25 مشاركاً)
function videoEncoding(remotes) {
  let enc;
  if (remotes <= 3) enc = { maxBitrate: 1200000, scaleResolutionDownBy: 1, maxFramerate: 30 };
  else if (remotes <= 7) enc = { maxBitrate: 450000, scaleResolutionDownBy: 1.5, maxFramerate: 24 };
  else if (remotes <= 14) enc = { maxBitrate: 220000, scaleResolutionDownBy: 2, maxFramerate: 20 };
  else enc = { maxBitrate: 130000, scaleResolutionDownBy: 3, maxFramerate: 15 };
  // الجميع يشاهد المعلّم كبيراً، فنعطيه جودة أعلى
  if (isStaff(state.role)) {
    enc.maxBitrate *= 2;
    enc.scaleResolutionDownBy = Math.max(1, enc.scaleResolutionDownBy / 1.5);
  }
  // مشاركة الشاشة تحتاج وضوحاً للنص
  if (state.screenStream) {
    enc.maxBitrate = Math.max(enc.maxBitrate, 800000);
    enc.scaleResolutionDownBy = 1;
    enc.maxFramerate = 15;
  }
  return enc;
}

// الطالب يرى زملاءه صغاراً ويرى المعلّم كبيراً، فنرسل لزملائه صورة خفيفة جداً
// ونوفّر الإنترنت للصورة المرسلة للمعلّم وللصوت
const PEER_LITE = { maxBitrate: 150000, scaleResolutionDownBy: 3, maxFramerate: 15 };
function tuneSenders() {
  const base = videoEncoding(state.peers.size);
  for (const peer of state.peers.values()) {
    if (isClosed(peer)) continue;
    tuneAudio(peer);
    const lite = !isStaff(state.role) && !isStaff(peer.role) && !state.screenStream && effectivePin() !== "local";
    const enc = lite ? { ...base, ...PEER_LITE, maxBitrate: Math.min(base.maxBitrate, PEER_LITE.maxBitrate) } : base;
    const sender = peer.pc.getTransceivers().find((x) => x.receiver.track.kind === "video")?.sender;
    if (!sender?.getParameters) continue;
    // تعديل واحد في كل مرة لكل اتصال؛ وإن طُلب تعديل أثناء آخر نعيده بعده
    if (sender.tuning) {
      sender.retune = true;
      continue;
    }
    const params = sender.getParameters();
    if (!params.encodings?.length) continue; // قبل اكتمال التفاوض
    Object.assign(params.encodings[0], enc);
    sender.tuning = true;
    sender.setParameters(params).catch(() => {}).finally(() => {
      sender.tuning = false;
      if (sender.retune) {
        sender.retune = false;
        tuneSenders();
      }
    });
  }
}

// بعض الجوالات (خصوصاً آيفون) تمنع تشغيل الصوت تلقائياً بعد الانتقال بين الغرف.
// حينها نشغّل الصورة بدون صوت فوراً، ونظهر زراً واحداً لتشغيل الصوت للجميع
function playVideo(video) {
  const p = video.play();
  if (!p) return;
  p.catch((err) => {
    if (err?.name !== "NotAllowedError" || video.muted) return;
    video.muted = true;
    video.dataset.needsSound = "1";
    video.play().catch(() => {});
    $("soundBtn").hidden = false;
  });
}
$("soundBtn").addEventListener("click", () => {
  for (const v of document.querySelectorAll('#grid video[data-needs-sound="1"]')) {
    v.muted = false;
    delete v.dataset.needsSound;
    v.play().catch(() => {});
  }
  state.audioCtx?.resume?.();
  $("soundBtn").hidden = true;
});

// الصوت أولاً: عند ضعف الشبكة يحافظ المتصفح على الصوت قبل الصورة
function tuneAudio(peer) {
  const sender = peer.pc.getTransceivers().find((x) => x.receiver.track.kind === "audio")?.sender;
  if (!sender?.getParameters || sender.audioTuned) return;
  const params = sender.getParameters();
  if (!params.encodings?.length) return;
  params.encodings[0].priority = "high";
  params.encodings[0].networkPriority = "high";
  sender.audioTuned = true;
  sender.setParameters(params).catch(() => (sender.audioTuned = false));
}

/* ---------- البلاطات (عرض المشاركين) ---------- */

function createTile(id, isLocal) {
  const tile = document.createElement("div");
  tile.className = "tile" + (isLocal ? " local" : "");
  tile.dataset.id = id;
  tile.innerHTML = `
    <video autoplay playsinline ${isLocal ? "muted" : ""}></video>
    <div class="avatar"></div>
    <span class="hand-badge">${icon("hand")}يرفع يده</span>
    <button class="pin-btn" type="button" title="تثبيت في الوسط">${icon("pin")}</button>
    ${isLocal ? "" : `<button class="tile-more" type="button" title="خيارات المشارك" aria-label="خيارات المشارك">${icon("more")}</button>`}
    <span class="recite-tag">${icon("book")}يُسمّع الآن</span>
    ${isLocal ? "" : `<div class="conn-overlay">
      <span class="conn-wait"><span class="spinner"></span>جارٍ الاتصال…</span>
      <span class="conn-fail"><b>تعذر الاتصال</b><small>قد تكون شبكة أحدكما تمنع الاتصال المباشر</small><button type="button" class="btn btn-sm btn-primary conn-retry">إعادة المحاولة</button></span>
    </div>`}
    <div class="label">${icon("mic-off", "mic-off")}<span class="name"></span><span class="role-tag" hidden>المعلّم</span><span class="stars-tag" hidden></span></div>`;
  tile.querySelector(".pin-btn").addEventListener("click", () => togglePin(id));
  if (!isLocal) {
    attachTileGestures(tile, id);
    tile.querySelector(".tile-more").addEventListener("click", (e) => {
      e.stopPropagation();
      const p = state.peers.get(id);
      if (canManagePeer(p)) openPersonMenu(e.currentTarget, p);
    });
  }
  tile.querySelector(".conn-retry")?.addEventListener("click", () => {
    const peer = state.peers.get(id);
    if (peer) retryPeer(peer);
  });
  $("grid").appendChild(tile);
  return tile;
}

function paintTile(tile, { name, mic, cam, hand, screen, role }) {
  tile.querySelector(".name").textContent = name;
  const avatar = tile.querySelector(".avatar");
  avatar.textContent = initial(name);
  avatar.style.background = colorFor(name.replace(" (أنت)", ""));
  tile.classList.toggle("cam-off", !cam && !screen);
  tile.classList.toggle("screen", screen);
  tile.classList.toggle("muted", !mic);
  tile.classList.toggle("hand", hand);
  const tag = tile.querySelector(".role-tag");
  tag.hidden = !isStaff(role);
  tag.textContent = ROLE_LABEL[role] || "";
  tile.classList.toggle("admin", role === "admin");
  const id = tile.dataset.id === "local" ? state.myId : tile.dataset.id;
  const stars = state.stars[cidOf(id)] || 0;
  const starsTag = tile.querySelector(".stars-tag");
  starsTag.hidden = !stars;
  starsTag.textContent = `⭐ ${stars}`;
  tile.classList.toggle("reciting", !!id && state.reciter === id);
}

function togglePin(id) {
  state.pinned = effectivePin() === id ? "none" : id;
  layoutGrid();
  renderPeople();
}

// من يظهر كبيراً في الوسط: المثبّت يدوياً، ثم من يشارك شاشته، ثم المعلّم
function effectivePin() {
  if (state.pinned === "none") return null;
  if (state.pinned && (state.pinned === "local" || state.peers.has(state.pinned))) return state.pinned;
  state.pinned = null;
  const sharer = [...state.peers.values()].find((p) => p.screen);
  if (sharer) return sharer.id;
  if (state.reciter) {
    if (state.reciter === state.myId) return "local";
    if (state.peers.has(state.reciter)) return state.reciter;
  }
  if (state.role !== "teacher" && state.peers.size >= 2) {
    const teacher = [...state.peers.values()].find((p) => p.role === "teacher") || [...state.peers.values()].find((p) => p.role === "admin");
    if (teacher) return teacher.id;
  }
  return null;
}

function updatePeerTile(peer) {
  peer.tile.classList.toggle("manageable", canManagePeer(peer));
  paintTile(peer.tile, peer.blockedMic || peer.blockedCam ? { ...peer, mic: peer.mic && !peer.blockedMic, cam: peer.cam && !peer.blockedCam } : peer);
}

function repaintTiles() {
  for (const p of state.peers.values()) updatePeerTile(p);
  updateLocalTile();
}

/* ---------- طابور التسميع والتقييم ---------- */

// الطلاب الرافعون أيديهم مرتّبين حسب أسبقية الرفع
function handQueue() {
  return [...state.peers.values()].filter((p) => p.hand && !isStaff(p.role)).sort((a, b) => a.handAt - b.handAt);
}

// النجوم تُحفظ بالمعرّف الثابت حتى لا تضيع عند التنقل بين الغرف
function cidOf(id) {
  if (id === state.myId) return state.cid;
  return state.peers.get(id)?.cid || id;
}

function nameOf(id) {
  if (id === state.myId) return state.name;
  return state.peers.get(id)?.name || "طالب";
}

function setReciter(id) {
  const was = state.reciter;
  state.reciter = id;
  if (id && id === state.myId && was !== id) {
    // دوري الآن: أُنزل يدي وأنبّه نفسي
    if (state.hand) {
      state.hand = false;
      state.handAt = 0;
      syncToggleButtons();
      broadcastState();
    }
    toast(state.micOn ? "🎙️ دورك الآن في التسميع، بالتوفيق" : "🎙️ دورك الآن — افتح الميكروفون وابدأ التسميع");
  }
  updateReciteUI();
  repaintTiles();
  tuneSenders(); // من يُسمّع يُرسل صورته بجودة كاملة لأن الجميع يراه كبيراً
  enforceLocks(); // من يُسمّع يُسمح له بالمايك تلقائياً
  if (!id) maybeAutoRecite();
  layoutGrid();
  renderPeople();
}

function startRecite(id) {
  if (!isStaff(state.role)) return;
  setReciter(id);
  signal("recite", { id });
}

function endRecite() {
  setReciter(null);
  signal("recite", { id: null });
}

function gradeReciter(grade) {
  const id = state.reciter;
  if (!id || !isStaff(state.role)) return;
  const key = cidOf(id);
  const total = (state.stars[key] || 0) + GRADES[grade].stars;
  state.stars[key] = total;
  signal("grade", { to: id, cid: key, grade, total });
  toast(`${GRADES[grade].stars ? "⭐" : "📖"} ${nameOf(id)}: ${GRADES[grade].label}`);
  endRecite();
}

function receiveGrade(to, cid, grade, total) {
  const key = cid || cidOf(to);
  const gained = total - (state.stars[key] || 0);
  state.stars[key] = total;
  if (to === state.myId) {
    state.sessionStars += Math.max(0, gained);
    celebrate(grade, total);
  } else {
    toast(`${GRADES[grade].stars ? "⭐" : "📖"} ${nameOf(to)}: ${GRADES[grade].label}`);
  }
  if (state.reciter === to) setReciter(null);
  else repaintTiles();
}

function updateReciteUI() {
  const id = state.reciter;
  const isTeacher = isStaff(state.role);
  $("gradeCard").hidden = !id || !isTeacher;
  $("reciteBanner").hidden = !id || isTeacher;
  if (!id) return;
  if (isTeacher) {
    $("gradeName").textContent = nameOf(id);
  } else {
    const mine = id === state.myId;
    $("reciteBanner").classList.toggle("mine", mine);
    $("reciteText").textContent = mine ? "دورك الآن في التسميع" : `يُسمّع الآن: ${nameOf(id)}`;
  }
}

for (const btn of document.querySelectorAll("#gradeCard [data-grade]")) {
  btn.addEventListener("click", () => gradeReciter(btn.dataset.grade));
}
$("gradeEnd").addEventListener("click", endRecite);

// احتفال عند التقييم: نجوم ونثار ملوّن
function celebrate(grade, total) {
  const g = GRADES[grade];
  const box = $("celebrate");
  box.className = `celebrate g-${grade}`;
  $("celStars").innerHTML = g.stars
    ? Array.from({ length: g.stars }, (_, i) => `<span style="--d:${i * 0.15}s">⭐</span>`).join("")
    : '<span>📖</span>';
  $("celTitle").textContent = g.title;
  $("celNote").textContent = total ? `${g.note} — مجموع نجومك: ${total}` : g.note;
  const confetti = $("confetti");
  confetti.innerHTML = "";
  if (g.stars >= 2) {
    const colors = ["#6fbf98", "#a9dcc2", "#2f8f6b", "#6fbf98", "#ffffff"];
    for (let i = 0; i < 70; i++) {
      const c = document.createElement("i");
      c.style.cssText = `left:${Math.random() * 100}%;background:${colors[i % colors.length]};` +
        `animation-delay:${Math.random() * 0.6}s;animation-duration:${2.2 + Math.random() * 1.6}s;` +
        `transform:rotate(${Math.random() * 360}deg);width:${6 + Math.random() * 6}px`;
      confetti.appendChild(c);
    }
  }
  box.hidden = false;
  clearTimeout(celebrate.t);
  celebrate.t = setTimeout(() => (box.hidden = true), 4200);
}
$("celebrate").addEventListener("click", () => ($("celebrate").hidden = true));

function updateLocalTile() {
  if (!state.localTile) return;
  const s = myStatus();
  paintTile(state.localTile, { ...s, name: `${state.name} (أنت)` });
  const video = state.localTile.querySelector("video");
  // نغيّر المصدر فقط إن تغيّر؛ إعادة تعيينه في كل تحديث توقف الصورة لحظياً
  const src = state.screenStream || state.stream;
  if (video.srcObject !== src) video.srcObject = src;
  video.classList.toggle("mirror", !state.screenStream);
}

function layoutGrid() {
  const grid = $("grid");
  const tiles = [...grid.children];
  const n = tiles.length;
  const pin = n > 1 ? effectivePin() : null;
  for (const t of tiles) {
    t.classList.toggle("pinned", t.dataset.id === pin);
    t.querySelector(".pin-btn").title = t.dataset.id === pin ? "إلغاء التثبيت" : "تثبيت في الوسط";
  }
  grid.classList.toggle("spotlight", !!pin);
  grid.classList.toggle("many", n > 9);
  if (pin) {
    grid.style.setProperty("--rows", Math.min(Math.max(n - 1, 1), n > 9 ? 6 : 4));
  } else {
    const narrow = window.innerWidth < 640;
    const cols = narrow
      ? (n <= 2 ? 1 : n <= 8 ? 2 : 3)
      : n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : 5;
    grid.style.setProperty("--cols", cols);
  }
  $("peopleCount").textContent = $("peoplePill").textContent = state.peers.size + 1;
  $("inviteCard").hidden = !state.joinedAt || state.peers.size > 0 || state.inviteDismissed || state.room !== state.code;
}
window.addEventListener("resize", layoutGrid);

$("inviteClose").addEventListener("click", () => {
  state.inviteDismissed = true;
  layoutGrid();
});
$("inviteCopy").addEventListener("click", () => copyText(meetingLink(), "تم نسخ رابط الحلقة"));

function floatReaction(tile, emoji) {
  if (!tile || !REACTIONS.includes(emoji)) return;
  const el = document.createElement("div");
  el.className = "float-reaction";
  el.textContent = emoji;
  tile.appendChild(el);
  setTimeout(() => el.remove(), 2300);
}

// إبراز من يتحدث
function watchLevel(stream, tile) {
  if (!state.audioCtx || !stream?.getAudioTracks().length) return;
  try {
    const src = state.audioCtx.createMediaStreamSource(stream);
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    stopMeter(tile);
    analyser.src = src;
    state.meters.set(tile, analyser);
  } catch {}
}

function stopMeter(tile) {
  const old = state.meters.get(tile);
  if (!old) return;
  try {
    old.src.disconnect();
  } catch {}
  state.meters.delete(tile);
}

// نوقف الفيديو ونحرّر مصدره قبل إزالة البلاطة، حتى لا تبقى إطارات معلّقة في المتصفح
function disposeTile(tile) {
  stopMeter(tile);
  const video = tile.querySelector("video");
  if (video) {
    video.pause();
    video.srcObject = null;
  }
  tile.remove();
}

const levelBuf = new Uint8Array(512);
function levelOf(analyser) {
  analyser.getByteTimeDomainData(levelBuf);
  let sum = 0;
  for (const v of levelBuf) sum += (v - 128) ** 2;
  return Math.sqrt(sum / levelBuf.length);
}

setInterval(() => {
  for (const [tile, analyser] of state.meters) {
    const muted = tile === state.localTile ? !state.micOn : tile.classList.contains("muted");
    tile.classList.toggle("speaking", !muted && levelOf(analyser) > 6);
  }
  if (lobbyAnalyser && !$("lobby").hidden) {
    const level = state.micOn ? Math.min(100, levelOf(lobbyAnalyser) * 5) : 0;
    $("micLevel").style.height = `${level}%`;
  }
}, 120);

/* ---------- غرفة الاجتماع ---------- */

function enterRoom() {
  state.joinedAt = Date.now();
  $("joinNowBtn").disabled = false;
  show("room");
  $("roomCode").textContent = state.code;
  for (const t of [...$("grid").children]) disposeTile(t);
  $("messages").innerHTML = '<p class="hint">الرسائل تظهر فقط للحاضرين في الحلقة الآن</p>';
  state.pinned = null;
  state.inviteDismissed = false;
  state.sessionStars = 0;
  applyRole();
  updateRoomUI();
  $("inviteLink").textContent = meetingLink().replace(/^https?:\/\//, "");
  $("roomElapsed").textContent = "00:00";
  state.localTile = createTile("local", true);
  watchLevel(state.stream, state.localTile);
  updateLocalTile();
  syncToggleButtons();
  layoutGrid();
  renderPeople();
  keepAwake(true);
  setMediaSession();
}

/* ---------- تبدّل الشبكة (واي فاي ↔ بيانات الجوال) ---------- */

// عند تبدّل الشبكة نعيد بناء المسارات فوراً بدل انتظار انقطاعها
let netTimer;
let lastNetType = navigator.connection?.type;
function networkChanged() {
  clearTimeout(netTimer);
  netTimer = setTimeout(() => {
    if (!state.joinedAt) return;
    for (const p of state.peers.values()) if (p.initiator && !isClosed(p) && p.pc.connectionState !== "connected") makeOffer(p, true);
    if (!state.es) connect(state.room, { rid: state.myId, rtoken: state.token });
  }, 800);
}
addEventListener("online", networkChanged);
navigator.connection?.addEventListener?.("change", () => {
  if (navigator.connection.type === lastNetType) return;
  lastNetType = navigator.connection.type;
  // الشبكة تغيّرت فعلاً: نعيد التفاوض على المسارات حتى للمتصلة (عنوان الجهاز تغيّر)
  for (const p of state.peers.values()) if (p.initiator && !isClosed(p)) makeOffer(p, true);
});

/* ---------- العمل والجوال في الخلفية ---------- */

// يمنع انطفاء الشاشة أثناء الحلقة (انطفاؤها يوقف الكاميرا في أغلب الجوالات)
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && document.visibilityState === "visible" && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

// يُعرّف الحلقة كمكالمة جارية عند النظام فيبقى الصوت في الخلفية حيث يسمح الجوال
function setMediaSession() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: "حلقة وصل", artist: roomLabel(state.room), album: "وصل — بالقرآن نتّصل" });
    navigator.mediaSession.setActionHandler?.("hangup", () => leave());
  } catch {}
}

// عند الرجوع للصفحة بعد الخلفية: نعيد ما توقف فوراً بدل انتظار المحاولات التلقائية
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !state.joinedAt) return;
  keepAwake(true);
  state.audioCtx?.resume?.();
  for (const v of document.querySelectorAll("#grid video")) if (v.paused && v.srcObject) playVideo(v);
  // الكاميرا قد يوقفها النظام في الخلفية؛ نتحقق منها
  const cam = camTrack();
  if (state.camOn && cam && cam.readyState === "ended") restartCamera();
  if (!state.es) return connect(state.room, { rid: state.myId, rtoken: state.token });
  for (const p of state.peers.values()) {
    const st = p.pc.connectionState;
    if (st === "failed" || st === "disconnected") retryPeer(p);
  }
});

async function restartCamera() {
  try {
    const fresh = await navigator.mediaDevices.getUserMedia({ video: CAM_CONSTRAINTS });
    const track = fresh.getVideoTracks()[0];
    const old = camTrack();
    if (old) {
      state.stream.removeTrack(old);
      old.stop();
    }
    state.stream.addTrack(track);
    for (const p of state.peers.values()) {
      const sender = p.pc.getTransceivers().find((x) => x.receiver.track.kind === "video")?.sender;
      if (sender && !state.screenStream) sender.replaceTrack(track).catch(() => {});
    }
    updateLocalTile();
  } catch {}
}

function leave(navigate = true) {
  keepAwake(false);
  if (state.joinedAt) {
    $("leftSummary").textContent = `مدة حضورك: ${formatDuration(Date.now() - state.joinedAt)}`;
    $("leftStars").hidden = !state.sessionStars;
    $("leftStarsCount").textContent = state.sessionStars;
  }
  stopRecording();
  state.es?.close();
  state.es = null;
  for (const id of [...state.peers.keys()]) removePeer(id, true);
  for (const t of [...$("grid").children]) disposeTile(t);
  state.meters.clear();
  stopMedia();
  state.myId = null;
  state.joinedAt = 0;
  state.hand = false;
  state.handAt = 0;
  state.reciter = null;
  state.controls = null;
  state.presence = null;
  $("knockCard").hidden = true;
  knownKnocks = new Set();
  state.boChoice = null;
  $("roomsStrip").hidden = true;
  $("moreMenu").hidden = true;
  closePersonMenu();
  state.stars = {};
  state.localTile = null;
  $("gradeCard").hidden = true;
  $("reciteBanner").hidden = true;
  state.room = null;
  state.breakout = null;
  $("breakoutModal").hidden = true;
  $("roomBanner").hidden = true;
  $("announce").hidden = true;
  $("panel").hidden = true;
  $("recBanner").hidden = true;
  $("inviteCard").hidden = true;
  if (navigate) show("left");
}

$("micBtn").addEventListener("click", () => setMic(!state.micOn));
$("camBtn").addEventListener("click", () => setCam(!state.camOn));
// المعلّم يختار: إنهاء الحلقة للجميع، أو المغادرة وتبقى الحلقة قائمة
$("leaveBtn").addEventListener("click", async () => {
  if (state.role !== "teacher" || DEMO || !state.peers.size) return leave();
  const choice = await askLeave();
  if (choice === "end") {
    if (await moderate("end")) toast("أُنهيت الحلقة للجميع");
    leave();
    $("leftSummary").textContent = "أنهيت الحلقة للجميع";
  } else if (choice === "leave") leave();
});
function askLeave() {
  return new Promise((resolve) => {
    const m = $("leaveModal");
    m.hidden = false;
    $("leaveEnd").focus();
    const done = (v) => {
      m.hidden = true;
      m.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onClick = (e) => {
      if (e.target.closest("#leaveEnd")) done("end");
      else if (e.target.closest("#leaveOnly")) done("leave");
      else if (e.target.closest("[data-cancel]")) done(null);
    };
    const onKey = (e) => e.key === "Escape" && (e.stopPropagation(), done(null));
    m.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey, true);
  });
}
$("rejoinBtn").addEventListener("click", () => openLobby());
$("goHomeBtn").addEventListener("click", () => goTo(null));

function setHand(on) {
  state.hand = on;
  state.handAt = on ? Date.now() : 0;
  syncToggleButtons();
  updateLocalTile();
  broadcastState();
  renderPeople();
}
$("handBtn").addEventListener("click", () => {
  setHand(!state.hand);
  if (state.hand) toast("✋ رفعت يدك — سينادي المعلّم دورك");
});

$("shareBtn").addEventListener("click", async () => {
  if (state.screenStream) return stopShare();
  if (!navigator.mediaDevices?.getDisplayMedia) return toast("مشاركة الشاشة غير مدعومة على هذا الجهاز");
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch {
    return;
  }
  state.screenStream.getVideoTracks()[0].onended = stopShare;
  replaceOutgoingVideo();
  syncToggleButtons();
  updateLocalTile();
  broadcastState();
  toast("أنت تشارك شاشتك الآن");
});

function stopShare() {
  if (!state.screenStream) return;
  state.screenStream.getTracks().forEach((t) => t.stop());
  state.screenStream = null;
  replaceOutgoingVideo();
  syncToggleButtons();
  updateLocalTile();
  broadcastState();
}

$("reactBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("reactions").hidden = !$("reactions").hidden;
});
$("reactions").addEventListener("click", (e) => {
  const emoji = e.target.closest("button")?.textContent;
  if (!emoji) return;
  floatReaction(state.localTile, emoji);
  signal("reaction", { emoji });
  $("reactions").hidden = true;
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".reactions-wrap")) $("reactions").hidden = true;
});

$("copyBtn").addEventListener("click", () => copyText(meetingLink(), "تم نسخ رابط الحلقة"));

$("settingsBtn").addEventListener("click", () => {
  populateDevices();
  $("settingsModal").hidden = false;
});
for (const el of document.querySelectorAll("#settingsModal [data-close]")) {
  el.addEventListener("click", () => ($("settingsModal").hidden = true));
}

document.addEventListener("keydown", (e) => {
  if (!state.joinedAt || !(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === "d") {
    e.preventDefault();
    setMic(!state.micOn);
  } else if (key === "e") {
    e.preventDefault();
    setCam(!state.camOn);
  }
});

/* ---------- اللوحة الجانبية: الدردشة والمشاركون ---------- */

function openPanel(tab) {
  const panel = $("panel");
  const current = panel.querySelector(".panel-tab.active").dataset.tab;
  if (!panel.hidden && current === tab) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  for (const t of panel.querySelectorAll(".panel-tab")) t.classList.toggle("active", t.dataset.tab === tab);
  for (const p of panel.querySelectorAll(".panel-body")) p.hidden = p.dataset.pane !== tab;
  if (tab === "chat") {
    $("chatDot").hidden = true;
    $("chatInput").focus();
    $("messages").scrollTop = $("messages").scrollHeight;
  }
}

$("chatBtn").addEventListener("click", () => openPanel("chat"));
$("peopleBtn").addEventListener("click", () => openPanel("people"));
$("closePanel").addEventListener("click", () => ($("panel").hidden = true));
for (const t of document.querySelectorAll(".panel-tab")) {
  t.addEventListener("click", () => openPanel(t.dataset.tab));
}

function addMessage(author, text, mine = false, priv = false, from = null) {
  if (!text.trim()) return;
  const box = $("messages");
  const msg = document.createElement("div");
  msg.className = "msg" + (mine ? " mine" : "") + (priv ? " private" : "");
  // الضغط على رسالة خاصة يفتح الرد الخاص على مرسلها
  if (from) {
    msg.title = "اضغط للرد برسالة خاصة";
    msg.addEventListener("click", () => state.peers.has(from.id) && startDM(from));
  }
  msg.innerHTML = '<div class="meta"><b></b><time></time></div><p></p>';
  msg.querySelector("b").textContent = author;
  msg.querySelector("time").textContent = timeNow();
  msg.querySelector("p").textContent = text;
  box.appendChild(msg);
  box.scrollTop = box.scrollHeight;
  const chatVisible = !$("panel").hidden && !document.querySelector('[data-pane="chat"]').hidden;
  if (!chatVisible && !mine) {
    $("chatDot").hidden = false;
    toast(`💬 ${author}: ${text.slice(0, 60)}`);
  }
}

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text || (chatLocked() && !state.dm)) return;
  if (state.dm) {
    if (!state.peers.has(state.dm.id)) {
      toast(`${state.dm.name} لم يعد في الغرفة`);
      state.dm = null;
      return updateChatInput();
    }
    addMessage(`أنت ← ${state.dm.name}`, text, true, true);
    signal("chat", { text, private: true }, state.dm.id);
    $("chatInput").value = "";
    return;
  }
  addMessage("أنت", text, true);
  signal("chat", { text });
  $("chatInput").value = "";
});

// يحدّث الواجهة حسب دوري (معلّم/مشرف/طالب)
function applyRole() {
  $("breakoutBtn").hidden = !isStaff(state.role) || DEMO;
  $("adminMenuBtn").hidden = !isStaff(state.role) || DEMO;
  for (const p of state.peers.values()) p.tile?.classList.toggle("manageable", canManagePeer(p));
  tuneSenders();
  // التسجيل للمستضيف (المعلّم) فقط
  $("recBtn").hidden = state.role !== "teacher";
  if (state.recorder && state.role !== "teacher") stopRecording();
  renderRoomsStrip();
  applyControls(false);
  updateReciteUI();
  updateLocalTile();
  renderPeople();
}

/* ---------- أدوات المشرف ---------- */

const chatLocked = () => !!state.controls?.chatOff && !isStaff(state.role);

// يحدّث أزرار الإدارة وحالة الدردشة حسب إعدادات الحلقة
function applyControls(repaint = true) {
  const c = state.controls || {};
  const staff = isStaff(state.role) && !DEMO;
  $("adminTools").hidden = !staff;
  $("lockBtn").classList.toggle("on", !!c.locked);
  $("lockBtn").querySelector("span").textContent = "الدخول بإذن";
  $("chatOffBtn").classList.toggle("on", !!c.chatOff);
  $("chatOffBtn").querySelector("span").textContent = c.chatOff ? "تفعيل الدردشة" : "إيقاف الدردشة";
  $("micLockBtn").classList.toggle("on", !!c.micLock);
  $("camLockBtn").classList.toggle("on", !!c.camLock);
  $("autoQueueBtn").classList.toggle("on", state.autoQueue);
  $("lockBadge").hidden = !c.locked;
  renderBanned(c.banned || []);
  updateChatInput();
  if (repaint) renderPeople();
}

// قائمة الممنوعين من العودة مع زر السماح لكل واحد
function renderBanned(list) {
  const box = $("bannedBox");
  box.hidden = !list.length || !isStaff(state.role);
  const ul = $("bannedList");
  ul.innerHTML = "";
  for (const b of list) {
    const li = document.createElement("li");
    li.innerHTML = `<span></span><button class="btn btn-sm" type="button">السماح بالعودة</button>`;
    li.firstChild.textContent = b.name;
    li.querySelector("button").addEventListener("click", () => moderate("unban", { cid: b.cid }));
    ul.appendChild(li);
  }
}

function updateChatInput() {
  const off = chatLocked() && !state.dm;
  $("chatInput").disabled = off;
  $("chatInput").placeholder = off ? "الدردشة موقفة من المعلّم" : state.dm ? `رسالة خاصة إلى ${state.dm.name}…` : "اكتب رسالة للحلقة…";
  $("dmChip").hidden = !state.dm;
  if (state.dm) $("dmName").textContent = state.dm.name;
}

/* ---------- الرسائل الخاصة ---------- */

// المعلّم أو المشرف يراسل طالباً على انفراد، والطالب يرد عليه بالضغط على رسالته
function startDM(p) {
  state.dm = { id: p.id, name: p.name.replace(" (أنت)", "") };
  if ($("panel").hidden || document.querySelector('[data-pane="chat"]').hidden) openPanel("chat");
  updateChatInput();
  $("chatInput").focus();
}
$("dmClose").addEventListener("click", () => {
  state.dm = null;
  updateChatInput();
});

/* ---------- التسميع التلقائي بالترتيب ---------- */

try {
  state.autoQueue = localStorage.getItem("wasl:autoq") === "1";
} catch {}

// من يدير الطابور: المعلّم إن وُجد في الغرفة، وإلا أول مشرف — حتى لا ينادي اثنان معاً
function isQueueDriver() {
  const staff = [{ id: state.myId, role: state.role }, ...[...state.peers.values()].filter((p) => isStaff(p.role))].filter((x) => isStaff(x.role));
  staff.sort((a, b) => (a.role === "teacher" ? 0 : 1) - (b.role === "teacher" ? 0 : 1) || String(a.id).localeCompare(String(b.id)));
  return staff[0]?.id === state.myId;
}

let autoTimer;
function maybeAutoRecite() {
  if (!state.autoQueue || !isStaff(state.role) || state.reciter || !state.joinedAt || !isQueueDriver()) return;
  const next = handQueue()[0];
  if (!next) return;
  clearTimeout(autoTimer);
  // مهلة قصيرة حتى يرى الطالب السابق تقييمه
  autoTimer = setTimeout(() => {
    if (!state.reciter && handQueue()[0]?.id === next.id) startRecite(next.id);
  }, 1500);
}

$("autoQueueBtn").addEventListener("click", () => {
  state.autoQueue = !state.autoQueue;
  try {
    localStorage.setItem("wasl:autoq", state.autoQueue ? "1" : "0");
  } catch {}
  toast(state.autoQueue ? "التسميع تلقائي: يُنادى صاحب اليد المرفوعة التالي بعد كل تقييم" : "أُوقف التسميع التلقائي");
  applyControls();
  maybeAutoRecite();
});
$("micLockBtn").addEventListener("click", () => moderate("micLock", { on: !state.controls?.micLock }));
$("camLockBtn").addEventListener("click", () => moderate("camLock", { on: !state.controls?.camLock }));

async function moderate(action, extra = {}) {
  try {
    const r = await fetch(`/api/rooms/${state.room}/moderate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: state.myId, token: state.token, action, ...extra }),
    });
    if (!r.ok) throw new Error();
    return true;
  } catch {
    toast("تعذر تنفيذ الأمر، حاول مرة أخرى");
    return false;
  }
}

$("muteAllBtn").addEventListener("click", async () => {
  if (await moderate("muteAll")) toast("كُتم ميكروفون جميع الطلاب");
});
$("lockBtn").addEventListener("click", () => moderate("lock", { on: !state.controls?.locked }));
$("chatOffBtn").addEventListener("click", () => moderate("chat", { on: !!state.controls?.chatOff }));

// قائمة إدارة مشارك واحد
// قائمة شؤون الطالب: من زر ⋮ في الحضور، أو بضغطة مطولة على مربعه في الحلقة.
// anchor: العنصر أو نقطة {x, y}. remoteRoom: الشخص في غرفة أخرى (لا نملك إلا نقله)
function openPersonMenu(anchor, p, remoteRoom) {
  closePersonMenu();
  const menu = document.createElement("div");
  menu.className = "pmenu";
  menu.id = "pmenu";
  // فُتحت بضغطة مطوّلة: نتجاهل النقرة الناتجة عن رفع الإصبع نفسه فقط
  if (!anchor.getBoundingClientRect) {
    menu.guard = true;
    const release = () => setTimeout(() => (menu.guard = false), 80);
    document.addEventListener("pointerup", release, { once: true, capture: true });
    setTimeout(() => (menu.guard = false), 1500); // احتياط إن لم يصل حدث الرفع
  }
  const head = document.createElement("div");
  head.className = "pm-head";
  head.textContent = p.name;
  menu.appendChild(head);
  const c = state.controls || {};
  // [أيقونة، النص، متاح، التنفيذ، خطر]
  const items = [];
  if (!remoteRoom) {
    const student = !isStaff(p.role);
    if (student) {
      const reciting = state.reciter === p.id;
      items.push(["book", reciting ? "إنهاء التسميع" : "ابدأ تسميعه", true, () => (reciting ? endRecite() : startRecite(p.id))]);
    }
    items.push(["mic-off", "كتم الصوت", p.mic && !p.blockedMic, () => moderate("mute", { target: p.id })]);
    items.push(["cam-off", "إغلاق الكاميرا", p.cam && !p.blockedCam, () => moderate("camOff", { target: p.id })]);
    if (c.micLock && student) {
      const on = c.micAllow?.includes(p.cid);
      items.push(["mic", on ? "سحب إذن المايك" : "السماح بفتح المايك", true, () => moderate("allowMic", { target: p.id, on: !on })]);
    }
    if (c.camLock && student) {
      const on = c.camAllow?.includes(p.cid);
      items.push(["cam", on ? "سحب إذن الكاميرا" : "السماح بفتح الكاميرا", true, () => moderate("allowCam", { target: p.id, on: !on })]);
    }
    items.push(["chat", "رسالة خاصة", true, () => startDM(p)]);
    items.push(["hand", "خفض اليد", p.hand, () => moderate("lowerHand", { target: p.id })]);
    items.push(["pin", effectivePin() === p.id ? "إلغاء التثبيت" : "تثبيت في الوسط", true, () => togglePin(p.id)]);
    if (state.role === "teacher" && !DEMO) {
      items.push(["shield", p.role === "admin" ? "إلغاء الإشراف" : "تعيينه مشرفاً", true, () => setAdmin(p.cid, p.role !== "admin")]);
    }
  }
  for (const [ic, label, enabled, run, danger] of items) menu.appendChild(menuButton(ic, label, enabled, run, danger));

  // النقل بين الغرف عندما تكون مفتوحة (للطلاب، وللمشرف من المعلّم)
  if (state.breakout && (p.role === "student" || state.role === "teacher")) {
    const cur = remoteRoom || (state.room === state.code ? "main" : state.room.slice(state.code.length + 1));
    const dests = [["main", "الحلقة الرئيسية"], ...state.breakout.rooms.map((r) => [r.id, r.name])].filter(([id]) => id !== cur);
    if (menu.childElementCount > 1) menu.appendChild(document.createElement("hr"));
    const title = document.createElement("small");
    title.className = "pm-title";
    title.textContent = "نقل إلى";
    menu.appendChild(title);
    for (const [id, name] of dests) {
      const b = menuButton(null, name, true, () => assignTo(p, id === "main" ? null : id));
      b.insertAdjacentHTML("afterbegin", `<span class="rs-dot" style="--c:${roomColor(id === "main" ? null : id)}"></span>`);
      menu.appendChild(b);
    }
  }
  if (!remoteRoom) {
    menu.appendChild(document.createElement("hr"));
    menu.appendChild(
      menuButton("end", "إخراج من الحلقة", true, async () => {
        const yes = await askConfirm({ title: `إخراج ${p.name}؟`, text: "يخرج من الحلقة الآن، ويستطيع العودة بالرابط.", ok: "إخراج", icon: "end" });
        if (yes && (await moderate("kick", { target: p.id }))) toast(`أُخرج ${p.name}`);
      }, true)
    );
    menu.appendChild(
      menuButton("lock", "إخراج ومنع من العودة", true, async () => {
        const yes = await askConfirm({ title: `إخراج ${p.name} ومنعه؟`, text: "لن يستطيع العودة حتى تسمح له من «ممنوعون من العودة» في أدوات الإدارة.", ok: "إخراج ومنع", icon: "lock" });
        if (yes && (await moderate("kick", { target: p.id, ban: true }))) {
          toast(`أُخرج ${p.name} ومُنع من العودة`);
        }
      }, true)
    );
  }

  // القائمة تُعرض فوق كل شيء بجانب الزر أو مكان الضغط، وتنفتح للأعلى إن لم يتسع لها المكان
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const h = Math.min(menu.offsetHeight, innerHeight - 16);
  const w = menu.offsetWidth;
  menu.style.maxHeight = `${innerHeight - 16}px`;
  menu.style.top = `${r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  menu.style.left = `${Math.min(Math.max(8, r.left - (anchor.getBoundingClientRect ? 0 : w / 2)), innerWidth - w - 8)}px`;
  // الضغط خارج القائمة يغلقها (لا داخلها، ولا رفع الإصبع بعد الضغطة المطوّلة)
  const onOutside = (e) => {
    if (!document.body.contains(menu)) return document.removeEventListener("click", onOutside, true);
    if (menu.guard || menu.contains(e.target)) return;
    document.removeEventListener("click", onOutside, true);
    closePersonMenu();
  };
  setTimeout(() => document.addEventListener("click", onOutside, true));
}

function menuButton(ic, label, enabled, run, danger) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = danger ? "danger" : "";
  b.disabled = !enabled;
  b.innerHTML = `${ic ? icon(ic) : ""}<span></span>`;
  b.lastChild.textContent = label;
  b.addEventListener("click", () => {
    // بعد الضغطة المطوّلة يرفع المستخدم إصبعه فوق القائمة؛ نتجاهل تلك اللمسة حتى لا يُنفَّذ الخيار الذي تحتها
    if ($("pmenu")?.guard) return;
    closePersonMenu();
    run();
  });
  return b;
}

// هل أستطيع إدارة هذا المشارك؟ المشرف يدير الطلاب، والمعلّم يدير الجميع عدا نفسه
const canManagePeer = (p) => isStaff(state.role) && !DEMO && !!p && p.role !== "teacher" && (state.role === "teacher" || p.role === "student");

// على مربع المشارك في الحلقة: ضغطة مطولة (أو زر الفأرة الأيمن) تفتح قائمة شؤونه،
// وضغطة عادية على طالب رافع يده تبدأ تسميعه
function attachTileGestures(tile, id) {
  let timer = 0;
  let start = null;
  let longFired = false;
  const open = (x, y) => {
    const p = state.peers.get(id);
    if (!canManagePeer(p)) return;
    longFired = true;
    navigator.vibrate?.(15);
    openPersonMenu({ x, y }, p);
  };
  tile.addEventListener("pointerdown", (e) => {
    if (!isStaff(state.role) || e.target.closest("button") || e.button > 0) return;
    longFired = false;
    start = [e.clientX, e.clientY];
    clearTimeout(timer);
    timer = setTimeout(() => open(e.clientX, e.clientY), 500);
  });
  const cancel = () => clearTimeout(timer);
  tile.addEventListener("pointermove", (e) => {
    if (start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 12) cancel();
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) tile.addEventListener(ev, cancel);
  tile.addEventListener("contextmenu", (e) => {
    if (!isStaff(state.role)) return;
    e.preventDefault();
    cancel();
    if (!$("pmenu")) open(e.clientX, e.clientY);
  });
  tile.addEventListener("click", (e) => {
    if (longFired) {
      // نمنع الضغطة التي أنهت الضغط المطوّل من إغلاق القائمة
      longFired = false;
      e.stopPropagation();
      return;
    }
    if (e.target.closest("button")) return;
    const p = state.peers.get(id);
    if (isStaff(state.role) && p?.hand && !isStaff(p.role) && state.reciter !== id) startRecite(id);
  });
}
window.addEventListener("resize", () => closePersonMenu());
function closePersonMenu() {
  $("pmenu")?.remove();
}

async function setAdmin(cid, admin) {
  try {
    const r = await fetch(`/api/rooms/${state.room}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: state.myId, token: state.token, cid, admin }),
    });
    if (!r.ok) throw new Error();
  } catch {
    toast("تعذر تغيير الصلاحية، حاول مرة أخرى");
  }
}

function renderPeople() {
  const isTeacher = isStaff(state.role);
  const isHost = state.role === "teacher" && !DEMO;
  const queue = handQueue();

  // طابور التسميع (يراه الجميع، والمعلّم يستطيع مناداة الطالب)
  const qbox = $("queue");
  qbox.hidden = queue.length === 0;
  $("queueCount").textContent = queue.length;
  const qlist = $("queueList");
  qlist.innerHTML = "";
  queue.forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="qnum">${i + 1}</span><span class="pn"></span>${isTeacher ? `<button class="btn btn-sm btn-primary" type="button">${icon("book")}ابدأ تسميعه</button>` : ""}`;
    li.querySelector(".pn").textContent = p.name;
    li.querySelector("button")?.addEventListener("click", () => startRecite(p.id));
    qlist.appendChild(li);
  });
  $("handCount").hidden = !isTeacher || !queue.length;
  $("handCount").textContent = queue.length;

  const list = $("people");
  list.innerHTML = "";
  const me = { ...myStatus(), id: "local", sid: state.myId, skey: state.cid, name: `${state.name} (أنت)` };
  const everyone = [me, ...[...state.peers.values()].map((p) => ({ ...p, sid: p.id, skey: p.cid }))];
  const rank = (r) => (r === "teacher" ? 2 : r === "admin" ? 1 : 0);
  everyone.sort((a, b) => rank(b.role) - rank(a.role) || (state.stars[b.skey] || 0) - (state.stars[a.skey] || 0));
  const pin = effectivePin();
  for (const p of everyone) {
    const stars = state.stars[p.skey] || 0;
    const canRecite = isTeacher && p.id !== "local" && !isStaff(p.role);
    const canPromote = isHost && p.id !== "local" && p.role !== "teacher";
    // المشرف يدير الطلاب، والمعلّم يدير الطلاب والمشرف
    const canManage = isTeacher && !DEMO && p.id !== "local" && p.role !== "teacher" && (isHost || p.role === "student");
    const reciting = state.reciter && state.reciter === p.sid;
    const li = document.createElement("li");
    li.classList.toggle("reciting", !!reciting);
    li.innerHTML = `
      <span class="mini"></span>
      <span class="pname"><span class="pn"></span><small class="r-${p.role}"${isStaff(p.role) ? "" : " hidden"}>${ROLE_LONG[p.role] || ""}</small>${reciting ? '<small class="now">يُسمّع الآن</small>' : ""}</span>
      ${stars ? `<span class="pstars">⭐ ${stars}</span>` : ""}
      <span class="icons">${p.hand ? icon("hand", "hand") : ""}${statusIcons(p, canManage, isTeacher)}</span>
      ${canRecite && !canManage ? `<button class="icon-btn recite-btn" type="button" title="ابدأ تسميعه">${icon("book")}</button>` : ""}
      ${canPromote && !canManage ? `<button class="icon-btn admin-btn${p.role === "admin" ? " active" : ""}" type="button" title="${p.role === "admin" ? "إلغاء الإشراف" : "تعيينه مشرفاً"}">${icon("shield")}</button>` : ""}
      ${canManage ? "" : `<button class="icon-btn pin${pin === p.id ? " active" : ""}" type="button" title="${pin === p.id ? "إلغاء التثبيت" : "تثبيت في الوسط"}">${icon("pin")}</button>`}
      ${canManage ? `<button class="icon-btn manage-btn" type="button" title="إدارة المشارك" aria-label="إدارة المشارك">${icon("more")}</button>` : ""}`;
    li.querySelector(".mini").textContent = initial(p.name);
    li.querySelector(".mini").style.background = colorFor(p.name.replace(" (أنت)", ""));
    li.querySelector(".pn").textContent = p.name;
    li.querySelector(".pin")?.addEventListener("click", () => togglePin(p.id));
    li.querySelector(".recite-btn")?.addEventListener("click", () => startRecite(p.id));
    li.querySelector(".admin-btn")?.addEventListener("click", () => setAdmin(p.cid, p.role !== "admin"));
    li.querySelector(".manage-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openPersonMenu(e.currentTarget, p);
    });
    // المعلّم والمشرف يكتمون المايك أو يوقفون الكاميرا من أيقونتها مباشرة
    li.querySelector(".mod-mic")?.addEventListener("click", async () => {
      if (await moderate("mute", { target: p.id })) toast(`كُتم ميكروفون ${p.name}`);
    });
    li.querySelector(".mod-cam")?.addEventListener("click", async () => {
      if (await moderate("camOff", { target: p.id })) toast(`أُوقفت كاميرا ${p.name}`);
    });
    list.appendChild(li);
  }
  $("peopleCount").textContent = $("peoplePill").textContent = everyone.length;
  if (isTeacher && state.breakout) renderOtherRooms(list, isHost);
}

// أيقونات المايك والكاميرا: أزرار للإدارة إن كانت مفتوحة، وإلا مجرد حالة
function statusIcons(p, canManage, staffView) {
  const mic = p.mic
    ? canManage
      ? `<button class="icon-btn mod mod-mic" type="button" title="كتم الميكروفون" aria-label="كتم ميكروفون ${p.name}">${icon("mic")}</button>`
      : icon("mic")
    : icon("mic-off", "muted-i");
  if (!staffView) return mic;
  const cam = p.cam
    ? canManage
      ? `<button class="icon-btn mod mod-cam" type="button" title="إيقاف الكاميرا" aria-label="إيقاف كاميرا ${p.name}">${icon("cam")}</button>`
      : icon("cam")
    : icon("cam-off", "muted-i");
  return mic + cam;
}

// للمعلّم والمشرف: من في الغرف الأخرى، مع إمكانية نقلهم
function renderOtherRooms(list, isHost) {
  const here = state.room === state.code ? "main" : state.room.slice(state.code.length + 1);
  const sections = [["main", "الحلقة الرئيسية"], ...state.breakout.rooms.map((r) => [r.id, r.name])];
  for (const [rid, name] of sections) {
    if (rid === here) continue;
    const members = (state.presence?.[rid] || []).filter((m) => m.cid !== state.cid);
    const head = document.createElement("li");
    head.className = "p-section";
    head.style.setProperty("--c", roomColor(rid === "main" ? null : rid));
    head.innerHTML = `<span class="rs-dot"></span><b></b><small>${members.length}</small>`;
    head.querySelector("b").textContent = name;
    list.appendChild(head);
    for (const m of members) {
      const li = document.createElement("li");
      li.className = "remote";
      const movable = m.role === "student" || (isHost && m.role === "admin");
      li.innerHTML = `
        <span class="mini"></span>
        <span class="pname"><span class="pn"></span><small class="r-${m.role}"${isStaff(m.role) ? "" : " hidden"}>${ROLE_LONG[m.role] || ""}</small></span>
        ${movable ? `<button class="icon-btn manage-btn" type="button" title="نقل إلى غرفة" aria-label="نقل ${m.name}">${icon("more")}</button>` : ""}`;
      li.querySelector(".mini").textContent = initial(m.name);
      li.querySelector(".mini").style.background = colorFor(m.name);
      li.querySelector(".pn").textContent = m.name;
      li.querySelector(".manage-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        openPersonMenu(e.currentTarget, m, rid);
      });
      list.appendChild(li);
    }
  }
}

/* ---------- تسجيل الاجتماع ---------- */

function updateRecBanner() {
  const others = [...state.peers.values()].filter((p) => p.recording).map((p) => p.name);
  const me = !!state.recorder;
  $("recBanner").hidden = !me && others.length === 0;
  $("recText").textContent = me
    ? "أنت تسجّل هذه الحلقة"
    : `يتم تسجيل هذه الحلقة بواسطة ${others.join("، ")}`;
  $("recBtn").classList.toggle("active", me);
  $("recLabel").textContent = me ? "إيقاف التسجيل" : "تسجيل الحلقة";
  $("moreDot").hidden = !me;
}

function addToRecording(stream) {
  if (!state.recDest || !stream.getAudioTracks().length) return;
  try {
    state.audioCtx.createMediaStreamSource(stream).connect(state.recDest);
  } catch {}
}

function pickMimeType(audioOnly) {
  const types = audioOnly
    ? ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"]
    : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4"];
  return types.find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
}

// صورة التسجيل في الجوال (ولكل متصفح لا يدعم التقاط الشاشة): نرسم بلاطات المشاركين على لوحة بأنفسنا
function canvasCapture() {
  const W = 1280;
  const H = 720;
  const FPS = 20;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const font = getComputedStyle(document.body).fontFamily;

  const drawTile = (tile, x, y, w, h) => {
    const g = 4;
    x += g; y += g; w -= g * 2; h -= g * 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, h, 14) : ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = "#121c18";
    ctx.fillRect(x, y, w, h);
    const v = tile.querySelector("video");
    const name = (tile.querySelector(".name")?.textContent || "").replace(" (أنت)", "");
    if (v && v.videoWidth && !tile.classList.contains("cam-off")) {
      // ملء المربع مع قصّ الأطراف (مثل object-fit: cover)، وصورتي معكوسة كما أراها
      const scale = Math.max(w / v.videoWidth, h / v.videoHeight);
      const vw = v.videoWidth * scale;
      const vh = v.videoHeight * scale;
      if (tile.classList.contains("local") && !tile.classList.contains("screen")) {
        ctx.translate(x + w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(v, (w - vw) / 2, y + (h - vh) / 2, vw, vh);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      } else {
        ctx.drawImage(v, x + (w - vw) / 2, y + (h - vh) / 2, vw, vh);
      }
    } else {
      const r = Math.min(w, h) * 0.16;
      ctx.fillStyle = "#2f8f6b";
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `600 ${Math.round(r)}px ${font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(initial(name), x + w / 2, y + h / 2);
    }
    if (name) {
      ctx.font = `600 ${Math.max(13, Math.round(Math.min(w, h) / 16))}px ${font}`;
      ctx.direction = "rtl";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(name).width;
      const lh = Math.max(24, Math.min(w, h) / 10);
      ctx.fillStyle = "rgba(0, 0, 0, .55)";
      ctx.fillRect(x + w - tw - 26, y + h - lh - 10, tw + 18, lh);
      ctx.fillStyle = "#fff";
      ctx.fillText(name, x + w - 17, y + h - 10 - lh / 2);
    }
    ctx.restore();
  };

  const draw = () => {
    ctx.fillStyle = "#0a110e";
    ctx.fillRect(0, 0, W, H);
    const tiles = [...$("grid").querySelectorAll(".tile")];
    if (!tiles.length) return;
    const pin = effectivePin();
    const big = pin && tiles.length > 1 ? tiles.find((t) => t.dataset.id === pin) : null;
    if (big) {
      // المثبّت كبيراً، والبقية في عمود جانبي
      const rest = tiles.filter((t) => t !== big).slice(0, 5);
      const side = W * 0.24;
      drawTile(big, side, 0, W - side, H);
      const h = H / Math.max(rest.length, 3);
      rest.forEach((t, i) => drawTile(t, 0, i * h, side, h));
      return;
    }
    const n = tiles.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const w = W / cols;
    const h = H / rows;
    // من اليمين لليسار مثل الواجهة
    tiles.forEach((t, i) => drawTile(t, W - ((i % cols) + 1) * w, Math.floor(i / cols) * h, w, h));
  };
  draw();
  const timer = setInterval(draw, 1000 / FPS);
  const stream = canvas.captureStream(FPS);
  return { stream, stop: () => clearInterval(timer) };
}

const canCaptureCanvas = () => !!HTMLCanvasElement.prototype.captureStream;

async function startRecording() {
  const tabCapture = !!navigator.mediaDevices?.getDisplayMedia && !matchMedia("(hover: none)").matches;
  if (!window.MediaRecorder) {
    // متصفحات داخل التطبيقات (واتساب، سناب…) لا تدعم التسجيل غالباً
    return toast("التسجيل غير مدعوم هنا. افتح الرابط في Safari أو Chrome مباشرة (وليس من داخل واتساب)", 6000);
  }
  ensureAudio();
  // إن لم يدعم الجهاز رسم الحلقة كفيديو نسجّل الصوت فقط (يكفي لمراجعة التلاوة)
  const audioOnly = !tabCapture && !canCaptureCanvas();
  // الكمبيوتر: نلتقط تبويب الحلقة نفسه. الجوال: نرسم الحلقة على لوحة ونسجّلها
  let video;
  if (audioOnly) {
    video = { stream: new MediaStream(), stop() {} };
    toast("هذا الجهاز يدعم تسجيل الصوت فقط — سيُسجَّل صوت الحلقة");
  } else if (tabCapture) {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser", frameRate: 30 },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
      });
      video = { stream: display, stop: () => display.getTracks().forEach((t) => t.stop()) };
      display.getVideoTracks()[0].onended = stopRecording;
    } catch {
      return; // ألغى اختيار الشاشة
    }
  } else {
    video = canvasCapture();
  }
  let audioTracks = [];
  if (state.audioCtx) {
    await state.audioCtx.resume?.().catch(() => {});
    state.recDest = state.audioCtx.createMediaStreamDestination();
    addToRecording(state.stream);
    for (const p of state.peers.values()) addToRecording(p.stream);
    audioTracks = state.recDest.stream.getAudioTracks();
  } else if (micTrack()) audioTracks = [micTrack()]; // بلا مازج صوت: صوتي فقط
  const mixed = new MediaStream([...video.stream.getVideoTracks(), ...audioTracks]);
  const mimeType = pickMimeType(audioOnly);
  let recorder;
  try {
    recorder = new MediaRecorder(mixed, mimeType ? { mimeType } : undefined);
  } catch {
    video.stop();
    state.recDest = null;
    return toast("تعذر بدء التسجيل على هذا الجهاز");
  }
  const chunks = [];
  const startedAt = new Date();
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    video.stop();
    const type = recorder.mimeType || mimeType || (audioOnly ? "audio/webm" : "video/webm");
    const blob = new Blob(chunks, { type });
    const ext = type.includes("mp4") ? (audioOnly ? "m4a" : "mp4") : "webm";
    const stamp = startedAt.toISOString().slice(0, 16).replace(/[:T]/g, "-");
    saveRecording(blob, `wasl-${state.code || "halaqa"}-${stamp}.${ext}`);
  };
  recorder.start(1000);
  state.recorder = recorder;
  updateRecBanner();
  broadcastState();
  toast("بدأ التسجيل — سيتم حفظه على جهازك عند الإيقاف");
}

function stopRecording() {
  const recorder = state.recorder;
  if (!recorder) return;
  state.recorder = null;
  state.recDest = null;
  if (recorder.state !== "inactive") recorder.stop();
  updateRecBanner();
  broadcastState();
}

// حفظ التسجيل: في الجوال نعرض «حفظ» ليفتح قائمة المشاركة (حفظ في الصور/الملفات أو الإرسال)
// لأن التنزيل المباشر لا يعمل جيداً في آيفون. وفي الكمبيوتر يُنزَّل مباشرة
async function saveRecording(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (IS_PHONE && navigator.canShare?.({ files: [file] })) {
    const yes = await askConfirm({ title: "التسجيل جاهز", text: "احفظه في الصور أو الملفات، أو أرسله مباشرة.", ok: "حفظ التسجيل", icon: "download", danger: false });
    if (!yes) return;
    try {
      await navigator.share({ files: [file], title: "تسجيل الحلقة" });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
  }
  downloadBlob(blob, filename);
  toast("تم حفظ التسجيل على جهازك");
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$("recBtn").addEventListener("click", () => (state.recorder ? stopRecording() : startRecording()));

/* ---------- قائمة «المزيد» ---------- */

// القائمة تُنقل لجسم الصفحة حتى تُعرض فوق كل شيء (وعلى الجوال كلوحة من الأسفل)
document.body.append($("moreBackdrop"), $("moreMenu"));
function setMoreMenu(open) {
  $("moreMenu").hidden = !open;
  $("moreBackdrop").hidden = !open;
  $("moreBtn").setAttribute("aria-expanded", String(open));
  $("moreBtn").classList.toggle("open", open);
  if (open) {
    // على الكمبيوتر تظهر فوق الزر مباشرة (على الجوال يضعها التصميم في الأسفل)
    const m = $("moreMenu");
    const r = $("moreBtn").getBoundingClientRect();
    m.style.bottom = `${innerHeight - r.top + 12}px`;
    m.style.left = `${Math.min(Math.max(8, r.left + r.width / 2 - m.offsetWidth / 2), innerWidth - m.offsetWidth - 8)}px`;
  }
}
$("moreBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("reactions").hidden = true;
  setMoreMenu($("moreMenu").hidden);
});
// أي عنصر في القائمة يغلقها بعد تنفيذه
$("moreMenu").addEventListener("click", (e) => e.target.closest(".mi") && setMoreMenu(false));
$("moreBackdrop").addEventListener("click", () => setMoreMenu(false));
document.addEventListener("click", (e) => {
  if (!$("moreMenu").hidden && !e.target.closest("#moreMenu, #moreBtn")) setMoreMenu(false);
});
document.addEventListener("keydown", (e) => e.key === "Escape" && setMoreMenu(false));
// مشاركة الشاشة غير متاحة في أغلب الجوالات
if (!navigator.mediaDevices?.getDisplayMedia) $("shareBtn").hidden = true;

/* ---------- جدولة الاجتماعات ---------- */

const SCHEDULE_KEY = "halaqati:scheduled";

function loadScheduled() {
  try {
    const list = JSON.parse(localStorage.getItem(SCHEDULE_KEY)) || [];
    // نحذف الاجتماعات التي انتهت
    return list.filter((m) => m.start + m.duration * 60000 > Date.now()).sort((a, b) => a.start - b.start);
  } catch {
    return [];
  }
}

function saveScheduled(list) {
  try {
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(list));
  } catch {}
}

function formatWhen(ts) {
  return new Date(ts).toLocaleString("ar", {
    weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  });
}

function renderUpcoming() {
  const list = loadScheduled();
  saveScheduled(list);
  $("upcoming").hidden = list.length === 0;
  const ul = $("upcomingList");
  ul.innerHTML = "";
  for (const m of list) {
    const li = document.createElement("li");
    const live = m.start - Date.now() < 10 * 60000;
    li.innerHTML = `
      <div class="when"><b></b><span></span></div>
      <button class="btn btn-primary" data-join>دخول</button>
      <button class="icon-btn del-btn" data-del title="حذف" aria-label="حذف">${icon("trash")}</button>`;
    li.querySelector("b").textContent = m.title;
    li.querySelector("span").textContent = live ? "يبدأ الآن" : formatWhen(m.start);
    li.querySelector("span").classList.toggle("soon", live);
    li.querySelector("[data-join]").addEventListener("click", () => goTo(m.code));
    li.querySelector("[data-del]").addEventListener("click", async () => {
      if (!(await askConfirm({ title: `حذف «${m.title}»؟`, text: "سيُحذف الموعد من قائمتك. من أرسلت لهم الرابط يستطيعون الدخول به." }))) return;
      saveScheduled(loadScheduled().filter((x) => x.code !== m.code));
      renderUpcoming();
      toast("حُذف الموعد");
    });
    ul.appendChild(li);
  }
}

function toCalDate(ts) {
  return new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function inviteText(m) {
  return `أنت مدعو لحضور حلقة تحفيظ عبر منصة وصل (بالقرآن نتّصل)\n\n${m.title}\n${formatWhen(m.start)} (${m.duration} دقيقة)\n\nرابط الانضمام:\n${linkFor(m.code)}`;
}

function icsFile(m) {
  const esc = (t) => t.replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const link = `${linkFor(m.code)}`;
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Halaqati//AR", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${m.code}@halaqati`,
    `DTSTAMP:${toCalDate(Date.now())}`,
    `DTSTART:${toCalDate(m.start)}`,
    `DTEND:${toCalDate(m.start + m.duration * 60000)}`,
    `SUMMARY:${esc(m.title)}`,
    `DESCRIPTION:${esc("رابط الانضمام: " + link)}`,
    `URL:${link}`,
    `LOCATION:${esc(link)}`,
    "BEGIN:VALARM", "TRIGGER:-PT10M", "ACTION:DISPLAY", `DESCRIPTION:${esc(m.title)}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
}

let lastScheduled = null;

function openSchedule() {
  const start = new Date(Date.now() + 60 * 60000);
  start.setMinutes(start.getMinutes() < 30 ? 30 : 60, 0, 0);
  const local = new Date(start.getTime() - start.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("sStart").value = local;
  $("sTitle").value = "";
  $("scheduleError").textContent = "";
  $("scheduleForm").hidden = false;
  $("scheduleResult").hidden = true;
  $("scheduleModal").hidden = false;
  $("sTitle").focus();
}

function closeSchedule() {
  $("scheduleModal").hidden = true;
  renderUpcoming();
}

$("scheduleBtn").addEventListener("click", openSchedule);
for (const el of document.querySelectorAll("#scheduleModal [data-close]")) el.addEventListener("click", closeSchedule);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("scheduleModal").hidden) closeSchedule();
  if (!$("termModal").hidden) closeTerm();
  $("settingsModal").hidden = true;
  $("breakoutModal").hidden = true;
});

$("scheduleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const start = new Date($("sStart").value).getTime();
  if (!start || start < Date.now() - 60000) {
    $("scheduleError").textContent = "اختر موعداً في المستقبل";
    return;
  }
  let code;
  try {
    code = await createRoom();
  } catch {
    $("scheduleError").textContent = "تعذر إنشاء الحلقة، تأكد من الاتصال وحاول مرة أخرى";
    return;
  }
  const m = {
    code,
    title: $("sTitle").value.trim() || "حلقة",
    start,
    duration: Number($("sDuration").value),
  };
  saveScheduled([...loadScheduled(), m]);
  lastScheduled = m;
  const link = `${linkFor(m.code)}`;
  $("sSummary").textContent = `${m.title} — ${formatWhen(m.start)}`;
  $("sLink").textContent = link;
  const g = new URL("https://calendar.google.com/calendar/render");
  g.searchParams.set("action", "TEMPLATE");
  g.searchParams.set("text", m.title);
  g.searchParams.set("dates", `${toCalDate(m.start)}/${toCalDate(m.start + m.duration * 60000)}`);
  g.searchParams.set("details", `رابط الانضمام: ${link}`);
  g.searchParams.set("location", link);
  $("sGoogle").href = g.toString();
  $("scheduleForm").hidden = true;
  $("scheduleResult").hidden = false;
});

$("sCopy").addEventListener("click", async () => {
  if (!lastScheduled) return;
  try {
    await navigator.clipboard.writeText(inviteText(lastScheduled));
    toast("تم نسخ الدعوة — أرسلها لمن تريد");
  } catch {
    prompt("انسخ الدعوة:", inviteText(lastScheduled));
  }
});

$("sIcs").addEventListener("click", () => {
  if (!lastScheduled) return;
  downloadBlob(new Blob([icsFile(lastScheduled)], { type: "text/calendar;charset=utf-8" }), `halaqati-${lastScheduled.code}.ics`);
});

setInterval(() => {
  if (!$("home").hidden) renderUpcoming();
}, 60000);

/* ---------- الغرف الفرعية داخل الحلقة ---------- */

const MAX_BREAKOUTS = 9;
const bo = { count: 2, names: [], assign: new Map() }; // إعداد المعلّم قبل الفتح

function roomLabel(roomId) {
  if (!roomId || roomId === state.code) return "الحلقة الرئيسية";
  const rid = roomId.slice(state.code.length + 1);
  return state.breakout?.rooms.find((r) => r.id === rid)?.name || "غرفة";
}

// يطبّق حالة الغرف القادمة من الخادم، ويُرجع true إذا انتقلنا لغرفة أخرى
function applyBreakout(b) {
  state.breakout = b?.open ? b : null;
  const main = state.code;
  let target = state.room;
  if (isStaff(state.role)) {
    // المعلّم يبقى حيث هو، إلا إذا أُغلقت الغرفة التي هو فيها
    const rid = state.room?.slice(main.length + 1);
    const stillOpen = state.breakout?.rooms.some((r) => r.id === rid);
    if (state.room !== main && !stillOpen) target = main;
  } else if (state.breakout) {
    const mine = myBreakoutRoom();
    // الطالب يستطيع العودة للرئيسية بنفسه، ويبقى فيها حتى يغيّر المعلّم غرفته
    if (mine?.id !== state.boChoice?.room) state.boChoice = null;
    target = mine && !state.boChoice ? `${main}-${mine.id}` : main;
  } else {
    state.boChoice = null;
    target = main;
  }
  updateRoomUI();
  renderRoomsStrip();
  if (target && target !== state.room) {
    moveTo(target);
    return true;
  }
  return false;
}

const myBreakoutRoom = () => state.breakout?.rooms.find((r) => r.members.includes(state.cid)) || null;

/* ---------- شريط الغرف أسفل الحلقة ---------- */

const roomColor = (id) => (id ? COLORS[(Number(id.slice(1)) - 1) % COLORS.length] : "#6b7d75");

// المعلّم يرى كل الغرف المفتوحة، والطالب يرى غرفته والحلقة الرئيسية فقط ليتنقل بينهما
function renderRoomsStrip() {
  const strip = $("roomsStrip");
  const b = state.breakout;
  const staff = isStaff(state.role);
  const mine = myBreakoutRoom();
  if (!b || !state.joinedAt || (!staff && !mine)) {
    strip.hidden = true;
    return;
  }
  const cards = staff ? [{ id: null, name: "الحلقة الرئيسية" }, ...b.rooms] : [{ id: null, name: "الحلقة الرئيسية" }, mine];
  strip.innerHTML = "";
  strip.hidden = false;
  if (staff) {
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "rs-manage";
    manage.innerHTML = `${icon("rooms")}<span>غرف المراجعة</span>`;
    manage.addEventListener("click", openBreakout);
    strip.appendChild(manage);
  }
  for (const r of cards) {
    const target = r.id ? `${state.code}-${r.id}` : state.code;
    const here = state.room === target;
    const present = state.presence?.[r.id || "main"] || [];
    const card = document.createElement("div");
    card.className = "rs-card" + (here ? " here" : "");
    card.style.setProperty("--c", roomColor(r.id));
    card.innerHTML = `
      <span class="rs-dot"></span>
      <span class="rs-body"><b></b><small></small></span>
      <span class="rs-faces"></span>
      ${here ? '<span class="rs-here">أنت هنا</span>' : `<button class="rs-go" type="button">${r.id ? "انتقل" : "الرئيسية"}</button>`}
      ${staff && r.id ? `<button class="icon-btn rs-close" type="button" title="إغلاق هذه الغرفة" aria-label="إغلاق هذه الغرفة">${icon("close")}</button>` : ""}`;
    card.querySelector("b").textContent = r.name;
    card.querySelector("small").textContent = present.length ? `${present.length} في الغرفة` : "فارغة";
    const faces = card.querySelector(".rs-faces");
    for (const m of present.slice(0, 4)) {
      const f = document.createElement("span");
      f.textContent = initial(m.name);
      f.title = m.name;
      f.style.background = colorFor(m.name);
      faces.appendChild(f);
    }
    if (present.length > 4) faces.insertAdjacentHTML("beforeend", `<span class="more">+${present.length - 4}</span>`);
    card.querySelector(".rs-go")?.addEventListener("click", () => {
      if (!staff) state.boChoice = r.id ? null : { room: mine.id };
      moveTo(target);
    });
    card.querySelector(".rs-close")?.addEventListener("click", async () => {
      if (await breakoutAction({ action: "closeRoom", room: r.id })) toast(`أُغلقت «${r.name}» وعاد طلابها للحلقة الرئيسية`);
    });
    strip.appendChild(card);
  }
}

// نقل طالب إلى غرفة (أو للرئيسية) من قائمة الحضور
async function assignTo(p, roomId) {
  const dest = roomId ? state.breakout.rooms.find((r) => r.id === roomId)?.name : "الحلقة الرئيسية";
  if (await breakoutAction({ action: "assign", cid: p.cid, name: p.name.replace(" (أنت)", ""), room: roomId })) toast(`نُقل ${p.name} إلى ${dest}`);
}

function moveTo(target) {
  // نغلق قناة الأحداث أولاً حتى لا تصل إشارات للاتصالات التي سنغلقها
  state.es?.close();
  state.es = null;
  for (const id of [...state.peers.keys()]) removePeer(id, true);
  state.reciter = null;
  state.pinned = null;
  state.hand = false;
  state.handAt = 0;
  state.room = target;
  syncToggleButtons();
  updateReciteUI();
  updateLocalTile();
  layoutGrid();
  renderPeople();
  updateRoomUI();
  renderRoomsStrip();
  const label = roomLabel(target);
  addNote(`انتقلت إلى ${label}`);
  toast(target === state.code ? "عدت إلى الحلقة الرئيسية" : `🚪 انتقلت إلى ${label}`);
  // مهلة قصيرة حتى تُغلق الاتصالات القديمة تماماً قبل فتح الجديدة
  clearTimeout(moveTo.t);
  moveTo.t = setTimeout(() => {
    if (state.room === target && state.joinedAt) connect(target);
  }, 400);
}

function addNote(text) {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = `— ${text} —`;
  $("messages").appendChild(p);
}

function updateRoomUI() {
  if (!state.room) return;
  const inSub = state.room !== state.code;
  $("roomBanner").hidden = !inSub;
  $("roomBannerText").textContent = roomLabel(state.room);
  $("roomCode").textContent = inSub ? `${state.code} · ${roomLabel(state.room)}` : state.code;
  $("breakoutBtn").classList.toggle("on", !!state.breakout);
  if (!$("breakoutModal").hidden) renderBreakout();
}

let announceTimer;
function showAnnounce(name, text) {
  $("announceFrom").textContent = name;
  $("announceText").textContent = text;
  $("announce").hidden = false;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => ($("announce").hidden = true), 12000);
}
$("announceClose").addEventListener("click", () => ($("announce").hidden = true));

async function breakoutAction(body) {
  try {
    const r = await fetch(`/api/rooms/${state.room}/breakout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: state.myId, token: state.token, ...body }),
    });
    if (!r.ok) throw new Error();
    return true;
  } catch {
    toast("تعذر تنفيذ الأمر، حاول مرة أخرى");
    return false;
  }
}

function boStudents() {
  return [...state.peers.values()].filter((p) => !isStaff(p.role));
}

function autoAssign() {
  const list = boStudents().sort(() => Math.random() - 0.5);
  bo.assign.clear();
  list.forEach((p, i) => bo.assign.set(p.cid, i % bo.count));
  renderBreakout();
}

function renderBreakout() {
  const live = !!state.breakout;
  $("boSetup").hidden = live;
  $("boLive").hidden = !live;
  if (live) return renderBreakoutLive();

  $("boCountVal").textContent = bo.count;
  for (let i = 0; i < bo.count; i++) bo.names[i] ||= `مراجعة ${i + 1}`;
  const students = boStudents();
  // الطالب الجديد أو من خرج رقم غرفته عن العدد يوضع في أقل غرفة عدداً
  for (const p of students) {
    if (!bo.assign.has(p.cid) || bo.assign.get(p.cid) >= bo.count) {
      const sizes = Array.from({ length: bo.count }, (_, i) => [...bo.assign.values()].filter((v) => v === i).length);
      bo.assign.set(p.cid, sizes.indexOf(Math.min(...sizes)));
    }
  }

  const roomsBox = $("boRooms");
  roomsBox.innerHTML = "";
  for (let i = 0; i < bo.count; i++) {
    const members = students.filter((p) => bo.assign.get(p.cid) === i);
    const card = document.createElement("div");
    card.className = "bo-room";
    card.style.setProperty("--c", COLORS[i % COLORS.length]);
    card.innerHTML = `<div class="bo-room-head"><span class="bo-dot"></span><input maxlength="30" aria-label="اسم الغرفة"><span class="bo-n">${members.length}</span></div><div class="bo-chips"></div>`;
    const input = card.querySelector("input");
    input.value = bo.names[i];
    input.addEventListener("input", () => (bo.names[i] = input.value));
    const chips = card.querySelector(".bo-chips");
    if (!members.length) chips.innerHTML = '<span class="bo-empty">لا يوجد طلاب</span>';
    for (const p of members) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "bo-chip";
      chip.title = "اضغط لنقله إلى الغرفة التالية";
      chip.textContent = p.name;
      chip.addEventListener("click", () => {
        bo.assign.set(p.cid, (bo.assign.get(p.cid) + 1) % bo.count);
        renderBreakout();
      });
      chips.appendChild(chip);
    }
    roomsBox.appendChild(card);
  }
  $("boHint").textContent = students.length
    ? "اضغط على اسم الطالب لنقله إلى الغرفة التالية"
    : "لا يوجد طلاب في الحلقة الآن";
  $("boOpen").disabled = !students.length;
}

function renderBreakoutLive() {
  const box = $("boLiveRooms");
  box.innerHTML = "";
  const cards = [{ id: null, name: "الحلقة الرئيسية", names: [] }, ...state.breakout.rooms];
  cards.forEach((r, i) => {
    const target = r.id ? `${state.code}-${r.id}` : state.code;
    const here = state.room === target;
    const card = document.createElement("div");
    card.className = "bo-room live" + (here ? " here" : "") + (r.id ? "" : " main");
    // لون ثابت لكل غرفة حسب رقمها، حتى لا تتغير الألوان عند إغلاق غرفة
    card.style.setProperty("--c", r.id ? COLORS[(Number(r.id.slice(1)) - 1) % COLORS.length] : "#94a3b8");
    card.innerHTML = `
      <div class="bo-room-head"><span class="bo-dot"></span><b></b>${r.id ? `<span class="bo-n">${r.names.length}</span><button class="icon-btn bo-close" type="button" title="إغلاق هذه الغرفة وإعادة طلابها">${icon("close")}</button>` : ""}</div>
      <div class="bo-names"></div>
      <button class="btn btn-sm${here ? "" : " btn-primary"}" type="button"${here ? " disabled" : ""}>${here ? "أنت هنا" : r.id ? "انضم للغرفة" : "عودة للرئيسية"}</button>`;
    card.querySelector("b").textContent = r.name;
    card.querySelector(".bo-names").textContent = r.id ? r.names.join("، ") || "—" : "لمن لم يُوزَّع";
    card.querySelector(".bo-room-head ~ button").addEventListener("click", () => {
      moveTo(target);
      $("breakoutModal").hidden = true;
    });
    card.querySelector(".bo-close")?.addEventListener("click", async () => {
      if (await breakoutAction({ action: "closeRoom", room: r.id })) toast(`أُغلقت «${r.name}» وعاد طلابها للحلقة الرئيسية`);
    });
    box.appendChild(card);
  });
}

function openBreakout() {
  renderBreakout();
  $("breakoutModal").hidden = false;
}
$("breakoutBtn").addEventListener("click", openBreakout);
// أدوات الإدارة من قائمة «المزيد» (أسهل على الجوال): تفتح الحضور وأدوات الإدارة في أعلاه
$("adminMenuBtn").addEventListener("click", () => {
  if ($("panel").hidden || document.querySelector('[data-pane="people"]').hidden) openPanel("people");
  $("adminTools").scrollIntoView({ block: "start" });
});
for (const el of document.querySelectorAll("#breakoutModal [data-close]")) {
  el.addEventListener("click", () => ($("breakoutModal").hidden = true));
}
$("boMinus").addEventListener("click", () => {
  bo.count = Math.max(1, bo.count - 1);
  renderBreakout();
});
$("boPlus").addEventListener("click", () => {
  bo.count = Math.min(MAX_BREAKOUTS, bo.count + 1);
  renderBreakout();
});
$("boAuto").addEventListener("click", autoAssign);
$("boOpen").addEventListener("click", async () => {
  const students = boStudents();
  const rooms = Array.from({ length: bo.count }, (_, i) => {
    const members = students.filter((p) => bo.assign.get(p.cid) === i);
    return { name: bo.names[i].trim() || `مراجعة ${i + 1}`, members: members.map((p) => p.cid), names: members.map((p) => p.name) };
  });
  $("boOpen").disabled = true;
  if (await breakoutAction({ action: "open", rooms })) {
    toast("فُتحت الغرف — تجدها في الشريط أسفل الحلقة");
    $("breakoutModal").hidden = true;
  }
  $("boOpen").disabled = false;
});
$("boClose").addEventListener("click", async () => {
  if (await breakoutAction({ action: "close" })) {
    toast("أُغلقت الغرف وعاد الجميع للحلقة الرئيسية");
    $("breakoutModal").hidden = true;
  }
});
$("boAnnounce").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("boMsg").value.trim();
  if (!text) return;
  if (await breakoutAction({ action: "announce", text })) {
    $("boMsg").value = "";
    toast("📢 أُرسلت الرسالة لكل الغرف");
  }
});

/* ---------- غرفة ثابتة بنفس الرابط ---------- */

const TERMS_KEY = "wasl:terms";
const DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function loadTerms() {
  try {
    const list = JSON.parse(localStorage.getItem(TERMS_KEY)) || [];
    const today = new Date().toISOString().slice(0, 10);
    return list.filter((t) => !t.until || t.until >= today);
  } catch {
    return [];
  }
}

function saveTerms(list) {
  try {
    localStorage.setItem(TERMS_KEY, JSON.stringify(list));
  } catch {}
}

function daysText(days) {
  const d = [...days].sort();
  if (d.length === 7) return "يومياً";
  if (d.join() === "0,1,2,3,4") return "من الأحد إلى الخميس";
  return d.map((i) => DAYS[i]).join("، ");
}

function timeText(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString("ar", { hour: "numeric", minute: "2-digit" });
}

// أقرب موعد قادم للحلقة حسب أيامها ووقتها
function nextOccurrence(t, from = new Date()) {
  const [h, m] = t.time.split(":").map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, h, m);
    if (t.days.includes(d.getDay()) && d.getTime() + t.duration * 60000 > from.getTime()) return d;
  }
  return null;
}

function termRRule(t) {
  let rule = `RRULE:FREQ=WEEKLY;BYDAY=${[...t.days].sort().map((i) => DAY_CODES[i]).join(",")}`;
  if (t.until) rule += `;UNTIL=${t.until.replace(/-/g, "")}T235959Z`;
  return rule;
}

function termInvite(t) {
  return `رابط ${t.title} — غرفة ثابتة بنفس الرابط\nمنصة وصل (بالقرآن نتّصل)\n\nالمواعيد: ${daysText(t.days)} الساعة ${timeText(t.time)}\n\nادخل يومياً من نفس الرابط:\n${linkFor(t.code)}`;
}

function renderTerms() {
  const list = loadTerms();
  $("terms").hidden = list.length === 0;
  const ul = $("termsList");
  ul.innerHTML = "";
  for (const t of list) {
    const next = nextOccurrence(t);
    const live = next && next.getTime() - Date.now() < 15 * 60000;
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="when"><b></b><span></span></div>
      <button class="icon-btn" data-copy title="نسخ الرابط">${icon("copy")}</button>
      <button class="btn btn-primary" data-join>دخول</button>
      <button class="icon-btn del-btn" data-del title="حذف" aria-label="حذف">${icon("trash")}</button>`;
    li.querySelector("b").textContent = t.title;
    const span = li.querySelector("span");
    span.textContent = live ? "الحلقة الآن" : `${daysText(t.days)} · ${timeText(t.time)}`;
    span.classList.toggle("soon", !!live);
    li.querySelector("[data-join]").addEventListener("click", () => goTo(t.code));
    li.querySelector("[data-copy]").addEventListener("click", () => copyText(termInvite(t), "تم نسخ رابط الغرفة الثابتة"));
    li.querySelector("[data-del]").addEventListener("click", async () => {
      const yes = await askConfirm({
        title: `حذف «${t.title}»؟`,
        text: "ستُحذف من قائمتك في هذا الجهاز فقط، والرابط نفسه يبقى يعمل لمن عنده.",
      });
      if (!yes) return;
      saveTerms(loadTerms().filter((x) => x.code !== t.code));
      renderTerms();
      toast("حُذفت الغرفة من قائمتك");
    });
    ul.appendChild(li);
  }
}

let lastTerm = null;

function slugify(v) {
  return v.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function updateSlugPreview() {
  const slug = $("tSlug").value;
  const ok = ROOM_RE.test(slug);
  $("tSlugPreview").textContent = (DEMO ? "" : `${location.host}/`) + (slug || "…") + "-•••";
  $("tSlugPreview").classList.toggle("bad", !!slug && !ok);
  return ok;
}

function openTerm() {
  $("tTitle").value = "";
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => "abcdefghjkmnpqrstuvwxyz"[b % 23]).join("");
  $("tSlug").value = `sahaba-${rand}`;
  $("tTime").value = "16:30";
  $("tUntil").value = "";
  for (const c of document.querySelectorAll("#termForm .day input")) c.checked = Number(c.value) <= 4;
  $("termError").textContent = "";
  $("termForm").hidden = false;
  $("termResult").hidden = true;
  updateSlugPreview();
  $("termModal").hidden = false;
  $("tTitle").focus();
}

function closeTerm() {
  $("termModal").hidden = true;
  renderTerms();
}

$("termBtn").addEventListener("click", openTerm);
for (const el of document.querySelectorAll("#termModal [data-close]")) el.addEventListener("click", closeTerm);
$("tSlug").addEventListener("input", () => {
  const el = $("tSlug");
  const clean = (v) => v.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (clean(el.value) !== el.value) {
    // نحافظ على مكان المؤشر بحساب ما قبله بعد التنظيف
    const before = clean(el.value.slice(0, el.selectionStart));
    el.value = clean(el.value);
    el.setSelectionRange(before.length, before.length);
  }
  updateSlugPreview();
});

$("termForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const slug = slugify($("tSlug").value);
  $("tSlug").value = slug;
  const days = [...document.querySelectorAll("#termForm .day input:checked")].map((c) => Number(c.value));
  if (!updateSlugPreview()) {
    $("termError").textContent = "اسم الرابط: حروف إنجليزية صغيرة وأرقام وشرطة (-) فقط، من 3 أحرف على الأقل";
    return;
  }
  if (!days.length) {
    $("termError").textContent = "اختر يوماً واحداً على الأقل";
    return;
  }
  let code;
  try {
    code = await createRoom(slug);
  } catch {
    $("termError").textContent = "تعذر إنشاء الغرفة، تأكد من الاتصال وحاول مرة أخرى";
    return;
  }
  const t = {
    code,
    title: $("tTitle").value.trim() || "الغرفة الثابتة",
    days,
    time: $("tTime").value || "16:30",
    duration: Number($("tDuration").value),
    until: $("tUntil").value || "",
  };
  saveTerms([...loadTerms().filter((x) => x.code !== t.code), t]);
  lastTerm = t;
  const link = linkFor(t.code);
  $("tLink").textContent = link;
  $("tDemoNote").hidden = !DEMO;
  $("tDemoSlug").textContent = t.code;
  $("tHostLink").hidden = !teacherLink(t.code);
  $("tSummary").textContent = `${t.title} — ${daysText(t.days)} الساعة ${timeText(t.time)}${t.until ? ` حتى ${new Date(t.until).toLocaleDateString("ar", { day: "numeric", month: "long" })}` : ""}`;
  const first = nextOccurrence(t) || new Date();
  const g = new URL("https://calendar.google.com/calendar/render");
  g.searchParams.set("action", "TEMPLATE");
  g.searchParams.set("text", t.title);
  g.searchParams.set("dates", `${toCalDate(first.getTime())}/${toCalDate(first.getTime() + t.duration * 60000)}`);
  g.searchParams.set("recur", termRRule(t));
  g.searchParams.set("details", `رابط الغرفة الثابت: ${link}`);
  g.searchParams.set("location", link);
  $("tGoogle").href = g.toString();
  $("termForm").hidden = true;
  $("termResult").hidden = false;
});

$("tHostLink").addEventListener("click", () => lastTerm && copyText(teacherLink(lastTerm.code), "تم نسخ رابط المعلّم — احتفظ به ولا ترسله للطلاب"));
$("tCopy").addEventListener("click", () => lastTerm && copyText(termInvite(lastTerm), "تم نسخ الدعوة — أرسلها لطلابك مرة واحدة"));
$("tIcs").addEventListener("click", () => {
  if (!lastTerm) return;
  const t = lastTerm;
  const first = nextOccurrence(t) || new Date();
  const esc = (x) => x.replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const link = linkFor(t.code);
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Wasl//AR", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${t.code}-term@wasl`,
    `DTSTAMP:${toCalDate(Date.now())}`,
    `DTSTART:${toCalDate(first.getTime())}`,
    `DTEND:${toCalDate(first.getTime() + t.duration * 60000)}`,
    termRRule(t),
    `SUMMARY:${esc(t.title)}`,
    `DESCRIPTION:${esc("رابط الحلقة الثابت: " + link)}`,
    `URL:${link}`,
    `LOCATION:${esc(link)}`,
    "BEGIN:VALARM", "TRIGGER:-PT10M", "ACTION:DISPLAY", `DESCRIPTION:${esc(t.title)}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  downloadBlob(new Blob([ics], { type: "text/calendar;charset=utf-8" }), `wasl-${t.code}.ics`);
});
$("tGo").addEventListener("click", () => {
  if (!lastTerm) return;
  $("termModal").hidden = true;
  goTo(lastTerm.code);
});

/* ---------- الوضع النهاري والليلي ---------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "light" ? "#f4f3ee" : "#0a110e";
  for (const b of document.querySelectorAll("[data-theme-toggle]")) {
    const label = theme === "light" ? "الوضع الليلي" : "الوضع النهاري";
    b.title = label;
    b.setAttribute("aria-label", label);
  }
}
applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
$("demoBar").hidden = !DEMO;
if (!DEMO) loadIceConfig();

// نوقف دوران المدار حين يخرج من الشاشة أو تُخفى الصفحة، فلا يستهلك الجوال أثناء التمرير
{
  const orbit = document.querySelector(".orbit");
  if (orbit && "IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => orbit.classList.toggle("paused", !e.isIntersecting)).observe(orbit);
  }
  if (orbit) initOrbitTour(orbit);
  if (orbit) initFloatCards(orbit);
}

// البطاقتان الطافيتان حول المدار: تختفي كل واحدة ثم تظهر بإشعار جديد من حياة الحلقة
function initFloatCards(orbit) {
  const POOLS = [
    [
      ["i-chat", "رسالة من الحلقة", "السلام عليكم يا شيخ"],
      ["i-users", "انضم أحمد للحلقة", "الحضور الآن ١٢ طالباً"],
      ["i-check", "تقييم: ممتاز", "ما شاء الله يا يوسف ⭐⭐⭐"],
      ["i-chat", "رسالة خاصة", "يا شيخ، أسمّع بعد خالد؟"],
      ["i-mic", "أذن المعلّم بالميكروفون", "دورك يا عمر، تفضّل"],
    ],
    [
      ["i-hand", "طابور التسميع", "٣ طلاب بانتظار دورهم"],
      ["i-book", "دور يوسف للتسميع", "سورة الملك من أولها"],
      ["i-rooms", "غرف المراجعة", "٣ غرف تعمل الآن"],
      ["i-hand", "رفع خالد يده", "الرابع في الطابور"],
      ["i-calendar", "الحلقة القادمة", "بعد العصر ٤:٠٠"],
    ],
  ];
  const cards = [orbit.querySelector(".fc-chat"), orbit.querySelector(".fc-hand")];
  if (cards.some((c) => !c) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  cards.forEach((card, n) => {
    let i = 0;
    const swap = () => {
      if (!orbit.classList.contains("paused") && !document.hidden) {
        card.classList.add("fc-out");
        setTimeout(() => {
          const [icon, title, sub] = POOLS[n][(i = (i + 1) % POOLS[n].length)];
          card.querySelector(".fc-ic use").setAttribute("href", "#" + icon);
          card.querySelector("b").textContent = title;
          card.querySelector("small").textContent = sub;
          card.classList.remove("fc-out");
        }, 1400);
      }
      setTimeout(swap, 5200);
    };
    // البطاقتان لا تتبدلان معاً: الثانية متأخرة نصف دورة
    setTimeout(swap, 3000 + n * 2600);
  });
}

// المدار تفاعلي: لمس أيقونة (أو المرور عليها) يوقف الدوران ويعرض الميزة في القلب،
// وعند السكون يتجول المدار وحده بين المزايا. على الكمبيوتر يميل المدار قليلاً مع حركة المؤشر.
function initOrbitTour(orbit) {
  const FEATURES = {
    "i-book": ["حلقات التحفيظ", "تسميع منظّم وتقييم بالنجوم"],
    "i-hand": ["رفع اليد", "طابور تسميع تلقائي بالترتيب"],
    "i-mic": ["صوت نقي", "الميكروفون بإذن المعلّم"],
    "i-screen": ["عرض الشاشة", "اعرض المصحف للطلاب"],
    "i-cam": ["الصورة", "جودة تتكيّف مع سرعة النت"],
    "i-chat": ["الدردشة", "رسائل عامة وخاصة"],
    "i-rooms": ["غرف المراجعة", "قسّم الطلاب مجموعات"],
    "i-calendar": ["الجدولة", "مواعيد ثابتة ورابط واحد"],
  };
  const core = orbit.querySelector(".core");
  const ops = [...orbit.querySelectorAll(".op")].filter((op) => FEATURES[op.querySelector("use")?.getAttribute("href")?.slice(1)]);
  if (!core || !ops.length) return;
  orbit.closest(".home-art")?.removeAttribute("aria-hidden");
  const feat = document.createElement("div");
  feat.className = "core-feat";
  feat.setAttribute("aria-live", "polite");
  feat.innerHTML = '<svg class="i"><use href="#i-book"/></svg><b></b><small></small>';
  core.append(feat);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let active = null;
  let held = false;
  let resumeTimer = 0;
  let tourIndex = 0;

  function show(op, hold) {
    const id = op.querySelector("use").getAttribute("href").slice(1);
    const [title, desc] = FEATURES[id];
    if (active !== op) {
      active?.classList.remove("on");
      op.classList.add("on");
      active = op;
      feat.querySelector("use").setAttribute("href", "#" + id);
      feat.querySelector("b").textContent = title;
      feat.querySelector("small").textContent = desc;
      // إعادة تشغيل حركة الظهور مع كل ميزة جديدة
      feat.classList.remove("in");
      void feat.offsetWidth;
      feat.classList.add("in");
    }
    core.classList.add("featuring");
    held = hold;
    orbit.classList.toggle("hold", hold);
  }
  function hide() {
    active?.classList.remove("on");
    active = null;
    held = false;
    core.classList.remove("featuring");
    orbit.classList.remove("hold");
  }

  for (const op of ops) {
    const title = FEATURES[op.querySelector("use").getAttribute("href").slice(1)][0];
    op.tabIndex = 0;
    op.setAttribute("role", "button");
    op.setAttribute("aria-label", title);
    op.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") {
        clearTimeout(resumeTimer);
        show(op, true);
      }
    });
    op.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") resumeTimer = setTimeout(hide, 350);
    });
    op.addEventListener("click", (e) => {
      e.stopPropagation();
      clearTimeout(resumeTimer);
      show(op, true);
      op.classList.remove("pulse");
      void op.offsetWidth;
      op.classList.add("pulse");
      // باللمس: تبقى الميزة ظاهرة قليلاً ثم يعود الدوران
      resumeTimer = setTimeout(hide, 4500);
    });
    op.addEventListener("focus", () => show(op, true));
    op.addEventListener("blur", () => (resumeTimer = setTimeout(hide, 200)));
  }
  document.addEventListener("click", (e) => {
    if (held && !e.target.closest(".op")) {
      clearTimeout(resumeTimer);
      hide();
    }
  });

  // جولة تلقائية هادئة: ميزة كل بضع ثوانٍ، ثم يعود شعار «وصل»
  if (!reduced) {
    setInterval(() => {
      if (held || orbit.classList.contains("paused") || document.hidden) return;
      if (active) return hide();
      show(ops[tourIndex++ % ops.length], false);
    }, 2800);
  }

  // ميل خفيف مع المؤشر (الكمبيوتر فقط)
  const art = orbit.closest(".home-art");
  if (art && !reduced && matchMedia("(hover: hover) and (pointer: fine)").matches) {
    let frame = 0;
    art.addEventListener("pointermove", (e) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = orbit.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        orbit.style.setProperty("--tx", (y * -8).toFixed(2) + "deg");
        orbit.style.setProperty("--ty", (x * 8).toFixed(2) + "deg");
      });
    });
    art.addEventListener("pointerleave", () => {
      orbit.style.setProperty("--tx", "0deg");
      orbit.style.setProperty("--ty", "0deg");
    });
  }
}
for (const b of document.querySelectorAll("[data-theme-toggle]")) {
  b.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    try {
      localStorage.setItem("wasl:theme", next);
    } catch {}
  });
}

window.addEventListener("beforeunload", () => state.es?.close());

for (const el of document.querySelectorAll(".bar .ctrl[title]")) setTip(el, el.title);


route();
