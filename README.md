# LinkedIn Group Priority Actions

Chrome extension for LinkedIn group member pages that replaces the default `Message` button on each visible member card with the highest-priority action found on that member's profile page:

1. `Connect`
2. `Pending`
3. `Message`
4. Select the project root folder that contains `manifest.json`.
The extension is designed for pages like `https://www.linkedin.com/groups/123/members/`.

## What it does

- Watches member cards on the LinkedIn group members page.
- Fetches each visible member profile HTML on the same LinkedIn origin.
- Detects the best available action from the profile page.
- Replaces the group-page `Message` button with `Connect` or `Pending` when found.
- Keeps the original `Message` button when no higher-priority action exists.

## Button priority sources

- `Connect` selector is based on the saved example in `link_source/connect_example.html`.
- `Pending` selector is based on the saved example in `link_source/buttons_example.html`.
- Group member cards and default `Message` button are based on `link_source/cards.html`.

## Install

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `chrome_extension/linkedin-group-priority-actions`

## Current behavior

- The extension only processes cards that come into or near the viewport.
- Results are cached in `chrome.storage.local` for 12 hours.
- Replacement `Connect` and `Pending` buttons open in a new tab so the group page stays open.

## Limitations

- LinkedIn changes DOM and CSS frequently, so selectors may need updates later.
- `Pending` is detected from profile-page markup; LinkedIn does not expose a separate direct withdraw endpoint in the saved example, so the button opens the related LinkedIn URL rather than reproducing internal React handlers.
- The extension has not been packaged or tested in the real Chrome runtime from this workspace; only static validation was done here.
