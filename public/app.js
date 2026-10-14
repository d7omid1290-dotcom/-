// حلقتي — منطق الواجهة واتصالات WebRTC (شبكة نظير-لنظير بين كل المشاركين)
"use strict";

const ICE_CONFIG = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};
const CODE_RE = /[a-z]{3}-[a-z]{4}-[a-z]{3}/;
const COLORS = ["#0d4f3c", "#146a51", "#b8892b", "#8a5a2b", "#2f6f8f", "#6b4c9a", "#a8473d", "#3d7a5c"];
const REACTIONS = ["👍", "👏", "🤲", "❤️", "🌟", "✅"];

const $ = (id) => document.getElementById(id);

// وضع العرض: ملف HTML واحد يعمل بدون خادم (لا يمكن للآخرين الانضمام)
const DEMO = !!window.HALAQATI_DEMO;

const state = {
  code: null,
  name: "",
  myId: null,
  stream: null, // الكاميرا والميكروفون
  screenStream: null,
  micOn: true,
  camOn: true,
  hand: false,
  role: "student", // student | teacher
  pinned: null, // معرّف البلاطة المثبتة، أو "none" لإلغاء التثبيت التلقائي
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

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 2600);
}

function icon(name, cls = "") {
  return `<svg class="i ${cls}"><use href="#i-${name}"/></svg>`;
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

function initial(name) {
  return [...(name.trim() || "؟")][0].toUpperCase();
}

function genCode() {
  const letters = "abcdefghijkmnopqrstuvwxyz";
  const part = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => letters[b % letters.length]).join("");
  return `${part(3)}-${part(4)}-${part(3)}`;
}

function parseCode(input) {
  const s = String(input).trim().toLowerCase();
  const m = s.match(CODE_RE);
  if (m) return m[0];
  const plain = s.replace(/[^a-z]/g, "");
  if (plain.length === 10) return `${plain.slice(0, 3)}-${plain.slice(3, 7)}-${plain.slice(7)}`;
  return null;
}

function timeNow() {
  return new Date().toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
}

function show(viewId) {
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== viewId;
}

function linkFor(code) {
  return DEMO ? code : `${location.origin}/${code}`;
}

function meetingLink() {
  return linkFor(state.code);
}

/* ---------- التنقل ---------- */

function route() {
  const path = DEMO ? state.code || "" : location.pathname.slice(1);
  const code = parseCode(path);
  if (code && path === code) {
    state.code = code;
    openLobby();
  } else {
    stopMedia();
    show("home");
    renderUpcoming();
  }
}

function goTo(code) {
  if (DEMO) state.code = code;
  else history.pushState({}, "", code ? `/${code}` : "/");
  route();
}

window.addEventListener("popstate", () => {
  if (state.es) leave(false);
  route();
});

/* ---------- الصفحة الرئيسية ---------- */

$("newMeetingBtn").addEventListener("click", () => goTo(genCode()));

$("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = parseCode($("joinCode").value);
  if (!code) {
    $("homeError").textContent = "رمز غير صالح. الشكل الصحيح مثل: abc-defg-hij";
    return;
  }
  $("homeError").textContent = "";
  goTo(code);
});

setInterval(() => {
  $("homeClock").textContent = timeNow();
  $("roomClock").textContent = timeNow();
}, 1000);
$("homeClock").textContent = $("roomClock").textContent = timeNow();

/* ---------- الوسائط ---------- */

async function getMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("المتصفح لا يدعم الكاميرا هنا. افتح الموقع عبر HTTPS أو localhost.");
  }
  const attempts = [{ video: { width: 1280, height: 720 }, audio: true }, { audio: true }, { video: true }];
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
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
    $(id).title = state.micOn ? "كتم الميكروفون" : "تشغيل الميكروفون";
  }
  for (const id of ["lobbyCam", "camBtn"]) {
    $(id).classList.toggle("off", !state.camOn);
    $(id).title = state.camOn ? "إيقاف الكاميرا" : "تشغيل الكاميرا";
  }
  $("previewOff").hidden = state.camOn && !!camTrack();
  $("shareBtn").classList.toggle("on", !!state.screenStream);
  $("handBtn").classList.toggle("on", state.hand);
}

function setMic(on) {
  if (on && !micTrack()) return toast("لا يوجد ميكروفون متاح");
  state.micOn = on;
  if (micTrack()) micTrack().enabled = on;
  syncToggleButtons();
  updateLocalTile();
  broadcastState();
}

function setCam(on) {
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
  const role = localStorage.getItem("halaqati:role") === "teacher" ? "teacher" : "student";
  document.querySelector(`input[name="role"][value="${role}"]`).checked = true;
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
  $("nameInput").focus();
}

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
      isAudio ? { audio: { deviceId: { exact: deviceId } } } : { video: { deviceId: { exact: deviceId }, width: 1280, height: 720 } }
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

