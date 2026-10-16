// خادم وصل: يقدّم الواجهة ويعمل كخادم إشارة (signaling) لاتصالات WebRTC
// بدون أي اعتماديات خارجية — Node.js فقط.
const http = require("http");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
// رمز الحلقة: عشوائي مثل abc-defg-hij، أو اسم ثابت يختاره المعلّم للترم مثل sahaba-juz-amma
// (حروف إنجليزية صغيرة وأرقام وشرطات، ولا ينتهي بـ -r رقم حتى لا يختلط بالغرف الفرعية)
const SLUG = "[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])";
const ROOM_RE = new RegExp(`^(?!.*-r[1-9]$)(?!(?:api|healthz)$)${SLUG}$`);
// الغرف الفرعية داخل الحلقة: <الرمز>-r1 … -r9
const API_ROOM_RE = new RegExp(`^(?!.*-r[1-9]-r[1-9]$)${SLUG}$`);
const MAX_BREAKOUTS = 9;

// مفتاح المعلّم: توقيع سرّي لرمز الغرفة. من يملكه هو منشئ الغرفة (المعلّم).
// ضع WASL_SECRET في متغيرات البيئة حتى تبقى مفاتيح المعلّمين صالحة بعد إعادة تشغيل الخادم.
const SECRET = process.env.WASL_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.WASL_SECRET) {
  console.warn("تنبيه: WASL_SECRET غير مضبوط — مفاتيح المعلّمين ستتغير عند إعادة تشغيل الخادم");
}
const hostKey = (code) => crypto.createHmac("sha256", SECRET).update(`host:${code}`).digest("base64url").slice(0, 24);
function isHostKey(code, key) {
  const expected = Buffer.from(hostKey(code));
  const given = Buffer.from(String(key || ""));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
const STAFF = new Set(["teacher", "admin"]);

// خوادم الاتصال (ICE): STUN افتراضياً، ويمكن إضافة خادم TURN من متغيرات البيئة دون تعديل الكود
// TURN_URLS مثل: turn:example.com:3478,turns:example.com:443?transport=tcp
function staticIceServers() {
  const list = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  const urls = (process.env.TURN_URLS || "").split(",").map((u) => u.trim()).filter(Boolean);
  if (urls.length) {
    list.push({ urls, username: process.env.TURN_USERNAME || "", credential: process.env.TURN_CREDENTIAL || "" });
  }
  return list;
}

// خوادم TURN من Cloudflare (مجانية حتى 1000GB شهرياً): ضع CF_TURN_KEY_ID و CF_TURN_API_TOKEN
// في متغيرات البيئة، فيولّد الخادم بيانات دخول مؤقتة ويعطيها للمتصفحات. المفتاح نفسه لا يغادر الخادم.
const CF_TURN = process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN;
const CF_TTL = 86400;
let cfCache = { at: 0, servers: null };
async function iceServers() {
  if (!CF_TURN) return staticIceServers();
  // نعيد استخدام بيانات الدخول نصف مدتها ثم نجدّدها
  if (cfCache.servers && Date.now() - cfCache.at < (CF_TTL / 2) * 1000) return cfCache.servers;
  // بعد فشل نتوقف دقيقة قبل المحاولة التالية حتى لا يتأخر دخول أحد
  if (Date.now() - (cfCache.failedAt || 0) < 60000) return cfCache.servers || staticIceServers();
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: CF_TTL }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`cloudflare ${r.status}`);
    const { iceServers: list } = await r.json();
    // بعض المتصفحات تمنع المنفذ 53، فنحذف عناوينه
    const servers = (Array.isArray(list) ? list : [list]).map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }));
    cfCache = { at: Date.now(), servers };
    return servers;
  } catch (err) {
    console.warn("تعذر جلب خوادم TURN من Cloudflare:", err.message);
    cfCache.failedAt = Date.now();
    return cfCache.servers || staticIceServers();
  }
}
const MAX_PEERS = 25;
const MAX_BODY = 64 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

