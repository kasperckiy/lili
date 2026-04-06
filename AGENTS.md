## Release Workflow

- Unless the user explicitly says otherwise, every repository change completes the full release cycle.
- Always use the full `X.Y.Z` semantic version format.
- Choose the bump type by change scope: `major` for breaking or behavior-changing releases, `minor` for backward-compatible features or visible capability expansions, and `patch` for fixes, polish, metadata-only updates, or other small backward-compatible changes.
- Choose a semantic version bump in `manifest.json`.
- Commit and push the change to `main`.
- Create and push the matching `vX.Y.Z` tag.
- Publish GitHub Release notes using `CHANGELOG_TEMPLATE.md` as the structure.
- Run the release workflow through `gh` when needed and verify that release assets are published.