function signal(type, data, to) {
  if (!state.myId || DEMO) return;
  fetch(`/api/rooms/${state.code}/signal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: state.myId, to, type, data }),
  }).catch(() => {});
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
  state.role = document.querySelector('input[name="role"]:checked')?.value === "teacher" ? "teacher" : "student";
  try {
    localStorage.setItem("halaqati:name", state.name);
    localStorage.setItem("halaqati:role", state.role);
  } catch {}
  ensureAudio();

  if (DEMO) {
    state.myId = "demo";
    enterRoom();
    toast("وضع العرض: انشر الموقع حتى ينضم الطلاب");
    return;
  }

  $("joinNowBtn").disabled = true;
  const es = new EventSource(`/api/rooms/${state.code}/events?name=${encodeURIComponent(state.name)}`);
  state.es = es;

  es.addEventListener("welcome", (e) => {
    const { id, peers } = JSON.parse(e.data);
    // عند إعادة الاتصال التلقائي نبدأ من جديد
    for (const p of [...state.peers.values()]) removePeer(p.id, true);
    state.myId = id;
    if (!state.joinedAt) enterRoom();
    for (const p of peers) createPeer(p.id, p.name, true);
    broadcastState();
  });

  es.addEventListener("peer-joined", (e) => {
    const { id, name } = JSON.parse(e.data);
    createPeer(id, name, false);
    broadcastState(id);
    toast(`انضم ${name}`);
  });

  es.addEventListener("peer-left", (e) => {
    const { id } = JSON.parse(e.data);
    const p = state.peers.get(id);
    if (p) toast(`غادر ${p.name}`);
    removePeer(id);
  });

  es.addEventListener("signal", (e) => handleSignal(JSON.parse(e.data)));

  es.onerror = () => {
    if (!state.joinedAt) {
      es.close();
      state.es = null;
      $("joinNowBtn").disabled = false;
      $("lobbyError").textContent = "تعذر الاتصال بالخادم، أو أن الحلقة ممتلئة.";
    } else {
      toast("انقطع الاتصال… جارٍ إعادة المحاولة");
    }
  };
}

async function handleSignal({ from, type, data }) {
  let peer = state.peers.get(from);
  switch (type) {
    case "offer":
      peer ||= createPeer(from, "ضيف", false);
      await onOffer(peer, data);
      break;
    case "answer":
      if (peer) {
        await peer.pc.setRemoteDescription(data);
        flushIce(peer);
      }
      break;
    case "ice":
      if (!peer) return;
      if (peer.pc.remoteDescription) peer.pc.addIceCandidate(data).catch(() => {});
      else peer.pendingIce.push(data);
      break;
    case "state":
      if (!peer) return;
      if (data.hand && !peer.hand) toast(`✋ ${data.name} يرفع يده`);
      Object.assign(peer, {
        name: String(data.name || peer.name).slice(0, 40),
        mic: !!data.mic,
        cam: !!data.cam,
        hand: !!data.hand,
        screen: !!data.screen,
        recording: !!data.recording,
        role: data.role === "teacher" ? "teacher" : "student",
      });
      updatePeerTile(peer);
      layoutGrid();
      updateRecBanner();
      renderPeople();
      break;
    case "chat":
      if (peer) addMessage(peer.name, String(data.text || "").slice(0, 500));
      break;
    case "reaction":
      if (peer) floatReaction(peer.tile, data.emoji);
      break;
  }
}

/* ---------- اتصالات WebRTC ---------- */

function createPeer(id, name, initiator) {
  if (state.peers.has(id)) return state.peers.get(id);
  const pc = new RTCPeerConnection(ICE_CONFIG);
  const peer = {
    id, name, pc, initiator,
    stream: new MediaStream(),
    pendingIce: [],
    mic: true, cam: false, hand: false, screen: false, role: "student",
    tile: null,
  };
  state.peers.set(id, peer);
  peer.tile = createTile(id, false);
  updatePeerTile(peer);

  pc.ontrack = (e) => {
    peer.stream = new MediaStream([...peer.stream.getTracks().filter((t) => t.kind !== e.track.kind), e.track]);
    const video = peer.tile.querySelector("video");
    video.srcObject = peer.stream;
    video.play().catch(() => {});
    if (e.track.kind === "audio") {
      watchLevel(peer.stream, peer.tile);
      addToRecording(peer.stream);
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) signal("ice", e.candidate, id);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" && peer.initiator) makeOffer(peer, true);
  };

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
    const offer = await peer.pc.createOffer({ iceRestart });
    await peer.pc.setLocalDescription(offer);
    signal("offer", peer.pc.localDescription, peer.id);
  } catch (err) {
    console.error("offer failed", err);
  }
}

async function onOffer(peer, sdp) {
  const { pc } = peer;
  await pc.setRemoteDescription(sdp);
  for (const t of pc.getTransceivers()) {
    const kind = t.receiver.track.kind;
    t.direction = "sendrecv";
    await t.sender.replaceTrack(outgoingTrack(kind));
  }
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signal("answer", pc.localDescription, peer.id);
  flushIce(peer);
}

function flushIce(peer) {
  for (const c of peer.pendingIce.splice(0)) peer.pc.addIceCandidate(c).catch(() => {});
}

function removePeer(id, silent) {
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.pc.close();
  state.meters.delete(peer.tile);
  peer.tile.remove();
  state.peers.delete(id);
  if (!silent) {
    renderPeople();
    layoutGrid();
    updateRecBanner();
  }
}

function replaceOutgoingVideo() {
  const track = outgoingTrack("video");
  for (const { pc } of state.peers.values()) {
    const t = pc.getTransceivers().find((x) => x.receiver.track.kind === "video");
    t?.sender.replaceTrack(track).catch(() => {});
  }
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
    <div class="label">${icon("mic-off", "mic-off")}<span class="name"></span><span class="role-tag" hidden>المعلّم</span></div>`;
  tile.querySelector(".pin-btn").addEventListener("click", () => togglePin(id));
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
  tile.querySelector(".role-tag").hidden = role !== "teacher";
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
  if (state.role !== "teacher" && state.peers.size >= 2) {
    const teacher = [...state.peers.values()].find((p) => p.role === "teacher");
    if (teacher) return teacher.id;
  }
  return null;
}

function updatePeerTile(peer) {
  paintTile(peer.tile, peer);
}

function updateLocalTile() {
  if (!state.localTile) return;
  const s = myStatus();
  paintTile(state.localTile, { ...s, name: `${state.name} (أنت)` });
  const video = state.localTile.querySelector("video");
  video.srcObject = state.screenStream || state.stream;
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
  if (pin) {
    grid.style.setProperty("--rows", Math.min(Math.max(n - 1, 1), 4));
  } else {
    const narrow = window.innerWidth < 640;
    const cols = narrow ? (n <= 2 ? 1 : 2) : n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    grid.style.setProperty("--cols", cols);
  }
  $("peopleCount").textContent = state.peers.size + 1;
}
window.addEventListener("resize", layoutGrid);

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
  if (!state.audioCtx || !stream.getAudioTracks().length) return;
  try {
    const src = state.audioCtx.createMediaStreamSource(stream);
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    state.meters.set(tile, analyser);
  } catch {}
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
  $("grid").innerHTML = "";
  $("messages").innerHTML = '<p class="hint">الرسائل تظهر فقط للحاضرين في الحلقة الآن</p>';
  state.pinned = null;
  state.localTile = createTile("local", true);
  watchLevel(state.stream, state.localTile);
  updateLocalTile();
  syncToggleButtons();
  layoutGrid();
  renderPeople();
  if (state.peers.size === 0) toast("أنت أول الحاضرين — شارك رابط الحلقة لدعوة الطلاب");
}

