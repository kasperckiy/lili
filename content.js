(async () => {
    const LINKEDIN_ORIGIN = "https://www.linkedin.com";
    const CARD_SELECTOR = "li.groups-members-list__typeahead-result";
    const PROFILE_LINK_SELECTOR = "a.ui-conditional-link-wrapper.ui-entity-action-row__link[href]";
    const DEGREE_SELECTOR = ".artdeco-entity-lockup__degree";
    const NAME_SELECTOR = ".entity-action-title";
    const ACTION_SELECTOR = ".entry-point .lili-connect-action, .entry-point .lili-pending-action, .entry-point button.artdeco-button[aria-label*='Message'], .entry-point a[aria-label*='Message']";
    const OBSERVER_MARGIN = "300px";
    const NETWORK_HINT_EVENT = "lili:relationship-hints";

    const relationshipHints = new Map();
    const cardsBySlug = new Map();

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

    injectNetworkObserver();
    window.addEventListener(NETWORK_HINT_EVENT, handleNetworkHints);

    scanCards(document);
    mutationObserver.observe(document.body, { childList: true, subtree: true });

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

            relationshipHints.set(record.slug, {
                action: "pending",
                source: record.source || "network"
            });

            const cards = cardsBySlug.get(record.slug);
            if (!cards) {
                continue;
            }

            cards.forEach((card) => {
                if (card.isConnected) {
                    renderCardAction(card);
                }
            });
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

        const connectionDegree = getConnectionDegree(card);
        if (connectionDegree === "1st") {
            card.dataset.liliPriorityApplied = "message";
            return;
        }

        const desiredAction = relationshipHints.get(profileSlug)?.action === "pending" ? "pending" : "connect";
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
        const replacement = document.createElement("a");
        replacement.href = actionKind === "pending"
            ? profileUrl
            : `/preload/custom-invite/?vanityName=${encodeURIComponent(profileSlug)}`;
        replacement.className = buildActionClassName(currentAction, actionKind);
        replacement.setAttribute(
            "aria-label",
            actionKind === "pending"
                ? (name ? `Pending invitation for ${name}` : "Pending invitation")
                : (name ? `Invite ${name} to connect` : "Invite to connect")
        );
        replacement.dataset.liliPriorityAction = actionKind;
        replacement.dataset.liliPrioritySource = actionKind === "pending" ? "network-hint" : "slug";
        replacement.title = actionKind === "pending"
            ? "Pending invitation detected from LinkedIn page data"
            : "Invite to connect";

        const text = document.createElement("span");
        text.className = "artdeco-button__text";
        text.textContent = actionKind === "pending" ? "Pending" : "Connect";
        replacement.appendChild(text);

        return replacement;
    }

    function buildActionClassName(currentAction, actionKind) {
        const classes = new Set((currentAction.className || "").split(/\s+/).filter(Boolean));
        classes.delete("artdeco-button--secondary");
        classes.delete("artdeco-button--primary");
        classes.add("artdeco-button");
        classes.add("artdeco-button--2");
        classes.add(actionKind === "pending" ? "artdeco-button--secondary" : "artdeco-button--primary");
        classes.add(actionKind === "pending" ? "lili-pending-action" : "lili-connect-action");
        return Array.from(classes).join(" ");
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