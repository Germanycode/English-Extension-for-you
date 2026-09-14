# GermanyVocab

A Chrome extension for learning English and German vocabulary while browsing.
Translate selected text, save words with context and review them with spaced repetition.

## Features

- Translate selected words and phrases on websites and in the bundled PDF viewer.
- Local lemmatization, dictionary definitions, pronunciation and collocations.
- Vocabulary review with multiple-choice, matching, cloze and sentence exercises.
- Gemini-generated stories and sentence feedback.
- Gemini Live speaking coach with microphone input and streamed audio replies.
- Vocabulary backup and CSV/JSON export.
- Custom app name, icon and optional background music.

## Technology

JavaScript, HTML, CSS, Chrome Extension Manifest V3, Chrome Storage, PDF.js,
Wink lemmatizer, Google Translate, Gemini and Gemini Live.
No build step or package installation is needed to load the extension.

## Install locally

1. Clone this repository or download and extract its source archive.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this repository's root folder.
5. Open a website and select text, or open the extension popup to translate.

After updating the source, reload the extension and refresh the website to apply
content-script changes.

## Optional AI setup

Open the extension's settings and enter your own Gemini API key to enable stories,
sentence feedback and the Live speaking coach. Microphone access is needed for
speaking practice. Google Translate API credentials are optional; translation
has a fallback when no key is configured.

Vocabulary, settings and keys are stored in `chrome.storage.local`. Translation
and AI requests send the relevant selected text, context, vocabulary or audio to
the configured provider. Do not place personal API keys in the source code.

## Source layout

```text
background/   Service worker, API calls and local lemmatization
content/      Website selection and translation tooltip
popup/        Quick translation and vocabulary summary
review/       Vocabulary review, stories and Live coach
options/      Personalization and optional API settings
pdf-viewer/   PDF.js viewer
assets/       Icons, sounds and background music
docs/         Supporting documentation
```

## Current scope

This is a personal unpacked extension. AI features depend on the user's API key,
provider availability and quota. The Live coach is implemented in the source;
this repository does not claim a Chrome Web Store release or measured learning
outcomes. See [AGENT.md](AGENT.md) for project conventions.
