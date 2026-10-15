// خادم وصل: يقدّم الواجهة ويعمل كخادم إشارة (signaling) لاتصالات WebRTC
// بدون أي اعتماديات خارجية — Node.js فقط.
const http = require("http");
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
function iceServers() {
  const list = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  const urls = (process.env.TURN_URLS || "").split(",").map((u) => u.trim()).filter(Boolean);
  if (urls.length) {
    list.push({ urls, username: process.env.TURN_USERNAME || "", credential: process.env.TURN_CREDENTIAL || "" });
  }
  return list;
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
// الحلقة الرئيسية -> أدوات الإدارة { locked, chatOff, seen: Set(cid), kicked: Set(cid) }
const controls = new Map();
const controlsOf = (main) => {
  let c = controls.get(main);
  if (!c) controls.set(main, (c = { locked: false, chatOff: false, seen: new Set(), kicked: new Set() }));
  return c;
};
const publicControls = (main) => {
  const c = controls.get(main);
  return { locked: !!c?.locked, chatOff: !!c?.chatOff };
};

const mainOf = (roomId) => roomId.replace(/-r[1-9]$/, "");

// كل الغرف التابعة لحلقة واحدة: الرئيسية وغرفها الفرعية
function familyRooms(main) {
  return [...rooms.entries()].filter(([id]) => mainOf(id) === main).map(([, room]) => room);
}

function broadcastFamily(main, event, data) {
  for (const room of familyRooms(main)) broadcast(room, event, data);
}

// من في كل غرفة من غرف الحلقة الآن — ليرى المعلّم والطلاب أماكن الجميع
function presenceOf(main) {
  const out = {};
  for (const [id, room] of rooms.entries()) {
    if (mainOf(id) !== main) continue;
    out[id === main ? "main" : id.slice(main.length + 1)] = [...room.values()].map((p) => ({ cid: p.cid, name: p.name, role: p.role }));
  }
  return out;
}
function sendPresence(main) {
  broadcastFamily(main, "presence", presenceOf(main));
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

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function cleanName(name) {
  return String(name || "").trim().slice(0, 40) || "ضيف";
}

// إضافة مشارك للغرفة — مشترك بين طريقتي الاتصال. يرجع null إن كانت الغرفة ممتلئة
function addPeer(roomId, url, push) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  if (room.size >= MAX_PEERS) {
    if (room.size === 0) rooms.delete(roomId);
    return null;
  }
  const id = crypto.randomUUID();
  const name = cleanName(url.searchParams.get("name"));
  const cid = String(url.searchParams.get("cid") || id).slice(0, 64);
  // الدور يقرّره الخادم: مفتاح المعلّم ← معلّم، ومن عيّنه المعلّم ← مشرف، والباقي طلاب
  const main = mainOf(roomId);
  const role = isHostKey(main, url.searchParams.get("key")) ? "teacher" : admins.get(main)?.has(cid) ? "admin" : "student";

  const peers = [...room.values()].map((p) => ({ id: p.id, cid: p.cid, name: p.name, role: p.role }));
  const peer = { id, cid, name, role, push, end: () => {} };
  room.set(id, peer);
  controlsOf(main).seen.add(cid);
  send(peer, "welcome", { id, role, peers, breakout: breakouts.get(main) || null, controls: publicControls(main) });
  broadcast(room, "peer-joined", { id, cid, name, role }, id);
  sendPresence(main);
  return peer;
}

function removePeer(roomId, id) {
  const room = rooms.get(roomId);
  if (!room || !room.delete(id)) return;
  broadcast(room, "peer-left", { id });
  if (room.size === 0) rooms.delete(roomId);
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
  const refused = refuseReason(roomId, url);
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
  const peer = addPeer(roomId, url, (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`));
  peer.end = () => res.end();
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    removePeer(roomId, peer.id);
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
    const refused = refuseReason(roomId, url);
    if (refused) return json(res, 403, { error: refused });
    const p = { roomId, queue: [], seq: 0, waiting: null, expire: 0 };
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
  if (!p || p.roomId !== roomId) return json(res, 410, { error: "gone" });
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
    const sender = rooms.get(roomId)?.get(msg.from);
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
    const sender = rooms.get(roomId)?.get(msg.from);
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
    const sender = room?.get(msg.from);
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
        controlsOf(main).kicked.add(target.cid);
        send(target, "kicked", { by });
        removePeer(roomId, target.id);
        target.end();
        broadcastFamily(main, "notice", { text: `أخرج ${by} ${target.name} من الحلقة` });
      } else {
        send(target, "moderate", { action, by });
      }
    } else if (action === "muteAll") {
      // كتم الجميع يشمل الطلاب فقط
      for (const peer of room.values()) if (peer.role === "student") send(peer, "moderate", { action: "mute", by });
    } else if (action === "lock" || action === "chat") {
      const c = controlsOf(main);
      if (action === "lock") c.locked = !!msg.on;
      else c.chatOff = !msg.on;
      broadcastFamily(main, "controls", { ...publicControls(main), by });
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
    if (!room || !room.has(msg.from)) return json(res, 404, { error: "not_in_room" });
    const allowed = ["offer", "answer", "ice", "chat", "state", "reaction", "recite", "grade"];
    if (!allowed.includes(msg.type)) return json(res, 400, { error: "bad_type" });
    // مناداة الطالب للتسميع وتقييمه للمعلّم والمشرفين فقط
    if ((msg.type === "recite" || msg.type === "grade") && !STAFF.has(room.get(msg.from).role)) {
      return json(res, 403, { error: "teacher_only" });
    }
    // الدردشة موقفة للطلاب من المعلّم أو الأدمن
    if (msg.type === "chat" && controls.get(mainOf(roomId))?.chatOff && !STAFF.has(room.get(msg.from).role)) {
      return json(res, 403, { error: "chat_off" });
    }

    const payload = { from: msg.from, type: msg.type, data: msg.data };
    if (msg.to) {
      const target = room.get(msg.to);
      if (target) send(target, "signal", payload);
    } else {
      broadcast(room, "signal", payload, msg.from);
    }
    json(res, 200, { ok: true });
  });
}

function serveStatic(req, res, pathname) {
  // أي رابط بشكل رمز اجتماع يعرض الصفحة الرئيسية
  if (pathname === "/" || ROOM_RE.test(pathname.slice(1))) pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("الصفحة غير موجودة");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/config" && req.method === "GET") {
    return json(res, 200, { iceServers: iceServers(), turn: !!process.env.TURN_URLS });
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
      // مغادرة مستخدم الاستطلاع (يُرسل عند إغلاق الصفحة)
      return readJson(req, res, (msg) => {
        if (pollers.get(String(msg.from))?.roomId === roomId) dropPoll(String(msg.from));
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
