importScripts('vendor/wink-lemmatizer.js');

// Keep short-lived results in the service worker so repeatedly selecting the
// same word does not create another network round trip. These caches are only
// an optimisation: MV3 may discard them when the service worker stops.
const translationCache = new Map();
const dictionaryCache = new Map();
const dictionaryLookupsInFlight = new Map();
const pronunciationCache = new Map();
const vocabularyImageCache = new Map();
const vocabularyImageLookupsInFlight = new Map();
const TRANSLATION_CACHE_TTL_MS = 5 * 60 * 1000;
const DICTIONARY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MEMORY_CACHE_ENTRIES = 200;

// Pixabay API key — configurable via chrome.storage.local with default fallback
const DEFAULT_PIXABAY_KEY = '55815075-819f9a7ac5a51a635908a4d54';

async function getPixabayApiKey() {
  const data = await chrome.storage.local.get({ pixabayApiKey: '' });
  return (data.pixabayApiKey || '').trim() || DEFAULT_PIXABAY_KEY;
}

// ── Restore custom icon whenever the service worker starts ──
chrome.storage.local.get({ customIconDataUrl: '' }, ({ customIconDataUrl }) => {
  if (customIconDataUrl) applyIcon(customIconDataUrl);
});

chrome.storage.local.get({ vocabList: [] }, ({ vocabList }) => {
  notifyDueWords(vocabList);
});

async function applyIcon(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(128, 128);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, 128, 128);
    const imageData = ctx.getImageData(0, 0, 128, 128);
    await chrome.action.setIcon({ imageData });
  } catch (e) {
    console.warn('Could not apply custom icon:', e);
  }
}

// ── Context menu: right-click a PDF link → open in viewer ──
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:                 'gv-open-pdf',
    title:              '📄 Open PDF in GermanyVocab Viewer',
    contexts:           ['link'],
    targetUrlPatterns:  ['*://*/*.pdf', 'file:///*.pdf', 'file:///*/Deep_work.pdf'],
  });

  chrome.contextMenus.create({
    id:       'gv-translate-selection',
    title:    '📖 Translate with GermanyVocab',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'gv-open-pdf') {
    const viewerUrl = chrome.runtime.getURL('pdf-viewer/pdf-viewer.html')
      + '?file=' + encodeURIComponent(info.linkUrl);
    chrome.tabs.create({ url: viewerUrl, index: tab.index + 1 });
  }

  if (info.menuItemId === 'gv-translate-selection' && tab?.id) {
    handleContextMenuTranslation(info, tab);
  }
});

