// حلقتي — منطق الواجهة واتصالات WebRTC (شبكة نظير-لنظير بين كل المشاركين)
"use strict";

const ICE_CONFIG = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};
const CODE_RE = /[a-z]{3}-[a-z]{4}-[a-z]{3}/;
const COLORS = ["#1a73e8", "#34a853", "#e37400", "#d93025", "#a142f4", "#12a4af", "#c5221f", "#188038"];

const $ = (id) => document.getElementById(id);

const state = {
  code: null,
  name: "",
  myId: null,
  stream: null, // الكاميرا والميكروفون
  screenStream: null,
  micOn: true,
  camOn: true,
  hand: false,
  es: null,
  peers: new Map(), // id -> { id, name, pc, stream, pendingIce, mic, cam, hand, screen, tile }
  localTile: null,
  joinedAt: 0,
  audioCtx: null,
  meters: new Map(), // tile -> analyser
};

/* ---------- أدوات عامة ---------- */

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 2600);
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

function meetingLink() {
  return `${location.origin}/${state.code}`;
}

/* ---------- التنقل ---------- */

function route() {
  const code = parseCode(location.pathname.slice(1));
  if (code && location.pathname.slice(1) === code) {
    state.code = code;
    openLobby();
  } else {
    stopMedia();
    show("home");
  }
}

function goTo(code) {
  history.pushState({}, "", code ? `/${code}` : "/");
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
    $("lobbyError").textContent = "لم نتمكن من الوصول للكاميرا أو الميكروفون. يمكنك الانضمام للمشاهدة فقط.";
  }
  $("nameInput").focus();
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
  if (!state.myId) return;
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
  localStorage.setItem("halaqati:name", state.name);

  try {
    state.audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    state.audioCtx.resume();
  } catch {
    state.audioCtx = null;
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
      $("lobbyError").textContent = "تعذر الاتصال بالخادم، أو أن الاجتماع ممتلئ.";
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
      if (data.hand && !peer.hand) toast(`✋ ${data.name} رفع يده`);
      Object.assign(peer, {
        name: String(data.name || peer.name).slice(0, 40),
        mic: !!data.mic,
        cam: !!data.cam,
        hand: !!data.hand,
        screen: !!data.screen,
      });
      updatePeerTile(peer);
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
    mic: true, cam: false, hand: false, screen: false,
    tile: null,
  };
  state.peers.set(id, peer);
  peer.tile = createTile(peer.name, false);
  updatePeerTile(peer);

  pc.ontrack = (e) => {
    peer.stream = new MediaStream([...peer.stream.getTracks().filter((t) => t.kind !== e.track.kind), e.track]);
    const video = peer.tile.querySelector("video");
    video.srcObject = peer.stream;
    video.play().catch(() => {});
    if (e.track.kind === "audio") watchLevel(peer.stream, peer.tile);
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

function createTile(name, isLocal) {
  const tile = document.createElement("div");
  tile.className = "tile" + (isLocal ? " local" : "");
  tile.innerHTML = `
    <video autoplay playsinline ${isLocal ? "muted" : ""}></video>
    <div class="avatar"></div>
    <div class="badges"></div>
    <div class="name"></div>`;
  $("grid").appendChild(tile);
  return tile;
}

function paintTile(tile, { name, mic, cam, hand, screen }) {
  tile.querySelector(".name").textContent = name;
  const avatar = tile.querySelector(".avatar");
  avatar.textContent = initial(name);
  avatar.style.background = colorFor(name.replace(" (أنت)", ""));
  tile.classList.toggle("cam-off", !cam && !screen);
  tile.classList.toggle("screen", screen);
  const badges = [];
  if (hand) badges.push("✋");
  if (!mic) badges.push("🔇");
  tile.querySelector(".badges").innerHTML = badges.map((b) => `<span>${b}</span>`).join("");
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
  const n = $("grid").children.length;
  const narrow = window.innerWidth < 640;
  const cols = narrow ? (n <= 2 ? 1 : 2) : n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  $("grid").style.setProperty("--cols", cols);
  $("peopleCount").textContent = state.peers.size + 1;
}
window.addEventListener("resize", layoutGrid);

function floatReaction(tile, emoji) {
  if (!tile || !["👍", "👏", "😂", "❤️", "🎉", "😮"].includes(emoji)) return;
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
setInterval(() => {
  for (const [tile, analyser] of state.meters) {
    analyser.getByteTimeDomainData(levelBuf);
    let sum = 0;
    for (const v of levelBuf) sum += (v - 128) ** 2;
    const muted = tile === state.localTile ? !state.micOn : tile.querySelector(".badges").textContent.includes("🔇");
    tile.classList.toggle("speaking", !muted && Math.sqrt(sum / levelBuf.length) > 6);
  }
}, 200);

/* ---------- غرفة الاجتماع ---------- */

function enterRoom() {
  state.joinedAt = Date.now();
  $("joinNowBtn").disabled = false;
  show("room");
  $("roomCode").textContent = state.code;
  $("grid").innerHTML = "";
  $("messages").innerHTML = '<p class="muted small center">الرسائل تظهر فقط للموجودين في الاجتماع</p>';
  state.localTile = createTile(state.name, true);
  watchLevel(state.stream, state.localTile);
  updateLocalTile();
  syncToggleButtons();
  layoutGrid();
  renderPeople();
  if (state.peers.size === 0) toast("أنت أول الحاضرين — شارك الرابط لدعوة الآخرين");
}

function leave(navigate = true) {
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

$("copyBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(meetingLink());
    toast("تم نسخ رابط الاجتماع");
  } catch {
    prompt("انسخ رابط الاجتماع:", meetingLink());
  }
});

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

function addMessage(author, text) {
  if (!text.trim()) return;
  const box = $("messages");
  const msg = document.createElement("div");
  msg.className = "msg";
  msg.innerHTML = "<div><b></b><time></time></div><p></p>";
  msg.querySelector("b").textContent = author;
  msg.querySelector("time").textContent = timeNow();
  msg.querySelector("p").textContent = text;
  box.appendChild(msg);
  box.scrollTop = box.scrollHeight;
  const chatVisible = !$("panel").hidden && !document.querySelector('[data-pane="chat"]').hidden;
  if (!chatVisible && author !== "أنت") {
    $("chatDot").hidden = false;
    toast(`💬 ${author}: ${text.slice(0, 60)}`);
  }
}

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  addMessage("أنت", text);
  signal("chat", { text });
  $("chatInput").value = "";
});

function renderPeople() {
  const list = $("people");
  list.innerHTML = "";
  const everyone = [{ ...myStatus(), name: `${state.name} (أنت)` }, ...state.peers.values()];
  for (const p of everyone) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="mini"></span><span class="pname"></span><span class="icons"></span>';
    li.querySelector(".mini").textContent = initial(p.name);
    li.querySelector(".mini").style.background = colorFor(p.name.replace(" (أنت)", ""));
    li.querySelector(".pname").textContent = p.name;
    li.querySelector(".icons").textContent = `${p.hand ? "✋ " : ""}${p.mic ? "🎙️" : "🔇"}`;
    list.appendChild(li);
  }
  $("peopleCount").textContent = everyone.length;
}

window.addEventListener("beforeunload", () => state.es?.close());

route();
