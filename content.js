(async () => {
    const LINKEDIN_ORIGIN = "https://www.linkedin.com";
    const CARD_SELECTOR = "li.groups-members-list__typeahead-result";
    const PROFILE_LINK_SELECTOR = "a.ui-conditional-link-wrapper.ui-entity-action-row__link[href]";
    const DEGREE_SELECTOR = ".artdeco-entity-lockup__degree";
    const NAME_SELECTOR = ".entity-action-title";
    const ACTION_SELECTOR = ".entry-point .lili-connect-action, .entry-point .lili-pending-action, .entry-point .lili-sending-action, .entry-point button.artdeco-button[aria-label*='Message'], .entry-point a[aria-label*='Message']";
    const OBSERVER_MARGIN = "300px";
    const NETWORK_HINT_EVENT = "lili:relationship-hints";
    const INVITE_FRAME_TIMEOUT_MS = 15000;
    const INVITE_RESULT_TIMEOUT_MS = 8000;
    const INVITE_POLL_INTERVAL_MS = 200;
    const SEND_WITHOUT_NOTE_LABEL = "Send without a note";

    const relationshipHints = new Map();
    const cardsBySlug = new Map();
    const inviteStateBySlug = new Map();

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
            inviteStateBySlug.delete(record.slug);
            rerenderCards(record.slug);
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

        const inviteState = inviteStateBySlug.get(profileSlug)?.action;
        const desiredAction = relationshipHints.get(profileSlug)?.action === "pending"
            ? "pending"
            : inviteState === "sending"
                ? "sending"
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
        const replacement = document.createElement("button");
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
        replacement.dataset.liliPrioritySource = actionKind === "pending" ? "network-hint" : "invite-flow";
        replacement.title = actionKind === "pending"
            ? "Pending invitation detected from LinkedIn page data"
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

        const text = document.createElement("span");
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

    function buildActionClassName(currentAction, actionKind) {
        const classes = new Set((currentAction.className || "").split(/\s+/).filter(Boolean));
        classes.delete("artdeco-button--secondary");
        classes.delete("artdeco-button--primary");
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

        const sent = await sendInviteWithoutNote(profileSlug);
        inviteStateBySlug.delete(profileSlug);

        if (sent) {
            relationshipHints.set(profileSlug, {
                action: "pending",
                source: "invite-flow"
            });
        }

        rerenderCards(profileSlug);
    }

    async function sendInviteWithoutNote(profileSlug) {
        const frame = document.createElement("iframe");
        frame.setAttribute("aria-hidden", "true");
        frame.tabIndex = -1;
        frame.style.position = "fixed";
        frame.style.right = "0";
        frame.style.bottom = "0";
        frame.style.width = "1px";
        frame.style.height = "1px";
        frame.style.opacity = "0";
        frame.style.pointerEvents = "none";
        frame.style.border = "0";
        frame.style.zIndex = "-1";

        document.body.appendChild(frame);

        let requestObserver = null;

        try {
            await loadInviteFrame(frame, `/preload/custom-invite/?vanityName=${encodeURIComponent(profileSlug)}`);

            if (!frame.contentWindow) {
                throw new Error("Invite frame did not expose a window");
            }

            requestObserver = installInviteRequestObserver(frame.contentWindow);

            const sendButton = await waitForInviteSendButton(frame);
            sendButton.click();

            return await waitForInviteOutcome(frame, requestObserver.state);
        } catch (error) {
            console.warn("[LiLi] Failed to send invite without note", error);
            return false;
        } finally {
            requestObserver?.restore();
            frame.remove();
        }
    }

    function loadInviteFrame(frame, url) {
        return new Promise((resolve, reject) => {
            const handleLoad = () => {
                cleanup();
                resolve();
            };

            const handleError = () => {
                cleanup();
                reject(new Error("Invite frame failed to load"));
            };

            const timeoutId = window.setTimeout(() => {
                cleanup();
                reject(new Error("Invite frame load timed out"));
            }, INVITE_FRAME_TIMEOUT_MS);

            function cleanup() {
                window.clearTimeout(timeoutId);
                frame.removeEventListener("load", handleLoad);
                frame.removeEventListener("error", handleError);
            }

            frame.addEventListener("load", handleLoad, { once: true });
            frame.addEventListener("error", handleError, { once: true });
            frame.src = normalizeLinkedInUrl(url);
        });
    }

    async function waitForInviteSendButton(frame) {
        const deadline = Date.now() + INVITE_FRAME_TIMEOUT_MS;

        while (Date.now() < deadline) {
            const sendButton = queryInviteSendButton(frame.contentDocument);
            if (sendButton instanceof HTMLButtonElement) {
                return sendButton;
            }

            await delay(INVITE_POLL_INTERVAL_MS);
        }

        throw new Error("Send without note button not found");
    }

    async function waitForInviteOutcome(frame, requestState) {
        const deadline = Date.now() + INVITE_RESULT_TIMEOUT_MS;

        while (Date.now() < deadline) {
            if (requestState.success) {
                return true;
            }

            if (requestState.failure) {
                return false;
            }

            if (!queryInviteSendButton(frame.contentDocument)) {
                return true;
            }

            await delay(INVITE_POLL_INTERVAL_MS);
        }

        return requestState.success;
    }

    function queryInviteSendButton(doc) {
        const root = getInviteQueryRoot(doc);
        if (!root || !(root instanceof Document || root instanceof DocumentFragment || root instanceof Element)) {
            return null;
        }

        return root.querySelector(`button[aria-label='${SEND_WITHOUT_NOTE_LABEL}']`);
    }

    function getInviteQueryRoot(doc) {
        if (!(doc instanceof Document)) {
            return null;
        }

        const outlet = doc.getElementById("interop-outlet");
        if (!outlet) {
            return doc;
        }

        const template = outlet.querySelector("template[shadowrootmode='open']");
        return outlet.shadowRoot || template?.content || doc;
    }

    function installInviteRequestObserver(frameWindow) {
        const state = {
            success: false,
            failure: false
        };

        const originalFetch = typeof frameWindow.fetch === "function" ? frameWindow.fetch : null;
        if (originalFetch) {
            frameWindow.fetch = async function (...args) {
                const response = await originalFetch.apply(this, args);

                try {
                    const text = await response.clone().text();
                    updateInviteRequestState(
                        state,
                        getFetchMethod(args),
                        getFetchUrl(args),
                        response.status,
                        text
                    );
                } catch {
                    // ignore probe failures
                }

                return response;
            };
        }

        const xhrPrototype = frameWindow.XMLHttpRequest?.prototype;
        const originalOpen = xhrPrototype?.open;
        const originalSend = xhrPrototype?.send;

        if (xhrPrototype && originalOpen && originalSend) {
            xhrPrototype.open = function (method, url, ...rest) {
                this.__liliRequestMethod = method;
                this.__liliRequestUrl = url;
                return originalOpen.call(this, method, url, ...rest);
            };

            xhrPrototype.send = function (...args) {
                this.addEventListener("load", () => {
                    try {
                        const text = this.responseType && this.responseType !== "text" && this.responseType !== "json"
                            ? ""
                            : this.responseType === "json"
                                ? JSON.stringify(this.response)
                                : this.responseText;

                        updateInviteRequestState(
                            state,
                            this.__liliRequestMethod,
                            this.__liliRequestUrl,
                            this.status,
                            text || ""
                        );
                    } catch {
                        // ignore probe failures
                    }
                }, { once: true });

                return originalSend.apply(this, args);
            };
        }

        return {
            state,
            restore() {
                if (originalFetch) {
                    frameWindow.fetch = originalFetch;
                }

                if (xhrPrototype && originalOpen && originalSend) {
                    xhrPrototype.open = originalOpen;
                    xhrPrototype.send = originalSend;
                }
            }
        };
    }

    function updateInviteRequestState(state, method, urlLike, status, text) {
        if (state.success || state.failure) {
            return;
        }

        const normalizedMethod = String(method || "GET").toUpperCase();
        const normalizedUrl = normalizeRequestUrl(urlLike);
        const haystack = `${normalizedMethod} ${normalizedUrl} ${text || ""}`;

        if (looksLikeInviteFailure(haystack, normalizedMethod, status)) {
            state.failure = true;
            return;
        }

        if (looksLikeInviteSuccess(haystack, normalizedMethod, status)) {
            state.success = true;
        }
    }

    function looksLikeInviteSuccess(text, method, status) {
        if (method === "GET" || status < 200 || status >= 400) {
            return false;
        }

        return /(invitationId|sharedSecret|invitationState|invitationUrn|INVITATION_SENT|PENDING|inviteeMember)/i.test(text);
    }

    function looksLikeInviteFailure(text, method, status) {
        if (method === "GET") {
            return false;
        }

        if (status >= 400) {
            return true;
        }

        return /(emailRequired|weekly invitation limit|unable to send invitation|cannot send invitation|something went wrong|try again later|challenge)/i.test(text);
    }

    function getFetchMethod(args) {
        const request = args[0];
        const init = args[1];
        return init?.method || request?.method || "GET";
    }

    function getFetchUrl(args) {
        const request = args[0];
        return typeof request === "string" ? request : request?.url || "";
    }

    function normalizeRequestUrl(urlLike) {
        if (!urlLike) {
            return "";
        }

        try {
            return new URL(urlLike, LINKEDIN_ORIGIN).toString();
        } catch {
            return "";
        }
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