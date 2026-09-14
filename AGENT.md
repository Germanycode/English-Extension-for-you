# AGENT.md

This file provides guidance to my agent model in Antigravity when working with code in this repository.

## Agent Operating Preferences

- When the user asks for an "artifact", create a polished, easy-to-use HTML file unless they explicitly request another format. Store it in `docs/` and tell the user the exact file path.
- Do not run `git push`, publish code, or otherwise push terminal changes to GitHub unless the user explicitly asks for that specific action in the current turn.
- Do not commit or push API keys, credentials, `.env` files, local browser logs, generated screenshots, or other private/local artifacts.
- Before any GitHub publishing work, scan for key-shaped secrets and confirm the intended files. Prefer editing files and reporting their locations when the user only asks for a local artifact.

## Project Overview

**GermanyVocab** is a Chrome Extension (Manifest V3) for learning German/English vocabulary on any website. It translates selected text, saves words to a personal list, and schedules reviews using Spaced Repetition (SM-2).

## Loading the Extension

No build step. Load directly in Chrome via `chrome://extensions` with **Developer mode** enabled, then choose **Load unpacked** and select this folder. After changes, click **Reload** on the extension card. For `background.js` changes, the service worker auto-restarts; for content scripts, refresh the target page.

## Architecture

The extension entry points communicate via `chrome.runtime.sendMessage`:

| File                            | Role                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `background/background.js`      | Service worker. Handles `translate`, `lemmatizeWord`, `fetchCollocations`, `saveVocab`, `generateStory`, `evaluateSentence`, `openPdfViewer`, and `applyCustomIcon` messages. Owns translation/API calls and SM-2 initialization for new words. Restores custom icon on every service worker startup. |
| `content/content.js`            | Injected into every page. Detects text selection (1-4 English words), extracts sentence context for single-word selections, shows a floating tooltip with lemma-aware translation + English definition, and lets the user save words.                                                                 |
| `popup/popup.html+js`           | Extension toolbar popup. Two tabs: sentence translator (delegates to background) and vocab stats (reads `chrome.storage.local` directly). Applies custom app name and icon from storage on load.                                                                                                      |
| `review/review.html+js`         | Full-page review dashboard. Vocab table with delete, review gate/lobby, MCQ flashcard quiz, music player, story mode, native Gemini Live speaking coach, and advanced review types. All SM-2 scheduling updates happen here.                                                                          |
| `options/options.html+js`       | Settings page with personalization and optional API keys for Google Translate + Gemini.                                                                                                                                                                                                               |
| `pdf-viewer/pdf-viewer.html+js` | Bundled PDF.js viewer with selectable text so the content script can translate selections inside PDFs.                                                                                                                                                                                                |
| `assets/musics/music-tracks.js` | Shared plain-JS registry of bundled MP3 background music tracks used by the review dashboard and PDF viewer. Add new bundled MP3 files here to expose them in the music selectors.                                                                                                                    |

## Data Model

All data lives in `chrome.storage.local`:

```js
vocabList: [{
  id: string,              // Date.now().toString()
  word: string,            // lowercased lemma/base form when available
  originalWord: string,    // selected surface form before lemmatization
  translation: string,     // Vietnamese
  englishMeaning: string,
  context: string,         // sentence/context around the selection
  partOfSpeech: string,
  lemmaConfidence: string, // high/medium/low
  lemmaReason: string,
  pronunciation: string,
  audioUrl: string,
  imageUrl: string,
  synonyms: string[],
  antonyms: string[],
  collocations: object[],   // Datamuse-backed phrases for chunk practice
  dateAdded: number,       // ms timestamp
  interval: number,        // SM-2: days until next review
  repetition: number,      // SM-2: consecutive correct count
  easeFactor: number,      // SM-2: starts at 2.5
  nextReviewDate: number   // ms timestamp; missing/null = due now
}]
generatedStories: [{
  id: string,
  title: string,
  level: string,
  genre: string,
  story: string,
  imageUrl: string,
  imagePrompt: string,
  targetWords: string[],
  simpleDefinitions: object[],
  questions: object[],
  comprehensionQuestions: object[],
  imageSearchKeywords: string,
  createdAt: number
}]
googleApiKey: string        // optional; blank uses the free translate.googleapis.com fallback
geminiApiKey: string
appName: string             // custom display name shown in popup header
customIconDataUrl: string   // base64 data URL of user-uploaded icon
backgroundMusicTrack: string // selected track id from assets/musics/music-tracks.js
backgroundMusicVolume: number
collocationCache: object     // Datamuse cache keyed by word + part of speech
```

## Lemmatization And Translation Flow

For single-word selections, `content.js` sends `type: "lemmatizeWord"` with the selected word and surrounding sentence. `background.js` uses the bundled `background/vendor/wink-lemmatizer.js` script to infer noun, verb, and adjective base-form candidates without AI.

Simple local context hints prefer a likely part of speech when multiple candidates are possible, for example preferring `see` for a verb-like `saw` context or `saw` for a noun-like context.

The bundled lemmatizer supplies the candidate base form immediately, so translation never waits for dictionary metadata. DictionaryAPI and Datamuse/WordNet lookup run in parallel in the background to supply an English definition, part of speech, and (when DictionaryAPI responds) phonetic text. The first valid result is used, it has a short timeout, and is cached while the service worker is alive. The tooltip displays the surface form and base form, for example `saw -> see`.

For phrases or multi-word selections, the extension keeps the existing direct translation flow.

