chrome.runtime.onInstalled.addListener((details) => {
    if (!details || (details.reason !== "install" && details.reason !== "update")) {
        return;
    }

    void reloadLinkedInTabs();
});

async function reloadLinkedInTabs() {
    try {
        const tabs = await chrome.tabs.query({
            url: ["https://www.linkedin.com/*"]
        });

        for (const tab of tabs) {
            if (!Number.isInteger(tab?.id)) {
                continue;
            }

            try {
                await chrome.tabs.reload(tab.id);
            } catch (error) {
                console.warn("[LiLi] Failed to reload LinkedIn tab after extension update", error);
            }
        }
    } catch (error) {
        console.warn("[LiLi] Failed to query LinkedIn tabs after extension update", error);
    }
}