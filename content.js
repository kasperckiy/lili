(async () => {
    const LINKEDIN_ORIGIN = "https://www.linkedin.com";
    const CARD_SELECTOR = "li.groups-members-list__typeahead-result";
    const PROFILE_LINK_SELECTOR = "a.ui-conditional-link-wrapper.ui-entity-action-row__link[href]";
    const MESSAGE_BUTTON_SELECTOR = ".entry-point button.artdeco-button[aria-label*='Message']";
    const CACHE_KEY = "liliLinkedInPriorityActionCacheV1";
    const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
    const MAX_CONCURRENT_FETCHES = 2;
    const OBSERVER_MARGIN = "300px";

    const cache = new Map();
    const cardQueue = [];
    let activeFetches = 0;
    let persistTimer = null;

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

    await loadCache();
    scanCards(document);
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    function handleIntersections(entries) {
        for (const entry of entries) {
            if (!entry.isIntersecting) {
                continue;
            }

            intersectionObserver.unobserve(entry.target);
            enqueueCard(entry.target);
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

    function enqueueCard(card) {
        if (!(card instanceof HTMLElement)) {
            return;
        }

        if (card.dataset.liliPriorityQueued === "1") {
            return;
        }

        card.dataset.liliPriorityQueued = "1";
        cardQueue.push(card);
        pumpQueue();
    }

    function pumpQueue() {
        while (activeFetches < MAX_CONCURRENT_FETCHES && cardQueue.length > 0) {
            const card = cardQueue.shift();
            activeFetches += 1;
            void processCard(card)
                .catch((error) => {
                    console.warn("[LiLi] Failed to process card", error);
                })
                .finally(() => {
                    activeFetches -= 1;
                    pumpQueue();
                });
        }
    }

    async function processCard(card) {
        if (!(card instanceof HTMLElement)) {
            return;
        }

        try {
            const profileUrl = getCardProfileUrl(card);
            const messageButton = card.querySelector(MESSAGE_BUTTON_SELECTOR);

            if (!profileUrl || !messageButton || card.dataset.liliPriorityProcessed === "1") {
                return;
            }

            const action = await getPriorityAction(profileUrl);
            applyAction(card, messageButton, profileUrl, action);
            card.dataset.liliPriorityProcessed = "1";
        } catch (error) {
            delete card.dataset.liliPriorityQueued;
            intersectionObserver.observe(card);
            throw error;
        }
    }

    function getCardProfileUrl(card) {
        const profileLink = card.querySelector(PROFILE_LINK_SELECTOR);
        const href = profileLink?.getAttribute("href");
        return href ? normalizeLinkedInUrl(href) : "";
    }

    async function getPriorityAction(profileUrl) {
        const cacheKey = getCacheKey(profileUrl);
        const cached = cache.get(cacheKey);

        if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
            return cached;
        }

        const action = await fetchProfileAction(profileUrl);
        action.cachedAt = Date.now();
        cache.set(cacheKey, action);
        schedulePersistCache();
        return action;
    }

    async function fetchProfileAction(profileUrl) {
        const response = await fetch(profileUrl, {
            credentials: "include",
            headers: {
                "accept": "text/html,application/xhtml+xml"
            }
        });

        if (!response.ok) {
            throw new Error(`Profile fetch failed with ${response.status}`);
        }

        const html = await response.text();
        const documentFragment = new DOMParser().parseFromString(html, "text/html");
        const connect = findAction(documentFragment, "connect", profileUrl);
        if (connect) {
            return connect;
        }

        const pending = findAction(documentFragment, "pending", profileUrl);
        if (pending) {
            return pending;
        }

        const message = findAction(documentFragment, "message", profileUrl);
        if (message) {
            return message;
        }

        return {
            kind: "message",
            label: "Message",
            url: profileUrl,
            ariaLabel: `Open ${profileUrl}`
        };
    }

    function findAction(doc, kind, profileUrl) {
        const selectorsByKind = {
            connect: [
                "a[aria-label*='Invite'][aria-label*='connect'][href]",
                "a[href*='/preload/custom-invite/'][href]"
            ],
            pending: [
                "a[aria-label*='Pending'][href]",
                "a[aria-label*='withdraw invitation'][href]"
            ],
            message: [
                "a[href*='/messaging/compose/'][href]",
                "button[aria-label*='Message']"
            ]
        };

        const selectors = selectorsByKind[kind] || [];
        for (const selector of selectors) {
            const node = doc.querySelector(selector);
            if (!node) {
                continue;
            }

            const label = extractActionLabel(node, kind);
            const href = node.getAttribute("href");
            return {
                kind,
                label,
                url: href ? normalizeLinkedInUrl(href) : profileUrl,
                ariaLabel: node.getAttribute("aria-label") || label
            };
        }

        return null;
    }

    function extractActionLabel(node, kind) {
        const text = normalizeText(node.textContent || "");
        if (text) {
            if (text.includes("Connect")) {
                return "Connect";
            }
            if (text.includes("Pending")) {
                return "Pending";
            }
            if (text.includes("Message")) {
                return "Message";
            }
        }

        if (kind === "connect") {
            return "Connect";
        }
        if (kind === "pending") {
            return "Pending";
        }
        return "Message";
    }

    function applyAction(card, messageButton, profileUrl, action) {
        if (!action || action.kind === "message") {
            return;
        }

        const replacement = document.createElement("a");
        replacement.href = action.url || profileUrl;
        replacement.target = "_blank";
        replacement.rel = "noopener noreferrer";
        replacement.role = "button";
        replacement.className = buildReplacementClassName(messageButton, action.kind);
        replacement.setAttribute("aria-label", action.ariaLabel || action.label);
        replacement.dataset.liliPriorityAction = action.kind;
        replacement.title = action.kind === "pending"
            ? "Pending invitation detected on profile"
            : "Connect action detected on profile";

        const text = document.createElement("span");
        text.className = "artdeco-button__text";
        text.textContent = action.label;
        replacement.appendChild(text);

        messageButton.replaceWith(replacement);
        card.dataset.liliPriorityApplied = action.kind;
    }

    function buildReplacementClassName(messageButton, kind) {
        const classes = new Set((messageButton.className || "").split(/\s+/).filter(Boolean));
        classes.delete("artdeco-button--secondary");
        classes.delete("artdeco-button--primary");
        classes.add("artdeco-button");
        classes.add("artdeco-button--2");
        classes.add(kind === "connect" ? "artdeco-button--primary" : "artdeco-button--secondary");
        classes.add("lili-priority-action");
        classes.add(`lili-priority-action--${kind}`);
        return Array.from(classes).join(" ");
    }

    function normalizeLinkedInUrl(urlLike) {
        const url = new URL(urlLike, LINKEDIN_ORIGIN);
        url.hash = "";
        return url.toString();
    }

    function getCacheKey(profileUrl) {
        const url = new URL(profileUrl);
        return url.pathname.replace(/\/$/, "");
    }

    function normalizeText(value) {
        return value.replace(/\s+/g, " ").trim();
    }

    async function loadCache() {
        const stored = await chrome.storage.local.get(CACHE_KEY);
        const rawCache = stored[CACHE_KEY] || {};
        for (const [key, value] of Object.entries(rawCache)) {
            if (!value || typeof value !== "object") {
                continue;
            }
            if (Date.now() - value.cachedAt >= CACHE_TTL_MS) {
                continue;
            }
            cache.set(key, value);
        }
    }

    function schedulePersistCache() {
        if (persistTimer !== null) {
            clearTimeout(persistTimer);
        }

        persistTimer = window.setTimeout(() => {
            persistTimer = null;
            const payload = Object.fromEntries(cache.entries());
            void chrome.storage.local.set({ [CACHE_KEY]: payload });
        }, 250);
    }
})();