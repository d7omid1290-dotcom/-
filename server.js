// خادم حلقتي: يقدّم الواجهة ويعمل كخادم إشارة (signaling) لاتصالات WebRTC
// بدون أي اعتماديات خارجية — Node.js فقط.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOM_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const MAX_PEERS = 12;
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

// roomId -> Map(peerId -> { id, name, res })
const rooms = new Map();

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

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const peers = [...room.values()].map((p) => ({ id: p.id, name: p.name }));
  room.set(id, { id, name, res });
  send(res, "welcome", { id, peers });
  broadcast(room, "peer-joined", { id, name }, id);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    room.delete(id);
    broadcast(room, "peer-left", { id });
    if (room.size === 0) rooms.delete(roomId);
  });
}

function handleSignal(req, res, roomId) {
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
    const room = rooms.get(roomId);
    if (!room || !room.has(msg.from)) return json(res, 404, { error: "not_in_room" });
    const allowed = ["offer", "answer", "ice", "chat", "state", "reaction"];
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
  const m = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(events|signal)$/);
  if (m) {
    const [, roomId, action] = m;
    if (!ROOM_RE.test(roomId)) return json(res, 400, { error: "bad_room" });
    if (action === "events" && req.method === "GET") return handleEvents(req, res, roomId, url);
    if (action === "signal" && req.method === "POST") return handleSignal(req, res, roomId);
    return json(res, 405, { error: "method_not_allowed" });
  }
  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
  serveStatic(req, res, decodeURIComponent(url.pathname));
});

server.listen(PORT, () => {
  console.log(`حلقتي تعمل على http://localhost:${PORT}`);
});
