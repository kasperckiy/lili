(function () {
    const PROFILE_STATUS_CACHE_KEY = "lili-profile-status-cache-v2";

    const statusNode = document.getElementById("status");
    const clearCacheButton = document.getElementById("clear-cache-button");
    const updatedNode = document.getElementById("runtime-updated");
    const cacheEntryNode = document.getElementById("runtime-cache-entry-count");
    let lastLoadedAt = 0;
    let refreshTimerId = 0;

    clearCacheButton?.addEventListener("click", () => {
        void clearStatusCache();
    });

    if (chrome.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === "local" && changes[PROFILE_STATUS_CACHE_KEY]) {
                void loadPendingCache();
            }
        });
    }

    void loadPendingCache();
    startUpdatedTicker();

    async function loadPendingCache() {
        try {
            const cacheValue = await readPendingCache();
            const pendingCount = countValidPendingEntries(cacheValue);
            if (cacheEntryNode) {
                cacheEntryNode.textContent = String(pendingCount);
            }

            lastLoadedAt = Date.now();
            renderUpdatedAt();
            setStatus("Loaded shared pending cache.");
        } catch (error) {
            console.warn("[LiLi] Failed to load popup cache", error);
            if (cacheEntryNode) {
                cacheEntryNode.textContent = "0";
            }
            lastLoadedAt = 0;
            renderUpdatedAt();
            setStatus("Failed to load pending cache.");
        }
    }

    async function readPendingCache() {
        if (chrome.storage?.local) {
            return await new Promise((resolve, reject) => {
                chrome.storage.local.get([PROFILE_STATUS_CACHE_KEY], (value) => {
                    const error = chrome.runtime?.lastError;
                    if (error) {
                        reject(new Error(error.message));
                        return;
                    }

                    const nextValue = value?.[PROFILE_STATUS_CACHE_KEY];
                    resolve(nextValue && typeof nextValue === "object" ? nextValue : {});
                });
            });
        }

        try {
            const rawValue = window.localStorage.getItem(PROFILE_STATUS_CACHE_KEY);
            if (!rawValue) {
                return {};
            }

            const parsedValue = JSON.parse(rawValue);
            return parsedValue && typeof parsedValue === "object" ? parsedValue : {};
        } catch {
            return {};
        }
    }

    async function clearStatusCache() {
        try {
            if (chrome.storage?.local) {
                await new Promise((resolve, reject) => {
                    chrome.storage.local.remove([PROFILE_STATUS_CACHE_KEY], () => {
                        const error = chrome.runtime?.lastError;
                        if (error) {
                            reject(new Error(error.message));
                            return;
                        }

                        resolve();
                    });
                });
            } else {
                window.localStorage.removeItem(PROFILE_STATUS_CACHE_KEY);
            }

            await loadPendingCache();
            setStatus("Pending cache cleared.");
        } catch (error) {
            console.warn("[LiLi] Failed to clear popup cache", error);
            setStatus("Failed to clear pending cache.");
        }
    }

    function countValidPendingEntries(cacheValue) {
        if (!cacheValue || typeof cacheValue !== "object") {
            return 0;
        }

        let count = 0;
        for (const record of Object.values(cacheValue)) {
            if (isValidPendingRecord(record)) {
                count += 1;
            }
        }

        return count;
    }

    function isValidPendingRecord(record) {
        return Boolean(record)
            && record.action === "pending";
    }

    function startUpdatedTicker() {
        window.clearInterval(refreshTimerId);
        refreshTimerId = window.setInterval(() => {
            renderUpdatedAt();
        }, 1000);
    }

    function renderUpdatedAt() {
        if (!updatedNode) {
            return;
        }

        updatedNode.textContent = lastLoadedAt > 0
            ? `Updated ${formatRelativeAge(lastLoadedAt)}`
            : "Waiting for data";
    }

    function formatRelativeAge(updatedAt) {
        const deltaSeconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
        if (deltaSeconds <= 1) {
            return "just now";
        }

        if (deltaSeconds < 60) {
            return `${deltaSeconds}s ago`;
        }

        const deltaMinutes = Math.round(deltaSeconds / 60);
        return `${deltaMinutes}m ago`;
    }

    function setStatus(message) {
        if (statusNode) {
            statusNode.textContent = message;
        }
    }
})();