// roomId -> Map(peerId -> { id, cid, name, role, push })
const rooms = new Map();
// الحلقة الرئيسية -> حالة الغرف الفرعية { open, rooms: [{ id, name, members: [cid], names: [name] }] }
const breakouts = new Map();
// الحلقة الرئيسية -> المشرفون الذين عيّنهم المعلّم (بمعرّفاتهم الثابتة)
const admins = new Map();
// الحلقة الرئيسية -> أدوات الإدارة { locked, chatOff, seen: Set(cid), kicked: Map(cid -> الاسم) للممنوعين من العودة }
const controls = new Map();
const controlsOf = (main) => {
  let c = controls.get(main);
  if (!c) {
    c = { locked: false, chatOff: false, micLock: false, camLock: false, micAllow: new Set(), camAllow: new Set(), seen: new Set(), kicked: new Map() };
    controls.set(main, c);
  }
  return c;
};
// micLock/camLock: الطلاب لا يفتحون المايك أو الكاميرا إلا بإذن (micAllow/camAllow بالمعرّف الثابت)
const publicControls = (main) => {
  const c = controls.get(main);
  return {
    locked: !!c?.locked,
    chatOff: !!c?.chatOff,
    micLock: !!c?.micLock,
    camLock: !!c?.camLock,
    micAllow: c ? [...c.micAllow] : [],
    camAllow: c ? [...c.camAllow] : [],
    banned: c ? [...c.kicked].map(([cid, name]) => ({ cid, name })) : [],
  };
};

const mainOf = (roomId) => roomId.replace(/-r[1-9]$/, "");

// كل الغرف التابعة لحلقة واحدة: الرئيسية وغرفها الفرعية
// فهرس سريع: كل حلقة رئيسية ← معرّفات غرفها الموجودة (حتى لا نمر على كل غرف الموقع عند كل حدث)
const families = new Map();
function addRoom(roomId, room) {
  rooms.set(roomId, room);
  const main = mainOf(roomId);
  if (!families.has(main)) families.set(main, new Set());
  families.get(main).add(roomId);
}
function deleteRoom(roomId) {
  rooms.delete(roomId);
  const main = mainOf(roomId);
  const set = families.get(main);
  set?.delete(roomId);
  if (set && !set.size) families.delete(main);
}
function familyRooms(main) {
  return [...(families.get(main) || [])].map((id) => rooms.get(id)).filter(Boolean);
}

function broadcastFamily(main, event, data) {
  for (const room of familyRooms(main)) broadcast(room, event, data);
}

// من في كل غرفة من غرف الحلقة الآن — ليرى المعلّم والطلاب أماكن الجميع
function presenceOf(main) {
  const out = {};
  for (const id of families.get(main) || []) {
    const room = rooms.get(id);
    if (!room) continue;
    out[id === main ? "main" : id.slice(main.length + 1)] = [...room.values()].map((p) => ({ cid: p.cid, name: p.name, role: p.role }));
  }
  return out;
}
// نجمع التغييرات المتقاربة (دخول عشرين طالباً معاً) في رسالة واحدة بدل عشرين
const presenceTimers = new Map();
function sendPresence(main) {
  if (presenceTimers.has(main)) return;
  presenceTimers.set(
    main,
    setTimeout(() => {
      presenceTimers.delete(main);
      broadcastFamily(main, "presence", presenceOf(main));
    }, 120)
  );
}

// إرسال حدث لمشارك: عبر قناة SSE، أو يُحفظ في طابوره إن كان يتصل بالاستطلاع (polling)
function send(peer, event, data) {
  peer.push(event, JSON.stringify(data));
}

function broadcast(room, event, data, exceptId) {
  for (const peer of room.values()) {
    if (peer.id !== exceptId) send(peer, event, data);
  }
}

