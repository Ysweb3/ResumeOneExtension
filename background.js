chrome.action.onClicked.addListener(() => {
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
});