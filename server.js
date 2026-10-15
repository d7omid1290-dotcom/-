// خادم حلقتي: يقدّم الواجهة ويعمل كخادم إشارة (signaling) لاتصالات WebRTC
// بدون أي اعتماديات خارجية — Node.js فقط.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOM_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
// الغرف الفرعية داخل الحلقة: abc-defg-hij-r1 … -r9
const API_ROOM_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}(-r[1-9])?$/;
const MAX_BREAKOUTS = 9;
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
};

// roomId -> Map(peerId -> { id, cid, name, role, res })
const rooms = new Map();
// الحلقة الرئيسية -> حالة الغرف الفرعية { open, rooms: [{ id, name, members: [cid], names: [name] }] }
const breakouts = new Map();

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
  const role = url.searchParams.get("role") === "teacher" ? "teacher" : "student";

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const peers = [...room.values()].map((p) => ({ id: p.id, cid: p.cid, name: p.name }));
  room.set(id, { id, cid, name, role, res });
  send(res, "welcome", { id, peers, breakout: breakouts.get(mainOf(roomId)) || null });
  broadcast(room, "peer-joined", { id, cid, name }, id);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    room.delete(id);
    broadcast(room, "peer-left", { id });
    if (room.size === 0) rooms.delete(roomId);
    // إذا فرغت الحلقة كلها نحذف حالة غرفها
    const main = mainOf(roomId);
    if (familyRooms(main).length === 0) breakouts.delete(main);
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
    if (sender.role !== "teacher") return json(res, 403, { error: "teacher_only" });
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

function handleSignal(req, res, roomId) {
  readJson(req, res, (msg) => {
    const room = rooms.get(roomId);
    if (!room || !room.has(msg.from)) return json(res, 404, { error: "not_in_room" });
    const allowed = ["offer", "answer", "ice", "chat", "state", "reaction", "recite", "grade"];
    if (!allowed.includes(msg.type)) return json(res, 400, { error: "bad_type" });

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
  if (url.pathname === "/healthz") {
    let peers = 0;
    for (const room of rooms.values()) peers += room.size;
    return json(res, 200, { ok: true, rooms: rooms.size, peers });
  }
  const m = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(events|signal|peers|breakout)$/);
  if (m) {
    const [, roomId, action] = m;
    if (!API_ROOM_RE.test(roomId)) return json(res, 400, { error: "bad_room" });
    if (action === "events" && req.method === "GET") return handleEvents(req, res, roomId, url);
    if (action === "signal" && req.method === "POST") return handleSignal(req, res, roomId);
    if (action === "breakout" && req.method === "POST") return handleBreakout(req, res, roomId);
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
  console.log(`حلقتي تعمل على http://localhost:${PORT}`);
});