// المرسل الحقيقي: معرّفه ومفتاحه السرّي معاً
function senderOf(roomId, msg) {
  const peer = rooms.get(roomId)?.get(String(msg.from || ""));
  if (!peer) return null;
  const a = Buffer.from(String(msg.token || ""));
  const b = Buffer.from(peer.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? peer : null;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function cleanName(name) {
  return String(name || "").trim().slice(0, 40) || "ضيف";
}

// إضافة مشارك للغرفة — مشترك بين طريقتي الاتصال. يرجع null إن كانت الغرفة ممتلئة
// استئناف الجلسة: إن انقطعت قناة الأحداث لحظياً (شبكة الجوال أو الوسيط) يعود المشارك بنفس هويته
// خلال مهلة قصيرة، فلا تُهدم اتصالات الصوت والصورة عند الجميع ولا تضيع الرسائل التي فاتته
const GRACE_MS = 25000;
function resumePeer(roomId, url, push) {
  const peer = rooms.get(roomId)?.get(String(url.searchParams.get("rid") || ""));
  const given = Buffer.from(String(url.searchParams.get("rtoken") || ""));
  if (!peer || given.length !== peer.token.length || !crypto.timingSafeEqual(given, Buffer.from(peer.token))) return null;
  clearTimeout(peer.graceTimer);
  peer.graceTimer = 0;
  const backlog = peer.backlog || [];
  peer.backlog = null;
  peer.push = push;
  const main = mainOf(roomId);
  const room = rooms.get(roomId);
  const peers = [...room.values()].filter((p) => p.id !== peer.id).map((p) => ({ id: p.id, cid: p.cid, name: p.name, role: p.role }));
  send(peer, "welcome", { id: peer.id, token: peer.token, role: peer.role, peers, breakout: breakouts.get(main) || null, controls: publicControls(main), resumed: true });
  for (const [event, data] of backlog) push(event, data);
  return peer;
}

// انقطعت قناة المشارك: نحفظ ما يصله في طابور ونمهله، فإن لم يعد خلال المهلة نزيله
function startGrace(roomId, peer) {
  if (!rooms.get(roomId)?.has(peer.id) || peer.graceTimer) return;
  peer.backlog = [];
  peer.push = (event, data) => peer.backlog.length < 500 && peer.backlog.push([event, data]);
  peer.end = () => {};
  peer.graceTimer = setTimeout(() => removePeer(roomId, peer.id), GRACE_MS);
}

function addPeer(roomId, url, push) {
  const resumed = resumePeer(roomId, url, push);
  if (resumed) return resumed;
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    addRoom(roomId, room);
  }
  if (room.size >= MAX_PEERS) {
    if (room.size === 0) deleteRoom(roomId);
    return null;
  }
  const id = crypto.randomUUID();
  const name = cleanName(url.searchParams.get("name"));
  const cid = String(url.searchParams.get("cid") || id).slice(0, 64);
  // الدور يقرّره الخادم: مفتاح المعلّم ← معلّم، ومن عيّنه المعلّم ← مشرف، والباقي طلاب
  const main = mainOf(roomId);
  const role = isHostKey(main, url.searchParams.get("key")) ? "teacher" : admins.get(main)?.has(cid) ? "admin" : "student";

  const peers = [...room.values()].map((p) => ({ id: p.id, cid: p.cid, name: p.name, role: p.role }));
  // مفتاح سرّي لهذا المشارك وحده: يثبت هويته في كل طلب (المعرّف id يعرفه الجميع)
  const token = crypto.randomBytes(16).toString("hex");
  const peer = { id, cid, name, role, token, push, end: () => {} };
  room.set(id, peer);
  controlsOf(main).seen.add(cid);
  send(peer, "welcome", { id, token, role, peers, breakout: breakouts.get(main) || null, controls: publicControls(main) });
  broadcast(room, "peer-joined", { id, cid, name, role }, id);
  sendPresence(main);
  return peer;
}

function removePeer(roomId, id) {
  const room = rooms.get(roomId);
  const peer = room?.get(id);
  if (!peer) return;
  clearTimeout(peer.graceTimer);
  room.delete(id);
  broadcast(room, "peer-left", { id });
  if (room.size === 0) deleteRoom(roomId);
  // إذا فرغت الحلقة كلها نحذف حالة غرفها
  const main = mainOf(roomId);
  sendPresence(main);
  if (familyRooms(main).length === 0) {
    breakouts.delete(main);
    admins.delete(main);
    controls.delete(main);
  }
}

const isFull = (roomId) => (rooms.get(roomId)?.size || 0) >= MAX_PEERS;
const canResume = (roomId, url) => {
  const peer = rooms.get(roomId)?.get(String(url.searchParams.get("rid") || ""));
  const given = Buffer.from(String(url.searchParams.get("rtoken") || ""));
  return !!peer && given.length === peer.token.length && crypto.timingSafeEqual(given, Buffer.from(peer.token));
};

// سبب رفض الدخول: ممتلئة، أو أُخرج من الحلقة، أو مقفلة أمام القادمين الجدد (المعلّم والمشرفون يدخلون دائماً)
function refuseReason(roomId, url) {
  if (isFull(roomId)) return "room_full";
  const main = mainOf(roomId);
  const c = controls.get(main);
  if (!c) return null;
  const cid = String(url.searchParams.get("cid") || "");
  if (isHostKey(main, url.searchParams.get("key"))) return null;
  if (c.kicked.has(cid)) return "kicked";
  if (c.locked && !c.seen.has(cid) && !admins.get(main)?.has(cid)) return "locked";
  return null;
}

// الطريقة الأولى: قناة أحداث مستمرة (Server-Sent Events)
function handleEvents(req, res, roomId, url) {
  const refused = canResume(roomId, url) ? null : refuseReason(roomId, url);
  if (refused) return json(res, 403, { error: refused });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "identity",
  });
  // حشوة في البداية حتى لا تحبس بعض الوسائط (proxy) الأحداث الصغيرة في ذاكرتها
  res.write(`:${" ".repeat(2048)}\nretry: 3000\n\n`);
  req.socket.setNoDelay(true);
  if (canResume(roomId, url)) detachPoll(String(url.searchParams.get("rid")));
  const push = (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`);
  const peer = addPeer(roomId, url, push);
  peer.end = () => {
    peer.gone = true;
    res.end();
  };
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    // أُخرج أو غادر صراحةً، أو صار متصلاً بقناة أحدث: لا شيء
    if (peer.gone || peer.push !== push) return;
    startGrace(roomId, peer);
  });
}

// الطريقة الاحتياطية: استطلاع طويل (long polling) لمن تحجب شبكته قناة الأحداث.
// أول طلب بدون pid ينشئ المشارك، وكل طلب بعده يستلم الأحداث الجديدة (ack = آخر حدث وصله)
const POLL_HOLD = 25000;
const POLL_EXPIRE = 45000;
const pollers = new Map(); // pid -> { roomId, peer, queue, seq, waiting, expire }

function flushPoll(p) {
  if (!p.waiting || !p.queue.length) return;
  const { res, timer } = p.waiting;
  clearTimeout(timer);
  p.waiting = null;
  json(res, 200, { pid: p.peer.id, events: p.queue });
  if (p.closing) dropPoll(p.peer.id);
}

function expirePoll(p) {
  clearTimeout(p.expire);
  p.expire = setTimeout(() => dropPoll(p.peer.id), POLL_EXPIRE);
}

// فصل جلسة الاستطلاع دون إزالة المشارك (حين يستأنف بقناة أخرى)
function detachPoll(pid) {
  const p = pollers.get(pid);
  if (!p) return;
  pollers.delete(pid);
  clearTimeout(p.expire);
  if (p.waiting) {
    clearTimeout(p.waiting.timer);
    json(p.waiting.res, 410, { error: "gone" });
  }
}

function dropPoll(pid) {
  const p = pollers.get(pid);
  if (!p) return;
  pollers.delete(pid);
  clearTimeout(p.expire);
  if (p.waiting) {
    clearTimeout(p.waiting.timer);
    json(p.waiting.res, 410, { error: "gone" });
  }
  removePeer(p.roomId, pid);
}

function handlePoll(req, res, roomId, url) {
  const pid = url.searchParams.get("pid");
  if (!pid) {
    const refused = canResume(roomId, url) ? null : refuseReason(roomId, url);
    if (refused) return json(res, 403, { error: refused });
    const p = { roomId, queue: [], seq: 0, waiting: null, expire: 0 };
    if (canResume(roomId, url)) detachPoll(String(url.searchParams.get("rid")));
    p.peer = addPeer(roomId, url, (event, data) => {
      p.queue.push({ seq: ++p.seq, event, data });
      flushPoll(p);
    });
    // عند الإخراج: يستلم حدث الإخراج في استطلاعه التالي ثم تُحذف جلسته
    p.peer.end = () => {
      p.closing = true;
      flushPoll(p);
    };
    pollers.set(p.peer.id, p);
    expirePoll(p);
    return json(res, 200, { pid: p.peer.id, events: p.queue });
  }
  const p = pollers.get(pid);
  if (!p || p.roomId !== roomId || url.searchParams.get("token") !== p.peer.token) return json(res, 410, { error: "gone" });
  const ack = Number(url.searchParams.get("ack")) || 0;
  p.queue = p.queue.filter((e) => e.seq > ack);
  expirePoll(p);
  if (p.waiting) {
    clearTimeout(p.waiting.timer);
    json(p.waiting.res, 200, { pid, events: [] });
  }
  if (p.queue.length) {
    json(res, 200, { pid, events: p.queue });
    if (p.closing) dropPoll(pid);
    return;
  }
  const timer = setTimeout(() => {
    p.waiting = null;
    json(res, 200, { pid, events: [] });
  }, POLL_HOLD);
  p.waiting = { res, timer };
  req.on("close", () => {
    if (p.waiting?.res === res) {
      clearTimeout(timer);
      p.waiting = null;
    }
  });
}

function readJson(req, res, done) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) req.destroy();
  });
  req.on("end", () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return json(res, 400, { error: "bad_json" });
    }
    if (!msg || typeof msg !== "object") return json(res, 400, { error: "bad_json" });
    done(msg);
  });
}

// أوامر المعلّم للغرف الفرعية: فتح، إغلاق، رسالة لكل الغرف
function handleBreakout(req, res, roomId) {
  readJson(req, res, (msg) => {
    const sender = senderOf(roomId, msg);
    if (!sender) return json(res, 404, { error: "not_in_room" });
    if (!STAFF.has(sender.role)) return json(res, 403, { error: "teacher_only" });
    const main = mainOf(roomId);

    if (msg.action === "open") {
      const list = Array.isArray(msg.rooms) ? msg.rooms.slice(0, MAX_BREAKOUTS) : [];
      if (list.length < 1) return json(res, 400, { error: "no_rooms" });
      const state = {
        open: true,
        rooms: list.map((r, i) => {
          const members = (Array.isArray(r.members) ? r.members : []).slice(0, 25).map((c) => String(c).slice(0, 64));
          const names = (Array.isArray(r.names) ? r.names : []).slice(0, 25).map(cleanName);
          return { id: `r${i + 1}`, name: String(r.name || "").trim().slice(0, 30) || `غرفة ${i + 1}`, members, names };
        }),
      };
      breakouts.set(main, state);
      broadcastFamily(main, "breakout", state);
    } else if (msg.action === "close") {
      breakouts.delete(main);
      broadcastFamily(main, "breakout", { open: false, rooms: [] });
    } else if (msg.action === "closeRoom") {
      // إغلاق غرفة واحدة: طلابها يعودون للحلقة الرئيسية وتبقى الغرف الأخرى مفتوحة
      const state = breakouts.get(main);
      if (!state) return json(res, 404, { error: "not_open" });
      const rooms = state.rooms.filter((r) => r.id !== String(msg.room));
      if (rooms.length === state.rooms.length) return json(res, 404, { error: "no_room" });
      if (rooms.length === 0) {
        breakouts.delete(main);
        broadcastFamily(main, "breakout", { open: false, rooms: [] });
      } else {
        const next = { open: true, rooms };
        breakouts.set(main, next);
        broadcastFamily(main, "breakout", next);
      }
    } else if (msg.action === "assign") {
      // نقل طالب إلى غرفة أخرى (أو للرئيسية إن لم تُحدَّد غرفة) والغرف مفتوحة
      const state = breakouts.get(main);
      if (!state) return json(res, 404, { error: "not_open" });
      const cid = String(msg.cid || "").slice(0, 64);
      const to = msg.room ? String(msg.room) : null;
      if (!cid) return json(res, 400, { error: "bad_cid" });
      if (to && !state.rooms.some((r) => r.id === to)) return json(res, 404, { error: "no_room" });
      const name = cleanName(msg.name);
      const rooms = state.rooms.map((r) => {
        const keep = r.members.map((c, i) => [c, r.names[i]]).filter(([c]) => c !== cid);
        if (r.id === to) keep.push([cid, name]);
        return { ...r, members: keep.map(([c]) => c), names: keep.map(([, n]) => n) };
      });
      const next = { open: true, rooms };
      breakouts.set(main, next);
      broadcastFamily(main, "breakout", next);
    } else if (msg.action === "announce") {
      const text = String(msg.text || "").trim().slice(0, 200);
      if (!text) return json(res, 400, { error: "empty" });
      broadcastFamily(main, "announce", { text, name: sender.name });
    } else {
      return json(res, 400, { error: "bad_action" });
    }
    json(res, 200, { ok: true });
  });
}

// المعلّم (منشئ الغرفة فقط) يعيّن مشرفاً أو يلغي إشرافه
function handlePromote(req, res, roomId) {
  readJson(req, res, (msg) => {
    const sender = senderOf(roomId, msg);
    if (!sender) return json(res, 404, { error: "not_in_room" });
    if (sender.role !== "teacher") return json(res, 403, { error: "host_only" });
    const cid = String(msg.cid || "").slice(0, 64);
    if (!cid || cid === sender.cid) return json(res, 400, { error: "bad_cid" });
    const main = mainOf(roomId);
    let set = admins.get(main);
    if (!set) admins.set(main, (set = new Set()));
    if (msg.admin) set.add(cid);
    else set.delete(cid);
    const role = msg.admin ? "admin" : "student";
    for (const room of familyRooms(main)) {
      for (const peer of room.values()) if (peer.cid === cid && peer.role !== "teacher") peer.role = role;
    }
    broadcastFamily(main, "role", { cid, role });
    sendPresence(main);
    json(res, 200, { ok: true, role });
  });
}

// أدوات الإدارة للمعلّم والأدمن: كتم، إيقاف كاميرا، إنزال يد، إخراج، كتم الجميع، قفل الحلقة، إيقاف الدردشة.
// الأدمن يدير الطلاب فقط، والمعلّم يدير الجميع، ولا أحد يدير المعلّم.
const canManage = (sender, target) =>
  target && target.id !== sender.id && target.role !== "teacher" && (sender.role === "teacher" || target.role === "student");

function handleModerate(req, res, roomId) {
  readJson(req, res, (msg) => {
    const room = rooms.get(roomId);
    const sender = senderOf(roomId, msg);
    if (!sender) return json(res, 404, { error: "not_in_room" });
    if (!STAFF.has(sender.role)) return json(res, 403, { error: "staff_only" });
    const main = mainOf(roomId);
    const by = sender.name;
    const action = String(msg.action || "");

    if (["mute", "camOff", "lowerHand", "kick"].includes(action)) {
      const target = room.get(String(msg.target || ""));
      if (!target) return json(res, 404, { error: "no_target" });
      if (!canManage(sender, target)) return json(res, 403, { error: "not_allowed" });
      if (action === "kick") {
        // الإخراج العادي يسمح بالعودة، ومع ban يُمنع حتى يسمح له المعلّم أو الأدمن
        const ban = !!msg.ban;
        if (ban) controlsOf(main).kicked.set(target.cid, target.name);
        send(target, "kicked", { by, ban });
        removePeer(roomId, target.id);
        target.end();
        broadcastFamily(main, "notice", { text: `أخرج ${by} ${target.name} من الحلقة${ban ? " ومنعه من العودة" : ""}` });
        if (ban) broadcastFamily(main, "controls", { ...publicControls(main), by, changed: "ban" });
      } else {
        send(target, "moderate", { action, by });
      }
    } else if (action === "unban") {
      // السماح لممنوع بالعودة
      const c = controlsOf(main);
      const cid = String(msg.cid || "");
      const name = c.kicked.get(cid);
      if (!name) return json(res, 404, { error: "not_banned" });
      c.kicked.delete(cid);
      broadcastFamily(main, "controls", { ...publicControls(main), by, changed: "unban" });
      broadcastFamily(main, "notice", { text: `سمح ${by} لـ${name} بالعودة للحلقة` });
    } else if (action === "muteAll") {
      // كتم الجميع يشمل الطلاب فقط
      for (const peer of room.values()) if (peer.role === "student") send(peer, "moderate", { action: "mute", by });
    } else if (["lock", "chat", "micLock", "camLock"].includes(action)) {
      const c = controlsOf(main);
      if (action === "lock") c.locked = !!msg.on;
      else if (action === "chat") c.chatOff = !msg.on;
      else {
        c[action] = !!msg.on;
        // قفل جديد يلغي الأذونات السابقة
        if (msg.on) c[action === "micLock" ? "micAllow" : "camAllow"].clear();
      }
      broadcastFamily(main, "controls", { ...publicControls(main), by, changed: action });
    } else if (action === "allowMic" || action === "allowCam") {
      // إذن لطالب واحد بفتح المايك أو الكاميرا رغم القفل
      const target = room.get(String(msg.target || ""));
      if (!target || !canManage(sender, target)) return json(res, 403, { error: "not_allowed" });
      const set = controlsOf(main)[action === "allowMic" ? "micAllow" : "camAllow"];
      if (msg.on) set.add(target.cid);
      else set.delete(target.cid);
      broadcastFamily(main, "controls", { ...publicControls(main), by, changed: action, cid: target.cid, on: !!msg.on });
    } else {
      return json(res, 400, { error: "bad_action" });
    }
    json(res, 200, { ok: true });
  });
}

// إنشاء غرفة جديدة: الخادم يختار الرمز (أو يضيف لاحقة عشوائية للاسم المقروء) ويعطي منشئها مفتاح المعلّم
const LETTERS = "abcdefghijkmnopqrstuvwxyz";
const randomLetters = (n) => Array.from(crypto.randomBytes(n), (b) => LETTERS[b % LETTERS.length]).join("");
function handleCreate(req, res) {
  readJson(req, res, (msg) => {
    let code;
    if (msg.slug) {
      const base = String(msg.slug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 34);
      if (base.length < 2) return json(res, 400, { error: "bad_slug" });
      code = `${base}-${randomLetters(3)}`;
    } else {
      code = `${randomLetters(3)}-${randomLetters(4)}-${randomLetters(3)}`;
    }
    if (!ROOM_RE.test(code)) return json(res, 400, { error: "bad_slug" });
    json(res, 200, { code, key: hostKey(code) });
  });
}

function handleSignal(req, res, roomId) {
  readJson(req, res, (msg) => {
    const room = rooms.get(roomId);
    const sender = senderOf(roomId, msg);
    if (!sender) return json(res, 404, { error: "not_in_room" });
    const allowed = ["offer", "answer", "ice", "chat", "state", "reaction", "recite", "grade"];
    if (!allowed.includes(msg.type)) return json(res, 400, { error: "bad_type" });
    // مناداة الطالب للتسميع وتقييمه للمعلّم والمشرفين فقط
    if ((msg.type === "recite" || msg.type === "grade") && !STAFF.has(sender.role)) {
      return json(res, 403, { error: "teacher_only" });
    }
    // الدردشة موقفة للطلاب من المعلّم أو الأدمن
    if (msg.type === "chat" && controls.get(mainOf(roomId))?.chatOff && !STAFF.has(sender.role)) {
      return json(res, 403, { error: "chat_off" });
    }

    // الرسائل الخاصة: بين الطالب والمعلّم أو الأدمن فقط
    if (msg.type === "chat" && msg.to && !STAFF.has(sender.role) && !STAFF.has(room.get(String(msg.to))?.role)) {
      return json(res, 403, { error: "private_staff_only" });
    }
    const payload = { from: sender.id, type: msg.type, data: msg.data };
    if (msg.to) {
      const target = room.get(msg.to);
      if (target) send(target, "signal", payload);
    } else {
      broadcast(room, "signal", payload, sender.id);
    }
    json(res, 200, { ok: true });
  });
}

// الملفات الثابتة تُقرأ مرة واحدة وتُضغط مسبقاً، وتُرسل مضغوطة مع بصمة (ETag)
// فالمتصفح لا يعيد تنزيل ما لم يتغير، والتحديثات تصل فوراً بعد النشر
const staticCache = new Map();
function loadStatic(filePath) {
  if (staticCache.has(filePath)) return staticCache.get(filePath);
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  const ext = path.extname(filePath);
  const type = MIME[ext] || "application/octet-stream";
  const compressible = /text|javascript|json|svg|manifest/.test(type);
  const entry = {
    type,
    data,
    gz: compressible ? zlib.gzipSync(data, { level: 9 }) : null,
    etag: `"${crypto.createHash("sha1").update(data).digest("base64url").slice(0, 16)}"`,
    // الصور تُحفظ أسبوعاً، والصفحة والسكربت والتنسيق يُتحقق منها كل مرة (رد صغير 304 إن لم تتغير)
    cache: /\.(png|ico)$/.test(ext) ? "public, max-age=604800" : "no-cache",
  };
  if (process.env.NODE_ENV === "production" || !process.env.WASL_DEV) staticCache.set(filePath, entry);
  return entry;
}

function serveStatic(req, res, pathname) {
  // أي رابط بشكل رمز اجتماع يعرض الصفحة الرئيسية
  if (pathname === "/" || ROOM_RE.test(pathname.slice(1))) pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  const f = loadStatic(filePath);
  if (!f) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("الصفحة غير موجودة");
  }
  const headers = { "Content-Type": f.type, "Cache-Control": f.cache, ETag: f.etag, Vary: "Accept-Encoding" };
  if (req.headers["if-none-match"] === f.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  if (f.gz && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    res.writeHead(200, { ...headers, "Content-Encoding": "gzip", "Content-Length": f.gz.length });
    return res.end(f.gz);
  }
  res.writeHead(200, { ...headers, "Content-Length": f.data.length });
  res.end(f.data);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/config" && req.method === "GET") {
    return iceServers().then((list) => json(res, 200, { iceServers: list, turn: !!(CF_TURN || process.env.TURN_URLS) }));
  }
  if (url.pathname === "/healthz") {
    let peers = 0;
    for (const room of rooms.values()) peers += room.size;
    return json(res, 200, { ok: true, rooms: rooms.size, peers });
  }
  if (url.pathname === "/api/rooms" && req.method === "POST") return handleCreate(req, res);
  const m = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(events|poll|leave|signal|peers|breakout|promote|moderate)$/);
  if (m) {
    const [, roomId, action] = m;
    if (!API_ROOM_RE.test(roomId)) return json(res, 400, { error: "bad_room" });
    if (action === "events" && req.method === "GET") return handleEvents(req, res, roomId, url);
    if (action === "poll" && req.method === "GET") return handlePoll(req, res, roomId, url);
    if (action === "leave" && req.method === "POST") {
      // مغادرة صريحة (عند الانتقال لغرفة أخرى أو إغلاق الصفحة)
      return readJson(req, res, (msg) => {
        const peer = senderOf(roomId, msg);
        if (peer && pollers.has(peer.id)) dropPoll(peer.id);
        else if (peer) {
          // مغادرة صريحة من قناة SSE: نحذفه فوراً بدل انتظار انقطاع الاتصال
          peer.gone = true;
          removePeer(roomId, peer.id);
          peer.end();
        }
        json(res, 200, { ok: true });
      });
    }
    if (action === "signal" && req.method === "POST") return handleSignal(req, res, roomId);
    if (action === "breakout" && req.method === "POST") return handleBreakout(req, res, roomId);
    if (action === "promote" && req.method === "POST") return handlePromote(req, res, roomId);
    if (action === "moderate" && req.method === "POST") return handleModerate(req, res, roomId);
    if (action === "peers" && req.method === "GET") {
      // من في الحلقة الآن — لعرضه في شاشة ما قبل الدخول
      const room = rooms.get(roomId);
      const names = room ? [...room.values()].map((p) => p.name) : [];
      return json(res, 200, { count: names.length, names: names.slice(0, 8) });
    }
    return json(res, 405, { error: "method_not_allowed" });
  }
  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
  serveStatic(req, res, decodeURIComponent(url.pathname));
});

server.listen(PORT, () => {
  console.log(`وصل تعمل على http://localhost:${PORT}`);
});
