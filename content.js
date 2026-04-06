(async () => {
    const LINKEDIN_ORIGIN = "https://www.linkedin.com";
    const GROUP_MEMBERS_PATH_PATTERN = /^\/groups\/[^/]+\/members(?:\/|$)/;
    const PROFILE_PAGE_PATH_PATTERN = /^\/in\/[^/]+(?:\/|$)/;
    const SENT_INVITATIONS_PATH_PATTERN = /^\/mynetwork\/invitation-manager\/sent(?:\/|$)/;
    const CARD_SELECTOR = "li.groups-members-list__typeahead-result";
    const PROFILE_LINK_SELECTOR = "a.ui-conditional-link-wrapper.ui-entity-action-row__link[href]";
    const SENT_INVITATION_PROFILE_LINK_SELECTOR = "main a[href*='/in/']";
    const DEGREE_SELECTOR = ".artdeco-entity-lockup__degree";
    const NAME_SELECTOR = ".entity-action-title";
    const ACTION_SELECTOR = ".entry-point .lili-connect-action, .entry-point .lili-pending-action, .entry-point .lili-sending-action, .entry-point .lili-loading-action, .entry-point button.artdeco-button[aria-label*='Message'], .entry-point a[aria-label*='Message']";
    const OBSERVER_MARGIN = "300px";
    const NETWORK_HINT_EVENT = "lili:relationship-hints";
    const INVITE_API_PATH = "/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2";
    const PROFILE_FETCH_TIMEOUT_MS = 15000;
    const PROFILE_REQUEST_DELAY_MIN_MS = 1;
    const PROFILE_REQUEST_DELAY_MAX_MS = 10000;
    const PROFILE_STATUS_CACHE_KEY = "lili-profile-status-cache-v2";
    const PROFILE_STATUS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
    const PROFILE_PAGE_SYNC_DEBOUNCE_MS = 250;
    const SENT_INVITATIONS_SYNC_DEBOUNCE_MS = 250;

    const pageMode = getPageMode();
    const relationshipHints = new Map();
    const cardsBySlug = new Map();
    const inviteStateBySlug = new Map();
    const profileStatusBySlug = new Map();
    const profileProbeStateBySlug = new Map();
    const profileStatusCacheReady = loadProfileStatusCache();
    const profilePageSyncState = {
        timeoutId: 0
    };
    const sentInvitationsSyncState = {
        timeoutId: 0
    };

    const intersectionObserver = new IntersectionObserver(handleIntersections, {
        root: null,
        rootMargin: OBSERVER_MARGIN,
        threshold: 0
    });

    const mutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof Element)) {
                    continue;
                }

                if (node.matches?.(CARD_SELECTOR)) {
                    observeCard(node);
                }

                node.querySelectorAll?.(CARD_SELECTOR).forEach(observeCard);
            }
        }
    });

    installProfileStatusCacheObserver();

    if (pageMode === "group-members") {
        injectNetworkObserver();
        window.addEventListener(NETWORK_HINT_EVENT, handleNetworkHints);

        scanCards(document);
        mutationObserver.observe(document.body, { childList: true, subtree: true });
    } else if (pageMode === "profile-page") {
        void initializeProfilePageSync();
    } else if (pageMode === "sent-invitations") {
        void initializeSentInvitationsSync();
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

    async function initializeProfilePageSync() {
        await profileStatusCacheReady;
        await syncCurrentProfilePageCache();

        const profilePageObserver = new MutationObserver(() => {
            scheduleProfilePageSync();
        });

        profilePageObserver.observe(document.body, { childList: true, subtree: true });
    }

    function scheduleProfilePageSync() {
        window.clearTimeout(profilePageSyncState.timeoutId);
        profilePageSyncState.timeoutId = window.setTimeout(() => {
            void syncCurrentProfilePageCache();
        }, PROFILE_PAGE_SYNC_DEBOUNCE_MS);
    }

    async function syncCurrentProfilePageCache() {
        const profileSlug = getProfileSlug(window.location.href);
        if (!profileSlug) {
            return;
        }

        const profileRecord = getProfileDocumentRecord(document.documentElement.outerHTML);
        const didChange = profileRecord.action === "pending"
            ? applyPendingStatus(profileSlug, "profile-page", profileRecord.profileUrn)
            : applyConnectStatus(profileSlug, "profile-page", profileRecord.profileUrn);

        if (!didChange) {
            return;
        }

        await persistProfileStatusCache();
        rerenderAllCards();
    }

    async function initializeSentInvitationsSync() {
        await profileStatusCacheReady;
        await syncSentInvitationsCache(document);

        const sentInvitationsObserver = new MutationObserver(() => {
            scheduleSentInvitationsSync();
        });

        sentInvitationsObserver.observe(document.body, { childList: true, subtree: true });
    }

    function scheduleSentInvitationsSync() {
        window.clearTimeout(sentInvitationsSyncState.timeoutId);
        sentInvitationsSyncState.timeoutId = window.setTimeout(() => {
            void syncSentInvitationsCache(document);
        }, SENT_INVITATIONS_SYNC_DEBOUNCE_MS);
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
            if (!record || record.action !== "pending" || !record.slug) {
                continue;
            }

            const existing = relationshipHints.get(record.slug);
            if (existing?.action === "pending") {
                continue;
            }

            setPendingStatus(record.slug, record.source || "network");
        }
    }

    function scanCards(root) {
        root.querySelectorAll(CARD_SELECTOR).forEach(observeCard);
    }

    function observeCard(card) {
        if (!(card instanceof HTMLElement)) {
            return;
        }

        if (card.dataset.liliPriorityObserved === "1") {
            return;
        }

        card.dataset.liliPriorityObserved = "1";
        intersectionObserver.observe(card);
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

    function buildActionElement(card, currentAction, actionKind, profileUrl, profileSlug) {
        const name = normalizeText(card.querySelector(NAME_SELECTOR)?.textContent || "");
        const actionSource = getActionSource(profileSlug, actionKind);
        const replacement = document.createElement("button");
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

        const text = document.createElement("span");
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
        void resolveProfileStatus(profileSlug)
            .catch((error) => {
                console.debug("[LiLi] Profile fetch failed", profileSlug, error);
                profileProbeStateBySlug.set(profileSlug, { status: "failed" });
                rerenderCards(profileSlug);
            });
    }

    async function sendInviteWithoutNote(profileSlug) {
        try {
            const profileRecord = await ensureProfileRecord(profileSlug);
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

    async function ensureProfileRecord(profileSlug) {
        await profileStatusCacheReady;

        const cachedRecord = getCachedProfileStatus(profileSlug);
        if (cachedRecord?.profileUrn) {
            return cachedRecord;
        }

        const fetchedRecord = await fetchProfileRecord(profileSlug);
        await setCachedProfileStatus(profileSlug, fetchedRecord.action, "profile-fetch", fetchedRecord.profileUrn);
        return getCachedProfileStatus(profileSlug) || fetchedRecord;
    }

    async function sendInviteThroughApi(profileUrn) {
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
    }

    async function resolveProfileStatus(profileSlug) {
        await profileStatusCacheReady;

        if (relationshipHints.get(profileSlug)?.action === "pending" || getCachedProfileStatus(profileSlug)) {
            profileProbeStateBySlug.delete(profileSlug);
            rerenderCards(profileSlug);
            return;
        }

        await delay(getRandomProfileDelayMs());

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
                throw new Error(`Profile fetch failed with status ${response.status}`);
            }

            const html = await response.text();
            return getProfileDocumentRecord(html);
        } finally {
            window.clearTimeout(timeoutId);
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
            return `urn:li:fsd_profile:${decodeURIComponent(encodedProfileUrnMatch[1])}`;
        }

        const profileUrnMatch = html.match(/urn:li:fsd_profile:([A-Za-z0-9_-]+)/i);
        if (profileUrnMatch?.[1]) {
            return `urn:li:fsd_profile:${profileUrnMatch[1]}`;
        }

        return "";
    }

    function getRandomProfileDelayMs() {
        return Math.floor(Math.random() * (PROFILE_REQUEST_DELAY_MAX_MS - PROFILE_REQUEST_DELAY_MIN_MS + 1))
            + PROFILE_REQUEST_DELAY_MIN_MS;
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

    function injectNetworkObserver() {
        if (document.documentElement.dataset.liliNetworkObserverInjected === "1") {
            return;
        }

        document.documentElement.dataset.liliNetworkObserverInjected = "1";
        const script = document.createElement("script");
        script.dataset.liliEventName = NETWORK_HINT_EVENT;
        script.src = chrome.runtime.getURL("page-network-probe.js");
        script.addEventListener("load", () => script.remove(), { once: true });
        script.addEventListener("error", () => {
            console.warn("[LiLi] Failed to load page network probe");
            script.remove();
        }, { once: true });
        (document.head || document.documentElement).appendChild(script);
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