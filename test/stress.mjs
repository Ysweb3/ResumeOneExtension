// Stress test for background.js's link to the desktop app - no browser, no real app.
// background.js runs unmodified in a vm with chrome.* stubbed; its localhost:8765 is
// rewritten to a fake app on a spare port that can be killed, frozen or made to fail,
// so the real app can stay open on 8765 meanwhile. Extension timers run 20x fast
// (heartbeat 1s, retry 150ms). Run: node test/stress.mjs   (exit 1 if any GAP)
import vm from "node:vm";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const SCALE = 0.05;
const SRC = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const real = ms => new Promise(r => setTimeout(r, ms));
const sleep = ms => real(ms * SCALE); // in extension time

function frame(op, text) {
  const p = Buffer.from(text);
  let head;
  if (p.length < 126) head = Buffer.from([0x80 | op, p.length]);
  else if (p.length < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
  head[0] = 0x80 | op;
  return Buffer.concat([head, p]);
}

// The app side of the contract: /ws, POST /tabs, GET /project. mode flips misbehaviour.
async function fakeApp(port = 0) {
  const app = { socks: new Set(), msgs: [], posts: [], connects: [], mode: {} };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/tabs") {
        app.posts.push(body);
        res.writeHead(app.mode.tabsStatus || 200);
        return res.end();
      }
      res.end(req.url === "/project" ? "demo" : "");
    });
  });
  server.on("upgrade", (req, sock) => {
    sock.on("error", () => {});
    app.socks.add(sock);
    sock.on("close", () => app.socks.delete(sock));
    app.connects.push(req.url);
    if (app.mode.hangHandshake) return; // TCP accepted, 101 never comes
    const accept = crypto.createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    sock.on("data", d => {
      if (app.mode.frozen) return; // hung process: kernel still acks, nobody reads
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) break;
        const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < len; i++) data[i] ^= buf[off + (i & 3)];
        const op = buf[0] & 15;
        buf = buf.subarray(off + 4 + len);
        if (op === 1) app.msgs.push(data.toString());
        if (op === 8) sock.end(frame(8, ""));
      }
    });
  });
  app.send = text => app.socks.forEach(s => s.write(frame(1, text)));
  app.start = () => new Promise(r => server.listen(port, "127.0.0.1", () => { app.port = port = server.address().port; r(); }));
  // the app process dying: every socket reset, nothing listening
  app.kill = () => new Promise(r => { app.socks.forEach(s => s.destroy()); server.closeAllConnections(); server.close(r); });
  await app.start();
  return app;
}

function loadExtension(port, tabs = ["https://a.test/", "https://b.test/", "chrome://newtab/"]) {
  const ext = { sockets: [], created: [], logs: [], errors: [], timers: new Set() };
  const to = u => u.replace("localhost:8765", `127.0.0.1:${port}`);
  class WS extends WebSocket { constructor(u) { super(to(u)); ext.sockets.push(this); } }
  const timer = (fn, ms, every) => { const h = (every ? setInterval : setTimeout)(fn, ms * SCALE); ext.timers.add(h); return h; };
  vm.runInNewContext(SRC, {
    WebSocket: WS,
    fetch: (u, o) => fetch(to(u), o),
    navigator: { userAgentData: { brands: [{ brand: "Google Chrome" }] } },
    console: { log: (...a) => ext.logs.push(a.join(" ")), error: (...a) => ext.errors.push(a.join(" ")) },
    setTimeout: (f, ms) => timer(f, ms), setInterval: (f, ms) => timer(f, ms, true), clearTimeout, clearInterval,
    chrome: {
      tabs: { query: (_q, cb) => cb(tabs.map(url => ({ url }))), create: ({ url }) => ext.created.push(url) },
      alarms: { create() {}, onAlarm: { addListener: f => ext.alarm = f } },
    },
  });
  ext.fireAlarm = () => ext.alarm({ name: "ws-keepalive" });
  ext.last = () => ext.sockets.at(-1);
  ext.stop = () => { ext.timers.forEach(clearTimeout); ext.sockets.forEach(s => { s.onclose = null; s.close(); }); };
  return ext;
}

// polls in real time; resolves the extension-time ms it took, or null on timeout
async function until(cond, extMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < extMs * SCALE) { if (cond()) return (Date.now() - t0) / SCALE; await real(5); }
  return cond() ? extMs : null;
}

const results = [];
async function scenario(name, fn) {
  const app = await fakeApp();
  let ext;
  try {
    const [ok, note] = await fn(app, (...a) => ext = loadExtension(app.port, ...a));
    results.push([ok ? "ok " : "GAP", name, note]);
  } catch (e) {
    results.push(["ERR", name, e.stack]);
  } finally {
    ext?.stop();
    await app.kill().catch(() => {});
  }
}

await scenario("connect, heartbeat, capture -> POST /tabs", async (app, load) => {
  load();
  await until(() => app.msgs.includes("Heartbeat"), 25000);
  app.send("capture");
  await until(() => app.posts.length, 2000);
  const post = JSON.parse(app.posts[0] ?? "{}");
  const ok = app.connects[0] === "/ws?browser=Chrome" && app.msgs.includes("Heartbeat") && post.browser === "Chrome" && post.urls?.length === 3;
  return [ok, `url=${app.connects[0]} heartbeat=${app.msgs.includes("Heartbeat")} post=${app.posts[0]}`];
});