function leave(navigate = true) {
  if (state.joinedAt) $("leftSummary").textContent = `مدة حضورك: ${formatDuration(Date.now() - state.joinedAt)}`;
  stopRecording();
  state.es?.close();
  state.es = null;
  for (const id of [...state.peers.keys()]) removePeer(id, true);
  state.meters.clear();
  stopMedia();
  state.myId = null;
  state.joinedAt = 0;
  state.hand = false;
  state.localTile = null;
  $("panel").hidden = true;
  $("recBanner").hidden = true;
  if (navigate) show("left");
}

$("micBtn").addEventListener("click", () => setMic(!state.micOn));
$("camBtn").addEventListener("click", () => setCam(!state.camOn));
$("leaveBtn").addEventListener("click", () => leave());
$("rejoinBtn").addEventListener("click", () => openLobby());
$("goHomeBtn").addEventListener("click", () => goTo(null));

$("handBtn").addEventListener("click", () => {
  state.hand = !state.hand;
  syncToggleButtons();
  updateLocalTile();
  broadcastState();
  renderPeople();
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

function addMessage(author, text, mine = false) {
  if (!text.trim()) return;
  const box = $("messages");
  const msg = document.createElement("div");
  msg.className = "msg" + (mine ? " mine" : "");
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
  if (!text) return;
  addMessage("أنت", text, true);
  signal("chat", { text });
  $("chatInput").value = "";
});

function renderPeople() {
  const list = $("people");
  list.innerHTML = "";
  const everyone = [{ ...myStatus(), id: "local", name: `${state.name} (أنت)` }, ...state.peers.values()];
  // المعلّم أولاً، ثم من رفع يده
  everyone.sort((a, b) => (b.role === "teacher") - (a.role === "teacher") || b.hand - a.hand);
  const pin = effectivePin();
  for (const p of everyone) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="mini"></span>
      <span class="pname"><span class="pn"></span><small${p.role === "teacher" ? "" : " hidden"}>المعلّم</small></span>
      <span class="icons">${p.hand ? icon("hand", "hand") : ""}${p.mic ? icon("mic") : icon("mic-off", "muted-i")}</span>
      <button class="icon-btn${pin === p.id ? " active" : ""}" type="button" title="${pin === p.id ? "إلغاء التثبيت" : "تثبيت في الوسط"}">${icon("pin")}</button>`;
    li.querySelector(".mini").textContent = initial(p.name);
    li.querySelector(".mini").style.background = colorFor(p.name.replace(" (أنت)", ""));
    li.querySelector(".pn").textContent = p.name;
    li.querySelector("button").addEventListener("click", () => togglePin(p.id));
    list.appendChild(li);
  }
  $("peopleCount").textContent = everyone.length;
}

/* ---------- تسجيل الاجتماع ---------- */

function updateRecBanner() {
  const others = [...state.peers.values()].filter((p) => p.recording).map((p) => p.name);
  const me = !!state.recorder;
  $("recBanner").hidden = !me && others.length === 0;
  $("recText").textContent = me
    ? "أنت تسجّل هذه الحلقة"
    : `يتم تسجيل هذه الحلقة بواسطة ${others.join("، ")}`;
  $("recBtn").classList.toggle("recording", me);
  $("recBtn").title = me ? "إيقاف التسجيل" : "تسجيل الحلقة";
}

function addToRecording(stream) {
  if (!state.recDest || !stream.getAudioTracks().length) return;
  try {
    state.audioCtx.createMediaStreamSource(stream).connect(state.recDest);
  } catch {}
}

function pickMimeType() {
  const types = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

async function startRecording() {
  if (!window.MediaRecorder || !navigator.mediaDevices?.getDisplayMedia || !state.audioCtx) {
    return toast("التسجيل غير مدعوم في هذا المتصفح. جرّب Chrome أو Edge على الكمبيوتر");
  }
  let display;
  try {
    // نلتقط تبويب الاجتماع نفسه (الصورة) ونمزج كل الأصوات بأنفسنا
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser", frameRate: 30 },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
    });
  } catch {
    return;
  }
  state.recDest = state.audioCtx.createMediaStreamDestination();
  addToRecording(state.stream);
  for (const p of state.peers.values()) addToRecording(p.stream);

  const mixed = new MediaStream([...display.getVideoTracks(), ...state.recDest.stream.getAudioTracks()]);
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(mixed, mimeType ? { mimeType } : undefined);
  const chunks = [];
  const startedAt = new Date();
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    display.getTracks().forEach((t) => t.stop());
    const type = recorder.mimeType || "video/webm";
    const blob = new Blob(chunks, { type });
    const ext = type.includes("mp4") ? "mp4" : "webm";
    const stamp = startedAt.toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadBlob(blob, `halaqati-${state.code || "meeting"}-${stamp}.${ext}`);
    toast("تم حفظ التسجيل على جهازك");
  };
  display.getVideoTracks()[0].onended = stopRecording;
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
      <button class="icon-btn" data-del aria-label="حذف">🗑️</button>`;
    li.querySelector("b").textContent = m.title;
    li.querySelector("span").textContent = live ? "يبدأ الآن" : formatWhen(m.start);
    li.querySelector("span").classList.toggle("soon", live);
    li.querySelector("[data-join]").addEventListener("click", () => goTo(m.code));
    li.querySelector("[data-del]").addEventListener("click", () => {
      saveScheduled(loadScheduled().filter((x) => x.code !== m.code));
      renderUpcoming();
    });
    ul.appendChild(li);
  }
}

function toCalDate(ts) {
  return new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function inviteText(m) {
  return `أنت مدعو لحضور حلقة تحفيظ عبر منصة حلقتي — مدرسة جامع الصحابة\n\n${m.title}\n${formatWhen(m.start)} (${m.duration} دقيقة)\n\nرابط الانضمام:\n${linkFor(m.code)}`;
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
  $("settingsModal").hidden = true;
});

$("scheduleForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const start = new Date($("sStart").value).getTime();
  if (!start || start < Date.now() - 60000) {
    $("scheduleError").textContent = "اختر موعداً في المستقبل";
    return;
  }
  const m = {
    code: genCode(),
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

window.addEventListener("beforeunload", () => state.es?.close());

// إن لم يوجد ملف الشعار logo.png نعرض الشعار المرسوم
for (const img of document.querySelectorAll(".logo-img")) {
  const fail = () => img.parentElement.classList.add("no-img");
  if (img.complete && !img.naturalWidth) fail();
  else img.addEventListener("error", fail);
}

route();