// Handle messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const messageType = request.type || request.action;

  if (messageType === "translate") {
    handleTranslation(request.text).then(sendResponse);
    return true; // Indicates async response
  }
  if (messageType === "lemmatizeWord") {
    handleLemmatizeWord(request.word, request.sentence).then(sendResponse);
    return true;
  }
  if (messageType === "lookupDictionary") {
    lookupDictionaryWord(request.word).then(sendResponse).catch(error => {
      console.warn('Dictionary lookup error:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  if (messageType === "lookupPronunciation") {
    lookupPronunciation(request.word, request.accent).then(sendResponse).catch(error => {
      console.warn('Pronunciation lookup error:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  if (messageType === "speakText") {
    speakText(request.text, request.lang).then(sendResponse);
    return true;
  }
  if (messageType === "saveVocab") {
    saveVocabulary(request.vocabData).then(sendResponse);
    return true;
  }
  if (messageType === "fetchCollocations") {
    handleFetchCollocations(request.word, request.partOfSpeech).then(sendResponse);
    return true;
  }
  if (messageType === "fetchVocabularyImage") {
    fetchVocabularyImage(request.vocab || {}).then(imageUrl => {
      sendResponse({ success: Boolean(imageUrl), imageUrl });
    }).catch(error => {
      console.warn('Vocabulary image lookup error:', error);
      sendResponse({ success: false, imageUrl: '', error: error.message });
    });
    return true;
  }
  if (messageType === "explainCollocation") {
    explainCollocationWithGemini(request.word, request.collocation).then(sendResponse);
    return true;
  }
  if (messageType === "generateStory") {
    handleGenerateStory(request.words, request.level, request.genre).then(sendResponse);
    return true;
  }
  if (messageType === "openPdfViewer") {
    const viewerUrl = chrome.runtime.getURL('pdf-viewer/pdf-viewer.html')
      + (request.fileUrl ? '?file=' + encodeURIComponent(request.fileUrl) : '');
    chrome.tabs.create({ url: viewerUrl });
    sendResponse({ success: true });
    return true;
  }
  if (messageType === "evaluateSentence") {
    evaluateSentenceWithGemini(request.word, request.sentence).then(sendResponse);
    return true;
  }
  if (messageType === "applyCustomIcon") {
    applyIcon(request.dataUrl).then(() => sendResponse({ success: true }));
    return true;
  }
});

async function handleLemmatizeWord(word, sentence) {
  const originalWord = normalizeWord(word);
  const contextSentence = String(sentence || '').trim();
  const lemmaData = lemmatizeWithWink(originalWord, contextSentence);

  const candidateLemma = normalizeWord(lemmaData.lemma) || originalWord;
  // Do not put a remote dictionary lookup on the translation critical path.
  // Wink runs locally, so the base form is available immediately; dictionary
  // metadata is fetched separately by the UI and can fail without delaying it.
  const lemma = candidateLemma;
  const translationText = lemma;

  return {
    success: true,
    lemma,
    partOfSpeech: lemmaData.partOfSpeech || '',
    confidence: lemmaData.confidence || 'low',
    reason: lemmaData.reason || 'Lemma candidate was generated locally.',
    lemmaIsValid: null,
    translationText
  };
}

function lemmatizeWithWink(word, sentence) {
  const original = normalizeWord(word);
  if (!original || typeof WinkLemmatizer !== 'object') {
    return buildLemmaResult(original, original, '', 'low', 'Wink lemmatizer was unavailable, so the original word was used.');
  }

  const candidates = [
    buildLemmaResult(original, WinkLemmatizer.verb(original), 'verb', 'medium', 'Local Wink lemmatizer selected the verb base form.'),
    buildLemmaResult(original, WinkLemmatizer.noun(original), 'noun', 'medium', 'Local Wink lemmatizer selected the noun base form.'),
    buildLemmaResult(original, WinkLemmatizer.adjective(original), 'adjective', 'medium', 'Local Wink lemmatizer selected the adjective base form.')
  ];
  const changedCandidates = candidates.filter(item => item.lemma && item.lemma !== original);
  if (changedCandidates.length === 0) {
    return buildLemmaResult(original, original, '', 'high', 'Local Wink lemmatizer found no inflection, so the original word was used.');
  }

  const preferredPartOfSpeech = inferPartOfSpeech(original, sentence);
  const preferredCandidate = changedCandidates.find(item => item.partOfSpeech === preferredPartOfSpeech);
  if (preferredCandidate) {
    preferredCandidate.confidence = 'high';
    preferredCandidate.reason = `Local Wink lemmatizer selected the ${preferredPartOfSpeech} base form using nearby sentence context.`;
    return preferredCandidate;
  }

  return changedCandidates[0];
}

function buildLemmaResult(original, lemma, partOfSpeech, confidence, reason) {
  return {
    lemma: normalizeWord(lemma) || original,
    partOfSpeech,
    confidence: normalizeConfidence(confidence),
    reason
  };
}

function inferPartOfSpeech(word, sentence) {
  const context = String(sentence || '').toLowerCase();
  const words = context.match(/[a-z']+/g) || [];
  const index = words.indexOf(word);
  const previous = index > 0 ? words[index - 1] : '';
  const next = index >= 0 && index < words.length - 1 ? words[index + 1] : '';

  if (['a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'our', 'their'].includes(previous)) {
    return 'noun';
  }
  if (previous === 'to' || ['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must'].includes(previous)) {
    return 'verb';
  }
  if (['i', 'you', 'we', 'they', 'he', 'she', 'it'].includes(previous) || ['ing', 'ed'].some(suffix => word.endsWith(suffix))) {
    return 'verb';
  }
  if (next && ['noun', 'person', 'thing', 'place'].includes(next)) {
    return 'adjective';
  }
  return '';
}

function normalizeWord(word) {
  return String(word || '').trim().toLowerCase().replace(/^[^a-z']+|[^a-z']+$/g, '');
}

function getVocabularyImageQueries(word, originalWord, englishMeaning, context) {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'used', 'use', 'person', 'thing', 'someone', 'something']);
  const sourceText = `${englishMeaning || ''} ${context || ''}`.toLowerCase();
  const keywords = sourceText
    .match(/[a-z][a-z'-]{3,}/g)
    ?.filter(item => !stopWords.has(item) && item !== word)
    .slice(0, 4) || [];
  const semanticQuery = keywords.length > 0 ? `${word} ${keywords.slice(0, 3).join(' ')}` : '';
  const candidates = [
    semanticQuery,
    `${originalWord || word} ${keywords.slice(0, 2).join(' ')}`.trim(),
    word,
    `${word} illustration`,
    `${word} concept`
  ];
  return [...new Set(candidates.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 5);
}

async function generateSmartImageQuery(word, englishMeaning, context, partOfSpeech) {
  try {
    const data = await chrome.storage.local.get({ geminiApiKey: '' });
    if (!data.geminiApiKey) return null;

    const prompt = `You are helping find a stock photo for a vocabulary flashcard.

Word: "${word}"
Part of speech: ${partOfSpeech || 'unknown'}
Meaning: ${englishMeaning || 'unknown'}
Context: ${context || 'none'}

Generate a 3-6 word image search query that would find a photo clearly representing this specific meaning of the word. The query should be concrete and visual — describe what should be IN the photo, not the abstract concept.

Rules:
- Focus on visual, concrete objects or scenes
- Disambiguate: if the word has multiple meanings, use the meaning above
- Don't include the word itself unless it's a concrete noun
- For abstract words (e.g. "resilience"), describe a visual metaphor
- For verbs, describe someone doing the action
- For adjectives, describe something that looks that way

Return ONLY the search query, nothing else. No quotes, no explanation.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${data.geminiApiKey}`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 30, temperature: 0.3 }
      })
    }, 1200);

    if (!response.ok) return null;
    const result = await response.json();
    const query = result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return query && query.length > 2 && query.length < 80 ? query : null;
  } catch (e) {
    console.warn('Gemini image query generation failed:', e);
    return null;
  }
}

async function fetchVocabularyImage({ word, originalWord, englishMeaning, context, partOfSpeech }) {
  const normalizedWord = normalizeWord(word);
  if (!normalizedWord) return '';

  const cacheKey = [normalizedWord, partOfSpeech || '', englishMeaning || ''].join('|').toLowerCase();
  const cached = readCachedValue(vocabularyImageCache, cacheKey, 30 * 24 * 60 * 60 * 1000);
  if (cached) return cached;
  if (vocabularyImageLookupsInFlight.has(cacheKey)) {
    return vocabularyImageLookupsInFlight.get(cacheKey);
  }

  const lookup = (async () => {
    const manualQueries = getVocabularyImageQueries(word, originalWord, englishMeaning, context);
    // Query planning and the first concrete lookup start together. The AI query
    // can improve precision, but it must never hold up an otherwise usable image.
    const smartQueryPromise = generateSmartImageQuery(word, englishMeaning, context, partOfSpeech);
    const firstManualSearch = findPixabayImageCandidates(manualQueries[0], 'photo');
    const smartQuery = await smartQueryPromise;
    const queries = [...new Set([smartQuery, ...manualQueries].filter(Boolean))].slice(0, 3);
    const additionalSearches = queries
      .filter(query => query !== manualQueries[0])
      .map(query => findPixabayImageCandidates(query, 'photo'));
    const candidateGroups = await Promise.all([firstManualSearch, ...additionalSearches]);
    const candidates = candidateGroups.flat();
    const bestPixabay = chooseBestPixabayImage(candidates, queries, englishMeaning, context);
    if (bestPixabay) return bestPixabay;

    // Illustrations are more reliable than stock photos for abstract concepts.
    const illustrationGroups = await Promise.all(
      queries.slice(0, 2).map(query => findPixabayImageCandidates(query, 'illustration'))
    );
    const bestIllustration = chooseBestPixabayImage(illustrationGroups.flat(), queries, englishMeaning, context);
    if (bestIllustration) return bestIllustration;

    // Unsplash remains a last fallback because its API does not expose enough
    // tag data here to rank several results consistently.
    return smartQuery ? fetchUnsplashImage(smartQuery) : '';
  })();

  vocabularyImageLookupsInFlight.set(cacheKey, lookup);
  try {
    const imageUrl = await lookup;
    if (imageUrl) cacheValue(vocabularyImageCache, cacheKey, imageUrl);
    return imageUrl;
  } finally {
    vocabularyImageLookupsInFlight.delete(cacheKey);
  }
}

async function findPixabayImageCandidates(query, imageType = 'photo') {
  try {
    const pixabayKey = await getPixabayApiKey();
    const params = new URLSearchParams({
      key: pixabayKey,
      q: query || 'study reading',
      image_type: imageType,
      safesearch: 'true',
      per_page: '10'
    });
    const response = await fetchWithTimeout(`https://pixabay.com/api/?${params.toString()}`, {}, 3500);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.hits || []).map(hit => ({ ...hit, sourceQuery: query, imageType }));
  } catch (error) {
    console.warn('Pixabay vocabulary image lookup failed:', error);
    return [];
  }
}

function chooseBestPixabayImage(candidates, queries, englishMeaning, context) {
  if (!candidates.length) return '';
  const referenceTerms = tokenizeImageText([...queries, englishMeaning, context].join(' '));
  const ranked = candidates.map(candidate => {
    const tags = tokenizeImageText(candidate.tags || '');
    const overlap = [...tags].filter(tag => referenceTerms.has(tag)).length;
    const ratio = Number(candidate.imageWidth) && Number(candidate.imageHeight)
      ? Math.min(candidate.imageWidth, candidate.imageHeight) / Math.max(candidate.imageWidth, candidate.imageHeight)
      : 0;
    const score = overlap * 12 + Math.min(Number(candidate.likes) || 0, 500) / 100
      + Math.min(Number(candidate.views) || 0, 50000) / 25000 + ratio;
    return { candidate, score };
  }).sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate?.webformatURL || ranked[0]?.candidate?.previewURL || '';
}

function tokenizeImageText(value) {
  const ignored = new Set(['this', 'that', 'with', 'from', 'into', 'used', 'use', 'person', 'thing', 'someone', 'something']);
  return new Set((String(value || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [])
    .filter(term => !ignored.has(term)));
}

async function fetchUnsplashImage(query) {
  try {
    const data = await chrome.storage.local.get({ unsplashAccessKey: '' });
    if (!data.unsplashAccessKey) return '';

    const params = new URLSearchParams({
      query: query,
      per_page: '1',
      orientation: 'squarish',
      content_filter: 'high'
    });
    const res = await fetch(`https://api.unsplash.com/search/photos?${params.toString()}`, {
      headers: { Authorization: `Client-ID ${data.unsplashAccessKey}` }
    });
    if (!res.ok) return '';
    const result = await res.json();
    return result?.results?.[0]?.urls?.small || '';
  } catch (e) {
    console.warn('Unsplash API error:', e);
    return '';
  }
}

async function fetchPixabayImage(query, imageType = 'photo') {
  try {
    const pixabayKey = await getPixabayApiKey();
    const params = new URLSearchParams({
      key: pixabayKey,
      q: query || 'study reading',
      image_type: imageType,
      safesearch: 'true',
      per_page: '3'
    });
    const pixabayRes = await fetch(`https://pixabay.com/api/?${params.toString()}`);
    if (!pixabayRes.ok) return '';
    const pixData = await pixabayRes.json();
    return pixData.hits?.[0]?.webformatURL || '';
  } catch (error) {
    console.warn("Story image lookup failed:", error);
    return '';
  }
}

function normalizeConfidence(confidence) {
  const value = String(confidence || '').toLowerCase();
  return ['high', 'medium', 'low'].includes(value) ? value : 'low';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function readCachedValue(cache, key, maxAgeMs) {
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.savedAt >= maxAgeMs) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheValue(cache, key, value) {
  if (cache.size >= MAX_MEMORY_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { savedAt: Date.now(), value });
}

async function lookupDictionaryWord(word) {
  const normalizedWord = normalizeWord(word);
  if (!normalizedWord) {
    return { success: false, valid: false, error: 'No word to look up' };
  }

  const cached = readCachedValue(dictionaryCache, normalizedWord, DICTIONARY_CACHE_TTL_MS);
  if (cached) return { ...cached, cached: true };

  if (dictionaryLookupsInFlight.has(normalizedWord)) {
    return dictionaryLookupsInFlight.get(normalizedWord);
  }

  const lookup = (async () => {
    // Use independent providers in parallel. DictionaryAPI adds phonetic data
    // when available; Datamuse supplies a WordNet definition if it responds
    // first or DictionaryAPI is unavailable.
    try {
      const result = await Promise.any([
        lookupDefinitionWithDictionaryApi(normalizedWord),
        lookupDefinitionWithDatamuse(normalizedWord)
      ]);
      cacheValue(dictionaryCache, normalizedWord, result);
      return result;
    } catch (error) {
      return {
        success: false,
        valid: false,
        error: 'No dictionary provider returned a definition'
      };
    }
  })();

  dictionaryLookupsInFlight.set(normalizedWord, lookup);
  try {
    return await lookup;
  } finally {
    dictionaryLookupsInFlight.delete(normalizedWord);
  }
}

async function lookupDefinitionWithDictionaryApi(word) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  const response = await fetchWithTimeout(url, {}, 3000);
  if (!response.ok) throw new Error(`Dictionary HTTP ${response.status}`);

  const data = await response.json();
  const firstEntry = data[0] || {};
  const firstMeaning = firstEntry.meanings?.[0];
  const firstDefinition = firstMeaning?.definitions?.[0]?.definition || '';
  if (!firstDefinition) throw new Error('Dictionary returned no definition');

  const partOfSpeech = firstMeaning?.partOfSpeech || '';
  const bestPhonetic = (firstEntry.phonetics || []).find(item => item.text) || firstEntry.phonetics?.[0];
  return {
    success: true,
    valid: true,
    definition: partOfSpeech ? `(${partOfSpeech}) ${firstDefinition}` : firstDefinition,
    partOfSpeech,
    phonetic: bestPhonetic?.text || '',
    source: 'dictionaryapi'
  };
}

async function lookupDefinitionWithDatamuse(word) {
  const params = new URLSearchParams({ sp: word, md: 'd', max: '1' });
  const response = await fetchWithTimeout(`https://api.datamuse.com/words?${params.toString()}`, {}, 2500);
  if (!response.ok) throw new Error(`Datamuse HTTP ${response.status}`);

  const entries = await response.json();
  const entry = entries.find(item => normalizeWord(item.word) === word) || entries[0];
  const definitionEntry = entry?.defs?.find(Boolean);
  if (!definitionEntry) throw new Error('Datamuse returned no definition');

  const [partOfSpeechCode, ...definitionParts] = definitionEntry.split('\t');
  const rawDefinition = definitionParts.join('\t').replace(/\s+/g, ' ').trim();
  if (!rawDefinition) throw new Error('Datamuse returned an empty definition');

  const partOfSpeech = {
    n: 'noun',
    v: 'verb',
    adj: 'adjective',
    adv: 'adverb'
  }[partOfSpeechCode] || '';
  return {
    success: true,
    valid: true,
    definition: partOfSpeech ? `(${partOfSpeech}) ${rawDefinition}` : rawDefinition,
    partOfSpeech,
    phonetic: '',
    source: 'datamuse'
  };
}

async function lookupPronunciation(word, accent = 'US') {
  const normalizedWord = normalizeWord(word);
  if (!normalizedWord) return { success: true, phonetic: '≈ /ˈwɜːd/', approximate: true, source: 'local-fallback' };

  const normalizedAccent = accent === 'UK' ? 'UK' : 'US';
  const cacheKey = `${normalizedWord}:${normalizedAccent}`;
  const cached = readCachedValue(pronunciationCache, cacheKey, DICTIONARY_CACHE_TTL_MS);
  if (cached) return { ...cached, cached: true };

  let phonetic = '';
  try {
    const params = new URLSearchParams({
      action: 'parse',
      format: 'json',
      prop: 'wikitext',
      page: normalizedWord,
      origin: '*'
    });
    const response = await fetchWithTimeout(
      `https://en.wiktionary.org/w/api.php?${params.toString()}`,
      {},
      2500
    );
    if (!response.ok) throw new Error(`Wiktionary HTTP ${response.status}`);

    const data = await response.json();
    const wikitext = data?.parse?.wikitext?.['*'] || '';
    phonetic = extractEnglishIpa(wikitext, normalizedAccent);
  } catch (error) {
    console.warn('Wiktionary IPA lookup failed:', error.message);
  }

  const result = phonetic
    ? { success: true, phonetic, approximate: false, source: 'wiktionary' }
    : {
        success: true,
        phonetic: `≈ /${buildSpellingIpa(normalizedWord)}/`,
        approximate: true,
        source: 'local-spelling'
      };
  cacheValue(pronunciationCache, cacheKey, result);
  return result;
}

function extractEnglishIpa(wikitext, accent) {
  const pronunciationSection = String(wikitext || '')
    .match(/===Pronunciation===([\s\S]*?)(?=\n===|$)/i)?.[1] || '';
  const ipaTemplates = [...pronunciationSection.matchAll(/\{\{IPA\|en\|([^|}]+)([^}]*)\}\}/gi)];
  if (ipaTemplates.length === 0) return '';

  const preferredRegion = accent === 'UK'
    ? /\|a=(?:UK|RP|Received Pronunciation)/i
    : /\|a=(?:US|GA|General American|Canada)/i;
  const preferred = ipaTemplates.find(match => preferredRegion.test(match[2] || '')) || ipaTemplates[0];
  return String(preferred[1] || '').trim();
}

function buildSpellingIpa(word) {
  const letterIpa = {
    a: 'eɪ', b: 'biː', c: 'siː', d: 'diː', e: 'iː', f: 'ɛf', g: 'dʒiː',
    h: 'eɪtʃ', i: 'aɪ', j: 'dʒeɪ', k: 'keɪ', l: 'ɛl', m: 'ɛm', n: 'ɛn',
    o: 'oʊ', p: 'piː', q: 'kjuː', r: 'ɑːr', s: 'ɛs', t: 'tiː', u: 'juː',
    v: 'viː', w: 'ˈdʌbəljuː', x: 'ɛks', y: 'waɪ', z: 'ziː'
  };
  const sounds = [...String(word || '').toLowerCase()]
    .map(letter => letterIpa[letter])
    .filter(Boolean);
  return sounds.join(' ') || 'ˈwɜːd';
}

async function speakText(text, lang = 'en-US') {
  const utterance = String(text || '').trim();
  if (!utterance) return { success: false, error: 'No text to speak' };
  const selectedLang = lang === 'en-GB' ? 'en-GB' : 'en-US';
  const preferences = await chrome.storage.local.get({ preferredTtsVoice: '', preferredTtsVoiceLang: '' });
  const voiceName = isCompatibleVoice(preferences.preferredTtsVoiceLang, selectedLang)
    ? preferences.preferredTtsVoice
    : '';

  return new Promise(resolve => {
    let settled = false;
    const timeoutId = setTimeout(() => finish({ success: false, error: 'Speech timed out' }), 15000);
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    try {
      chrome.tts.stop();
      chrome.tts.speak(utterance, {
        lang: selectedLang,
        ...(voiceName ? { voiceName } : {}),
        rate: 0.9,
        enqueue: false,
        onEvent(event) {
          if (event.type === 'end') finish({ success: true });
          if (['error', 'interrupted', 'cancelled'].includes(event.type)) {
            finish({ success: false, error: event.errorMessage || event.type });
          }
        }
      });
    } catch (error) {
      finish({ success: false, error: error.message });
    }
  });
}

function isCompatibleVoice(voiceLang, requestedLang) {
  const saved = String(voiceLang || '').toLowerCase();
  const requested = String(requestedLang || '').toLowerCase();
  return saved === 'en' || saved === requested;
}

async function handleFetchCollocations(word, partOfSpeech = '') {
  try {
    const collocations = await fetchCollocations(word, partOfSpeech);
    return { success: true, collocations };
  } catch (error) {
    console.warn("Collocation lookup error:", error);
    return { success: false, error: error.message, collocations: [] };
  }
}

async function fetchCollocations(word, partOfSpeech = '') {
  const normalizedWord = normalizeWord(word);
  if (!normalizedWord) return [];

  const cacheKey = `collocations:${normalizedWord}:${String(partOfSpeech || '').toLowerCase()}`;
  const cached = await chrome.storage.local.get({ collocationCache: {} });
  const cache = cached.collocationCache || {};
  const cachedEntry = cache[cacheKey];
  const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
  if (cachedEntry && Date.now() - cachedEntry.savedAt < maxAgeMs && Array.isArray(cachedEntry.items)) {
    return cachedEntry.items;
  }

  const items = [];
  const seen = new Set();
  const queries = getCollocationQueries(normalizedWord, partOfSpeech);

  for (const query of queries) {
    const results = await fetchDatamuseWords(query.params);
    for (const result of results) {
      const collocate = normalizeWord(result.word);
      if (!collocate || collocate === normalizedWord) continue;
      const phrase = query.buildPhrase(normalizedWord, collocate);
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        phrase,
        collocate,
        pattern: query.pattern,
        prompt: query.prompt,
        source: 'datamuse',
        score: Number(result.score) || 0,
        frequency: getDatamuseFrequency(result.tags)
      });
      if (items.length >= 8) break;
    }
    if (items.length >= 8) break;
  }

  const limitedItems = items.slice(0, 8);
  cache[cacheKey] = { savedAt: Date.now(), items: limitedItems };
  await chrome.storage.local.set({ collocationCache: cache });
  return limitedItems;
}

