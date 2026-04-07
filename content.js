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
    const ACTION_SELECTOR = ".entry-point .lili-connect-action, .entry-point .lili-pending-action, .entry-point .lili-sending-action, .entry-point button.artdeco-button[aria-label*='Message'], .entry-point a[aria-label*='Message']";
    const OBSERVER_MARGIN_PX = 300;
    const OBSERVER_MARGIN = `${OBSERVER_MARGIN_PX}px`;
    const NETWORK_HINT_EVENT = "lili:relationship-hints";
    const INVITE_API_PATH = "/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2";
    const PROFILE_FETCH_TIMEOUT_MS = 15000;
    const PROFILE_STATUS_CACHE_KEY = "lili-profile-status-cache-v2";
    const PROFILE_PAGE_SYNC_DEBOUNCE_MS = 250;
    const SENT_INVITATIONS_SYNC_DEBOUNCE_MS = 250;
    const ROUTE_WATCH_INTERVAL_MS = 500;

    const pageLifecycleState = createPageLifecycleState();
    const relationshipHints = new Map();
    const cardsBySlug = new Map();
    const inviteStateBySlug = new Map();
    const profileStatusBySlug = new Map();
    const profileStatusCacheReady = loadProfileStatusCache();
    const profilePageSyncState = {
        timeoutId: 0,
        observer: null,
        observedDocumentsKey: ""
    };
    const sentInvitationsSyncState = {
        timeoutId: 0,
        observer: null,
        observedDocumentsKey: ""
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
            activePageDocumentsKey: "",
            groupMembersInitialized: false,
            groupMembersObservedDocumentsKey: "",
            profilePageSyncInitialized: false,
            sentInvitationsSyncInitialized: false,
            networkHintTargetWindows: []
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
                || pageLifecycleState.activePageDocumentsKey !== getActivePageDocumentsKey()) {
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
        const nextDocuments = getActivePageDocuments(nextMode);
        const nextDocument = nextDocuments[0] || document;
        const nextDocumentsKey = getPageDocumentsKey(nextDocuments);
        const previousMode = pageLifecycleState.currentMode;
        const didModeChange = previousMode !== nextMode;
        const didUrlChange = pageLifecycleState.lastUrl !== nextUrl;
        const didDocumentChange = pageLifecycleState.activePageDocumentsKey !== nextDocumentsKey;

        if (!didModeChange && !didUrlChange && !didDocumentChange) {
            return;
        }

        pageLifecycleState.lastUrl = nextUrl;
        pageLifecycleState.currentMode = nextMode;
        pageLifecycleState.activePageDocument = nextDocument;
        pageLifecycleState.activePageDocumentsKey = nextDocumentsKey;

        if (previousMode === "profile-page" && nextMode !== "profile-page") {
            profilePageSyncState.observer?.disconnect();
            profilePageSyncState.observedDocumentsKey = "";
            pageLifecycleState.profilePageSyncInitialized = false;
        }

        if (previousMode === "sent-invitations" && nextMode !== "sent-invitations") {
            sentInvitationsSyncState.observer?.disconnect();
            sentInvitationsSyncState.observedDocumentsKey = "";
            pageLifecycleState.sentInvitationsSyncInitialized = false;
        }

        if (previousMode === "group-members" && nextMode !== "group-members") {
            mutationObserver.disconnect();
            pageLifecycleState.groupMembersObservedDocumentsKey = "";
            setNetworkHintTargetWindows([]);
        }

        if (nextMode === "group-members") {
            activateGroupMembersPage(nextDocuments);
            return;
        }

        if (nextMode === "profile-page") {
            await initializeProfilePageSync(nextDocuments);
            return;
        }

        if (nextMode === "sent-invitations") {
            await initializeSentInvitationsSync(nextDocuments);
        }
    }

    function activateGroupMembersPage(targetDocuments = getActivePageDocuments("group-members")) {
        pageLifecycleState.groupMembersInitialized = true;

        const documentsKey = getPageDocumentsKey(targetDocuments);
        targetDocuments.forEach((targetDocument) => {
            injectNetworkObserver(targetDocument);
        });
        setNetworkHintTargetWindows(targetDocuments);

        if (documentsKey && pageLifecycleState.groupMembersObservedDocumentsKey !== documentsKey) {
            mutationObserver.disconnect();
            observeDocumentBodies(mutationObserver, targetDocuments);
            pageLifecycleState.groupMembersObservedDocumentsKey = documentsKey;
        }

        targetDocuments.forEach((targetDocument) => {
            scanCards(targetDocument);
        });
    }

    function getActivePageDocument(mode = pageLifecycleState.currentMode) {
        return getActivePageDocuments(mode)[0] || document;
    }

    function getActivePageDocuments(mode = pageLifecycleState.currentMode) {
        if (mode !== "group-members" && mode !== "profile-page" && mode !== "sent-invitations") {
            return [document];
        }

        const targetDocuments = [];
        addUniquePageDocument(targetDocuments, document);

        const embeddedDocument = getEmbeddedPreloadDocument();
        if (documentMatchesPageMode(embeddedDocument, mode)) {
            addUniquePageDocument(targetDocuments, embeddedDocument);
        }

        return targetDocuments;
    }

    function addUniquePageDocument(targetDocuments, nextDocument) {
        if (!nextDocument?.documentElement || targetDocuments.includes(nextDocument)) {
            return;
        }

        targetDocuments.push(nextDocument);
    }

    function getActivePageDocumentsKey(mode = pageLifecycleState.currentMode) {
        return getPageDocumentsKey(getActivePageDocuments(mode));
    }

    function getPageDocumentsKey(targetDocuments) {
        return targetDocuments
            .filter((targetDocument) => targetDocument?.documentElement)
            .map((targetDocument) => {
                const targetWindow = getDocumentWindow(targetDocument);
                return `${getDocumentPathname(targetDocument)}::${targetWindow === window ? "top" : "embedded"}`;
            })
            .join("|");
    }

    function documentMatchesPageMode(targetDocument, mode) {
        if (!targetDocument?.documentElement) {
            return false;
        }

        const documentPathname = getDocumentPathname(targetDocument);
        if (mode === "group-members") {
            return GROUP_MEMBERS_PATH_PATTERN.test(documentPathname)
                || targetDocument.querySelector(CARD_SELECTOR) instanceof HTMLElement;
        }

        if (mode === "profile-page") {
            return PROFILE_PAGE_PATH_PATTERN.test(documentPathname)
                || Boolean(getProfileSlug(documentPathname ? `${LINKEDIN_ORIGIN}${documentPathname}` : "")
                    && targetDocument.querySelector("main")
                    && getProfileDocumentRecord(targetDocument.documentElement.outerHTML).action);
        }

        if (mode === "sent-invitations") {
            return SENT_INVITATIONS_PATH_PATTERN.test(documentPathname)
                || targetDocument.querySelector(SENT_INVITATION_PROFILE_LINK_SELECTOR) instanceof HTMLAnchorElement;
        }

        return false;
    }

    function getDocumentPathname(targetDocument) {
        try {
            return targetDocument?.defaultView?.location?.pathname || "";
        } catch {
            return "";
        }
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

    function setNetworkHintTargetWindows(targetDocuments) {
        const nextWindows = targetDocuments
            .map((targetDocument) => getDocumentWindow(targetDocument))
            .filter((targetWindow, index, windows) => Boolean(targetWindow) && windows.indexOf(targetWindow) === index);

        for (const previousWindow of pageLifecycleState.networkHintTargetWindows) {
            if (!nextWindows.includes(previousWindow)) {
                previousWindow.removeEventListener(NETWORK_HINT_EVENT, handleNetworkHints);
            }
        }

        for (const targetWindow of nextWindows) {
            if (!pageLifecycleState.networkHintTargetWindows.includes(targetWindow)) {
                targetWindow.addEventListener(NETWORK_HINT_EVENT, handleNetworkHints);
            }
        }

        pageLifecycleState.networkHintTargetWindows = nextWindows;
    }

    function observeDocumentBodies(observer, targetDocuments) {
        targetDocuments.forEach((targetDocument) => {
            const observationRoot = targetDocument?.body || targetDocument?.documentElement;
            if (observationRoot) {
                observer.observe(observationRoot, { childList: true, subtree: true });
            }
        });
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

    async function initializeProfilePageSync(targetDocuments = getActivePageDocuments("profile-page")) {
        await profileStatusCacheReady;
        await syncCurrentProfilePageCache(targetDocuments);

        if (!profilePageSyncState.observer) {
            profilePageSyncState.observer = new MutationObserver(() => {
                scheduleProfilePageSync();
            });
        }

        const documentsKey = getPageDocumentsKey(targetDocuments);
        if (pageLifecycleState.profilePageSyncInitialized && profilePageSyncState.observedDocumentsKey === documentsKey) {
            return;
        }

        pageLifecycleState.profilePageSyncInitialized = true;
        profilePageSyncState.observer.disconnect();
        observeDocumentBodies(profilePageSyncState.observer, targetDocuments);
        profilePageSyncState.observedDocumentsKey = documentsKey;
    }

    function scheduleProfilePageSync() {
        window.clearTimeout(profilePageSyncState.timeoutId);
        profilePageSyncState.timeoutId = window.setTimeout(() => {
            void syncCurrentProfilePageCache(getActivePageDocuments("profile-page"));
        }, PROFILE_PAGE_SYNC_DEBOUNCE_MS);
    }

    async function syncCurrentProfilePageCache(targetDocuments = getActivePageDocuments("profile-page")) {
        const profileSlug = getProfileSlug(window.location.href);
        if (!profileSlug) {
            return;
        }

        let didChange = false;
        for (const targetDocument of targetDocuments) {
            if (!documentMatchesPageMode(targetDocument, "profile-page")) {
                continue;
            }

            const htmlDocument = targetDocument?.documentElement?.outerHTML || document.documentElement.outerHTML;
            const profileRecord = getProfileDocumentRecord(htmlDocument);
            didChange = profileRecord.action === "pending"
                ? applyPendingStatus(profileSlug, "profile-page", profileRecord.profileUrn) || didChange
                : applyConnectStatus(profileSlug, "profile-page", profileRecord.profileUrn) || didChange;
        }

        if (!didChange) {
            return;
        }

        await persistProfileStatusCache();
        rerenderAllCards();
    }

    async function initializeSentInvitationsSync(targetDocuments = getActivePageDocuments("sent-invitations")) {
        await profileStatusCacheReady;
        await syncSentInvitationsCache(targetDocuments);

        if (!sentInvitationsSyncState.observer) {
            sentInvitationsSyncState.observer = new MutationObserver(() => {
                scheduleSentInvitationsSync();
            });
        }

        const documentsKey = getPageDocumentsKey(targetDocuments);
        if (pageLifecycleState.sentInvitationsSyncInitialized && sentInvitationsSyncState.observedDocumentsKey === documentsKey) {
            return;
        }

        pageLifecycleState.sentInvitationsSyncInitialized = true;
        sentInvitationsSyncState.observer.disconnect();
        observeDocumentBodies(sentInvitationsSyncState.observer, targetDocuments);
        sentInvitationsSyncState.observedDocumentsKey = documentsKey;
    }

    function scheduleSentInvitationsSync() {
        window.clearTimeout(sentInvitationsSyncState.timeoutId);
        sentInvitationsSyncState.timeoutId = window.setTimeout(() => {
            void syncSentInvitationsCache(getActivePageDocuments("sent-invitations"));
        }, SENT_INVITATIONS_SYNC_DEBOUNCE_MS);
    }

    async function syncSentInvitationsCache(targetDocuments = getActivePageDocuments("sent-invitations")) {
        const profileSlugs = collectSentInvitationProfileSlugs(targetDocuments);
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

    function collectSentInvitationProfileSlugs(targetDocuments) {
        const profileSlugs = new Set();
        targetDocuments.forEach((targetDocument) => {
            if (!documentMatchesPageMode(targetDocument, "sent-invitations")) {
                return;
            }

            targetDocument.querySelectorAll(SENT_INVITATION_PROFILE_LINK_SELECTOR).forEach((link) => {
                const href = link.getAttribute("href") || "";
                const profileSlug = getProfileSlug(normalizeLinkedInUrl(href));
                if (profileSlug) {
                    profileSlugs.add(profileSlug);
                }
            });
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
        if (!profileUrl || !profileSlug) {
            return;
        }

        registerCard(profileSlug, card);
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
            if (applyConnectStatus(profileSlug, "group-members", "")) {
                void persistProfileStatusCache();
            }

            card.dataset.liliPriorityApplied = "message";
            return;
        }

        const inviteState = inviteStateBySlug.get(profileSlug)?.action;
        const profileStatus = getCachedProfileStatus(profileSlug)?.action || "";
        const desiredAction = relationshipHints.get(profileSlug)?.action === "pending"
            ? "pending"
            : inviteState === "sending"
                ? "sending"
                : profileStatus === "pending"
                    ? "pending"
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
        if (!existingCache) {
            return;
        }

        if (existingCache?.profileUrn === normalizedProfileUrn) {
            return;
        }

        profileStatusBySlug.set(profileSlug, {
            action: existingCache.action,
            source: existingCache.source || source,
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
                : actionKind === "sending"
                    ? (name ? `Sending invitation to ${name}` : "Sending invitation")
                    : (name ? `Invite ${name} to connect` : "Invite to connect")
        );
        replacement.dataset.liliPriorityAction = actionKind;
        replacement.dataset.liliPrioritySource = actionSource;
        replacement.title = actionKind === "pending"
            ? getPendingTitle(actionSource)
            : actionKind === "sending"
                ? "Sending invitation without a note"
                : "Send invitation without a note";

        if (actionKind === "pending" || actionKind === "sending") {
            replacement.disabled = true;
            replacement.setAttribute("aria-disabled", "true");
        }

        if (actionKind === "sending") {
            replacement.setAttribute("aria-busy", "true");
        }

        const text = elementDocument.createElement("span");
        text.className = "artdeco-button__text";
        text.textContent = actionKind === "pending"
            ? "Pending"
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

        if (actionKind === "connect") {
            return "group-members";
        }

        return "invite-flow";
    }

    function getPendingTitle(source) {
        return source === "profile-fetch" || source === "profile-cache"
            ? "Pending invitation confirmed from the LinkedIn profile document"
            : source === "profile-page"
                ? "Pending invitation confirmed from the opened LinkedIn profile page"
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
        classes.delete("lili-pending-action");
        classes.add("artdeco-button");
        classes.add("artdeco-button--2");
        classes.add(actionKind === "pending" ? "artdeco-button--secondary" : "artdeco-button--primary");
        classes.add(actionKind === "pending"
            ? "lili-pending-action"
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

            return profileRecord;
        } catch (error) {
            if (error?.name === "AbortError") {
                throw createProfileFetchError("timeout", "Profile fetch timed out");
            }

            throw error;
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

    function getCachedProfileStatus(profileSlug) {
        return profileStatusBySlug.get(profileSlug) || null;
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
        const nextProfileUrn = profileUrn || existingCache?.profileUrn || "";
        const didChange = existingHint?.action !== "pending"
            || existingHint?.source !== source
            || existingCache?.action !== "pending"
            || existingCache?.source !== cachedSource
            || (existingCache?.profileUrn || "") !== nextProfileUrn;

        relationshipHints.set(profileSlug, {
            action: "pending",
            source
        });
        inviteStateBySlug.delete(profileSlug);
        profileStatusBySlug.set(profileSlug, {
            action: "pending",
            source: cachedSource,
            profileUrn: nextProfileUrn
        });

        return didChange;
    }

    function applyConnectStatus(profileSlug, source, profileUrn) {
        const existingHint = relationshipHints.get(profileSlug);
        const existingCache = getCachedProfileStatus(profileSlug);
        const didChange = Boolean(existingHint)
            || Boolean(existingCache);

        relationshipHints.delete(profileSlug);
        inviteStateBySlug.delete(profileSlug);
        profileStatusBySlug.delete(profileSlug);

        void source;
        void profileUrn;

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
        const nextRecords = new Map();
        let didPrune = false;

        for (const [profileSlug, record] of Object.entries(storedCache || {})) {
            if (!isValidProfileStatusRecord(record)) {
                didPrune = true;
                continue;
            }

            nextRecords.set(profileSlug, {
                action: "pending",
                source: record.source || "profile-cache",
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

    function isValidProfileStatusRecord(record) {
        return Boolean(record)
            && record.action === "pending";
    }

    function rerenderAllCards() {
        for (const profileSlug of cardsBySlug.keys()) {
            rerenderCards(profileSlug);
        }
    }

    async function persistProfileStatusCache() {
        const payload = {};
        for (const [profileSlug, record] of profileStatusBySlug.entries()) {
            if (!isValidProfileStatusRecord(record)) {
                continue;
            }

            payload[profileSlug] = {
                action: "pending",
                source: record.source || "profile-cache",
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