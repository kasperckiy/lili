(function () {
    const settingsApi = globalThis.LiliProfileFetchSettings;
    if (!settingsApi) {
        return;
    }

    const {
        SETTINGS_STORAGE_KEY,
        RUNTIME_STATS_STORAGE_KEY_PREFIX,
        RUNTIME_STATS_STALE_MS,
        DEFAULT_PROFILE_FETCH_SETTINGS,
        normalizeProfileFetchSettings
    } = settingsApi;
    const PROFILE_STATUS_CACHE_KEY = "lili-profile-status-cache-v2";

    const form = document.getElementById("settings-form");
    const statusNode = document.getElementById("status");
    const saveButton = document.getElementById("save-button");
    const resetButton = document.getElementById("reset-button");
    const clearCacheButton = document.getElementById("clear-cache-button");
    const runtimeNodes = {
        queuedCount: document.getElementById("runtime-queued-count"),
        activeCount: document.getElementById("runtime-active-count"),
        tabCount: document.getElementById("runtime-tab-count"),
        successfulCheckCount: document.getElementById("runtime-successful-check-count"),
        cacheEntryCount: document.getElementById("runtime-cache-entry-count"),
        meta: document.getElementById("runtime-meta"),
        updated: document.getElementById("runtime-updated"),
        waitGate: document.getElementById("runtime-wait-gate"),
        gapWait: document.getElementById("runtime-gap-wait"),
        cooldownWait: document.getElementById("runtime-cooldown-wait"),
        idleWait: document.getElementById("runtime-idle-wait"),
        budgetWait: document.getElementById("runtime-budget-wait"),
        nextDrain: document.getElementById("runtime-next-drain"),
        schedulerJobs: document.getElementById("runtime-scheduler-jobs"),
        oldestQueued: document.getElementById("runtime-oldest-queued"),
        recentStarts: document.getElementById("runtime-recent-starts"),
        failureCount: document.getElementById("runtime-failure-count"),
        failedTotal: document.getElementById("runtime-failed-total"),
        leaseCount: document.getElementById("runtime-lease-count"),
        lastFailure: document.getElementById("runtime-last-failure"),
        lastSuccess: document.getElementById("runtime-last-success"),
        failureChallenge: document.getElementById("runtime-failure-challenge"),
        failureRateLimit: document.getElementById("runtime-failure-rate-limit"),
        failureTimeout: document.getElementById("runtime-failure-timeout"),
        failureForbidden: document.getElementById("runtime-failure-forbidden"),
        failureServer: document.getElementById("runtime-failure-server"),
        failureParse: document.getElementById("runtime-failure-parse"),
        failureOther: document.getElementById("runtime-failure-other"),
        settingWorkerCount: document.getElementById("runtime-setting-worker-count"),
        settingBaseGap: document.getElementById("runtime-setting-base-gap"),
        settingJitter: document.getElementById("runtime-setting-jitter"),
        settingScrollIdle: document.getElementById("runtime-setting-scroll-idle"),
        settingBudget: document.getElementById("runtime-setting-budget"),
        settingBackoffCap: document.getElementById("runtime-setting-backoff-cap")
    };

    let lastRuntimeSnapshot = null;
    let runtimeTickerId = 0;
    let isSettingsFormDirty = false;
    let isSettingsLoadComplete = false;

    const fields = {
        workerCount: document.getElementById("workerCount"),
        baseGapMs: document.getElementById("baseGapMs"),
        jitterMinMs: document.getElementById("jitterMinMs"),
        jitterMaxMs: document.getElementById("jitterMaxMs"),
        scrollIdleMs: document.getElementById("scrollIdleMs"),
        rollingBudgetMax: document.getElementById("rollingBudgetMax"),
        rollingWindowMinutes: document.getElementById("rollingWindowMinutes"),
        backoffCapMinutes: document.getElementById("backoffCapMinutes")
    };

    form?.addEventListener("submit", (event) => {
        event.preventDefault();
        void saveSettings();
    });

    Object.values(fields).forEach((field) => {
        field?.addEventListener("input", () => {
            isSettingsFormDirty = true;
        });
        field?.addEventListener("change", () => {
            isSettingsFormDirty = true;
        });
    });

    resetButton?.addEventListener("click", () => {
        applySettingsToForm(DEFAULT_PROFILE_FETCH_SETTINGS);
        isSettingsFormDirty = false;
        void saveSettings("Defaults restored.");
    });

    clearCacheButton?.addEventListener("click", () => {
        void clearStatusCache();
    });

    setSettingsFormEnabled(false);

    if (chrome.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== "local") {
                return;
            }

            if (changes[SETTINGS_STORAGE_KEY]) {
                void loadSettings();
            }

            if (changes[PROFILE_STATUS_CACHE_KEY] || Object.keys(changes).some((key) => key.startsWith(RUNTIME_STATS_STORAGE_KEY_PREFIX))) {
                void loadRuntimeStats();
            }
        });
    }

    void loadSettings();
    void loadRuntimeStats();
    startRuntimeTicker();

    async function loadSettings() {
        try {
            const result = await chrome.storage.local.get([SETTINGS_STORAGE_KEY]);
            const settings = normalizeProfileFetchSettings(result?.[SETTINGS_STORAGE_KEY]);
            if (isSettingsFormDirty && isSettingsLoadComplete) {
                return;
            }
            applySettingsToForm(settings);
            isSettingsFormDirty = false;
            isSettingsLoadComplete = true;
            setSettingsFormEnabled(true);
            setStatus("Loaded current scheduler settings.");
        } catch (error) {
            console.warn("[LiLi] Failed to load popup settings", error);
            applySettingsToForm(DEFAULT_PROFILE_FETCH_SETTINGS);
            isSettingsFormDirty = false;
            isSettingsLoadComplete = true;
            setSettingsFormEnabled(true);
            setStatus("Failed to load stored settings. Showing defaults.");
        }
    }

    async function saveSettings(successMessage = "Saved. New LinkedIn tabs will pick this up immediately.") {
        try {
            const settings = normalizeProfileFetchSettings(readSettingsFromForm());
            applySettingsToForm(settings);
            isSettingsFormDirty = false;
            await chrome.storage.local.set({
                [SETTINGS_STORAGE_KEY]: settings
            });
            setStatus(successMessage);
        } catch (error) {
            console.warn("[LiLi] Failed to save popup settings", error);
            setStatus("Failed to save settings.");
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
            lastRuntimeSnapshot = null;
            await loadRuntimeStats();
            setStatus("Status cache cleared.");
        } catch (error) {
            console.warn("[LiLi] Failed to clear popup cache", error);
            setStatus("Failed to clear status cache.");
        }
    }

    async function loadRuntimeStats() {
        try {
            const snapshot = await readRuntimeStatsSnapshot();
            lastRuntimeSnapshot = snapshot;
            renderRuntimeStats(snapshot);
            if (snapshot.staleKeys.length > 0) {
                void removeStaleRuntimeStats(snapshot.staleKeys);
            }
        } catch (error) {
            console.warn("[LiLi] Failed to load popup runtime stats", error);
            const fallbackSnapshot = {
                queuedCount: 0,
                activeCount: 0,
                tabCount: 0,
                successfulCheckCount: 0,
                cacheEntryCount: 0,
                totalFailedCheckCount: 0,
                failureCounts: createEmptyFailureCounts(),
                latestUpdatedAt: 0,
                staleKeys: []
            };
            lastRuntimeSnapshot = fallbackSnapshot;
            renderRuntimeStats(fallbackSnapshot);
        }
    }

    async function readRuntimeStatsSnapshot() {
        const storageItems = chrome.storage?.local
            ? await new Promise((resolve, reject) => {
                chrome.storage.local.get(null, (value) => {
                    const error = chrome.runtime?.lastError;
                    if (error) {
                        reject(new Error(error.message));
                        return;
                    }

                    resolve(value || {});
                });
            })
            : {};

        const now = Date.now();
        const snapshot = {
            queuedCount: 0,
            activeCount: 0,
            tabCount: 0,
            successfulCheckCount: 0,
            cacheEntryCount: countValidCacheEntries(storageItems[PROFILE_STATUS_CACHE_KEY], now),
            totalFailedCheckCount: 0,
            failureCounts: createEmptyFailureCounts(),
            latestUpdatedAt: 0,
            staleKeys: [],
            primaryTab: null
        };

        for (const [key, value] of Object.entries(storageItems)) {
            if (!key.startsWith(RUNTIME_STATS_STORAGE_KEY_PREFIX)) {
                continue;
            }

            if (!value || typeof value !== "object") {
                snapshot.staleKeys.push(key);
                continue;
            }

            const updatedAt = Number(value.updatedAt || 0);
            if (!Number.isFinite(updatedAt) || updatedAt <= now - RUNTIME_STATS_STALE_MS || value.pageMode !== "group-members") {
                snapshot.staleKeys.push(key);
                continue;
            }

            const queuedCount = Number(value.queuedCount || 0);
            const activeCount = Number(value.activeCount || 0);
            const successfulCheckCount = Number(value.successfulCheckCount || 0);
            const totalFailedCheckCount = Number(value.totalFailedCheckCount || 0);
            snapshot.queuedCount += Number.isFinite(queuedCount) && queuedCount > 0 ? queuedCount : 0;
            snapshot.activeCount += Number.isFinite(activeCount) && activeCount > 0 ? activeCount : 0;
            snapshot.successfulCheckCount += Number.isFinite(successfulCheckCount) && successfulCheckCount > 0 ? successfulCheckCount : 0;
            snapshot.totalFailedCheckCount += Number.isFinite(totalFailedCheckCount) && totalFailedCheckCount > 0 ? totalFailedCheckCount : 0;
            accumulateFailureCounts(snapshot.failureCounts, value.failureCounts);
            snapshot.tabCount += 1;
            snapshot.latestUpdatedAt = Math.max(snapshot.latestUpdatedAt, updatedAt);

            if (!snapshot.primaryTab || updatedAt >= (snapshot.primaryTab.updatedAt || 0)) {
                snapshot.primaryTab = value;
            }
        }

        return snapshot;
    }

    async function removeStaleRuntimeStats(keys) {
        if (!chrome.storage?.local || keys.length === 0) {
            return;
        }

        await new Promise((resolve, reject) => {
            chrome.storage.local.remove(keys, () => {
                const error = chrome.runtime?.lastError;
                if (error) {
                    reject(new Error(error.message));
                    return;
                }

                resolve();
            });
        });
    }

    function renderRuntimeStats(snapshot) {
        setRuntimeValue(runtimeNodes.queuedCount, snapshot.queuedCount);
        setRuntimeValue(runtimeNodes.activeCount, snapshot.activeCount);
        setRuntimeValue(runtimeNodes.tabCount, snapshot.tabCount);
        setRuntimeValue(runtimeNodes.successfulCheckCount, snapshot.successfulCheckCount);
        setRuntimeValue(runtimeNodes.cacheEntryCount, snapshot.cacheEntryCount);
        setRuntimeValue(runtimeNodes.failedTotal, snapshot.totalFailedCheckCount);

        if (runtimeNodes.meta) {
            runtimeNodes.meta.textContent = snapshot.tabCount > 0
                ? `Reporting tabs: ${snapshot.tabCount}. Queue is aggregated across active LinkedIn group pages; cache is shared across supported LinkedIn pages.`
                : "Open a LinkedIn group members tab to see live queue stats. Cache count is shared across supported LinkedIn pages.";
        }

        if (runtimeNodes.updated) {
            runtimeNodes.updated.textContent = snapshot.latestUpdatedAt > 0
                ? `Updated ${formatRelativeAge(snapshot.latestUpdatedAt)}`
                : "Waiting for data";
        }

        renderRuntimeDebugDetails(snapshot.primaryTab);
    }

    function renderRuntimeDebugDetails(primaryTab) {
        const tab = primaryTab && typeof primaryTab === "object" ? primaryTab : null;

        const gapWaitMs = getCountdownMs(tab?.nextAllowedStartAt || 0);
        const cooldownWaitMs = getCountdownMs(tab?.cooldownUntil || 0);
        const idleWaitMs = getCountdownMs(tab?.idleUntil || 0);
        const budgetWaitMs = getCountdownMs(tab?.budgetBlockedUntil || 0);
        const nextDrainMs = getCountdownMs(tab?.scheduledDrainAt || 0);
        const oldestQueuedMs = getAgeMs(tab?.oldestQueuedAt || 0);
        const lastSuccessMs = getAgeMs(tab?.lastSuccessfulCheckAt || 0);

        setRuntimeValue(runtimeNodes.waitGate, describeWaitGate(tab, { gapWaitMs, cooldownWaitMs, idleWaitMs, budgetWaitMs }));
        setRuntimeValue(runtimeNodes.gapWait, formatDuration(gapWaitMs));
        setRuntimeValue(runtimeNodes.cooldownWait, formatDuration(cooldownWaitMs));
        setRuntimeValue(runtimeNodes.idleWait, formatDuration(idleWaitMs));
        setRuntimeValue(runtimeNodes.budgetWait, formatDuration(budgetWaitMs));
        setRuntimeValue(runtimeNodes.nextDrain, tab?.scheduledDrainAt ? formatDuration(nextDrainMs) : "not scheduled");
        setRuntimeValue(runtimeNodes.schedulerJobs, `${Number(tab?.schedulerActiveCount || 0)} / ${getConfiguredWorkerCount(tab)}`);
        setRuntimeValue(runtimeNodes.oldestQueued, tab?.oldestQueuedAt ? formatDuration(oldestQueuedMs) : "none");
        setRuntimeValue(runtimeNodes.recentStarts, `${Number(tab?.recentFetchStartsCount || 0)} / ${Number(tab?.rollingBudgetMax || 0)}`);
        setRuntimeValue(runtimeNodes.failureCount, Number(tab?.failureCount || 0));
        setRuntimeValue(runtimeNodes.failedTotal, Number(tab?.totalFailedCheckCount || 0));
        setRuntimeValue(runtimeNodes.leaseCount, Number(tab?.leaseCount || 0));
        setRuntimeValue(runtimeNodes.lastFailure, describeLastFailure(tab));
        setRuntimeValue(runtimeNodes.lastSuccess, tab?.lastSuccessfulCheckAt ? `${formatDuration(lastSuccessMs)} ago` : "never");
        setRuntimeValue(runtimeNodes.failureChallenge, Number(tab?.failureCounts?.challenge || 0));
        setRuntimeValue(runtimeNodes.failureRateLimit, Number(tab?.failureCounts?.["rate-limit"] || 0));
        setRuntimeValue(runtimeNodes.failureTimeout, Number(tab?.failureCounts?.timeout || 0));
        setRuntimeValue(runtimeNodes.failureForbidden, Number(tab?.failureCounts?.forbidden || 0));
        setRuntimeValue(runtimeNodes.failureServer, Number(tab?.failureCounts?.server || 0));
        setRuntimeValue(runtimeNodes.failureParse, Number(tab?.failureCounts?.parse || 0));
        setRuntimeValue(runtimeNodes.failureOther, Number(tab?.failureCounts?.other || 0));
        setRuntimeValue(runtimeNodes.settingWorkerCount, getConfiguredWorkerCount(tab));
        setRuntimeValue(runtimeNodes.settingBaseGap, formatDuration(Number(tab?.baseGapMs || 0)));
        setRuntimeValue(runtimeNodes.settingJitter, `${formatDuration(Number(tab?.jitterMinMs || 0))}-${formatDuration(Number(tab?.jitterMaxMs || 0))}`);
        setRuntimeValue(runtimeNodes.settingScrollIdle, formatDuration(Number(tab?.scrollIdleMs || 0)));
        setRuntimeValue(runtimeNodes.settingBudget, `${Number(tab?.rollingBudgetMax || 0)} / ${formatDuration(Number(tab?.rollingWindowMs || 0))}`);
        setRuntimeValue(runtimeNodes.settingBackoffCap, formatDuration(Number(tab?.backoffCapMs || 0)));
    }

    function startRuntimeTicker() {
        window.clearInterval(runtimeTickerId);
        runtimeTickerId = window.setInterval(() => {
            if (lastRuntimeSnapshot) {
                renderRuntimeStats(lastRuntimeSnapshot);
            }
        }, 1000);
    }

    function createEmptyFailureCounts() {
        return {
            challenge: 0,
            "rate-limit": 0,
            timeout: 0,
            forbidden: 0,
            server: 0,
            parse: 0,
            other: 0
        };
    }

    function countValidCacheEntries(cacheValue, now) {
        if (!cacheValue || typeof cacheValue !== "object") {
            return 0;
        }

        let count = 0;
        for (const record of Object.values(cacheValue)) {
            if (isValidCacheRecord(record, now)) {
                count += 1;
            }
        }

        return count;
    }

    function isValidCacheRecord(record, now) {
        return Boolean(record)
            && (record.action === "pending" || record.action === "connect")
            && Number.isFinite(record.expiresAt)
            && record.expiresAt > now;
    }

    function accumulateFailureCounts(target, source) {
        if (!source || typeof source !== "object") {
            return;
        }

        for (const key of Object.keys(target)) {
            const nextValue = Number(source[key] || 0);
            target[key] += Number.isFinite(nextValue) && nextValue > 0 ? nextValue : 0;
        }
    }

    function describeLastFailure(tab) {
        if (!tab?.lastFailureCode) {
            return "none";
        }

        const ageText = tab.lastFailureAt ? ` ${formatDuration(getAgeMs(tab.lastFailureAt))} ago` : "";
        return `${String(tab.lastFailureCode)}${ageText}`;
    }

    function describeWaitGate(tab, waits) {
        if (!tab || Number(tab.queuedCount || 0) <= 0) {
            return "idle";
        }

        const workerCount = getConfiguredWorkerCount(tab);
        if (Number(tab.schedulerActiveCount || 0) >= workerCount && workerCount > 0) {
            return "workers";
        }

        const waitEntries = [
            ["cooldown", waits.cooldownWaitMs],
            ["budget", waits.budgetWaitMs],
            ["gap", waits.gapWaitMs],
            ["idle", waits.idleWaitMs]
        ];

        let selectedGate = "ready";
        let selectedWaitMs = 0;
        for (const [gate, waitMs] of waitEntries) {
            if (waitMs > selectedWaitMs) {
                selectedGate = gate;
                selectedWaitMs = waitMs;
            }
        }

        if (tab.draining) {
            return selectedWaitMs > 0 ? `${selectedGate} + draining` : "draining";
        }

        return selectedGate;
    }

    function getCountdownMs(timestamp) {
        return Math.max(0, Number(timestamp || 0) - Date.now());
    }

    function getAgeMs(timestamp) {
        return Math.max(0, Date.now() - Number(timestamp || 0));
    }

    function formatDuration(durationMs) {
        const normalizedMs = Math.max(0, Math.floor(Number(durationMs || 0)));
        if (normalizedMs < 1000) {
            return `${normalizedMs}ms`;
        }

        const totalSeconds = Math.floor(normalizedMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        }

        return `${totalSeconds}s`;
    }

    function setRuntimeValue(node, value) {
        if (node) {
            node.textContent = String(value);
        }
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

    function readSettingsFromForm() {
        return {
            workerCount: fields.workerCount?.value,
            baseGapMs: fields.baseGapMs?.value,
            jitterMinMs: fields.jitterMinMs?.value,
            jitterMaxMs: fields.jitterMaxMs?.value,
            scrollIdleMs: fields.scrollIdleMs?.value,
            rollingBudgetMax: fields.rollingBudgetMax?.value,
            rollingWindowMs: Number(fields.rollingWindowMinutes?.value || 0) * 60 * 1000,
            backoffCapMs: Number(fields.backoffCapMinutes?.value || 0) * 60 * 1000
        };
    }

    function applySettingsToForm(settings) {
        const normalizedSettings = normalizeProfileFetchSettings(settings);
        setFieldValue(fields.workerCount, normalizedSettings.workerCount || normalizedSettings.concurrency);
        setFieldValue(fields.baseGapMs, normalizedSettings.baseGapMs);
        setFieldValue(fields.jitterMinMs, normalizedSettings.jitterMinMs);
        setFieldValue(fields.jitterMaxMs, normalizedSettings.jitterMaxMs);
        setFieldValue(fields.scrollIdleMs, normalizedSettings.scrollIdleMs);
        setFieldValue(fields.rollingBudgetMax, normalizedSettings.rollingBudgetMax);
        setFieldValue(fields.rollingWindowMinutes, normalizedSettings.rollingWindowMs / (60 * 1000));
        setFieldValue(fields.backoffCapMinutes, normalizedSettings.backoffCapMs / (60 * 1000));
    }

    function setFieldValue(field, value) {
        if (field instanceof HTMLInputElement) {
            field.value = String(value);
        }
    }

    function setSettingsFormEnabled(enabled) {
        const disabled = !enabled;
        Object.values(fields).forEach((field) => {
            if (field instanceof HTMLInputElement) {
                field.disabled = disabled;
            }
        });

        if (saveButton instanceof HTMLButtonElement) {
            saveButton.disabled = disabled;
        }

        if (resetButton instanceof HTMLButtonElement) {
            resetButton.disabled = disabled;
        }
    }

    function getConfiguredWorkerCount(tab) {
        const workerCount = Number(tab?.workerCount || tab?.concurrency || 0);
        return Number.isFinite(workerCount) && workerCount > 0 ? workerCount : 0;
    }

    function setStatus(message) {
        if (statusNode) {
            statusNode.textContent = message;
        }
    }
})();