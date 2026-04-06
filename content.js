(async () => {
    const LINKEDIN_ORIGIN = "https://www.linkedin.com";
    const GROUP_MEMBERS_PATH_PATTERN = /^\/groups\/[^/]+\/members(?:\/|$)/;
    const PROFILE_PAGE_PATH_PATTERN = /^\/in\/[^/]+(?:\/|$)/;
    const SENT_INVITATIONS_PATH_PATTERN = /^\/mynetwork\/invitation-manager\/sent(?:\/|$)/;
    const CARD_SELECTOR = "li.groups-members-list__typeahead-result";
    const PROFILE_LINK_SELECTOR = "a.ui-conditional-link-wrapper.ui-entity-action-row__link[href]";
    const SENT_INVITATION_PROFILE_LINK_SELECTOR = "main a[href*='/in/']";
    const PRELOAD_FRAME_SELECTOR = "iframe[src*='/preload/']";
    const DEGREE_SELECTOR = ".artdeco-entity-lockup__degree";
    const NAME_SELECTOR = ".entity-action-title";
    const ACTION_SELECTOR = ".entry-point .lili-connect-action, .entry-point .lili-pending-action, .entry-point .lili-sending-action, .entry-point .lili-loading-action, .entry-point button.artdeco-button[aria-label*='Message'], .entry-point a[aria-label*='Message']";
    const OBSERVER_MARGIN_PX = 300;
    const OBSERVER_MARGIN = `${OBSERVER_MARGIN_PX}px`;
    const NETWORK_HINT_EVENT = "lili:relationship-hints";
    const INVITE_API_PATH = "/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2";
    const PROFILE_FETCH_TIMEOUT_MS = 15000;
    const PROFILE_FETCH_BACKOFF_INITIAL_MS = 30000;
    const PROFILE_FETCH_LEASE_TTL_MS = PROFILE_FETCH_TIMEOUT_MS + 5000;
    const PROFILE_FETCH_LEASE_RETRY_MIN_MS = 1000;
    const profileFetchSettingsApi = globalThis.LiliProfileFetchSettings || null;
    const PROFILE_FETCH_SETTINGS_KEY = profileFetchSettingsApi?.SETTINGS_STORAGE_KEY || "lili-profile-fetch-settings-v1";
    const PROFILE_FETCH_RUNTIME_KEY_PREFIX = profileFetchSettingsApi?.RUNTIME_STATS_STORAGE_KEY_PREFIX || "lili-profile-fetch-runtime-v1:";
    const DEFAULT_PROFILE_FETCH_SETTINGS = profileFetchSettingsApi?.DEFAULT_PROFILE_FETCH_SETTINGS || {
        workerCount: 2,
        concurrency: 2,
        baseGapMs: 3000,
        jitterMinMs: 100,
        jitterMaxMs: 10000,
        scrollIdleMs: 1000,
        rollingBudgetMax: 15,
        rollingWindowMs: 2 * 60 * 1000,
        backoffCapMs: 10 * 60 * 1000
    };
    const PROFILE_STATUS_CACHE_KEY = "lili-profile-status-cache-v2";
    const PROFILE_FETCH_SCHEDULER_KEY = "lili-profile-fetch-scheduler-v1";
    const PROFILE_STATUS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
    const PROFILE_PAGE_SYNC_DEBOUNCE_MS = 250;
    const SENT_INVITATIONS_SYNC_DEBOUNCE_MS = 250;
    const ROUTE_WATCH_INTERVAL_MS = 500;

    const pageLifecycleState = createPageLifecycleState();
    const relationshipHints = new Map();
    const cardsBySlug = new Map();
    const inviteStateBySlug = new Map();
    const profileStatusBySlug = new Map();
    const profileProbeStateBySlug = new Map();
    const profileFetchSettingsState = createProfileFetchSettingsState();
    const profileFetchSchedulerState = createProfileFetchSchedulerState();
    const profileStatusCacheReady = loadProfileStatusCache();
    const profileFetchSettingsReady = loadProfileFetchSettings();
    const profileFetchSchedulerReady = loadProfileFetchSchedulerState();
    const profilePageSyncState = {
        timeoutId: 0,
        observer: null,
        observedDocument: null
    };
    const sentInvitationsSyncState = {
        timeoutId: 0,
        observer: null,
        observedDocument: null
    };

    const intersectionObserver = new IntersectionObserver(handleIntersections, {
        root: null,
        rootMargin: OBSERVER_MARGIN,
        threshold: 0
    });

    const mutationObserver = new MutationObserver((mutations) => {
        const touchedCards = new Set();

        for (const mutation of mutations) {
            const targetCard = mutation.target instanceof Element
                ? mutation.target.closest(CARD_SELECTOR)
                : null;
            if (targetCard instanceof HTMLElement) {
                touchedCards.add(targetCard);
            }

            for (const node of mutation.addedNodes) {
                if (!(node instanceof Element)) {
                    continue;
                }

                const closestCard = node.closest?.(CARD_SELECTOR);
                if (closestCard instanceof HTMLElement) {
                    touchedCards.add(closestCard);
                }

                if (node.matches?.(CARD_SELECTOR)) {
                    touchedCards.add(node);
                }

                node.querySelectorAll?.(CARD_SELECTOR).forEach((card) => {
                    touchedCards.add(card);
                });
            }
        }

        touchedCards.forEach(reconcileCardMutation);
    });

    installProfileStatusCacheObserver();
    installRouteChangeObserver();
    void refreshPageMode();

    function createPageLifecycleState() {
        return {
            currentMode: "unsupported",
            lastUrl: "",
            routeTimerId: 0,
            routeWatchIntervalId: 0,
            activePageDocument: null,
            groupMembersInitialized: false,
            groupMembersObservedDocument: null,
            profilePageSyncInitialized: false,
            sentInvitationsSyncInitialized: false,
            networkHintTargetWindow: null
        };
    }

    function installRouteChangeObserver() {
        wrapHistoryMethod("pushState");
        wrapHistoryMethod("replaceState");
        window.addEventListener("popstate", schedulePageModeRefresh);
        window.addEventListener("hashchange", schedulePageModeRefresh);
        window.addEventListener("pageshow", schedulePageModeRefresh);
        window.addEventListener("focus", schedulePageModeRefresh);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        window.addEventListener("click", schedulePageModeRefresh, true);

        pageLifecycleState.routeWatchIntervalId = window.setInterval(() => {
            if (pageLifecycleState.lastUrl !== window.location.href
                || pageLifecycleState.activePageDocument !== getActivePageDocument()) {
                schedulePageModeRefresh();
            }
        }, ROUTE_WATCH_INTERVAL_MS);
    }

    function handleVisibilityChange() {
        if (document.visibilityState === "visible") {
            schedulePageModeRefresh();
        }
    }

    function wrapHistoryMethod(methodName) {
        const originalMethod = history[methodName];
        if (typeof originalMethod !== "function") {
            return;
        }

        history[methodName] = function (...args) {
            const result = originalMethod.apply(this, args);
            schedulePageModeRefresh();
            return result;
        };
    }

    function schedulePageModeRefresh() {
        window.clearTimeout(pageLifecycleState.routeTimerId);
        pageLifecycleState.routeTimerId = window.setTimeout(() => {
            pageLifecycleState.routeTimerId = 0;
            void refreshPageMode();
        }, 0);
    }

    async function refreshPageMode() {
        const nextUrl = window.location.href;
        const nextMode = getPageMode();
        const nextDocument = getActivePageDocument(nextMode);
        const previousMode = pageLifecycleState.currentMode;
        const didModeChange = previousMode !== nextMode;
        const didUrlChange = pageLifecycleState.lastUrl !== nextUrl;
        const didDocumentChange = pageLifecycleState.activePageDocument !== nextDocument;

        if (!didModeChange && !didUrlChange && !didDocumentChange) {
            return;
        }

        pageLifecycleState.lastUrl = nextUrl;
        pageLifecycleState.currentMode = nextMode;
        pageLifecycleState.activePageDocument = nextDocument;

        if (previousMode === "group-members" && nextMode !== "group-members") {
            mutationObserver.disconnect();
            pageLifecycleState.groupMembersObservedDocument = null;
            setNetworkHintTargetWindow(null);
            void clearProfileFetchRuntimeStats();
        }

        if (nextMode === "group-members") {
            activateGroupMembersPage(nextDocument);
            return;
        }

        if (nextMode === "profile-page") {
            await initializeProfilePageSync(nextDocument);
            return;
        }

        if (nextMode === "sent-invitations") {
            await initializeSentInvitationsSync(nextDocument);
        }
    }

    function activateGroupMembersPage(targetDocument = getActivePageDocument("group-members")) {
        if (!pageLifecycleState.groupMembersInitialized) {
            pageLifecycleState.groupMembersInitialized = true;
            initializeProfileFetchScheduler();
        }

        injectNetworkObserver(targetDocument);
        setNetworkHintTargetWindow(getDocumentWindow(targetDocument));

        if (targetDocument?.body && pageLifecycleState.groupMembersObservedDocument !== targetDocument) {
            mutationObserver.disconnect();
            mutationObserver.observe(targetDocument.body, { childList: true, subtree: true });
            pageLifecycleState.groupMembersObservedDocument = targetDocument;
        }

        scanCards(targetDocument);
        scheduleProfileFetchQueueDrain();
        scheduleProfileFetchRuntimeStatsPublish();
    }

    function getActivePageDocument(mode = pageLifecycleState.currentMode) {
        if (mode !== "group-members" && mode !== "profile-page" && mode !== "sent-invitations") {
            return document;
        }

        return getEmbeddedPreloadDocument() || document;
    }

    function getEmbeddedPreloadDocument() {
        const preloadFrame = document.querySelector(PRELOAD_FRAME_SELECTOR);
        if (!(preloadFrame instanceof HTMLIFrameElement)) {
            return null;
        }

        try {
            const frameDocument = preloadFrame.contentDocument;
            return frameDocument?.documentElement ? frameDocument : null;
        } catch {
            return null;
        }
    }

    function getDocumentWindow(targetDocument) {
        return targetDocument?.defaultView || window;
    }

    function setNetworkHintTargetWindow(targetWindow) {
        const previousWindow = pageLifecycleState.networkHintTargetWindow;
        if (previousWindow && previousWindow !== targetWindow) {
            previousWindow.removeEventListener(NETWORK_HINT_EVENT, handleNetworkHints);
        }

        if (targetWindow && previousWindow !== targetWindow) {
            targetWindow.addEventListener(NETWORK_HINT_EVENT, handleNetworkHints);
        }

        pageLifecycleState.networkHintTargetWindow = targetWindow || null;
    }

    function getPageMode() {
        const pathName = window.location.pathname || "";

        if (GROUP_MEMBERS_PATH_PATTERN.test(pathName)) {
            return "group-members";
        }

        if (PROFILE_PAGE_PATH_PATTERN.test(pathName)) {
            return "profile-page";
        }

        if (SENT_INVITATIONS_PATH_PATTERN.test(pathName)) {
            return "sent-invitations";
        }

        return "unsupported";
    }

    async function initializeProfilePageSync(targetDocument = getActivePageDocument("profile-page")) {
        await profileStatusCacheReady;
        await syncCurrentProfilePageCache(targetDocument);

        if (!profilePageSyncState.observer) {
            profilePageSyncState.observer = new MutationObserver(() => {
                scheduleProfilePageSync();
            });
        }

        if (pageLifecycleState.profilePageSyncInitialized && profilePageSyncState.observedDocument === targetDocument) {
            return;
        }

        pageLifecycleState.profilePageSyncInitialized = true;
        profilePageSyncState.observer.disconnect();
        if (targetDocument?.body) {
            profilePageSyncState.observer.observe(targetDocument.body, { childList: true, subtree: true });
            profilePageSyncState.observedDocument = targetDocument;
        }
    }

    function scheduleProfilePageSync() {
        window.clearTimeout(profilePageSyncState.timeoutId);
        profilePageSyncState.timeoutId = window.setTimeout(() => {
            void syncCurrentProfilePageCache(getActivePageDocument("profile-page"));
        }, PROFILE_PAGE_SYNC_DEBOUNCE_MS);
    }

    async function syncCurrentProfilePageCache(targetDocument = getActivePageDocument("profile-page")) {
        const profileSlug = getProfileSlug(window.location.href);
        if (!profileSlug) {
            return;
        }

        const htmlDocument = targetDocument?.documentElement?.outerHTML || document.documentElement.outerHTML;
        const profileRecord = getProfileDocumentRecord(htmlDocument);
        const didChange = profileRecord.action === "pending"
            ? applyPendingStatus(profileSlug, "profile-page", profileRecord.profileUrn)
            : applyConnectStatus(profileSlug, "profile-page", profileRecord.profileUrn);

        if (!didChange) {
            return;
        }

        await persistProfileStatusCache();
        rerenderAllCards();
    }

    async function initializeSentInvitationsSync(targetDocument = getActivePageDocument("sent-invitations")) {
        await profileStatusCacheReady;
        await syncSentInvitationsCache(targetDocument);

        if (!sentInvitationsSyncState.observer) {
            sentInvitationsSyncState.observer = new MutationObserver(() => {
                scheduleSentInvitationsSync();
            });
        }

        if (pageLifecycleState.sentInvitationsSyncInitialized && sentInvitationsSyncState.observedDocument === targetDocument) {
            return;
        }

        pageLifecycleState.sentInvitationsSyncInitialized = true;
        sentInvitationsSyncState.observer.disconnect();
        if (targetDocument?.body) {
            sentInvitationsSyncState.observer.observe(targetDocument.body, { childList: true, subtree: true });
            sentInvitationsSyncState.observedDocument = targetDocument;
        }
    }

    function scheduleSentInvitationsSync() {
        window.clearTimeout(sentInvitationsSyncState.timeoutId);
        sentInvitationsSyncState.timeoutId = window.setTimeout(() => {
            void syncSentInvitationsCache(getActivePageDocument("sent-invitations"));
        }, SENT_INVITATIONS_SYNC_DEBOUNCE_MS);
    }

    function initializeProfileFetchScheduler() {
        installProfileFetchSettingsObserver();
        installProfileFetchSchedulerObserver();
        window.addEventListener("scroll", handleProfileFetchScroll, { passive: true });
        window.addEventListener("pagehide", handleProfileFetchPageHide);
        void profileFetchSettingsReady;
        void profileFetchSchedulerReady;
        scheduleProfileFetchRuntimeStatsPublish();
    }

    function createProfileFetchSettingsState() {
        return {
            values: normalizeProfileFetchSettings(DEFAULT_PROFILE_FETCH_SETTINGS)
        };
    }

    function createProfileFetchSchedulerState() {
        return {
            tabId: createTabInstanceId(),
            queue: [],
            jobsBySlug: new Map(),
            workers: createProfileFetchWorkers(profileFetchSettingsState.values.workerCount),
            activeRequestCount: 0,
            successfulCheckCount: 0,
            lastSuccessfulCheckAt: 0,
            totalFailedCheckCount: 0,
            lastFailureCode: "",
            lastFailureAt: 0,
            failureCounts: createEmptyProfileFetchFailureCounts(),
            timerId: 0,
            scheduledDrainAt: 0,
            draining: false,
            runtimeStatsTimerId: 0,
            lastScrollAt: Date.now(),
            failureCount: 0,
            storageMutationPromise: Promise.resolve(),
            syncedState: createEmptyProfileFetchSchedulerStorageState()
        };
    }

    function createProfileFetchWorkers(workerCount) {
        const normalizedWorkerCount = Math.max(1, Number(workerCount) || 1);
        const workers = [];

        for (let index = 0; index < normalizedWorkerCount; index += 1) {
            workers.push(createProfileFetchWorker(index));
        }

        return workers;
    }

    function createProfileFetchWorker(index, existingWorker) {
        return {
            id: existingWorker?.id || `worker-${index + 1}`,
            status: existingWorker?.status === "active" ? "active" : "idle",
            activeProfileSlug: typeof existingWorker?.activeProfileSlug === "string"
                ? existingWorker.activeProfileSlug
                : "",
            nextAllowedStartAt: Number.isFinite(existingWorker?.nextAllowedStartAt)
                ? existingWorker.nextAllowedStartAt
                : 0
        };
    }

    function reconcileProfileFetchWorkers() {
        const targetWorkerCount = profileFetchSettingsState.values.workerCount;

        while (profileFetchSchedulerState.workers.length < targetWorkerCount) {
            profileFetchSchedulerState.workers.push(createProfileFetchWorker(profileFetchSchedulerState.workers.length));
        }

        trimIdleProfileFetchWorkers();
    }

    function trimIdleProfileFetchWorkers() {
        const targetWorkerCount = profileFetchSettingsState.values.workerCount;

        while (profileFetchSchedulerState.workers.length > targetWorkerCount) {
            const tailWorker = profileFetchSchedulerState.workers[profileFetchSchedulerState.workers.length - 1];
            if (tailWorker?.status === "active") {
                break;
            }

            profileFetchSchedulerState.workers.pop();
        }
    }

    function createEmptyProfileFetchSchedulerStorageState() {
        return {
            cooldownUntil: 0,
            recentFetchStarts: [],
            leases: {}
        };
    }

    function createEmptyProfileFetchFailureCounts() {
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

    function createTabInstanceId() {
        if (globalThis.crypto?.randomUUID) {
            return globalThis.crypto.randomUUID();
        }

        return `lili-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function handleProfileFetchScroll() {
        profileFetchSchedulerState.lastScrollAt = Date.now();
        scheduleProfileFetchQueueDrain(profileFetchSettingsState.values.scrollIdleMs);
    }

    function enqueueProfileStatusResolution(profileSlug) {
        if (!profileSlug || profileFetchSchedulerState.jobsBySlug.has(profileSlug)) {
            return;
        }

        profileFetchSchedulerState.jobsBySlug.set(profileSlug, {
            slug: profileSlug,
            status: "queued",
            enqueuedAt: Date.now()
        });
        profileFetchSchedulerState.queue.push(profileSlug);
        scheduleProfileFetchRuntimeStatsPublish();
        scheduleProfileFetchQueueDrain();
    }

    function scheduleProfileFetchRuntimeStatsPublish(delayMs = 0) {
        window.clearTimeout(profileFetchSchedulerState.runtimeStatsTimerId);
        profileFetchSchedulerState.runtimeStatsTimerId = window.setTimeout(() => {
            profileFetchSchedulerState.runtimeStatsTimerId = 0;
            void publishProfileFetchRuntimeStats();
        }, Math.max(0, delayMs));
    }

    async function publishProfileFetchRuntimeStats() {
        try {
            await writeProfileFetchRuntimeStats(getProfileFetchRuntimeSnapshot());
        } catch (error) {
            if (isExtensionContextInvalidatedError(error)) {
                return;
            }

            console.warn("[LiLi] Failed to publish runtime queue stats", error);
        }
    }

    function isExtensionContextInvalidatedError(error) {
        return /Extension context invalidated/i.test(String(error?.message || error || ""));
    }

    function getProfileFetchRuntimeSnapshot() {
        const now = Date.now();
        const queuedCount = getQueuedProfileFetchCount();
        const gapWaitMs = getNextProfileFetchWorkerWaitMs(now);
        const cooldownWaitMs = Math.max(0, (profileFetchSchedulerState.syncedState.cooldownUntil || 0) - now);
        const idleWaitMs = Math.max(0, profileFetchSettingsState.values.scrollIdleMs - (now - profileFetchSchedulerState.lastScrollAt));
        const budgetWaitMs = getProfileFetchBudgetWaitMs(now);
        const budgetBlockedUntil = budgetWaitMs > 0
            ? (profileFetchSchedulerState.syncedState.recentFetchStarts[0] + profileFetchSettingsState.values.rollingWindowMs)
            : 0;
        const nextAllowedStartAt = gapWaitMs > 0 ? now + gapWaitMs : 0;
        const activeWorkerCount = getActiveProfileFetchWorkerCount();

        return {
            tabId: profileFetchSchedulerState.tabId,
            pageMode: pageLifecycleState.currentMode,
            pathName: window.location.pathname || "",
            queuedCount,
            activeCount: profileFetchSchedulerState.activeRequestCount,
            successfulCheckCount: profileFetchSchedulerState.successfulCheckCount,
            lastSuccessfulCheckAt: profileFetchSchedulerState.lastSuccessfulCheckAt || 0,
            totalFailedCheckCount: profileFetchSchedulerState.totalFailedCheckCount,
            lastFailureCode: profileFetchSchedulerState.lastFailureCode,
            lastFailureAt: profileFetchSchedulerState.lastFailureAt || 0,
            failureCounts: { ...profileFetchSchedulerState.failureCounts },
            schedulerActiveCount: activeWorkerCount,
            workerCount: profileFetchSettingsState.values.workerCount,
            concurrency: profileFetchSettingsState.values.workerCount,
            draining: profileFetchSchedulerState.draining,
            failureCount: profileFetchSchedulerState.failureCount,
            leaseCount: Object.keys(profileFetchSchedulerState.syncedState.leases || {}).length,
            recentFetchStartsCount: (profileFetchSchedulerState.syncedState.recentFetchStarts || []).length,
            rollingBudgetMax: profileFetchSettingsState.values.rollingBudgetMax,
            rollingWindowMs: profileFetchSettingsState.values.rollingWindowMs,
            backoffCapMs: profileFetchSettingsState.values.backoffCapMs,
            baseGapMs: profileFetchSettingsState.values.baseGapMs,
            jitterMinMs: profileFetchSettingsState.values.jitterMinMs,
            jitterMaxMs: profileFetchSettingsState.values.jitterMaxMs,
            scrollIdleMs: profileFetchSettingsState.values.scrollIdleMs,
            nextAllowedStartAt,
            cooldownUntil: profileFetchSchedulerState.syncedState.cooldownUntil || 0,
            lastScrollAt: profileFetchSchedulerState.lastScrollAt,
            idleUntil: profileFetchSchedulerState.lastScrollAt + profileFetchSettingsState.values.scrollIdleMs,
            budgetBlockedUntil,
            scheduledDrainAt: profileFetchSchedulerState.scheduledDrainAt || 0,
            gapWaitMs,
            cooldownWaitMs,
            idleWaitMs,
            budgetWaitMs,
            totalWaitMs: Math.max(gapWaitMs, cooldownWaitMs, idleWaitMs, budgetWaitMs),
            oldestQueuedAt: getOldestQueuedAt(),
            workers: profileFetchSchedulerState.workers.map((worker) => ({
                id: worker.id,
                status: worker.status,
                activeProfileSlug: worker.activeProfileSlug,
                nextAllowedStartAt: worker.nextAllowedStartAt
            })),
            updatedAt: now
        };
    }

    function getActiveProfileFetchWorkerCount() {
        let activeWorkerCount = 0;

        for (const worker of profileFetchSchedulerState.workers) {
            if (worker?.status === "active") {
                activeWorkerCount += 1;
            }
        }

        return activeWorkerCount;
    }

    function getQueuedProfileFetchCount() {
        let queuedCount = 0;
        for (const job of profileFetchSchedulerState.jobsBySlug.values()) {
            if (job?.status === "queued") {
                queuedCount += 1;
            }
        }

        return queuedCount;
    }

    function getOldestQueuedAt() {
        let oldestQueuedAt = 0;

        for (const job of profileFetchSchedulerState.jobsBySlug.values()) {
            if (job?.status !== "queued" || !Number.isFinite(job.enqueuedAt)) {
                continue;
            }

            oldestQueuedAt = oldestQueuedAt === 0
                ? job.enqueuedAt
                : Math.min(oldestQueuedAt, job.enqueuedAt);
        }

        return oldestQueuedAt;
    }

    function beginTrackedRuntimeRequest() {
        profileFetchSchedulerState.activeRequestCount += 1;
        scheduleProfileFetchRuntimeStatsPublish();
    }

    function endTrackedRuntimeRequest() {
        profileFetchSchedulerState.activeRequestCount = Math.max(0, profileFetchSchedulerState.activeRequestCount - 1);
        scheduleProfileFetchRuntimeStatsPublish();
    }

    function handleProfileFetchPageHide() {
        window.clearTimeout(profileFetchSchedulerState.runtimeStatsTimerId);
        profileFetchSchedulerState.runtimeStatsTimerId = 0;
        void clearProfileFetchRuntimeStats();
    }

    function scheduleProfileFetchQueueDrain(delayMs = 0) {
        const normalizedDelayMs = Math.max(0, Math.floor(delayMs));
        const scheduledDrainAt = Date.now() + normalizedDelayMs;

        if (profileFetchSchedulerState.timerId && profileFetchSchedulerState.scheduledDrainAt <= scheduledDrainAt) {
            return;
        }

        window.clearTimeout(profileFetchSchedulerState.timerId);
        profileFetchSchedulerState.scheduledDrainAt = scheduledDrainAt;
        profileFetchSchedulerState.timerId = window.setTimeout(() => {
            profileFetchSchedulerState.timerId = 0;
            profileFetchSchedulerState.scheduledDrainAt = 0;
            void drainProfileFetchQueue();
        }, normalizedDelayMs);
    }

    async function syncSentInvitationsCache(root) {
        const profileSlugs = collectSentInvitationProfileSlugs(root);
        if (profileSlugs.size === 0) {
            return;
        }

        let didChange = false;
        for (const profileSlug of profileSlugs) {
            didChange = applyPendingStatus(profileSlug, "sent-invitations") || didChange;
        }

        if (!didChange) {
            return;
        }

        await persistProfileStatusCache();
        rerenderAllCards();
    }

    function collectSentInvitationProfileSlugs(root) {
        const profileSlugs = new Set();
        root.querySelectorAll(SENT_INVITATION_PROFILE_LINK_SELECTOR).forEach((link) => {
            const href = link.getAttribute("href") || "";
            const profileSlug = getProfileSlug(normalizeLinkedInUrl(href));
            if (profileSlug) {
                profileSlugs.add(profileSlug);
            }
        });
        return profileSlugs;
    }

    function handleIntersections(entries) {
        for (const entry of entries) {
            if (!entry.isIntersecting) {
                continue;
            }

            intersectionObserver.unobserve(entry.target);
            processCard(entry.target);
        }
    }

    function handleNetworkHints(event) {
        const records = Array.isArray(event.detail) ? event.detail : [];
        for (const record of records) {
            if (!record?.slug) {
                continue;
            }

            if (record.profileUrn) {
                mergeProfileUrnIntoCache(record.slug, record.profileUrn, record.source || "network");
            }

            if (record.action !== "pending") {
                continue;
            }

            const existing = relationshipHints.get(record.slug);
            const existingCache = getCachedProfileStatus(record.slug);
            if (existing?.action === "pending"
                && ((existingCache?.profileUrn || "") === normalizeProfileUrn(record.profileUrn || "") || !record.profileUrn)) {
                continue;
            }

            setPendingStatus(record.slug, record.source || "network", record.profileUrn);
        }
    }

    function scanCards(root) {
        root.querySelectorAll(CARD_SELECTOR).forEach(observeCard);
    }

    function observeCard(card) {
        if (!(card instanceof HTMLElement)) {
            return;
        }

        if (card.ownerDocument !== document) {
            processCard(card);
            return;
        }

        if (card.dataset.liliPriorityObserved === "1") {
            return;
        }

        card.dataset.liliPriorityObserved = "1";
        intersectionObserver.observe(card);

        if (isCardWithinObserverMargin(card)) {
            intersectionObserver.unobserve(card);
            processCard(card);
        }
    }

    function isCardWithinObserverMargin(card) {
        if (!(card instanceof HTMLElement)) {
            return false;
        }

        const rect = card.getBoundingClientRect();
        return rect.bottom >= -OBSERVER_MARGIN_PX
            && rect.top <= window.innerHeight + OBSERVER_MARGIN_PX;
    }

    function reconcileCardMutation(card) {
        if (!(card instanceof HTMLElement) || !card.isConnected) {
            return;
        }

        if (card.dataset.liliPriorityProcessed === "1" || card.dataset.liliPriorityObserved === "1") {
            processCard(card);
            return;
        }

        observeCard(card);
    }

    function processCard(card) {
        if (!(card instanceof HTMLElement)) {
            return;
        }

        const profileUrl = getCardProfileUrl(card);
        const profileSlug = getProfileSlug(profileUrl);
        const connectionDegree = getConnectionDegree(card);
        if (!profileUrl || !profileSlug) {
            return;
        }

        registerCard(profileSlug, card);
        primeProfileStatus(profileSlug, connectionDegree);
        renderCardAction(card);
        card.dataset.liliPriorityProcessed = "1";
    }

    function renderCardAction(card) {
        if (!(card instanceof HTMLElement)) {
            return;
        }

        const profileUrl = getCardProfileUrl(card);
        const profileSlug = getProfileSlug(profileUrl);
        const currentAction = card.querySelector(ACTION_SELECTOR);

        if (!profileUrl || !profileSlug || !(currentAction instanceof HTMLElement)) {
            return;
        }

        hydrateProfileUrnFromAction(profileSlug, currentAction);

        const connectionDegree = getConnectionDegree(card);
        if (connectionDegree === "1st") {
            card.dataset.liliPriorityApplied = "message";
            return;
        }

        const inviteState = inviteStateBySlug.get(profileSlug)?.action;
        const profileStatus = getCachedProfileStatus(profileSlug)?.action || "";
        const probeStatus = profileProbeStateBySlug.get(profileSlug)?.status || "";
        const desiredAction = relationshipHints.get(profileSlug)?.action === "pending"
            ? "pending"
            : inviteState === "sending"
                ? "sending"
                : profileStatus === "pending"
                    ? "pending"
                    : profileStatus === "connect"
                        ? "connect"
                        : probeStatus === "loading"
                            ? "loading"
                            : "connect";

        if (currentAction.dataset.liliPriorityAction === desiredAction) {
            card.dataset.liliPriorityApplied = desiredAction;
            return;
        }

        const replacement = buildActionElement(card, currentAction, desiredAction, profileUrl, profileSlug);
        if (!replacement) {
            return;
        }

        currentAction.replaceWith(replacement);
        card.dataset.liliPriorityApplied = desiredAction;
    }

    function registerCard(profileSlug, card) {
        let cards = cardsBySlug.get(profileSlug);
        if (!cards) {
            cards = new Set();
            cardsBySlug.set(profileSlug, cards);
        }
        cards.add(card);
    }

    function rerenderCards(profileSlug) {
        const cards = cardsBySlug.get(profileSlug);
        if (!cards) {
            return;
        }

        cards.forEach((card) => {
            if (card.isConnected) {
                renderCardAction(card);
            }
        });
    }

    function getCardProfileUrl(card) {
        const profileLink = card.querySelector(PROFILE_LINK_SELECTOR);
        const href = profileLink?.getAttribute("href");
        return href ? normalizeLinkedInUrl(href) : "";
    }

    function getProfileSlug(profileUrl) {
        if (!profileUrl) {
            return "";
        }

        const url = new URL(profileUrl);
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts[0] !== "in" || !parts[1]) {
            return "";
        }

        return parts[1];
    }

    function getConnectionDegree(card) {
        const degreeText = normalizeText(card.querySelector(DEGREE_SELECTOR)?.textContent || "");
        return degreeText.replace(/^·\s*/, "");
    }

    function hydrateProfileUrnFromAction(profileSlug, actionElement) {
        const profileUrn = getProfileUrnFromActionElement(actionElement);
        if (!profileUrn) {
            return;
        }

        mergeProfileUrnIntoCache(profileSlug, profileUrn, "message-link");
    }

    function getProfileUrnFromActionElement(actionElement) {
        if (!(actionElement instanceof HTMLAnchorElement)) {
            return "";
        }

        const href = actionElement.getAttribute("href") || "";
        if (!href || !/\/messaging\/compose\//i.test(href)) {
            return "";
        }

        try {
            const url = new URL(href, LINKEDIN_ORIGIN);
            return normalizeProfileUrn(
                url.searchParams.get("profileUrn")
                || url.searchParams.get("recipient")
                || ""
            );
        } catch {
            return "";
        }
    }

    function mergeProfileUrnIntoCache(profileSlug, profileUrn, source) {
        const normalizedProfileUrn = normalizeProfileUrn(profileUrn);
        if (!profileSlug || !normalizedProfileUrn) {
            return;
        }

        const existingCache = getCachedProfileStatus(profileSlug);
        if (existingCache?.profileUrn === normalizedProfileUrn) {
            return;
        }

        const nextExpiresAt = Date.now() + PROFILE_STATUS_CACHE_TTL_MS;
        profileStatusBySlug.set(profileSlug, {
            action: existingCache?.action || "connect",
            source: existingCache?.source || source,
            expiresAt: Math.max(existingCache?.expiresAt || 0, nextExpiresAt),
            profileUrn: normalizedProfileUrn
        });

        void persistProfileStatusCache();
    }

    function buildActionElement(card, currentAction, actionKind, profileUrl, profileSlug) {
        const name = normalizeText(card.querySelector(NAME_SELECTOR)?.textContent || "");
        const actionSource = getActionSource(profileSlug, actionKind);
        const elementDocument = card.ownerDocument || document;
        const replacement = elementDocument.createElement("button");
        replacement.type = "button";
        replacement.className = buildActionClassName(currentAction, actionKind);
        replacement.setAttribute(
            "aria-label",
            actionKind === "pending"
                ? (name ? `Pending invitation for ${name}` : "Pending invitation")
                : actionKind === "loading"
                    ? (name ? `Checking invitation status for ${name}` : "Checking invitation status")
                    : actionKind === "sending"
                        ? (name ? `Sending invitation to ${name}` : "Sending invitation")
                        : (name ? `Invite ${name} to connect` : "Invite to connect")
        );
        replacement.dataset.liliPriorityAction = actionKind;
        replacement.dataset.liliPrioritySource = actionSource;
        replacement.title = actionKind === "pending"
            ? getPendingTitle(actionSource)
            : actionKind === "loading"
                ? "Checking LinkedIn profile status"
                : actionKind === "sending"
                    ? "Sending invitation without a note"
                    : "Send invitation without a note";

        if (actionKind === "pending" || actionKind === "sending" || actionKind === "loading") {
            replacement.disabled = true;
            replacement.setAttribute("aria-disabled", "true");
        }

        if (actionKind === "sending" || actionKind === "loading") {
            replacement.setAttribute("aria-busy", "true");
        }

        const text = elementDocument.createElement("span");
        text.className = "artdeco-button__text";
        text.textContent = actionKind === "pending"
            ? "Pending"
            : actionKind === "loading"
                ? "Loading..."
                : actionKind === "sending"
                    ? "Sending..."
                    : "Connect";
        replacement.appendChild(text);

        if (actionKind === "connect") {
            replacement.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                void handleConnectClick(profileSlug);
            });
        }

        return replacement;
    }

    function getActionSource(profileSlug, actionKind) {
        if (actionKind === "pending") {
            return relationshipHints.get(profileSlug)?.source
                || profileStatusBySlug.get(profileSlug)?.source
                || "network";
        }

        if (actionKind === "loading") {
            return "profile-fetch";
        }

        if (actionKind === "connect") {
            return profileStatusBySlug.get(profileSlug)?.source || "profile-fetch";
        }

        return "invite-flow";
    }

    function getPendingTitle(source) {
        return source === "profile-fetch" || source === "profile-cache"
            ? "Pending invitation confirmed from the LinkedIn profile document"
            : source === "sent-invitations"
                ? "Pending invitation confirmed from LinkedIn sent invitations"
                : "Pending invitation detected from LinkedIn page data";
    }

    function buildActionClassName(currentAction, actionKind) {
        const classes = new Set((currentAction.className || "").split(/\s+/).filter(Boolean));
        classes.delete("artdeco-button--secondary");
        classes.delete("artdeco-button--primary");
        classes.delete("lili-connect-action");
        classes.delete("lili-sending-action");
        classes.delete("lili-loading-action");
        classes.delete("lili-pending-action");
        classes.add("artdeco-button");
        classes.add("artdeco-button--2");
        classes.add(actionKind === "pending" ? "artdeco-button--secondary" : "artdeco-button--primary");
        classes.add(actionKind === "pending"
            ? "lili-pending-action"
            : actionKind === "loading"
                ? "lili-loading-action"
                : actionKind === "sending"
                    ? "lili-sending-action"
                    : "lili-connect-action");
        return Array.from(classes).join(" ");
    }

    async function handleConnectClick(profileSlug) {
        if (!profileSlug || relationshipHints.get(profileSlug)?.action === "pending") {
            return;
        }

        if (inviteStateBySlug.get(profileSlug)?.action === "sending") {
            return;
        }

        inviteStateBySlug.set(profileSlug, { action: "sending" });
        rerenderCards(profileSlug);

        const inviteOutcome = await sendInviteWithoutNote(profileSlug);
        inviteStateBySlug.delete(profileSlug);

        if (inviteOutcome === "sent" || inviteOutcome === "pending") {
            setPendingStatus(profileSlug, inviteOutcome === "pending" ? "invite-response" : "invite-flow");
        }

        rerenderCards(profileSlug);
    }

    async function drainProfileFetchQueue() {
        await profileFetchSettingsReady;
        await profileFetchSchedulerReady;

        if (pageLifecycleState.currentMode !== "group-members" || profileFetchSchedulerState.draining) {
            return;
        }

        profileFetchSchedulerState.draining = true;

        try {
            while (true) {
                const nextQueuedJob = getNextQueuedProfileJob();
                if (!nextQueuedJob) {
                    return;
                }

                const { profileSlug, queueIndex } = nextQueuedJob;

                if (shouldSkipQueuedProfileFetch(profileSlug)) {
                    profileFetchSchedulerState.queue.splice(queueIndex, 1);
                    profileFetchSchedulerState.jobsBySlug.delete(profileSlug);
                    profileProbeStateBySlug.delete(profileSlug);
                    rerenderCards(profileSlug);
                    scheduleProfileFetchRuntimeStatsPublish();
                    continue;
                }

                const sharedWaitMs = getNextProfileFetchSharedWaitMs();
                if (sharedWaitMs > 0) {
                    scheduleProfileFetchQueueDrain(sharedWaitMs);
                    return;
                }

                const worker = getNextReadyProfileFetchWorker();
                if (!worker) {
                    const workerWaitMs = getNextProfileFetchWorkerWaitMs();
                    if (workerWaitMs > 0) {
                        scheduleProfileFetchQueueDrain(workerWaitMs);
                    }
                    return;
                }

                const job = profileFetchSchedulerState.jobsBySlug.get(profileSlug);
                if (!job) {
                    continue;
                }

                profileFetchSchedulerState.queue.splice(queueIndex, 1);
                job.status = "active";
                job.workerId = worker.id;
                worker.status = "active";
                worker.activeProfileSlug = profileSlug;
                scheduleProfileFetchRuntimeStatsPublish();
                void runProfileFetchJob(worker.id, profileSlug);
            }
        } finally {
            profileFetchSchedulerState.draining = false;
        }
    }

    function getNextQueuedProfileJob() {
        const queuedCandidates = [];

        for (let index = profileFetchSchedulerState.queue.length - 1; index >= 0; index -= 1) {
            const profileSlug = profileFetchSchedulerState.queue[index];
            const job = profileFetchSchedulerState.jobsBySlug.get(profileSlug);
            if (!job || job.status !== "queued") {
                profileFetchSchedulerState.queue.splice(index, 1);
                continue;
            }

            queuedCandidates.push({
                profileSlug,
                queueIndex: index
            });
        }

        if (queuedCandidates.length === 0) {
            return null;
        }

        return queuedCandidates[Math.floor(Math.random() * queuedCandidates.length)];
    }

    function shouldSkipQueuedProfileFetch(profileSlug) {
        return Boolean(relationshipHints.get(profileSlug)?.action === "pending"
            || getCachedProfileStatus(profileSlug)
            || inviteStateBySlug.get(profileSlug)?.action === "sending");
    }

    function getNextProfileFetchSharedWaitMs() {
        const now = Date.now();
        const cooldownWaitMs = Math.max(0, (profileFetchSchedulerState.syncedState.cooldownUntil || 0) - now);
        const idleWaitMs = Math.max(0, profileFetchSettingsState.values.scrollIdleMs - (now - profileFetchSchedulerState.lastScrollAt));
        const budgetWaitMs = getProfileFetchBudgetWaitMs(now);

        return Math.max(cooldownWaitMs, idleWaitMs, budgetWaitMs);
    }

    function getNextReadyProfileFetchWorker(now = Date.now()) {
        for (let index = 0; index < profileFetchSettingsState.values.workerCount; index += 1) {
            const worker = profileFetchSchedulerState.workers[index];
            if (!worker || worker.status !== "idle") {
                continue;
            }

            if (Math.max(0, worker.nextAllowedStartAt - now) > 0) {
                continue;
            }

            return worker;
        }

        return null;
    }

    function getNextProfileFetchWorkerWaitMs(now = Date.now()) {
        let minWaitMs = 0;

        for (let index = 0; index < profileFetchSettingsState.values.workerCount; index += 1) {
            const worker = profileFetchSchedulerState.workers[index];
            if (!worker || worker.status !== "idle") {
                continue;
            }

            const waitMs = Math.max(0, worker.nextAllowedStartAt - now);
            if (waitMs <= 0) {
                return 0;
            }

            minWaitMs = minWaitMs === 0 ? waitMs : Math.min(minWaitMs, waitMs);
        }

        return minWaitMs;
    }

    function getProfileFetchBudgetWaitMs(now) {
        const recentFetchStarts = profileFetchSchedulerState.syncedState.recentFetchStarts || [];
        if (recentFetchStarts.length < profileFetchSettingsState.values.rollingBudgetMax) {
            return 0;
        }

        const earliestAllowedAt = recentFetchStarts[0] + profileFetchSettingsState.values.rollingWindowMs;
        return Math.max(0, earliestAllowedAt - now);
    }

    async function runProfileFetchJob(workerId, profileSlug) {
        let preserveJob = false;
        let retryDelayMs = 0;
        let leaseAcquired = false;
        const worker = getProfileFetchWorkerById(workerId);

        try {
            const leaseResult = await tryAcquireProfileFetchLease(profileSlug);
            if (!leaseResult.acquired) {
                preserveJob = true;
                retryDelayMs = leaseResult.retryAfterMs;
                requeueProfileFetchJob(profileSlug);
                return;
            }

            leaseAcquired = true;
            const startedAt = Date.now();
            if (worker) {
                worker.nextAllowedStartAt = startedAt
                    + profileFetchSettingsState.values.baseGapMs
                    + getRandomProfileFetchJitterMs();
            }
            await registerProfileFetchStart(startedAt);
            await resolveProfileStatus(profileSlug);
            profileFetchSchedulerState.failureCount = 0;
        } catch (error) {
            console.debug("[LiLi] Scheduled profile fetch failed", profileSlug, error);
            profileProbeStateBySlug.set(profileSlug, { status: "failed" });
            rerenderCards(profileSlug);
            noteProfileFetchFailure(error);
            await applyProfileFetchFailurePenalty(error);
        } finally {
            if (leaseAcquired) {
                await releaseProfileFetchLease(profileSlug);
            }

            finalizeProfileFetchJob(workerId, profileSlug, preserveJob);
            scheduleProfileFetchQueueDrain(retryDelayMs);
        }
    }

    function getProfileFetchWorkerById(workerId) {
        return profileFetchSchedulerState.workers.find((worker) => worker.id === workerId) || null;
    }

    function requeueProfileFetchJob(profileSlug) {
        const job = profileFetchSchedulerState.jobsBySlug.get(profileSlug);
        if (!job) {
            return;
        }

        job.status = "queued";
        if (!profileFetchSchedulerState.queue.includes(profileSlug)) {
            profileFetchSchedulerState.queue.unshift(profileSlug);
        }

        scheduleProfileFetchRuntimeStatsPublish();
    }

    function finalizeProfileFetchJob(workerId, profileSlug, preserveJob) {
        const worker = getProfileFetchWorkerById(workerId);
        if (worker) {
            worker.status = "idle";
            worker.activeProfileSlug = "";
        }

        if (!preserveJob) {
            profileFetchSchedulerState.jobsBySlug.delete(profileSlug);
        } else {
            const job = profileFetchSchedulerState.jobsBySlug.get(profileSlug);
            if (job) {
                delete job.workerId;
            }
        }

        trimIdleProfileFetchWorkers();
        scheduleProfileFetchRuntimeStatsPublish();
    }

    function noteProfileFetchFailure(error) {
        const failureCode = normalizeProfileFetchFailureCode(error?.liliCode);
        profileFetchSchedulerState.totalFailedCheckCount += 1;
        profileFetchSchedulerState.lastFailureCode = failureCode;
        profileFetchSchedulerState.lastFailureAt = Date.now();
        profileFetchSchedulerState.failureCounts[failureCode] = (profileFetchSchedulerState.failureCounts[failureCode] || 0) + 1;
        scheduleProfileFetchRuntimeStatsPublish();
    }

    function normalizeProfileFetchFailureCode(code) {
        switch (code) {
            case "challenge":
            case "rate-limit":
            case "timeout":
            case "forbidden":
            case "server":
            case "parse":
                return code;
            default:
                return "other";
        }
    }

    async function registerProfileFetchStart(startedAt) {
        await mutateProfileFetchSchedulerState((state) => {
            state.recentFetchStarts.push(startedAt);
            return state;
        });
    }

    async function applyProfileFetchFailurePenalty(error) {
        const penaltyMs = getProfileFetchFailurePenaltyMs(error);
        if (penaltyMs <= 0) {
            return;
        }

        profileFetchSchedulerState.failureCount = Math.min(profileFetchSchedulerState.failureCount + 1, 8);
        const cooldownMs = Math.min(
            profileFetchSettingsState.values.backoffCapMs,
            penaltyMs * (2 ** (profileFetchSchedulerState.failureCount - 1))
        );
        const cooldownUntil = Date.now() + cooldownMs;

        await mutateProfileFetchSchedulerState((state) => {
            state.cooldownUntil = Math.max(state.cooldownUntil || 0, cooldownUntil);
            return state;
        });
    }

    function getProfileFetchFailurePenaltyMs(error) {
        switch (error?.liliCode) {
            case "rate-limit":
            case "challenge":
                return PROFILE_FETCH_BACKOFF_INITIAL_MS;
            case "forbidden":
                return 15000;
            case "timeout":
            case "parse":
            case "server":
                return 10000;
            default:
                return 0;
        }
    }

    function primeProfileStatus(profileSlug, connectionDegree) {
        if (!profileSlug || connectionDegree === "1st") {
            return;
        }

        if (relationshipHints.get(profileSlug)?.action === "pending" || getCachedProfileStatus(profileSlug)) {
            return;
        }

        if (inviteStateBySlug.get(profileSlug)?.action === "sending") {
            return;
        }

        const probeStatus = profileProbeStateBySlug.get(profileSlug)?.status;
        if (probeStatus) {
            return;
        }

        profileProbeStateBySlug.set(profileSlug, { status: "loading" });
        enqueueProfileStatusResolution(profileSlug);
    }

    async function sendInviteWithoutNote(profileSlug) {
        try {
            const profileRecord = await ensureProfileRecord(profileSlug, {
                forceRefresh: true
            });
            if (profileRecord?.action === "pending") {
                return "pending";
            }

            if (!profileRecord?.profileUrn) {
                throw new Error("Profile URN was not resolved for invite API");
            }

            return await sendInviteThroughApi(profileRecord.profileUrn);
        } catch (error) {
            console.warn("[LiLi] Failed to send invite without note", error);
            return "failure";
        }
    }

    async function ensureProfileRecord(profileSlug, options = {}) {
        await profileStatusCacheReady;

        const {
            forceRefresh = false,
            failClosedWithoutFreshRecord = false
        } = options;

        const cachedRecord = getCachedProfileStatus(profileSlug);
        if (!forceRefresh && cachedRecord?.profileUrn) {
            return cachedRecord;
        }

        if (cachedRecord?.action === "pending") {
            return cachedRecord;
        }

        let fetchedRecord;
        try {
            fetchedRecord = await fetchProfileRecord(profileSlug);
        } catch (error) {
            if (failClosedWithoutFreshRecord) {
                throw error;
            }

            if (cachedRecord?.profileUrn) {
                return cachedRecord;
            }

            throw error;
        }

        const mergedProfileUrn = fetchedRecord.profileUrn || cachedRecord?.profileUrn || "";
        await setCachedProfileStatus(profileSlug, fetchedRecord.action, "profile-fetch", mergedProfileUrn);

        return getCachedProfileStatus(profileSlug) || {
            ...fetchedRecord,
            profileUrn: mergedProfileUrn
        };
    }

    async function sendInviteThroughApi(profileUrn) {
        beginTrackedRuntimeRequest();

        try {
            const csrfToken = getLinkedInCsrfToken();
            if (!csrfToken) {
                throw new Error("LinkedIn CSRF token is not available");
            }

            const response = await fetch(normalizeLinkedInUrl(INVITE_API_PATH), {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    accept: "application/vnd.linkedin.normalized+json+2.1",
                    "content-type": "application/json; charset=UTF-8",
                    "csrf-token": csrfToken,
                    "x-li-lang": getLinkedInLanguageHeader(),
                    "x-restli-protocol-version": "2.0.0"
                },
                body: JSON.stringify({
                    invitee: {
                        inviteeUnion: {
                            memberProfile: profileUrn
                        }
                    }
                })
            });

            const text = await response.text();
            if (looksLikeInvitePending(text, "POST", response.status)) {
                return "pending";
            }

            if (response.ok) {
                return "sent";
            }

            if (looksLikeInviteFailure(text, "POST", response.status)) {
                return "failure";
            }

            return "failure";
        } finally {
            endTrackedRuntimeRequest();
        }
    }

    async function resolveProfileStatus(profileSlug) {
        await profileStatusCacheReady;

        if (relationshipHints.get(profileSlug)?.action === "pending" || getCachedProfileStatus(profileSlug)) {
            profileProbeStateBySlug.delete(profileSlug);
            rerenderCards(profileSlug);
            return;
        }

        const profileRecord = await fetchProfileRecord(profileSlug);
        profileProbeStateBySlug.delete(profileSlug);

        if (profileRecord.action === "pending") {
            setPendingStatus(profileSlug, "profile-fetch", profileRecord.profileUrn);
            return;
        }

        await setCachedProfileStatus(profileSlug, "connect", "profile-fetch", profileRecord.profileUrn);
        rerenderCards(profileSlug);
    }

    async function fetchProfileRecord(profileSlug) {
        beginTrackedRuntimeRequest();

        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => {
            controller.abort();
        }, PROFILE_FETCH_TIMEOUT_MS);

        try {
            const response = await fetch(normalizeLinkedInUrl(`/in/${encodeURIComponent(profileSlug)}/`), {
                method: "GET",
                credentials: "same-origin",
                headers: {
                    accept: "text/html,application/xhtml+xml"
                },
                signal: controller.signal
            });

            if (!response.ok) {
                if (response.status === 429) {
                    throw createProfileFetchError("rate-limit", `Profile fetch failed with status ${response.status}`);
                }

                if (response.status === 403) {
                    throw createProfileFetchError("forbidden", `Profile fetch failed with status ${response.status}`);
                }

                if (response.status >= 500) {
                    throw createProfileFetchError("server", `Profile fetch failed with status ${response.status}`);
                }

                throw new Error(`Profile fetch failed with status ${response.status}`);
            }

            const html = await response.text();
            if (looksLikeProtectedProfileFetchHtml(html)) {
                throw createProfileFetchError("challenge", "Profile fetch returned a LinkedIn challenge page");
            }

            const profileRecord = getProfileDocumentRecord(html);
            if (looksLikeUnexpectedProfileFetchHtml(html, profileSlug, profileRecord)) {
                throw createProfileFetchError("parse", "Profile fetch returned an unexpected LinkedIn document");
            }

            profileFetchSchedulerState.successfulCheckCount += 1;
            profileFetchSchedulerState.lastSuccessfulCheckAt = Date.now();
            scheduleProfileFetchRuntimeStatsPublish();

            return profileRecord;
        } catch (error) {
            if (error?.name === "AbortError") {
                throw createProfileFetchError("timeout", "Profile fetch timed out");
            }

            throw error;
        } finally {
            window.clearTimeout(timeoutId);
            endTrackedRuntimeRequest();
        }
    }

    function getProfileDocumentRecord(html) {
        const profileUrn = getProfileUrnFromHtml(html);
        if (!html) {
            return {
                action: "connect",
                profileUrn
            };
        }

        const hasInvitationState = /state:invitation:urn:li:member:[^"']+/i.test(html);
        const hasPendingStringValue = /stringValue\\":\\"Pending\\"|stringValue":"Pending"/i.test(html);
        const hasConnectStringValue = /stringValue\\":\\"Connect\\"|stringValue":"Connect"/i.test(html);

        if (hasInvitationState) {
            if (hasPendingStringValue) {
                return {
                    action: "pending",
                    profileUrn
                };
            }

            if (hasConnectStringValue) {
                return {
                    action: "connect",
                    profileUrn
                };
            }
        }

        const hasFallbackPendingState = /Pending, click to withdraw invitation sent to/i.test(html)
            || /queryName\\":\\"ProfileMemberRelationshipRefreshById\\"|queryName":"ProfileMemberRelationshipRefreshById"/i.test(html)
            && /withdrawInvitation|Withdraw invitation/i.test(html);

        return {
            action: hasFallbackPendingState ? "pending" : "connect",
            profileUrn
        };
    }

    function getProfileUrnFromHtml(html) {
        if (!html) {
            return "";
        }

        const encodedProfileUrnMatch = html.match(/profileUrn=urn%3Ali%3Afsd_profile%3A([^"&]+)/i);
        if (encodedProfileUrnMatch?.[1]) {
            return normalizeProfileUrn(`urn:li:fsd_profile:${decodeURIComponent(encodedProfileUrnMatch[1])}`);
        }

        const profileUrnMatch = html.match(/urn:li:fsd_profile:([A-Za-z0-9_-]+)/i);
        if (profileUrnMatch?.[1]) {
            return normalizeProfileUrn(`urn:li:fsd_profile:${profileUrnMatch[1]}`);
        }

        return "";
    }

    function normalizeProfileUrn(value) {
        if (typeof value !== "string") {
            return "";
        }

        const trimmedValue = value.trim();
        if (!trimmedValue) {
            return "";
        }

        const directMatch = trimmedValue.match(/(?:urn:li:fsd_profile:)+([A-Za-z0-9_-]+)/i);
        if (directMatch?.[1]) {
            return `urn:li:fsd_profile:${directMatch[1]}`;
        }

        try {
            const url = new URL(trimmedValue, LINKEDIN_ORIGIN);
            const queryValue = url.searchParams.get("profileUrn") || url.searchParams.get("recipient") || "";
            const queryMatch = queryValue.match(/(?:urn:li:fsd_profile:)+([A-Za-z0-9_-]+)/i);
            if (queryMatch?.[1]) {
                return `urn:li:fsd_profile:${queryMatch[1]}`;
            }
        } catch {
            return "";
        }

        return "";
    }

    function looksLikeProtectedProfileFetchHtml(html) {
        if (!html) {
            return false;
        }

        return /(security verification|verify to continue|unusual activity detected|let'?s do a quick security check|checkpoint\/challenge|challenge\/captcha|id="captcha-internal"|name="challengeId")/i.test(html);
    }

    function looksLikeUnexpectedProfileFetchHtml(html, profileSlug, profileRecord) {
        if (!html) {
            return true;
        }

        if (profileRecord?.profileUrn) {
            return false;
        }

        const explicitStateDetected = /(stringValue\\":\\"Pending\\"|stringValue":"Pending"|stringValue\\":\\"Connect\\"|stringValue":"Connect"|Pending, click to withdraw invitation sent to)/i.test(html);
        if (explicitStateDetected) {
            return false;
        }

        return !looksLikeFetchedProfileHtml(html, profileSlug);
    }

    function looksLikeFetchedProfileHtml(html, profileSlug) {
        if (!html || !profileSlug) {
            return false;
        }

        const escapedSlug = escapeRegExp(profileSlug);
        const slugPattern = new RegExp(`(?:/in/${escapedSlug}(?:[/?#"'])|"publicIdentifier":"${escapedSlug}"|"vanityName":"${escapedSlug}"|"entityUrn":"urn:li:fsd_profile:)`, "i");
        const profileLayoutPattern = /(profile-displayphoto|artdeco-entity-lockup__title|pv-top-card|top-card-layout|profile-topcard-person-entity)/i;

        return slugPattern.test(html) && profileLayoutPattern.test(html);
    }

    function escapeRegExp(value) {
        return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function createProfileFetchError(code, message) {
        const error = new Error(message);
        error.liliCode = code;
        return error;
    }

    function getRandomProfileFetchJitterMs() {
        const { jitterMinMs, jitterMaxMs } = profileFetchSettingsState.values;
        return Math.floor(Math.random() * (jitterMaxMs - jitterMinMs + 1))
            + jitterMinMs;
    }
    function normalizeProfileFetchSettings(value) {
        if (profileFetchSettingsApi?.normalizeProfileFetchSettings) {
            return profileFetchSettingsApi.normalizeProfileFetchSettings(value);
        }

        return DEFAULT_PROFILE_FETCH_SETTINGS;
    }


    function getCachedProfileStatus(profileSlug) {
        const record = profileStatusBySlug.get(profileSlug);
        if (!record) {
            return null;
        }

        if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) {
            profileStatusBySlug.delete(profileSlug);
            void persistProfileStatusCache();
            return null;
        }

        return record;
    }

    function setPendingStatus(profileSlug, source, profileUrn) {
        applyPendingStatus(profileSlug, source, profileUrn);
        void persistProfileStatusCache();
        rerenderCards(profileSlug);
    }

    function applyPendingStatus(profileSlug, source, profileUrn) {
        const existingHint = relationshipHints.get(profileSlug);
        const existingCache = getCachedProfileStatus(profileSlug);
        const cachedSource = source;
        const nextExpiresAt = Date.now() + PROFILE_STATUS_CACHE_TTL_MS;
        const nextProfileUrn = profileUrn || existingCache?.profileUrn || "";
        const didChange = existingHint?.action !== "pending"
            || existingHint?.source !== source
            || existingCache?.action !== "pending"
            || existingCache?.source !== cachedSource
            || (existingCache?.profileUrn || "") !== nextProfileUrn
            || !Number.isFinite(existingCache?.expiresAt)
            || existingCache.expiresAt <= Date.now();

        relationshipHints.set(profileSlug, {
            action: "pending",
            source
        });
        inviteStateBySlug.delete(profileSlug);
        profileProbeStateBySlug.delete(profileSlug);
        profileStatusBySlug.set(profileSlug, {
            action: "pending",
            source: cachedSource,
            expiresAt: nextExpiresAt,
            profileUrn: nextProfileUrn
        });

        return didChange;
    }

    function applyConnectStatus(profileSlug, source, profileUrn) {
        const existingHint = relationshipHints.get(profileSlug);
        const existingCache = getCachedProfileStatus(profileSlug);
        const nextExpiresAt = Date.now() + PROFILE_STATUS_CACHE_TTL_MS;
        const nextProfileUrn = profileUrn || existingCache?.profileUrn || "";
        const didChange = Boolean(existingHint)
            || existingCache?.action !== "connect"
            || existingCache?.source !== source
            || (existingCache?.profileUrn || "") !== nextProfileUrn
            || !Number.isFinite(existingCache?.expiresAt)
            || existingCache.expiresAt <= Date.now();

        relationshipHints.delete(profileSlug);
        inviteStateBySlug.delete(profileSlug);
        profileProbeStateBySlug.delete(profileSlug);
        profileStatusBySlug.set(profileSlug, {
            action: "connect",
            source,
            expiresAt: nextExpiresAt,
            profileUrn: nextProfileUrn
        });

        return didChange;
    }

    async function setCachedProfileStatus(profileSlug, action, source, profileUrn) {
        if (action === "pending") {
            applyPendingStatus(profileSlug, source, profileUrn);
        } else {
            applyConnectStatus(profileSlug, source, profileUrn);
        }

        await persistProfileStatusCache();
    }

    async function loadProfileStatusCache() {
        try {
            const storedCache = await readProfileStatusCache();
            const { didPrune } = replaceProfileStatusCache(storedCache);

            if (didPrune) {
                await persistProfileStatusCache();
            }
        } catch (error) {
            console.warn("[LiLi] Failed to load profile status cache", error);
        }

        rerenderAllCards();
    }

    function replaceProfileStatusCache(storedCache) {
        const now = Date.now();
        const nextRecords = new Map();
        let didPrune = false;

        for (const [profileSlug, record] of Object.entries(storedCache || {})) {
            if (!isValidProfileStatusRecord(record, now)) {
                didPrune = true;
                continue;
            }

            nextRecords.set(profileSlug, {
                action: record.action,
                source: record.source || "profile-cache",
                expiresAt: record.expiresAt,
                profileUrn: typeof record.profileUrn === "string" ? record.profileUrn : ""
            });
        }

        const affectedSlugs = new Set([
            ...profileStatusBySlug.keys(),
            ...nextRecords.keys()
        ]);

        profileStatusBySlug.clear();
        for (const [profileSlug, record] of nextRecords.entries()) {
            profileStatusBySlug.set(profileSlug, record);
        }

        for (const profileSlug of affectedSlugs) {
            const record = nextRecords.get(profileSlug);
            if (record?.action !== "pending") {
                relationshipHints.delete(profileSlug);
            }
        }

        return { didPrune };
    }

    function installProfileStatusCacheObserver() {
        if (!chrome.storage?.onChanged) {
            return;
        }

        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== "local") {
                return;
            }

            const change = changes[PROFILE_STATUS_CACHE_KEY];
            if (!change) {
                return;
            }

            replaceProfileStatusCache(change.newValue || {});
            rerenderAllCards();
        });
    }

    async function loadProfileFetchSchedulerState() {
        try {
            await profileFetchSettingsReady;
            const { state, didPrune } = normalizeProfileFetchSchedulerStorageState(await readProfileFetchSchedulerState());
            replaceLocalProfileFetchSchedulerState(state);

            if (didPrune) {
                await writeProfileFetchSchedulerState(state);
            }
        } catch (error) {
            console.warn("[LiLi] Failed to load profile fetch scheduler state", error);
        }
    }

    async function loadProfileFetchSettings() {
        try {
            replaceLocalProfileFetchSettings(await readProfileFetchSettings());
        } catch (error) {
            console.warn("[LiLi] Failed to load profile fetch settings", error);
        }
    }

    function replaceLocalProfileFetchSettings(nextSettings) {
        profileFetchSettingsState.values = normalizeProfileFetchSettings(nextSettings);
        reconcileProfileFetchWorkers();
    }

    function installProfileFetchSettingsObserver() {
        if (!chrome.storage?.onChanged) {
            return;
        }

        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== "local") {
                return;
            }

            const change = changes[PROFILE_FETCH_SETTINGS_KEY];
            if (!change) {
                return;
            }

            replaceLocalProfileFetchSettings(change.newValue || DEFAULT_PROFILE_FETCH_SETTINGS);
            scheduleProfileFetchQueueDrain();
        });
    }

    function installProfileFetchSchedulerObserver() {
        if (!chrome.storage?.onChanged) {
            return;
        }

        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== "local") {
                return;
            }

            const change = changes[PROFILE_FETCH_SCHEDULER_KEY];
            if (!change) {
                return;
            }

            const { state } = normalizeProfileFetchSchedulerStorageState(change.newValue || {});
            replaceLocalProfileFetchSchedulerState(state);
            scheduleProfileFetchQueueDrain();
        });
    }

    function normalizeProfileFetchSchedulerStorageState(storedState) {
        const now = Date.now();
        const nextState = createEmptyProfileFetchSchedulerStorageState();
        let didPrune = false;

        if (storedState && typeof storedState === "object") {
            if (Number.isFinite(storedState.cooldownUntil) && storedState.cooldownUntil > now) {
                nextState.cooldownUntil = storedState.cooldownUntil;
            } else if (storedState.cooldownUntil) {
                didPrune = true;
            }

            if (Array.isArray(storedState.recentFetchStarts)) {
                nextState.recentFetchStarts = storedState.recentFetchStarts
                    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > now - profileFetchSettingsState.values.rollingWindowMs)
                    .sort((left, right) => left - right);
                didPrune = didPrune || nextState.recentFetchStarts.length !== storedState.recentFetchStarts.length;
            }

            if (storedState.leases && typeof storedState.leases === "object") {
                for (const [profileSlug, lease] of Object.entries(storedState.leases)) {
                    if (!lease || typeof lease.owner !== "string" || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= now) {
                        didPrune = true;
                        continue;
                    }

                    nextState.leases[profileSlug] = {
                        owner: lease.owner,
                        expiresAt: lease.expiresAt
                    };
                }
            }
        }

        return {
            state: nextState,
            didPrune
        };
    }

    function replaceLocalProfileFetchSchedulerState(nextState) {
        profileFetchSchedulerState.syncedState = nextState;
    }

    function mutateProfileFetchSchedulerState(mutation) {
        const runMutation = async () => {
            const { state: currentState } = normalizeProfileFetchSchedulerStorageState(await readProfileFetchSchedulerState());
            const mutatedState = mutation(structuredClone(currentState)) || currentState;
            const { state: nextState } = normalizeProfileFetchSchedulerStorageState(mutatedState);
            await writeProfileFetchSchedulerState(nextState);
            replaceLocalProfileFetchSchedulerState(nextState);
            return nextState;
        };

        const mutationPromise = profileFetchSchedulerState.storageMutationPromise.then(runMutation, runMutation);
        profileFetchSchedulerState.storageMutationPromise = mutationPromise.then(() => undefined, () => undefined);
        return mutationPromise;
    }

    async function tryAcquireProfileFetchLease(profileSlug) {
        const now = Date.now();
        const nextLease = {
            owner: profileFetchSchedulerState.tabId,
            expiresAt: now + PROFILE_FETCH_LEASE_TTL_MS
        };

        await mutateProfileFetchSchedulerState((state) => {
            const existingLease = state.leases[profileSlug];
            if (existingLease && existingLease.owner !== profileFetchSchedulerState.tabId && existingLease.expiresAt > now) {
                return state;
            }

            state.leases[profileSlug] = nextLease;
            return state;
        });

        const { state: verifiedState } = normalizeProfileFetchSchedulerStorageState(await readProfileFetchSchedulerState());
        replaceLocalProfileFetchSchedulerState(verifiedState);

        const verifiedLease = verifiedState.leases[profileSlug];
        if (verifiedLease?.owner === profileFetchSchedulerState.tabId && verifiedLease.expiresAt > now) {
            return {
                acquired: true,
                retryAfterMs: 0
            };
        }

        return {
            acquired: false,
            retryAfterMs: Math.max(
                PROFILE_FETCH_LEASE_RETRY_MIN_MS,
                (verifiedLease?.expiresAt || now + PROFILE_FETCH_LEASE_RETRY_MIN_MS) - now
            )
        };
    }

    async function releaseProfileFetchLease(profileSlug) {
        await mutateProfileFetchSchedulerState((state) => {
            const existingLease = state.leases[profileSlug];
            if (existingLease?.owner === profileFetchSchedulerState.tabId) {
                delete state.leases[profileSlug];
            }
            return state;
        });
    }

    function isValidProfileStatusRecord(record, now) {
        return Boolean(record)
            && (record.action === "pending" || record.action === "connect")
            && Number.isFinite(record.expiresAt)
            && record.expiresAt > now;
    }

    function rerenderAllCards() {
        for (const profileSlug of cardsBySlug.keys()) {
            rerenderCards(profileSlug);
        }
    }

    async function persistProfileStatusCache() {
        const payload = {};
        for (const [profileSlug, record] of profileStatusBySlug.entries()) {
            if (!isValidProfileStatusRecord(record, Date.now())) {
                continue;
            }

            payload[profileSlug] = {
                action: record.action,
                source: record.source || "profile-cache",
                expiresAt: record.expiresAt,
                profileUrn: typeof record.profileUrn === "string" ? record.profileUrn : ""
            };
        }

        await writeProfileStatusCache(payload);
    }

    async function readProfileStatusCache() {
        if (chrome.storage?.local) {
            const result = await new Promise((resolve, reject) => {
                chrome.storage.local.get([PROFILE_STATUS_CACHE_KEY], (value) => {
                    const error = chrome.runtime?.lastError;
                    if (error) {
                        reject(new Error(error.message));
                        return;
                    }

                    resolve(value || {});
                });
            });

            return result[PROFILE_STATUS_CACHE_KEY] && typeof result[PROFILE_STATUS_CACHE_KEY] === "object"
                ? result[PROFILE_STATUS_CACHE_KEY]
                : {};
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

    async function writeProfileStatusCache(payload) {
        if (chrome.storage?.local) {
            await new Promise((resolve, reject) => {
                chrome.storage.local.set({ [PROFILE_STATUS_CACHE_KEY]: payload }, () => {
                    const error = chrome.runtime?.lastError;
                    if (error) {
                        reject(new Error(error.message));
                        return;
                    }

                    resolve();
                });
            });
            return;
        }

        window.localStorage.setItem(PROFILE_STATUS_CACHE_KEY, JSON.stringify(payload));
    }

    async function readProfileFetchSchedulerState() {
        if (chrome.storage?.local) {
            const result = await new Promise((resolve, reject) => {
                chrome.storage.local.get([PROFILE_FETCH_SCHEDULER_KEY], (value) => {
                    const error = chrome.runtime?.lastError;
                    if (error) {
                        reject(new Error(error.message));
                        return;
                    }

                    resolve(value || {});
                });
            });

            return result[PROFILE_FETCH_SCHEDULER_KEY] && typeof result[PROFILE_FETCH_SCHEDULER_KEY] === "object"
                ? result[PROFILE_FETCH_SCHEDULER_KEY]
                : {};
        }

        try {
            const rawValue = window.localStorage.getItem(PROFILE_FETCH_SCHEDULER_KEY);
            if (!rawValue) {
                return {};
            }

            const parsedValue = JSON.parse(rawValue);
            return parsedValue && typeof parsedValue === "object" ? parsedValue : {};
        } catch {
            return {};
        }
    }

    async function writeProfileFetchSchedulerState(payload) {
        if (chrome.storage?.local) {
            await new Promise((resolve, reject) => {
                chrome.storage.local.set({ [PROFILE_FETCH_SCHEDULER_KEY]: payload }, () => {
                    const error = chrome.runtime?.lastError;
                    if (error) {
                        reject(new Error(error.message));
                        return;
                    }

                    resolve();
                });
            });
            return;
        }

        window.localStorage.setItem(PROFILE_FETCH_SCHEDULER_KEY, JSON.stringify(payload));
    }

    async function writeProfileFetchRuntimeStats(payload) {
        const storageKey = `${PROFILE_FETCH_RUNTIME_KEY_PREFIX}${profileFetchSchedulerState.tabId}`;
        if (chrome.storage?.local) {
            await new Promise((resolve, reject) => {
                chrome.storage.local.set({ [storageKey]: payload }, () => {
                    const error = chrome.runtime?.lastError;
                    if (error) {
                        reject(new Error(error.message));
                        return;
                    }

                    resolve();
                });
            });
            return;
        }

        window.localStorage.setItem(storageKey, JSON.stringify(payload));
    }

    async function clearProfileFetchRuntimeStats() {
        const storageKey = `${PROFILE_FETCH_RUNTIME_KEY_PREFIX}${profileFetchSchedulerState.tabId}`;
        if (chrome.storage?.local) {
            await new Promise((resolve, reject) => {
                chrome.storage.local.remove(storageKey, () => {
                    const error = chrome.runtime?.lastError;
                    if (error) {
                        reject(new Error(error.message));
                        return;
                    }

                    resolve();
                });
            });
            return;
        }

        window.localStorage.removeItem(storageKey);
    }

    async function readProfileFetchSettings() {
        if (chrome.storage?.local) {
            const result = await new Promise((resolve, reject) => {
                chrome.storage.local.get([PROFILE_FETCH_SETTINGS_KEY], (value) => {
                    const error = chrome.runtime?.lastError;
                    if (error) {
                        reject(new Error(error.message));
                        return;
                    }

                    resolve(value || {});
                });
            });

            return normalizeProfileFetchSettings(result[PROFILE_FETCH_SETTINGS_KEY]);
        }

        try {
            const rawValue = window.localStorage.getItem(PROFILE_FETCH_SETTINGS_KEY);
            if (!rawValue) {
                return DEFAULT_PROFILE_FETCH_SETTINGS;
            }

            return normalizeProfileFetchSettings(JSON.parse(rawValue));
        } catch {
            return DEFAULT_PROFILE_FETCH_SETTINGS;
        }
    }

    function getLinkedInCsrfToken() {
        const cookieValue = document.cookie
            .split("; ")
            .find((entry) => entry.startsWith("JSESSIONID="))
            ?.slice("JSESSIONID=".length) || "";

        return cookieValue.replace(/^"|"$/g, "");
    }

    function getLinkedInLanguageHeader() {
        const localeMeta = document.querySelector('meta[name="i18nLocale"]')?.getAttribute("content");
        if (localeMeta) {
            return localeMeta;
        }

        const pageLanguage = (document.documentElement.lang || "en").replace("-", "_");
        if (pageLanguage.includes("_")) {
            return pageLanguage;
        }

        return `${pageLanguage}_US`;
    }

    function looksLikeInvitePending(text, method, status) {
        if (method === "GET") {
            return false;
        }

        if (status === 400 && /(CANT_RESEND_YET|ALREADY_INVITED|INVITATION_EXISTS|PENDING_INVITATION)/i.test(text)) {
            return true;
        }

        if (status >= 200 && status < 400 && /(invitationState|PENDING|already invited|pending invitation)/i.test(text)) {
            return true;
        }

        return false;
    }

    function looksLikeInviteFailure(text, method, status) {
        if (method === "GET") {
            return false;
        }

        if (looksLikeInvitePending(text, method, status)) {
            return false;
        }

        if (status >= 400) {
            return true;
        }

        return /(emailRequired|weekly invitation limit|unable to send invitation|cannot send invitation|something went wrong|try again later|challenge)/i.test(text);
    }

    function delay(ms) {
        return new Promise((resolve) => {
            window.setTimeout(resolve, ms);
        });
    }

    function injectNetworkObserver(targetDocument = document) {
        if (!targetDocument?.documentElement || targetDocument.documentElement.dataset.liliNetworkObserverInjected === "1") {
            return;
        }

        targetDocument.documentElement.dataset.liliNetworkObserverInjected = "1";
        const script = targetDocument.createElement("script");
        script.dataset.liliEventName = NETWORK_HINT_EVENT;
        script.src = chrome.runtime.getURL("page-network-probe.js");
        script.addEventListener("load", () => script.remove(), { once: true });
        script.addEventListener("error", () => {
            console.warn("[LiLi] Failed to load page network probe");
            script.remove();
        }, { once: true });
        (targetDocument.head || targetDocument.documentElement).appendChild(script);
    }

    function normalizeLinkedInUrl(urlLike) {
        const url = new URL(urlLike, LINKEDIN_ORIGIN);
        url.hash = "";
        return url.toString();
    }

    function normalizeText(value) {
        return value.replace(/\s+/g, " ").trim();
    }

})();