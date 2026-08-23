function sendTabs() {
     chrome.tabs.query({},(tabs) =>{

        const urls = tabs.map(tab => tab.url);
        console.log("sending tabs:", urls);
        fetch("http://localhost:8765/tabs",{
            method:"POST",
            headers:{
                "Content-Type":"application/json"
            },
            body: JSON.stringify({urls:urls})
        })
        .then(() => console.log("tabs"))
        .catch(err => console.error("failed:", err));
        
    })
}
//manual click of extension
chrome.action.onClicked.addListener(() => {
    sendTabs()
});
//websocket for auto send to app
const ws = new WebSocket("ws://localhost:8765/ws");
ws.onmessage = (event) => {
    if (event.data === "capture") {
      sendTabs();
    }
};
ws.onopen = () => console.log("connected to Resume Work");
ws.onerror = (err) => console.error("ws error:", err);