(() => {
    const eventName = document.currentScript?.dataset.liliEventName || "lili:relationship-hints";

    if (window.__liliNetworkProbeInstalled) {
        return;
    }

    window.__liliNetworkProbeInstalled = true;

    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const relationshipUrnToSlug = new Map();
    const profileUrnToSlug = new Map();

    scanEmbeddedRelationshipHints();

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

    function scanEmbeddedRelationshipHints() {
        const codeBlocks = document.querySelectorAll("code");
        for (const codeBlock of codeBlocks) {
            const text = codeBlock.textContent || "";
            if (!/groupsDashGroupMembershipsByTypeahead|memberRelationship|invitation|withdraw/i.test(text)) {
                continue;
            }

            emitHintsFromText(text, "embedded-page-data");
        }
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
            for (const entity of included) {
                if (!entity || typeof entity !== "object") {
                    continue;
                }

                const slug = getVoyagerProfileSlug(entity) || extractSlug(entity);
                const profileUrn = getVoyagerProfileUrn(entity) || extractProfileUrn(entity);
                const relationshipUrn = getVoyagerRelationshipUrn(entity);
                if (slug && profileUrn) {
                    profileUrnToSlug.set(profileUrn, slug);
                }

                if (slug && relationshipUrn) {
                    relationshipUrnToSlug.set(relationshipUrn, slug);
                }

                if (!slug || !hasPendingProfileAction(entity)) {
                    continue;
                }

                addHint(slug, url, profileUrn);
            }

            for (const entity of included) {
                if (!entity || typeof entity !== "object") {
                    continue;
                }

                if (!hasPendingRelationship(entity)) {
                    continue;
                }

                const slug = relationshipUrnToSlug.get(entity.entityUrn)
                    || profileUrnToSlug.get(entity.entityUrn)
                    || resolveSlugFromKnownUrns(entity)
                    || extractSlug(entity);
                if (!slug) {
                    continue;
                }

                addHint(slug, url, extractProfileUrn(entity));
            }
        }

        function addHint(slug, sourceUrl, profileUrn) {
            const key = `${slug}:pending`;
            if (seen.has(key)) {
                return;
            }

            seen.add(key);
            hints.push({
                slug,
                action: "pending",
                source: sourceUrl || "voyager",
                profileUrn: normalizeProfileUrn(profileUrn)
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
            source: url || "network",
            profileUrn: extractProfileUrn(node)
        };
    }

    function extractSlug(node) {
        const directKeys = ["publicIdentifier", "vanityName", "memberVanityName", "profileVanityName", "inviteeVanityName"];
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

        walk(node, "", 0);
        return parts.join(" | ");

        function walk(value, prefix, depth) {
            if (!value || typeof value !== "object" || depth > 2) {
                return;
            }

            for (const [key, nestedValue] of Object.entries(value)) {
                if (nestedValue == null) {
                    continue;
                }

                const nextPrefix = prefix ? `${prefix}.${key}` : key;
                if (typeof nestedValue === "string" || typeof nestedValue === "number" || typeof nestedValue === "boolean") {
                    parts.push(`${nextPrefix}:${String(nestedValue)}`);
                    continue;
                }

                if (Array.isArray(nestedValue)) {
                    continue;
                }

                walk(nestedValue, nextPrefix, depth + 1);
            }
        }
    }

    function extractProfileUrn(node) {
        return normalizeProfileUrn(findProfileUrnValue(node, 0));
    }

    function findProfileUrnValue(node, depth) {
        if (!node || depth > 3) {
            return "";
        }

        if (typeof node === "string") {
            return node;
        }

        if (typeof node !== "object") {
            return "";
        }

        if (typeof node.profileId === "string") {
            return `urn:li:fsd_profile:${node.profileId}`;
        }

        const preferredKeys = [
            "profileUrn",
            "entityUrn",
            "memberProfile",
            "profile",
            "profileResolutionResult",
            "targetInviteeResolutionResult",
            "inviteeResolutionResult"
        ];

        for (const key of preferredKeys) {
            const value = node[key] || node[`*${key}`];
            const found = findProfileUrnValue(value, depth + 1);
            if (normalizeProfileUrn(found)) {
                return found;
            }
        }

        for (const value of Object.values(node)) {
            const found = findProfileUrnValue(value, depth + 1);
            if (normalizeProfileUrn(found)) {
                return found;
            }
        }

        return "";
    }

    function looksLikePendingState(text) {
        return /(pending|withdraw invitation|invitation sent|already invited|isInvited:true|sentInvitation|PENDING|INVITATION_SENT)/i.test(text);
    }

    function getVoyagerProfileSlug(entity) {
        const slug = entity.publicIdentifier;
        return typeof slug === "string" && isValidSlug(slug) ? slug : "";
    }

    function getVoyagerProfileUrn(entity) {
        const profileUrn = entity.entityUrn
            || entity.profileUrn
            || entity.profile?.entityUrn
            || entity.profileResolutionResult?.entityUrn;
        return normalizeProfileUrn(profileUrn);
    }

    function getVoyagerRelationshipUrn(entity) {
        const relationshipUrn = entity["*memberRelationship"]
            || entity.memberRelationshipUrn
            || entity.memberRelationshipWrapper?.memberRelationshipUrn;
        return typeof relationshipUrn === "string" ? relationshipUrn : "";
    }

    function resolveSlugFromKnownUrns(entity) {
        const candidateUrns = [
            entity["*targetInviteeResolutionResult"],
            entity["*inviteeResolutionResult"],
            entity["*profileResolutionResult"],
            entity.noConnection?.invitation?.noInvitation?.["*targetInviteeResolutionResult"],
            entity.noConnection?.invitationUnion?.invitation?.["*targetInviteeResolutionResult"],
            entity.memberRelationshipData?.noInvitation?.["*targetInviteeResolutionResult"],
            entity.memberRelationshipDataResolutionResult?.noInvitation?.["*targetInviteeResolutionResult"],
            entity.memberRelationshipData?.invitation?.["*targetInviteeResolutionResult"],
            entity.memberRelationshipDataResolutionResult?.invitation?.["*targetInviteeResolutionResult"]
        ];

        for (const profileUrn of candidateUrns) {
            if (typeof profileUrn !== "string") {
                continue;
            }

            const slug = profileUrnToSlug.get(profileUrn);
            if (slug) {
                return slug;
            }
        }

        return "";
    }

    function hasPendingProfileAction(entity) {
        const primaryAction = entity.profileStatefulProfileActions?.primaryActionResolutionResult;
        const statefulRelationship = primaryAction?.statefulAction?.actionDataModel?.relationshipActionData?.relationshipData;
        const connectionOrInvitation = primaryAction?.statefulAction?.actionDataModel?.connectionOrInvitation;

        return hasNonNullValue(primaryAction?.withdraw)
            || hasNonNullValue(primaryAction?.["*withdraw"])
            || hasActualInvitationValue(primaryAction?.invitation)
            || hasActualInvitationValue(primaryAction?.["*invitation"])
            || hasPendingRelationshipData(statefulRelationship)
            || hasActualInvitationValue(connectionOrInvitation);
    }

    function hasPendingRelationship(entity) {
        const candidates = [
            entity.memberRelationship,
            entity.memberRelationshipData,
            entity.memberRelationshipDataResolutionResult,
            entity.memberRelationshipUnion,
            entity.memberRelationshipWrapper?.memberRelationship,
            entity.memberRelationshipWrapper?.memberRelationshipData,
            entity.memberRelationshipWrapper?.memberRelationshipDataResolutionResult
        ];

        return candidates.some(hasPendingRelationshipData);
    }

    function hasPendingRelationshipData(relationship) {
        if (!relationship || typeof relationship !== "object") {
            return false;
        }

        return hasActualInvitationValue(relationship.memberRelationshipData)
            || hasActualInvitationValue(relationship.memberRelationshipDataResolutionResult)
            || hasActualInvitationValue(relationship.invitation)
            || hasActualInvitationValue(relationship["*invitation"])
            || hasActualInvitationValue(relationship.invitationUnion)
            || hasActualInvitationValue(relationship.noConnection?.invitation)
            || hasActualInvitationValue(relationship.noConnection?.["*invitation"])
            || hasActualInvitationValue(relationship.noConnection?.invitationUnion);
    }

    function hasActualInvitationValue(value) {
        if (typeof value === "string") {
            return /invitation/i.test(value);
        }

        if (!value || typeof value !== "object") {
            return false;
        }

        if (typeof value.invitationState === "string") {
            return true;
        }

        if (typeof value.entityUrn === "string" && /invitation/i.test(value.entityUrn)) {
            return true;
        }

        return hasActualInvitationValue(value.invitation)
            || hasActualInvitationValue(value["*invitation"]);
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

    function normalizeProfileUrn(value) {
        if (typeof value !== "string") {
            return "";
        }

        const trimmedValue = value.trim();
        if (!trimmedValue) {
            return "";
        }

        const match = trimmedValue.match(/(?:urn:li:fsd_profile:)+([A-Za-z0-9_-]+)/i);
        if (!match?.[1]) {
            return "";
        }

        return `urn:li:fsd_profile:${match[1]}`;
    }

    function isValidSlug(value) {
        return /^[A-Za-z0-9._%-]+$/.test(value);
    }
})();