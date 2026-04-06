# Profile Status Resolution Requirement

## Goal

Show the correct relationship action for LinkedIn group members when the group members page does not expose enough data to distinguish `Connect` from `Pending`.

## Source of truth

- Use the LinkedIn profile document response from `/in/{slug}/` as the fallback source.
- Parse the returned HTML for the embedded invitation relationship markers that indicate `Pending`.
- When the profile HTML includes an explicit invitation state such as `Connect` or `Pending`, that explicit state must win over hidden withdraw-modal templates or other non-primary UI fragments.
- Continue trusting LinkedIn group-page embedded data and live network hints first when they already provide `Pending`.

## Required behavior

1. When the group members list opens, every non-`1st` member must show either a cached action or a loading action.
2. If a valid cached status exists, render it immediately.
3. If there is no valid cache entry, render a loading action and start a background profile status request.
4. Fallback profile status requests must run through a scheduler and must not start immediately when a card becomes visible.
5. The scheduler must enforce a single fallback profile fetch at a time per tab, with a base gap of `3000` milliseconds plus jitter between `0` and `10000` milliseconds.
6. The scheduler must coalesce repeated requests for the same profile slug and must avoid duplicate concurrent fallback fetches across open tabs when possible.
7. The scheduler must wait for a short scroll-idle window before starting low-priority fallback profile fetches.
8. The scheduler must enforce a rolling budget of `8` fallback profile fetch starts per `5` minutes and must pause new fallback fetches when the budget is exhausted.
9. The scheduler must apply cooldown/backoff after protection-like failures such as `429`, repeated `403`, challenge pages, timeouts, or unexpected profile documents, with a maximum cooldown of `10` minutes.
10. After the profile response is parsed, render `Pending` when the profile document proves an existing invitation; otherwise render `Connect`.
11. Cache both `Pending` and `Connect` results for `6` hours.
12. If the user clicks `Connect` and LinkedIn accepts the invite flow, store `Pending` in cache immediately.
13. If LinkedIn reports an already-existing invitation during the invite flow, store `Pending` in cache immediately.
14. If the user opens `https://www.linkedin.com/mynetwork/invitation-manager/sent/`, store `Pending` in cache for each visible invited profile there.
15. If LinkedIn appends more sent invitations to that page, repeat the cache sync for the newly visible profiles.
16. If the user opens a concrete profile page at `https://www.linkedin.com/in/{slug}/`, overwrite the cache with the explicit `Connect` or `Pending` state from that already loaded profile page.
17. Cache overwrites from concrete profile pages and from the sent invitations page must propagate to other open extension tabs through shared storage updates.
18. The generated `Connect` action must call LinkedIn's invitation API directly and must not depend on a hidden invite iframe.
19. The extension popup must expose editable scheduler settings for concurrency, base gap, jitter range, scroll idle, rolling budget, rolling window, and backoff cap.
20. Popup changes must persist in extension storage and be observable by already open LinkedIn tabs.

## UX notes

- `1st` degree members must keep the native `Message` action unchanged.
- The loading action should be visibly distinct from both `Connect` and `Pending`.
- Status changes should update all visible cards for the same profile slug.

## Constraints

- Do not navigate the current group page away from the members list.
- Do not send data to external servers.
- Keep all cache state local to the extension.