## Advanced Review System & Mastery Progression

The review dashboard (`review/review.html+js`) supports multiple question types that scale in difficulty based on the word's `repetition`:

- **Level 0 (New)**: Multiple Choice (English to Vietnamese or Vietnamese to English).
- **Level 1 (Learning)**: Picture Choice (if `imageUrl` exists).
- **Level 2 (Familiar)**: Matching Game (4 pairs of English words and definitions).
- **Level 3 (Known)**: Collocation cloze when available, otherwise synonym / antonym selection.
- **Level 4+ (Mastered)**: Sentence Generation (graded dynamically via the Gemini API), with occasional collocation cloze when available.

## Media & Metadata

- Newly saved words automatically fetch `synonyms`, `antonyms`, `pronunciation`, `audioUrl`, and dictionary `context` from the Free Dictionary API, `collocations` from Datamuse, and `imageUrl` from a background image lookup. Image lookup is cache-backed, uses short provider timeouts, ranks several Pixabay results by tags, and does not delay saving or rendering the Review summary. In the tooltip and Quick Translate popup, IPA falls back to Wiktionary when DictionaryAPI has no response; playback uses Chrome TTS with the browser SpeechSynthesis API as a fallback.
- Legacy words missing these fields fetch and persist them dynamically on the first review session (`fetchMissingMedia` in `review.js`).

## API Integration

- `background.js` uses Google Cloud Translation API v2 only when a Google API key is saved in the options page. If no key is configured, it uses the free `translate.googleapis.com` endpoint.
- `background.js` handles Gemini requests for `generateStory` and `evaluateSentence`. Gemini features require `geminiApiKey` in local storage; lemmatization is fully local via the bundled Wink lemmatizer.
- Story generation sends selected target words plus CEFR level and genre. Story Mode can choose due words or random saved words and limits each story to 3-7 target words. Gemini is prompted to return valid JSON with `title`, `level`, `genre`, `story`, `targetWords`, `simpleDefinitions`, `comprehensionQuestions`, `imagePrompt`, and `imageSearchKeywords`. `background.js` uses `imageSearchKeywords` for safe-search Pixabay lookup, saves the result to `generatedStories`, and `review.js` renders the structured package in Story Mode.
- English definitions come from the Free Dictionary API (`dictionaryapi.dev`).

## Native Gemini Live Coach

The review dashboard includes a native Gemini Live coach. It captures microphone audio with `navigator.mediaDevices.getUserMedia`, streams raw PCM chunks to Gemini Live over a WebSocket, and plays streamed 24 kHz PCM audio replies with the Web Audio API. This replaces the older `SpeechRecognition` -> text request -> `speechSynthesis` coach flow.

The Live WebSocket connects directly from `review.js` using the saved `geminiApiKey`, the `gemini-3.1-flash-live-preview` model, and `responseModalities: ["AUDIO"]`. This is fine for a local/personal unpacked extension. For a shared or production extension, use a small backend to mint Gemini ephemeral tokens instead of exposing a normal API key to frontend code.

## Background Music

The review dashboard and PDF viewer both use `assets/musics/music-tracks.js` for the selectable background music list. Track choice is stored as `backgroundMusicTrack` in `chrome.storage.local`, and review volume is stored as `backgroundMusicVolume`. There is no runtime directory scanning in MV3, so newly added bundled MP3 files must be added to `GV_MUSIC_TRACKS`.

## SM-2 Spaced Repetition

- **Initialization**: `background.js` sets `interval: 0`, `repetition: 0`, `easeFactor: 2.5`, `nextReviewDate: now` (due immediately).
- **Update**: `review.js` `updateSM2()` uses a fixed interval ladder `[0, 20/(24*60), 1, 3, 7, 14]` days (Day 0, 20 mins, 1d, 3d, 7d, 14d). Correct (`quality >= 3`) advances repetition; wrong resets to `interval: 20/(24*60)`.
- Words with a missing `nextReviewDate` are treated as due now.
- The review tab opens a gate/lobby before questions. It shows due word count, countdown to the next due review, queue peek, shuffle, and a focus pulse button. The quiz starts only when the user clicks **Start Review**.
- Review answers play bundled feedback sounds from `assets/musics/Right_answer.mp3` and `assets/musics/Wrong answer.mp3` for MCQ, picture, synonym/antonym, matching, and sentence review results.

## Sharing & Personalization

The extension is distributed as a zip (no build step). Friends load it via `chrome://extensions` -> **Load unpacked**. Do not bundle a personal Google Translate API key; users can optionally add their own key in settings, otherwise translations use the free fallback.

Friends customize their copy through **Settings -> Personalize Your App**:

- **App Name**: stored as `appName`; UI pages read it on load and update visible branding/document title.
- **App Icon**: uploaded image is stored as `customIconDataUrl`; `background.js` calls `chrome.action.setIcon()` immediately and on service worker restart.

The Chrome toolbar tooltip (hover text) always shows the `manifest.json` name; that cannot be changed at runtime.

## Key Constraints

- No build tooling: plain JS/CSS/HTML, no npm, no bundler.
- MV3 service worker: `background.js` cannot use DOM APIs or persistent in-memory state. Use `chrome.storage` for state that must survive worker termination.
- Content script isolation: `content.js` runs in a separate JS world; it cannot import modules and must send messages to background for storage or privileged API work.
- `escapeHtml()` is duplicated in `popup.js` and `review.js`; this is intentional for MV3 without shared modules.
