# LiLi

LiLi is a Chrome extension for LinkedIn group member pages that upgrades the action button on each member card.

Instead of always showing the default `Message` button, LiLi uses a simple local rule without extra profile requests:

1. `1st` degree connections keep the original `Message` button.
2. Non-`1st` members get a generated `Connect` button.
3. Clicking `Connect` stays on the current group page and runs LinkedIn's invite flow in the background.
4. LiLi attempts to skip the note dialog by triggering `Send without a note` directly.
5. If LinkedIn itself returns invitation state in live Voyager API responses, LiLi can upgrade that card from `Connect` to `Pending` without opening the profile.

This makes LinkedIn group member lists more useful for outreach and triage on pages like `https://www.linkedin.com/groups/123/members/`.

## Preview

![LiLi extension preview](docs/preview.svg)

## Features

- Leaves `Message` untouched for `1st` degree connections.
- Builds a `Connect` action locally for non-`1st` members.
- Sends the invite without leaving the current group members page.
- Attempts to press LinkedIn's own `Send without a note` action automatically.
- Avoids extra fetch requests to LinkedIn profile pages.
- Uses the profile vanity slug already present in the group member card URL.
- Listens to live LinkedIn page Voyager responses and applies a best-effort `Pending` state when relationship data is already present there.
- Processes cards lazily near the viewport instead of scanning the whole page at once.

## How it works

LiLi runs as a content script on LinkedIn group member pages.

For each visible member card it:

1. Reads the member degree from the group card.
2. Keeps the original `Message` button for `1st` degree members.
3. Reads the profile slug from the card URL.
4. Replaces the visible group action with `Connect`.
5. On click, opens LinkedIn's invite preload flow in a hidden same-origin iframe.
6. Attempts to trigger `Send without a note` inside that hidden invite flow.
7. Listens to LinkedIn's own `fetch` and `XHR` responses on the current page.
8. Parses Voyager `included` entities to map `publicIdentifier` to `memberRelationship` data.
9. If LinkedIn exposes invitation metadata for the same profile slug, updates the button to `Pending`.

## Install locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the project root folder, the one that contains [manifest.json](manifest.json).

## Permissions

- `https://www.linkedin.com/*`: required to run on LinkedIn group member pages.

## Privacy

- LiLi does not send data to any external server.
- All logic runs in the browser on the current LinkedIn page.
- No additional profile fetches are performed.
- Clicking `Connect` may open LinkedIn's own invite preload flow in a hidden same-origin iframe so the current group page stays in place.
- Best-effort invitation state is inferred only from Voyager network data the LinkedIn page already loads for itself.

## Project files

- [manifest.json](manifest.json): Chrome extension manifest.
- [content.js](content.js): degree detection, one-click invite flow, Voyager relationship parsing, and DOM replacement.
- [content.css](content.css): visual adjustments for generated Connect buttons.
- [docs/preview.svg](docs/preview.svg): repository preview asset.
- [icons/icon-source.svg](icons/icon-source.svg): source vector used for icon design.

## Limitations

- LinkedIn changes DOM and CSS frequently, so selectors may need updates.
- The one-click invite flow assumes the profile card contains a valid public LinkedIn vanity slug and that LinkedIn keeps the current preload invite dialog structure.
- `Pending` detection depends on LinkedIn exposing invitation state in the current page's own API responses, so it is intentionally best-effort rather than guaranteed.
- Some profiles may still require extra LinkedIn UI steps, quota checks, or email gating that cannot be bypassed reliably from this extension.
- The extension has been statically validated in this workspace, but not packaged for Chrome Web Store publication.
