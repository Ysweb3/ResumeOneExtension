 let ws;
 let heartbeatInterval;
function startHeartbeat(){
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
        ws.send("Heartbeat")
        console.log("Heatbeat")
    }, 20000);
}
function stopHeartbeat(){
    clearInterval(heartbeatInterval);
}

function sendTabs() {
     chrome.tabs.query({},(tabs) =>{
        
        const urls = tabs.map(tab => tab.url);
        console.log("sending tabs:", urls);
        console.log("sending browser name:", getBrowserFromBrands());
        fetch("http://localhost:8765/tabs",{
            method:"POST",
            headers:{
                "Content-Type":"application/json"
            },
            body: JSON.stringify({browser:getBrowserFromBrands(),urls:urls})
              
        })
        .then(() => console.log("tabs"))
        .catch(err => console.error("failed:", err));
        
    })
}
// open only the saved urls that are not already a tab, as background tabs in the window the
// user is already in - the browser is running, so a fresh window is just clutter.
// ponytail: exact string match - a tab that navigated to a fragment/redirect won't match.
function openMissing(urls) {
    chrome.tabs.query({}, (tabs) => {
        const open = new Set(tabs.map(t => t.url));
        const missing = urls.filter(u => !open.has(u));
        console.log("resume: opening", missing.length, "of", urls.length, "urls");
        missing.forEach(url => chrome.tabs.create({ url, active: false }));
    });
}
function connectWS() {
    //websocket for auto send to app
    // CONNECTING and CLOSING count as "a socket already exists" too - only checking OPEN
    // let the 3s retry and the 1min alarm each open their own socket, so the app saw two
    // extensions from one browser and the orphan died later at its own pace.
    if (ws && ws.readyState !== WebSocket.CLOSED) return;
    // brand goes in the url so the app knows which browser this socket belongs to at connect
    // time, rather than only after the first /tabs post
    const sock = ws = new WebSocket("ws://localhost:8765/ws?browser=" + encodeURIComponent(getBrowserFromBrands() || ""));
    sock.onopen = () => {
        console.log("connected to Resume Work");
         startHeartbeat();
    }
        
    sock.onmessage = (event) => {
        if (event.data === "capture") {
            sendTabs();
            return;
        }
        // resume: {"open":[urls]} - the app hands us the saved tabs instead of launching the
        // browser exe, because only we can see which of them are already open
        try {
            const msg = JSON.parse(event.data);
            if (Array.isArray(msg.open)) openMissing(msg.open);
        } catch (e) { /* not json - heartbeat echo or unknown message */ }
    };
    sock.onclose = () => {
        if (ws !== sock) return;  // an orphan closing must not schedule its own reconnect
        console.log("disconnected, retrying in 3s...");
        setTimeout(connectWS, 3000);  // retry after 3 seconds
        stopHeartbeat()
    };
    sock.onerror = (err) => console.error("ws error:", err);
}

function getBrowserFromBrands() {
  if (navigator.userAgentData && navigator.userAgentData.brands) {
    const brands = navigator.userAgentData.brands.map(b => b.brand.toLowerCase());
    
    if (brands.includes("microsoft edge")) return "Edge";
    if (brands.includes("opera")) return "Opera";
    if (brands.includes("google chrome")) return "Chrome";
    if (brands.includes("brave")) return "brave";

  }
}

// manual capture now lives in popup.html: chrome.action.onClicked never fires once
// the action has a default_popup, so the old listener here would be dead code.
// The socket path below is untouched - the app still pushes "capture" to sendTabs().
console.log(getBrowserFromBrands());

connectWS();

// MV3 kills this service worker after ~30s idle, dropping ws + its timers with it.
// chrome.alarms is the only thing guaranteed to wake it back up on a schedule.
chrome.alarms.create("ws-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "ws-keepalive") connectWS();
});