await scenario("app restart: reconnect time", async (app, load) => {
  const ext = load();
  await until(() => app.socks.size, 2000);
  await app.kill();
  await sleep(10000);
  await app.start();
  const took = await until(() => ext.last().readyState === 1 && app.socks.size === 1, 10000);
  return [took !== null && took <= 3500, `reconnected ${took === null ? "never" : `~${Math.round(took)}ms`} after app came back (retry is 3000ms)`];
});

await scenario("60s outage + 10 alarm wakes: still exactly one socket", async (app, load) => {
  const ext = load();
  await until(() => app.socks.size, 2000);
  await app.kill();
  for (let i = 0; i < 10; i++) { await sleep(6000); ext.fireAlarm(); ext.fireAlarm(); }
  await app.start();
  await until(() => app.socks.size, 5000);
  await sleep(8000);
  const live = ext.sockets.filter(s => s.readyState < 2).length;
  return [app.socks.size === 1 && live === 1, `${ext.sockets.length} attempts during outage, ${app.socks.size} socket(s) at app, ${live} live in extension`];
});

await scenario("app accepts TCP but never finishes handshake", async (app, load) => {
  app.mode.hangHandshake = true;
  const ext = load();
  await sleep(120000);
  app.mode.hangHandshake = false;
  ext.fireAlarm();
  await sleep(10000);
  const stuck = ext.sockets.length === 1 && ext.last().readyState === 0;
  return [!stuck, stuck ? "stuck in CONNECTING for 2+ min; alarm wakes are ignored (readyState !== CLOSED), so it never retries even after the app is fine"
    : `recovered: ${ext.sockets.length} attempts, state ${ext.last().readyState}`];
});

await scenario("app frozen (stops reading, socket stays up)", async (app, load) => {
  const ext = load();
  await until(() => app.socks.size, 2000);
  app.mode.frozen = true;
  await sleep(90000);
  const blind = ext.sockets.length === 1 && ext.last().readyState === 1;
  return [!blind, blind ? "90s of heartbeats into a dead app; extension still thinks it is connected (no reply/pong is ever expected)"
    : "noticed the dead app"];
});

await scenario("POST /tabs answered with 500", async (app, load) => {
  const ext = load();
  await until(() => app.socks.size, 2000);
  app.mode.tabsStatus = 500;
  app.send("capture");
  await until(() => app.posts.length, 2000);
  await real(100);
  const silent = ext.errors.length === 0 && ext.logs.includes("tabs");
  return [!silent, silent ? `logged as success, no retry; ${app.posts.length} post(s) - the checkpoint silently has no tabs`
    : `errors: ${ext.errors.join(" | ")}`];
});

await scenario("capture arrives while app is going down", async (app, load) => {
  const ext = load();
  await until(() => app.socks.size, 2000);
  app.send("capture");
  await app.kill(); // POST races the shutdown and loses
  await real(200);
  await app.start();
  await until(() => app.socks.size, 5000);
  await sleep(3000);
  return [app.posts.length > 0, app.posts.length ? "tabs arrived after restart" : `tabs lost, not re-sent on reconnect (errors: ${ext.errors.length})`];
});

await scenario("hostile/garbage {open} payloads", async (app, load) => {
  const ext = load();
  await until(() => app.socks.size, 2000);
  for (const m of ["garbage", "{", '{"open":"x"}', "null", '{"open":[null,5,"javascript:alert(1)","file:///C:/Windows/","chrome://settings","https://ok.test/"]}'])
    app.send(m);
  await sleep(1000);
  app.send("capture");
  await until(() => app.posts.length, 2000);
  const bad = ext.created.filter(u => !/^https?:\/\//.test(String(u)));
  return [bad.length === 0 && app.posts.length === 1,
    `survived=${app.posts.length === 1}; would open non-web urls: ${JSON.stringify(bad)}`];
});

await scenario("resume flood: {open} with 2000 urls", async (app, load) => {
  const ext = load();
  await until(() => app.socks.size, 2000);
  app.send(JSON.stringify({ open: Array.from({ length: 2000 }, (_, i) => `https://flood.test/${i}`) }));
  await until(() => ext.created.length === 2000, 2000);
  return [ext.created.length < 2000, `${ext.created.length} tabs created in one go, no cap or dedupe of the list itself`];
});

await scenario("capture storm: 200 pushes", async (app, load) => {
  load();
  await until(() => app.socks.size, 2000);
  for (let i = 0; i < 200; i++) app.send("capture");
  await until(() => app.posts.length === 200, 100000);
  return [app.posts.length < 200, `${app.posts.length} POST /tabs for 200 pushes (no coalescing)`];
});

for (const [s, name, note] of results) console.log(`${s}  ${name}\n     ${note}`);
const gaps = results.filter(r => r[0] !== "ok ").length;
console.log(`\n${results.length - gaps}/${results.length} ok, ${gaps} gap(s)`);
process.exit(gaps ? 1 : 0);
