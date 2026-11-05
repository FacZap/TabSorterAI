# TabMergerAI

A Chrome extension that uses Claude to:

- **Organize.** Groups your tabs by topic, across all windows or just one. You get a preview first: rename a group, change its color, move a tab to another group, or untick a group. Then choose how to apply it:
  - **Tab groups in this window:** merges every window into one.
  - **One window per group.**

  Groups you already have are reused: loose tabs that fit one of them are added to it (marked **existing** in the preview) rather than ending up in a duplicate group. With **Keep my groups as they are** (on by default) only ungrouped tabs are sorted. Turn it off to let Claude also move tabs between your groups.

  **Undo last organize** puts the previous layout back, including windows and old groups.
- **Summarize & archive.** Summarizes a set of tabs: the selected tabs, a whole window, or one group from the preview. You get a title, an overview, key points and one line per tab. The summary goes into the Archive, and the tabs can be closed. From the Archive page you can search, reopen everything, copy it as Markdown or delete it.

## Install

1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder (`C:\autohotkey\TabMergerAI`).
3. Open the extension's **Options**, paste an Anthropic API key and click **Test key**.
4. Open the popup with **Ctrl+Shift+Y**, or pin the toolbar icon.

After editing the code, click the reload icon on the extension's card in `chrome://extensions`.

## Privacy and cost

- Only tab titles and URLs (host and path, no query string for grouping) go to `api.anthropic.com`.
- If you tick **Read page text**, summaries also send up to 4000 characters of each page's visible text. That option needs site access, which Chrome asks for once.
- The key is kept in `chrome.storage.local` for this profile. It isn't synced and it isn't encrypted.
- The default model is Claude Haiku 4.5. Organizing 100 tabs uses about 4k input tokens, well under a cent. You can switch to Sonnet 5 or Opus 5 in Options for more careful grouping. Opus requests turn on the API's server-side fallback, so a safety decline is retried on another model.

## Files

| File | What it does |
|---|---|
| `background.js` | Service worker. Makes the Claude calls, applies and undoes layouts, archives. Results are kept in `chrome.storage.session` so they survive the popup closing. |
| `claude.js` | `fetch` wrapper for the Messages API, using JSON-schema structured output. |
| `plan.js` | Pure helpers such as `validatePlan` and `toMarkdown`, tested by `test/plan.test.mjs`. |
| `popup.*`, `options.*`, `archive.*` | The UI pages. |

```bash
node test/plan.test.mjs
```
