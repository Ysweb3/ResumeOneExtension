// Popup for artboard 1j. Lists the open tabs, lets the user drop any of them,
// and POSTs the rest to the desktop app on :8765 — the same contract background.js
// uses, so the app needs no new /tabs handling.

const APP = "http://localhost:8765";
const SHOWN = 3; // the design shows three and folds the rest

const els = {
  dot: document.getElementById("dot"),
  lede: document.getElementById("lede"),
  tabs: document.getElementById("tabs"),
  more: document.getElementById("more"),
  moreLabel: document.getElementById("moreLabel"),
  excluded: document.getElementById("excluded"),
  send: document.getElementById("send"),
  status: document.getElementById("status"),
  conn: document.getElementById("conn"),
};

let urls = [];
const dropped = new Set();
let expanded = false;
let project = "";
let running = null; // null until GET /project answers or fails

// Same brand detection as background.js — the app buckets urls per browser, so the
// popup has to label its post the same way or it lands under a second key.
function browserName() {
  if (navigator.userAgentData && navigator.userAgentData.brands) {
    const brands = navigator.userAgentData.brands.map(b => b.brand.toLowerCase());
    if (brands.includes("microsoft edge")) return "Edge";
    if (brands.includes("opera")) return "Opera";
    if (brands.includes("google chrome")) return "Chrome";
    if (brands.includes("brave")) return "brave";
  }
}

function tidy(url) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function render() {
  const kept = urls.filter(u => !dropped.has(u));
  // Send writes now (POST /tabs) - not "on the next checkpoint" - into the project open in
  // the app; whether it replaces or adds follows that project's last checkpoint mode.
  // textContent, not innerHTML: the name is the user's text.
  if (running === false) {
    els.lede.textContent = "coldstart isn't running. Open it, then open this again.";
  } else if (running && !project) {
    els.lede.textContent = "Open a project in coldstart to send tabs to it.";
  } else {
    const b = document.createElement("b");
    b.textContent = project || "…";
    els.lede.replaceChildren(`Send puts the ${kept.length} ticked tabs into `, b, ` now.`);
  }

  const visible = expanded ? urls : urls.slice(0, SHOWN);
  els.tabs.replaceChildren(...visible.map(url => {
    const row = document.createElement("div");
    row.className = dropped.has(url) ? "tab off" : "tab";
    row.title = url;
    // a real checkbox to keyboards and screen readers, not just a clickable div
    row.tabIndex = 0;
    row.setAttribute("role", "checkbox");
    row.setAttribute("aria-checked", String(!dropped.has(url)));
    row.setAttribute("aria-label", tidy(url));
    row.addEventListener("keydown", e => {
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); row.click(); }
    });
    row.innerHTML =
      '<span class="box"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" ' +
      'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>' +
      '<span class="url"></span>';
    row.querySelector(".url").textContent = tidy(url);
    row.addEventListener("click", () => {
      dropped.has(url) ? dropped.delete(url) : dropped.add(url);
      render();
      // render() rebuilt the rows; keep the keyboard where it was
      [...els.tabs.children].find(r => r.title === url)?.focus();
    });
    return row;
  }));

  const hidden = urls.length - visible.length;
  els.more.hidden = hidden === 0 && !expanded;
  els.moreLabel.textContent = expanded ? "Show fewer" : `${hidden} more tabs`;
  els.excluded.textContent = dropped.size ? `${dropped.size} excluded` : "";
  els.send.disabled = kept.length === 0 || !running || !project;
}

els.more.addEventListener("click", () => {
  expanded = !expanded;
  render();
});
els.more.addEventListener("keydown", e => {
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); els.more.click(); }
});

els.send.addEventListener("click", async () => {
  const kept = urls.filter(u => !dropped.has(u));
  els.send.disabled = true;
  els.status.textContent = "sending…";
  els.status.classList.remove("bad");
  try {
    await fetch(`${APP}/tabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: browserName(), urls: kept }),
    });
    els.status.textContent = `sent ${kept.length} tabs to ${project}`;
  } catch (err) {
    els.status.textContent = "couldn't reach coldstart · is it still open?";
    els.status.classList.add("bad");
    els.send.disabled = false;
  }
});

// The app answers GET /project with the active project's name (empty string when
// none is selected). A reply at all is what tells us the desktop app is running.
async function connect() {
  try {
    const res = await fetch(`${APP}/project`);
    project = (await res.text()).trim();
    running = true;
    els.dot.classList.add("live");
    els.conn.textContent = "connected";
  } catch (err) {
    running = false;
    els.conn.textContent = "not running";
  }
  render();
}

chrome.tabs.query({}, tabs => {
  urls = tabs.map(t => t.url).filter(Boolean);
  render();
  connect();
});