function getCollocationQueries(word, partOfSpeech = '') {
  const pos = String(partOfSpeech || '').toLowerCase();
  const nounQueries = [
    {
      pattern: 'adjective + noun',
      prompt: `Choose the adjective that naturally goes with "${word}".`,
      params: { rel_jjb: word, md: 'pf', max: '24' },
      buildPhrase: (base, collocate) => `${collocate} ${base}`
    },
    {
      pattern: 'associated word',
      prompt: `Choose a word commonly associated with "${word}".`,
      params: { rel_trg: word, md: 'pf', max: '24' },
      buildPhrase: (base, collocate) => `${collocate} ${base}`
    }
  ];
  const adjectiveQueries = [
    {
      pattern: 'adjective + noun',
      prompt: `Choose the noun that naturally follows "${word}".`,
      params: { rel_jja: word, md: 'pf', max: '24' },
      buildPhrase: (base, collocate) => `${base} ${collocate}`
    },
    {
      pattern: 'associated word',
      prompt: `Choose a word commonly associated with "${word}".`,
      params: { rel_trg: word, md: 'pf', max: '24' },
      buildPhrase: (base, collocate) => `${base} ${collocate}`
    }
  ];
  const fallbackQueries = [
    ...nounQueries,
    ...adjectiveQueries,
    {
      pattern: 'associated word',
      prompt: `Choose a word commonly associated with "${word}".`,
      params: { rel_trg: word, md: 'pf', max: '24' },
      buildPhrase: (base, collocate) => `${base} ${collocate}`
    }
  ];

  if (pos === 'noun') return nounQueries;
  if (pos === 'adjective') return adjectiveQueries;
  if (pos === 'verb') {
    return [
      {
        pattern: 'verb + following word',
        prompt: `Choose the word that often follows "${word}".`,
        params: { lc: word, sp: '*', md: 'pf', max: '32' },
        buildPhrase: (base, collocate) => `${base} ${collocate}`
      },
      ...fallbackQueries
    ];
  }
  return fallbackQueries;
}

