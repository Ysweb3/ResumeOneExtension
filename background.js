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
function connectWS() {
    //websocket for auto send to app
    const ws = new WebSocket("ws://localhost:8765/ws");
     if (ws && ws.readyState === WebSocket.OPEN) return;
    ws.onopen = () => console.log("connected to Resume Work");
    ws.onmessage = (event) => {
        if (event.data === "capture") {
            sendTabs();
        }
    };
    ws.onclose = () => {
        console.log("disconnected, retrying in 3s...");
        setTimeout(connectWS, 3000);  // retry after 3 seconds
        
    };
    ws.onerror = (err) => console.error("ws error:", err);
}

function getBrowserFromBrands() {
  if (navigator.userAgentData && navigator.userAgentData.brands) {
    const brands = navigator.userAgentData.brands.map(b => b.brand.toLowerCase());
    
    if (brands.includes("microsoft edge")) return "Edge";
    if (brands.includes("opera")) return "Opera";
    if (brands.includes("google chrome")) return "Chrome";
    if (brands.includes("brave")) return "brave";

  }
  // Fallback to legacy string checking if API is unsupported
  return getDetailedBrowserName(); 
}


//manual click of extension
chrome.action.onClicked.addListener(() => {
    sendTabs()
});
console.log(getBrowserFromBrands());

connectWS();
