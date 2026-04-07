# Profile Status Resolution Requirement

## Goal

Show the correct relationship action for LinkedIn group members using only live LinkedIn page evidence plus a shared pending-only cache.

## Source of truth

- Trust the live group-members page first when it already exposes `1st` degree or pending invitation hints.
- Trust live LinkedIn network hints and explicit invite-flow results when they prove `Pending`.
- Trust the already opened concrete profile page when it explicitly shows `Pending` or `Connect`.
- Trust the sent invitations page for visible invited profiles.
- Do not run automatic background profile fetches just because a group member card became visible.

## Required behavior

1. When the group members list opens, `1st` degree members must keep LinkedIn's native `Message` action unchanged.
2. When a non-`1st` member has confirmed pending evidence from page data, network hints, the sent invitations page, the profile page, or the invite flow, render `Pending`.
3. When there is no pending evidence, unresolved non-`1st` members must render `Connect` immediately.
4. The extension must not show a loading state for passive background status resolution on the group members page.
5. The extension must not start automatic queue-based or worker-based profile status requests while the user browses the group members list.
6. The shared cache must store only confirmed `Pending` entries for `24` hours.
7. `Connect` must be the implicit default when no valid pending entry exists.
8. If the user clicks `Connect` and LinkedIn accepts the invite flow, store `Pending` in cache immediately.
9. If LinkedIn reports an already-existing invitation during the invite flow, store `Pending` in cache immediately.
10. If the explicit connect flow still needs profile data such as a profile URN, that resolution may happen on demand inside the click path only.
11. If the user opens `https://www.linkedin.com/mynetwork/invitation-manager/sent/`, store `Pending` in cache for each visible invited profile there.
12. If LinkedIn appends more sent invitations to that page, repeat the cache sync for the newly visible profiles.
13. If the user opens a concrete profile page at `https://www.linkedin.com/in/{slug}/`, update the shared cache from that already loaded profile page.
14. If the opened concrete profile page explicitly shows `Connect` instead of `Pending`, any stale pending cache entry for that slug must be cleared.
15. Cache updates from concrete profile pages and from the sent invitations page must propagate to other open extension tabs through shared storage updates.
16. The generated `Connect` action must call LinkedIn's invitation API directly and must not depend on a hidden invite iframe.
17. The popup must show the shared pending-cache count and a clear-cache action, not scheduler controls.

## UX notes

- `1st` degree members must keep the native `Message` action unchanged.
- `Pending` should remain visibly distinct from `Connect`.
- Status changes should update all visible cards for the same profile slug.
- The popup should make it clear that LiLi now caches only `Pending` and does not run automatic background checks while browsing the group page.

## Constraints

- Do not navigate the current group page away from the members list.
- Do not send data to external servers.
- Keep all cache state local to the extension.