async function fetchDatamuseWords(params) {
  const url = new URL('https://api.datamuse.com/words');
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Datamuse HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data.filter(isUsableDatamuseResult) : [];
}

function isUsableDatamuseResult(result) {
  const word = String(result?.word || '').trim();
  if (!word || word.length < 3 || /[^a-zA-Z' -]/.test(word)) return false;
  const lower = word.toLowerCase();
  const stopWords = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'have', 'been', 'were', 'their', 'there', 'them', 'they', 'you', 'your']);
  return !stopWords.has(lower);
}

function getDatamuseFrequency(tags = []) {
  const tag = Array.isArray(tags) ? tags.find(item => String(item).startsWith('f:')) : '';
  return tag ? Number(String(tag).slice(2)) || 0 : 0;
}

async function explainCollocationWithGemini(word, collocation) {
  try {
    const data = await chrome.storage.local.get({ geminiApiKey: '' });
    if (!data.geminiApiKey) {
      return { success: false, error: 'Gemini API Key is missing. Add it in the extension settings.' };
    }

    const phrase = String(collocation?.phrase || '').trim();
    const pattern = String(collocation?.pattern || '').trim();
    if (!phrase) return { success: false, error: 'No collocation was provided.' };

    const prompt = `You are an English teacher helping a learner understand one collocation.

Word: "${word || ''}"
Collocation: "${phrase}"
Pattern: "${pattern || 'unknown'}"

Return ONLY a raw JSON object with:
{
  "meaning": "plain English explanation of what the collocation means",
  "example": "one natural sentence using the exact collocation",
  "note": "short usage note: formality, grammar, common situation, or learner warning"
}

Rules:
- Keep it useful for an intermediate English learner.
- Use the exact collocation in the example.
- Do not include markdown or extra text.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${data.geminiApiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: "application/json" }
      })
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody?.error?.message || `HTTP ${response.status}`);
    }

    const resultData = await response.json();
    const text = resultData?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(text);
    return {
      success: true,
      context: {
        meaning: String(parsed.meaning || '').slice(0, 360),
        example: String(parsed.example || '').slice(0, 280),
        note: String(parsed.note || '').slice(0, 280)
      }
    };
  } catch (error) {
    console.error("Collocation explanation error:", error);
    return { success: false, error: error.message };
  }
}

async function evaluateSentenceWithGemini(word, sentence) {
  try {
    const data = await chrome.storage.local.get({ geminiApiKey: '' });
    if (!data.geminiApiKey) {
      return { success: false, error: 'Gemini API Key is missing.' };
    }

    const prompt = `You are an English teacher. The user was asked to write a sentence using the word "${word}".
They wrote: "${sentence}"

Evaluate if the word is used correctly in the sentence (grammar and meaning).
Return ONLY a raw JSON object (no markdown, no backticks).
Format:
{
  "correct": true or false,
  "feedback": "A short, encouraging explanation of why it is right or wrong."
}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${data.geminiApiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: "application/json" }
      })
    });

    if (!response.ok) throw new Error("API request failed");
    
    const resultData = await response.json();
    const text = resultData?.candidates?.[0]?.content?.parts?.[0]?.text;
    const result = JSON.parse(text);
    
    return { success: true, result };
  } catch (error) {
    console.error("Sentence eval error:", error);
    return { success: false, error: error.message };
  }
}

