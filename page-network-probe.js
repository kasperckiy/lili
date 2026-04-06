(() => {
    const eventName = document.currentScript?.dataset.liliEventName || "lili:relationship-hints";

    if (window.__liliNetworkProbeInstalled) {
        return;
    }

    window.__liliNetworkProbeInstalled = true;

    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        try {
            inspectJsonResponse(response.clone(), args[0]);
        } catch (error) {
            console.debug("[LiLi] fetch inspection failed", error);
        }
        return response;
    };

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__liliRequestUrl = url;
        return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener("load", () => {
            try {
                inspectXhrResponse(this);
            } catch (error) {
                console.debug("[LiLi] xhr inspection failed", error);
            }
        });
        return originalSend.apply(this, args);
    };

    async function inspectJsonResponse(response, requestInfo) {
        const url = normalizeRequestUrl(typeof requestInfo === "string" ? requestInfo : requestInfo?.url);
        if (!isInterestingRequest(url)) {
            return;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("json")) {
            return;
        }

        const text = await response.text();
        emitHintsFromText(text, url);
    }

    function inspectXhrResponse(xhr) {
        const url = normalizeRequestUrl(xhr.__liliRequestUrl);
        if (!isInterestingRequest(url)) {
            return;
        }

        const contentType = xhr.getResponseHeader("content-type") || "";
        if (!contentType.includes("json")) {
            return;
        }

        if (xhr.responseType && xhr.responseType !== "text" && xhr.responseType !== "json") {
            return;
        }

        const text = xhr.responseType === "json" ? JSON.stringify(xhr.response) : xhr.responseText;
        emitHintsFromText(text, url);
    }

    function emitHintsFromText(text, url) {
        if (!text) {
            return;
        }

        let payload;
        try {
            payload = JSON.parse(text);
        } catch {
            return;
        }

        const hints = collectRelationshipHints(payload, url);
        if (hints.length === 0) {
            return;
        }

        window.dispatchEvent(new CustomEvent(eventName, { detail: hints }));
    }

    function collectRelationshipHints(payload, url) {
        const voyagerHints = collectVoyagerRelationshipHints(payload, url);
        if (voyagerHints.length > 0) {
            return voyagerHints;
        }

        const hints = [];
        const seen = new Set();
        let budget = 5000;

        walk(payload, 0);
        return hints;

        function walk(node, depth) {
            if (!node || budget <= 0 || depth > 8) {
                return;
            }

            budget -= 1;

            if (Array.isArray(node)) {
                for (const item of node) {
                    walk(item, depth + 1);
                }
                return;
            }

            if (typeof node !== "object") {
                return;
            }

            const hint = inferPendingHint(node, url);
            if (hint) {
                const key = `${hint.slug}:${hint.action}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    hints.push(hint);
                }
            }

            for (const value of Object.values(node)) {
                if (value && typeof value === "object") {
                    walk(value, depth + 1);
                }
            }
        }
    }

    function collectVoyagerRelationshipHints(payload, url) {
        const hints = [];
        const seen = new Set();
        let budget = 500;

        walk(payload, 0);
        return hints;

        function walk(node, depth) {
            if (!node || budget <= 0 || depth > 8) {
                return;
            }

            budget -= 1;

            if (Array.isArray(node)) {
                for (const item of node) {
                    walk(item, depth + 1);
                }
                return;
            }

            if (typeof node !== "object") {
                return;
            }

            const included = Array.isArray(node.included) ? node.included : null;
            if (included) {
                collectFromIncluded(included);
            }

            for (const value of Object.values(node)) {
                if (value && typeof value === "object") {
                    walk(value, depth + 1);
                }
            }
        }

        function collectFromIncluded(included) {
            const relationshipUrnToSlug = new Map();

            for (const entity of included) {
                if (!entity || typeof entity !== "object") {
                    continue;
                }

                const slug = getVoyagerProfileSlug(entity);
                const relationshipUrn = getVoyagerRelationshipUrn(entity);
                if (slug && relationshipUrn) {
                    relationshipUrnToSlug.set(relationshipUrn, slug);
                }

                if (!slug || !hasPendingProfileAction(entity)) {
                    continue;
                }

                addHint(slug, url);
            }

            for (const entity of included) {
                if (!entity || typeof entity !== "object") {
                    continue;
                }

                if (!hasPendingRelationship(entity)) {
                    continue;
                }

                const slug = relationshipUrnToSlug.get(entity.entityUrn) || extractSlug(entity);
                if (!slug) {
                    continue;
                }

                addHint(slug, url);
            }
        }

        function addHint(slug, sourceUrl) {
            const key = `${slug}:pending`;
            if (seen.has(key)) {
                return;
            }

            seen.add(key);
            hints.push({
                slug,
                action: "pending",
                source: sourceUrl || "voyager"
            });
        }
    }

    function inferPendingHint(node, url) {
        const slug = extractSlug(node);
        if (!slug) {
            return null;
        }

        const stateText = flattenPrimitivePairs(node);
        if (!looksLikePendingState(stateText)) {
            return null;
        }

        return {
            slug,
            action: "pending",
            source: url || "network"
        };
    }

    function extractSlug(node) {
        const directKeys = ["publicIdentifier", "vanityName", "memberVanityName", "profileVanityName"];
        for (const key of directKeys) {
            const value = node[key];
            if (typeof value === "string" && isValidSlug(value)) {
                return value;
            }
        }

        for (const value of Object.values(node)) {
            if (typeof value !== "string") {
                continue;
            }

            const slug = extractSlugFromString(value);
            if (slug) {
                return slug;
            }
        }

        return "";
    }

    function flattenPrimitivePairs(node) {
        const parts = [];
        for (const [key, value] of Object.entries(node)) {
            if (value == null) {
                continue;
            }

            if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
                parts.push(`${key}:${String(value)}`);
            }
        }
        return parts.join(" | ");
    }

    function looksLikePendingState(text) {
        return /(pending|withdraw invitation|invitation sent|already invited|isInvited:true|sentInvitation|PENDING|INVITATION_SENT)/i.test(text);
    }

    function getVoyagerProfileSlug(entity) {
        const slug = entity.publicIdentifier;
        return typeof slug === "string" && isValidSlug(slug) ? slug : "";
    }

    function getVoyagerRelationshipUrn(entity) {
        const relationshipUrn = entity["*memberRelationship"]
            || entity.memberRelationshipUrn
            || entity.memberRelationshipWrapper?.memberRelationshipUrn;
        return typeof relationshipUrn === "string" ? relationshipUrn : "";
    }

    function hasPendingProfileAction(entity) {
        const primaryAction = entity.profileStatefulProfileActions?.primaryActionResolutionResult;
        return hasNonNullValue(primaryAction?.withdraw)
            || hasNonNullValue(primaryAction?.["*withdraw"])
            || hasNonNullValue(primaryAction?.invitation)
            || hasNonNullValue(primaryAction?.["*invitation"]);
    }

    function hasPendingRelationship(entity) {
        const relationship = entity.memberRelationship
            || entity.memberRelationshipData
            || entity.memberRelationshipUnion
            || entity.memberRelationshipWrapper?.memberRelationship;

        if (!relationship || typeof relationship !== "object") {
            return false;
        }

        return hasNonNullValue(relationship.invitation)
            || hasNonNullValue(relationship["*invitation"])
            || hasNonNullValue(relationship.invitationUnion?.invitation)
            || hasNonNullValue(relationship.invitationUnion?.["*invitation"])
            || hasNonNullValue(relationship.noConnection?.invitation)
            || hasNonNullValue(relationship.noConnection?.["*invitation"])
            || hasNonNullValue(relationship.noConnection?.invitationUnion?.invitation)
            || hasNonNullValue(relationship.noConnection?.invitationUnion?.["*invitation"]);
    }

    function hasNonNullValue(value) {
        return value != null && (typeof value !== "object" || Object.keys(value).length > 0);
    }

    function isInterestingRequest(url) {
        if (!url) {
            return false;
        }

        try {
            const parsed = new URL(url, window.location.origin);
            if (parsed.origin !== window.location.origin) {
                return false;
            }

            return /graphql|voyager|api/i.test(parsed.pathname + parsed.search);
        } catch {
            return false;
        }
    }

    function normalizeRequestUrl(urlLike) {
        if (!urlLike) {
            return "";
        }

        try {
            return new URL(urlLike, window.location.origin).toString();
        } catch {
            return "";
        }
    }

    function extractSlugFromString(value) {
        const match = value.match(/(?:https?:\/\/www\.linkedin\.com)?\/in\/([^/?#]+)/i);
        if (!match) {
            return "";
        }
        return isValidSlug(match[1]) ? match[1] : "";
    }

    function isValidSlug(value) {
        return /^[A-Za-z0-9._%-]+$/.test(value);
    }
})();