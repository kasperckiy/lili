(function () {
    const settingsApi = globalThis.LiliProfileFetchSettings;
    if (!settingsApi) {
        return;
    }

    const {
        SETTINGS_STORAGE_KEY,
        DEFAULT_PROFILE_FETCH_SETTINGS,
        normalizeProfileFetchSettings
    } = settingsApi;

    const form = document.getElementById("settings-form");
    const statusNode = document.getElementById("status");
    const resetButton = document.getElementById("reset-button");

    const fields = {
        concurrency: document.getElementById("concurrency"),
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

    resetButton?.addEventListener("click", () => {
        applySettingsToForm(DEFAULT_PROFILE_FETCH_SETTINGS);
        void saveSettings("Defaults restored.");
    });

    void loadSettings();

    async function loadSettings() {
        try {
            const result = await chrome.storage.local.get([SETTINGS_STORAGE_KEY]);
            const settings = normalizeProfileFetchSettings(result?.[SETTINGS_STORAGE_KEY]);
            applySettingsToForm(settings);
            setStatus("Loaded current scheduler settings.");
        } catch (error) {
            console.warn("[LiLi] Failed to load popup settings", error);
            applySettingsToForm(DEFAULT_PROFILE_FETCH_SETTINGS);
            setStatus("Failed to load stored settings. Showing defaults.");
        }
    }

    async function saveSettings(successMessage = "Saved. New LinkedIn tabs will pick this up immediately.") {
        try {
            const settings = normalizeProfileFetchSettings(readSettingsFromForm());
            applySettingsToForm(settings);
            await chrome.storage.local.set({
                [SETTINGS_STORAGE_KEY]: settings
            });
            setStatus(successMessage);
        } catch (error) {
            console.warn("[LiLi] Failed to save popup settings", error);
            setStatus("Failed to save settings.");
        }
    }

    function readSettingsFromForm() {
        return {
            concurrency: fields.concurrency?.value,
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
        setFieldValue(fields.concurrency, normalizedSettings.concurrency);
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

    function setStatus(message) {
        if (statusNode) {
            statusNode.textContent = message;
        }
    }
})();