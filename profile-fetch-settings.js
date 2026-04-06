(function () {
    const SETTINGS_STORAGE_KEY = "lili-profile-fetch-settings-v1";
    const DEFAULT_PROFILE_FETCH_SETTINGS = Object.freeze({
        concurrency: 1,
        baseGapMs: 3000,
        jitterMinMs: 0,
        jitterMaxMs: 10000,
        scrollIdleMs: 1000,
        rollingBudgetMax: 8,
        rollingWindowMs: 5 * 60 * 1000,
        backoffCapMs: 10 * 60 * 1000
    });

    function toInteger(value, fallbackValue) {
        const numericValue = Number(value);
        return Number.isFinite(numericValue) ? Math.floor(numericValue) : fallbackValue;
    }

    function normalizeProfileFetchSettings(rawValue) {
        const candidate = rawValue && typeof rawValue === "object"
            ? rawValue
            : DEFAULT_PROFILE_FETCH_SETTINGS;

        const concurrency = Math.max(1, toInteger(candidate.concurrency, DEFAULT_PROFILE_FETCH_SETTINGS.concurrency));
        const baseGapMs = Math.max(0, toInteger(candidate.baseGapMs, DEFAULT_PROFILE_FETCH_SETTINGS.baseGapMs));
        const jitterMinMs = Math.max(0, toInteger(candidate.jitterMinMs, DEFAULT_PROFILE_FETCH_SETTINGS.jitterMinMs));
        const jitterMaxMs = Math.max(jitterMinMs, toInteger(candidate.jitterMaxMs, DEFAULT_PROFILE_FETCH_SETTINGS.jitterMaxMs));
        const scrollIdleMs = Math.max(0, toInteger(candidate.scrollIdleMs, DEFAULT_PROFILE_FETCH_SETTINGS.scrollIdleMs));
        const rollingBudgetMax = Math.max(1, toInteger(candidate.rollingBudgetMax, DEFAULT_PROFILE_FETCH_SETTINGS.rollingBudgetMax));
        const rollingWindowMs = Math.max(60 * 1000, toInteger(candidate.rollingWindowMs, DEFAULT_PROFILE_FETCH_SETTINGS.rollingWindowMs));
        const backoffCapMs = Math.max(1000, toInteger(candidate.backoffCapMs, DEFAULT_PROFILE_FETCH_SETTINGS.backoffCapMs));

        return {
            concurrency,
            baseGapMs,
            jitterMinMs,
            jitterMaxMs,
            scrollIdleMs,
            rollingBudgetMax,
            rollingWindowMs,
            backoffCapMs
        };
    }

    globalThis.LiliProfileFetchSettings = {
        SETTINGS_STORAGE_KEY,
        DEFAULT_PROFILE_FETCH_SETTINGS,
        normalizeProfileFetchSettings
    };
})();