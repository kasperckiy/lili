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
4. Profile status requests must use a randomized delay between `1` and `10000` milliseconds per profile.
5. After the profile response is parsed, render `Pending` when the profile document proves an existing invitation; otherwise render `Connect`.
6. Cache both `Pending` and `Connect` results for `6` hours.
7. If the user clicks `Connect` and LinkedIn accepts the invite flow, store `Pending` in cache immediately.
8. If LinkedIn reports an already-existing invitation during the invite flow, store `Pending` in cache immediately.
9. If the user opens `https://www.linkedin.com/mynetwork/invitation-manager/sent/`, store `Pending` in cache for each visible invited profile there.
10. If LinkedIn appends more sent invitations to that page, repeat the cache sync for the newly visible profiles.

## UX notes

- `1st` degree members must keep the native `Message` action unchanged.
- The loading action should be visibly distinct from both `Connect` and `Pending`.
- Status changes should update all visible cards for the same profile slug.

## Constraints

- Do not navigate the current group page away from the members list.
- Do not send data to external servers.
- Keep all cache state local to the extension.
