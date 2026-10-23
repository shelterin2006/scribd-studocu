# Command Code Handoff

## Objective

Fix the Scribd extension scan/download behavior shown by the user:

- For a document with expected `204` pages, scan finishes in about 4 seconds, which is too fast for Scribd lazy loading.
- Scan reports `216 URL` even though the page count is `204`; this is acceptable as candidate URLs, but the UI should make that clear.
- Download then resolves only `9/216` images and still reports success, which is wrong.

Expected user-visible result:

- Scanning scrolls slowly enough for lazy-loaded pages to appear.
- Scan completion is based on page/candidate stability over time, not a single quick bottom check.
- Popup labels scan output as candidate URLs, not pages.
- Download does not report success when only a tiny fraction of candidate URLs resolve to images.

## Workspace

Active workspace root: `C:\Users\ADMIN\Desktop\scribd`

This folder is not a Git repository. Preserve existing files carefully.

## Current State

Relevant current files:

- `content.js`
- `popup.js`
- `background.js`
- `test-collector.js`
- `manifest.json`
- `page-interceptor.js`

Evidence from current code:

- `content.js` uses `const scrollDelay = 300`.
- `autoScroll()` scrolls by `window.innerHeight * 0.8`.
- `autoScroll()` breaks after reaching bottom and waiting only `2000ms` if still at bottom.
- `autoScroll()` also breaks after `noChangeCount > 5` based only on `document.body.scrollHeight`.
- `background.js` reports `downloadComplete` as long as `images.length > 0`, so resolving only `9` images from `216` candidate URLs still reports success.

## Allowed Files

You may edit only:

- `content.js`
- `popup.js`
- `background.js`
- `test-collector.js`

Do not edit files outside `C:\Users\ADMIN\Desktop\scribd`.

## Requirements

### Scan / Scroll

1. Make auto-scroll materially slower:
   - Increase delay from `300ms` to around `1000-1500ms`.
   - Reduce scroll step from `0.8 viewport` to around `0.4-0.5 viewport`.
2. Do not stop immediately after first bottom detection.
   - At bottom, wait and keep checking whether any of these grow/change:
     - document height;
     - pending network URL count;
     - estimated loaded page count from DOM/page-number/candidate URLs.
   - Require multiple stable checks before stopping.
3. Add helper(s) in `content.js` to estimate loaded pages:
   - count unique DOM page identifiers from `[data-page-number]`, `[data-page]`, `[id^="page"]`, `.page`, `.document_page`;
   - count unique page numbers extracted from pending network URLs/candidate URLs;
   - use the max of those estimates.
4. Progress during scroll should use expected page count when available:
   - If `expectedPages > 0`, progress should be based on estimated loaded pages / expected pages, capped below 99 until final completion.
   - Otherwise, fall back to scroll-position percentage.
5. After auto-scroll, wait a longer settle delay (`3000-5000ms`) before final collection.
6. Keep the two-phase model: during scroll store pending URLs silently; after scroll collect final candidates.

### Candidate URL Count Clarity

7. Update popup messages to say "candidate URL" or "URL ứng viên" instead of implying the count is the same as page count.
8. Keep the explanation minimal in the UI.

### Download Completion Safety

9. In `background.js`, do not report `downloadComplete` when only a very small fraction of candidates resolve.
10. Add a practical failure threshold:
    - If `total >= 20` and resolved image count is less than `max(10, floor(total * 0.25))`, send `downloadError` with a clear message including resolved/total.
    - This would catch the user's `9/216` case.
11. Keep success behavior when a reasonable number of images resolves.
12. Progress denominator should be clear:
    - It can remain raw candidate total, but final failure/success must explain resolved image count.

### Tests / Verification

13. Update or add tests in `test-collector.js` for helper behavior where practical:
    - estimated page count from DOM-like nodes and candidate page URLs;
    - progress calculation if factored into a helper;
    - scan wiring still present.
14. If background helpers can be exported safely, add a minimal Node test or assertion for the low-resolve threshold. If not practical, use static assertions.

## Non-Goals And Prohibited Changes

- Do not implement paywall bypass logic.
- Do not redesign the extension UI.
- Do not change manifest permissions unless strictly necessary.
- Do not add dependencies, npm tooling, remote scripts, or external services.
- Do not commit, push, deploy, or upload anything.
- Do not edit global or project instruction files.

## Tests And Verification

Required verification after implementation:

1. `node --check content.js`
2. `node --check background.js`
3. `node --check popup.js`
4. `node --check page-interceptor.js`
5. `node test-collector.js`
6. Parse `manifest.json`.
7. Verify no remote JS/CDN references.
8. Static search/inspection showing:
   - scroll delay is no longer `300`;
   - bottom detection requires multiple stable checks;
   - popup says candidate URLs;
   - background has the low-resolve failure threshold.

If live Chrome testing is not possible, state that verification is static/local only.

## Completion Report

Report:

- Files changed.
- Root cause.
- New scroll stop condition.
- New download failure threshold.
- Verification commands and results.
- Remaining limitations.

## Commit Push Deploy Permissions

No commit, push, or deploy is permitted.
