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

// roomId -> Map(peerId -> { id, cid, name, role, res })
const rooms = new Map();
// الحلقة الرئيسية -> حالة الغرف الفرعية { open, rooms: [{ id, name, members: [cid], names: [name] }] }
const breakouts = new Map();
// الحلقة الرئيسية -> المشرفون الذين عيّنهم المعلّم (بمعرّفاتهم الثابتة)
const admins = new Map();

const mainOf = (roomId) => roomId.replace(/-r[1-9]$/, "");

// كل الغرف التابعة لحلقة واحدة: الرئيسية وغرفها الفرعية
function familyRooms(main) {
  return [...rooms.entries()].filter(([id]) => mainOf(id) === main).map(([, room]) => room);
}

function broadcastFamily(main, event, data) {
  for (const room of familyRooms(main)) broadcast(room, event, data);
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(room, event, data, exceptId) {
  for (const peer of room.values()) {
    if (peer.id !== exceptId) send(peer.res, event, data);
  }
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function cleanName(name) {
  return String(name || "").trim().slice(0, 40) || "ضيف";
}

function handleEvents(req, res, roomId, url) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  if (room.size >= MAX_PEERS) return json(res, 403, { error: "room_full" });

  const id = crypto.randomUUID();
  const name = cleanName(url.searchParams.get("name"));
  const cid = String(url.searchParams.get("cid") || id).slice(0, 64);
  // الدور يقرّره الخادم: مفتاح المعلّم ← معلّم، ومن عيّنه المعلّم ← مشرف، والباقي طلاب
  const main = mainOf(roomId);
  const role = isHostKey(main, url.searchParams.get("key")) ? "teacher" : admins.get(main)?.has(cid) ? "admin" : "student";

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const peers = [...room.values()].map((p) => ({ id: p.id, cid: p.cid, name: p.name, role: p.role }));
  room.set(id, { id, cid, name, role, res });
  send(res, "welcome", { id, role, peers, breakout: breakouts.get(main) || null });
  broadcast(room, "peer-joined", { id, cid, name, role }, id);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    room.delete(id);
    broadcast(room, "peer-left", { id });
    if (room.size === 0) rooms.delete(roomId);
    // إذا فرغت الحلقة كلها نحذف حالة غرفها
    if (familyRooms(main).length === 0) {
      breakouts.delete(main);
      admins.delete(main);
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
    json(res, 200, { ok: true, role });
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

    const payload = { from: msg.from, type: msg.type, data: msg.data };
    if (msg.to) {
      const target = room.get(msg.to);
      if (target) send(target.res, "signal", payload);
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
  const m = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(events|signal|peers|breakout|promote)$/);
  if (m) {
    const [, roomId, action] = m;
    if (!API_ROOM_RE.test(roomId)) return json(res, 400, { error: "bad_room" });
    if (action === "events" && req.method === "GET") return handleEvents(req, res, roomId, url);
    if (action === "signal" && req.method === "POST") return handleSignal(req, res, roomId);
    if (action === "breakout" && req.method === "POST") return handleBreakout(req, res, roomId);
    if (action === "promote" && req.method === "POST") return handlePromote(req, res, roomId);
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