async function handleGenerateStory(words, level = 'A2', genre = 'daily life') {
  try {
    const data = await chrome.storage.local.get({ geminiApiKey: '' });
    if (!data.geminiApiKey) {
      return { success: false, error: 'Gemini API Key is missing. Please add it in the extension settings.' };
    }

    const prompt = `You are an English teacher creating short stories for vocabulary learning.

Return only valid JSON.

Input:
Target words: ${words.join(', ')}
Level: ${level}
Genre: ${genre}

Write a short English story using the target words naturally.

Rules:
- The story must be interesting and easy to understand.
- Use mostly common English words.
- Avoid idioms, slang, rare words, and long sentences.
- Do not force every word if it makes the story unnatural.
- Use each target word in a clear context.
- The story should match the requested CEFR level.

Level rules:
A1: 80-120 words, very short sentences, simple present/past, beginner vocabulary.
A2: 120-180 words, daily vocabulary, simple connected events.
B1: 180-250 words, richer details, but still clear.

Return JSON:
{
  "title": "...",
  "level": "...",
  "genre": "...",
  "story": "...",
  "targetWords": [
    "..."
  ],
  "simpleDefinitions": [
    {
      "word": "...",
      "meaning": "...",
      "exampleSentence": "..."
    }
  ],
  "comprehensionQuestions": [
    {
      "question": "...",
      "answer": "..."
    }
  ],
  "imagePrompt": "...",
  "imageSearchKeywords": "..."
}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${data.geminiApiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: { response_mime_type: "application/json" }
      })
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody?.error?.message || `HTTP ${response.status}`);
    }

    const result = await response.json();
    const storyText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (storyText) {
      const storyData = JSON.parse(storyText);
      const imageUrl = await fetchPixabayImage(storyData.imageSearchKeywords || storyData.title || words.join(' '));
      storyData.imageUrl = imageUrl;
      storyData.level = storyData.level || level;
      storyData.genre = storyData.genre || genre;
      storyData.targetWords = normalizeStoryTargetWords(storyData.targetWords, words);
      storyData.comprehensionQuestions = Array.isArray(storyData.comprehensionQuestions)
        ? storyData.comprehensionQuestions.slice(0, 3)
        : [];

      const savedStory = await saveGeneratedStory(storyData);
      return { success: true, story: storyData.story || '', storyData: savedStory };
    }
    throw new Error('Gemini API returned no story text');
  } catch (error) {
    console.error("Story generation error:", error);
    return { success: false, error: error.message };
  }
}

function normalizeStoryTargetWords(targetWords, fallbackWords) {
  if (Array.isArray(targetWords) && targetWords.length > 0) {
    return targetWords.map(item => typeof item === 'string' ? item : item.word).filter(Boolean);
  }
  return fallbackWords;
}


async function saveGeneratedStory(storyData) {
  const savedStory = {
    id: Date.now().toString(),
    title: storyData.title || 'Vocabulary Story',
    level: storyData.level || '',
    genre: storyData.genre || '',
    story: storyData.story || '',
    imageUrl: storyData.imageUrl || '',
    imagePrompt: storyData.imagePrompt || '',
    targetWords: storyData.targetWords || [],
    simpleDefinitions: storyData.simpleDefinitions || [],
    questions: storyData.comprehensionQuestions || [],
    comprehensionQuestions: storyData.comprehensionQuestions || [],
    imageSearchKeywords: storyData.imageSearchKeywords || '',
    createdAt: Date.now()
  };

  const data = await chrome.storage.local.get({ generatedStories: [] });
  const generatedStories = [savedStory, ...data.generatedStories].slice(0, 50);
  await chrome.storage.local.set({ generatedStories });
  return savedStory;
}

async function handleTranslation(text) {
  const sourceText = String(text || '').trim();
  if (!sourceText) return { success: false, error: 'No text to translate' };

  const cacheKey = `en:vi:${sourceText.toLowerCase()}`;
  const cached = readCachedValue(translationCache, cacheKey, TRANSLATION_CACHE_TTL_MS);
  if (cached) return { ...cached, cached: true };

  const data = await chrome.storage.local.get({ googleApiKey: '' });
  const apiKey = (data.googleApiKey || '').trim();
  let result;

  if (apiKey) {
    try {
      result = await translateWithGoogle(sourceText, apiKey);
      cacheValue(translationCache, cacheKey, result);
      return result;
    } catch (error) {
      console.warn("Google Cloud API failed, falling back to Google free endpoint:", error.message);
    }
  }

  try {
    result = await translateWithGoogleFree(sourceText);
    cacheValue(translationCache, cacheKey, result);
    return result;
  } catch (fallbackError) {
    console.error("Translation error:", fallbackError);
    return { success: false, error: fallbackError.message };
  }
}

// Google Cloud Translation API v2 (paid, requires API key)
async function translateWithGoogle(text, apiKey) {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: text,
      source: 'en',
      target: 'vi',
      format: 'text'
    })
  }, 5000);

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `HTTP ${response.status}`);
  }

  const result = await response.json();
  const translated = result?.data?.translations?.[0]?.translatedText;
  if (translated) {
    return { success: true, translation: translated, source: 'google-cloud' };
  }
  throw new Error('Google Cloud API returned no result');
}

// Google Translate free endpoint (no API key needed, reliable in extensions)
async function translateWithGoogleFree(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=${encodeURIComponent(text)}`;

  const response = await fetchWithTimeout(url, {}, 8000);
  if (!response.ok) {
    throw new Error(`Google Translate Error: ${response.status}`);
  }

  const result = await response.json();
  // Response format: [[[translatedText, originalText, ...],...],...]
  const translated = result?.[0]?.map(chunk => chunk?.[0]).filter(Boolean).join('');
  if (translated) {
    return { success: true, translation: translated, source: 'google-free' };
  }
  throw new Error('Google Translate returned no result');
}

// Vocabulary writes in this service worker run one at a time, so a save and a
// delayed image lookup can't read the same list and overwrite each other.
let vocabWriteQueue = Promise.resolve();

function queueVocabWrite(task) {
  const run = vocabWriteQueue.then(task);
  vocabWriteQueue = run.catch(() => {});
  return run;
}

// SM-2 Spaced Repetition logic for adding new words
async function saveVocabulary(vocabData) {
  let {
    word,
    originalWord,
    translation,
    englishMeaning,
    context,
    partOfSpeech,
    lemmaConfidence,
    lemmaReason
  } = vocabData;
  const now = new Date().getTime();
  word = normalizeWord(word);
  originalWord = normalizeWord(originalWord || word);

  let pronunciation = '';
  let audioUrl = '';
  let imageUrl = '';
  let synonyms = [];
  let antonyms = [];
  let collocations = [];

  // Save the word immediately after essential enrichment. Image lookup starts
  // now but is deliberately not allowed to delay the Save button response.
  const existingData = await chrome.storage.local.get({ vocabList: [] });
  if (existingData.vocabList.some(item => item.word === word)) {
    return { success: false, message: 'Word already in vocabulary list' };
  }
  const imageLookup = fetchVocabularyImage({ word, originalWord, englishMeaning, context, partOfSpeech });

  try {
    const dictRes = await fetchWithTimeout(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
      {},
      3000
    );
    if (dictRes.ok) {
      const dictData = await dictRes.json();
      const phonetics = dictData[0]?.phonetics || [];
      const validPhonetic = phonetics.find(p => p.text && p.audio) || phonetics.find(p => p.text) || phonetics[0];
      if (validPhonetic) {
        pronunciation = validPhonetic.text || '';
        audioUrl = validPhonetic.audio || '';
      }
      
      let dictExample = '';
      
      if (dictData[0]?.meanings) {
        for (const meaning of dictData[0].meanings) {
          if (meaning.synonyms) synonyms.push(...meaning.synonyms);
          if (meaning.antonyms) antonyms.push(...meaning.antonyms);
          for (const def of meaning.definitions) {
            if (def.example && !dictExample) {
              dictExample = def.example;
            }
            if (def.synonyms) synonyms.push(...def.synonyms);
            if (def.antonyms) antonyms.push(...def.antonyms);
          }
        }
      }
      
      synonyms = [...new Set(synonyms)].slice(0, 5);
      antonyms = [...new Set(antonyms)].slice(0, 5);

      if (dictExample) {
        context = dictExample; // Override messy context with clean dictionary example
      }
    }
  } catch(e) { console.warn("Dict API error:", e); }

  try {
    collocations = await fetchCollocations(word, partOfSpeech);
  } catch (e) {
    console.warn("Collocation lookup error:", e);
  }
  const newVocab = {
    id: Date.now().toString(),
    word,
    originalWord,
    translation,
    englishMeaning: englishMeaning || word,
    context,
    partOfSpeech: partOfSpeech || '',
    lemmaConfidence: lemmaConfidence || '',
    lemmaReason: lemmaReason || '',
    pronunciation,
    audioUrl,
    imageUrl,
    synonyms,
    antonyms,
    collocations,
    dateAdded: now,
    // SM-2 Initial Values
    interval: 0, // 0 days initially
    repetition: 0,
    easeFactor: 2.5,
    nextReviewDate: now // Due immediately
  };

  // Re-read the list (and XP) right before writing, in one queued step, so
  // words saved while the lookups above were running aren't lost.
  const list = await queueVocabWrite(async () => {
    const latestData = await chrome.storage.local.get({
      vocabList: [],
      userGamification: { xp: 0, level: 1, badges: [] }
    });
    if (latestData.vocabList.some(item => item.word === newVocab.word)) return null;
    latestData.vocabList.push(newVocab);

    // Award XP for expanding vocabulary
    const gamer = latestData.userGamification || { xp: 0, level: 1, badges: [] };
    gamer.xp = (gamer.xp || 0) + 10;
    if (gamer.xp >= 150 && gamer.level < 2) gamer.level = 2;

    await chrome.storage.local.set({ vocabList: latestData.vocabList, userGamification: gamer });
    return latestData.vocabList;
  });
  if (!list) {
    return { success: false, message: 'Word already in vocabulary list' };
  }
  notifyDueWords(list);

  void imageLookup.then(resolvedImageUrl => {
    if (!resolvedImageUrl) return;
    return queueVocabWrite(async () => {
      const latest = await chrome.storage.local.get({ vocabList: [] });
      const savedWord = latest.vocabList.find(item => item.id === newVocab.id);
      if (!savedWord || savedWord.imageUrl) return;
      savedWord.imageUrl = resolvedImageUrl;
      await chrome.storage.local.set({ vocabList: latest.vocabList });
    });
  }).catch(error => console.warn('Background vocabulary image enrichment failed:', error));

  return { success: true, message: 'Saved to vocabulary' };
}

function notifyDueWords(vocabList = []) {
  const dueWords = vocabList.filter(item => isWordDue(item));
  if (!dueWords.length || !chrome.notifications?.create) return;

  const count = dueWords.length;
  const noun = count === 1 ? 'word' : 'words';
  const preview = dueWords
    .slice(0, 3)
    .map(item => item.word || item.originalWord || 'word')
    .join(', ');
  const message = preview
    ? `You have ${count} ${noun} ready to review: ${preview}${count > 3 ? '...' : ''}`
    : `You have ${count} ${noun} ready to review.`;

  chrome.notifications.create(`gv-due-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'assets/icons/icon128.png',
    title: 'New words to review',
    message
  });
}

function isWordDue(item) {
  if (!item) return false;
  if (item.nextReviewDate == null) return true;
  return Number(item.nextReviewDate) <= Date.now();
}

// ── Context menu translation for Google Docs and other canvas-based sites ──
async function handleContextMenuTranslation(info, tab) {
  const selectionText = (info.selectionText || '').replace(/\s+/g, ' ').trim();
  if (!selectionText) return;

  // Try to get a richer selection + position from the page via scripting API
  let injectedData = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const sel = window.getSelection();
        const text = (sel && sel.toString() || '').replace(/\s+/g, ' ').trim();
        let rect = null;
        let contextSentence = '';

        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          const domRect = range.getBoundingClientRect();
          if (domRect && domRect.width > 0) {
            rect = {
              x: domRect.left + domRect.width / 2,
              y: domRect.bottom
            };
          }
          // Try to extract context sentence
          const container = range.commonAncestorContainer;
          const source = (container.nodeType === Node.TEXT_NODE
            ? container.parentNode?.innerText
            : container.innerText) || '';
          const normalized = source.replace(/\s+/g, ' ').trim();
          if (normalized) {
            const selectedText = sel.toString().trim();
            const idx = normalized.toLowerCase().indexOf(selectedText.toLowerCase());
            if (idx !== -1) {
              const before = normalized.slice(0, idx);
              const after = normalized.slice(idx + selectedText.length);
              const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?')) + 1;
              const endCandidates = ['.', '!', '?']
                .map(m => after.indexOf(m)).filter(i => i !== -1);
              const end = endCandidates.length > 0
                ? idx + selectedText.length + Math.min(...endCandidates) + 1
                : normalized.length;
              contextSentence = normalized.slice(start, end).trim().substring(0, 300);
            } else {
              contextSentence = normalized.substring(0, 240);
            }
          }
        }

        return { text, rect, contextSentence };
      }
    });
    injectedData = results?.[0]?.result;
  } catch (e) {
    console.warn('Context menu: scripting.executeScript failed, using info.selectionText:', e);
  }

  // Use the best available text: injected DOM selection, or fallback to info.selectionText
  const text = (injectedData?.text && injectedData.text.length > 0)
    ? injectedData.text
    : selectionText;
  const position = injectedData?.rect || null;
  const contextSentence = injectedData?.contextSentence || '';

  // Send message to the content script to show the tooltip
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'gv-context-menu-translate',
      text,
      position,
      contextSentence
    });
  } catch (e) {
    console.warn('Context menu: could not send to content script, injecting it first:', e);
    // Content script may not be injected yet (e.g. on chrome:// or newly opened tabs)
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
      // Retry sending the message after injection
      await chrome.tabs.sendMessage(tab.id, {
        type: 'gv-context-menu-translate',
        text,
        position,
        contextSentence
      });
    } catch (retryErr) {
      console.error('Context menu: could not inject or message content script:', retryErr);
    }
  }
}
