importScripts('vendor/wink-lemmatizer.js');

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
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'gv-open-pdf') {
    const viewerUrl = chrome.runtime.getURL('pdf-viewer/pdf-viewer.html')
      + '?file=' + encodeURIComponent(info.linkUrl);
    chrome.tabs.create({ url: viewerUrl, index: tab.index + 1 });
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
  if (messageType === "saveVocab") {
    saveVocabulary(request.vocabData).then(sendResponse);
    return true;
  }
  if (messageType === "fetchCollocations") {
    handleFetchCollocations(request.word, request.partOfSpeech).then(sendResponse);
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
  const lemmaIsValid = await isValidDictionaryWord(candidateLemma);
  const lemma = lemmaIsValid ? candidateLemma : originalWord;
  const translationText = lemma;

  return {
    success: true,
    lemma,
    partOfSpeech: lemmaData.partOfSpeech || '',
    confidence: lemmaData.confidence || 'low',
    reason: lemmaIsValid
      ? (lemmaData.reason || '')
      : `${lemmaData.reason || 'Lemma candidate was generated locally.'} Candidate "${candidateLemma}" was not found in the dictionary, so the original word was used.`,
    lemmaIsValid,
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
  const candidates = [
    word,
    originalWord,
    `${word} illustration`,
    `${word} concept`,
    `${word} object`
  ];
  const sourceText = `${englishMeaning || ''} ${context || ''}`.toLowerCase();
  const keywords = sourceText
    .match(/[a-z][a-z'-]{3,}/g)
    ?.filter(item => !stopWords.has(item) && item !== word)
    .slice(0, 4) || [];
  if (keywords.length > 0) candidates.push(`${word} ${keywords.join(' ')}`);
  return [...new Set(candidates.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 6);
}

async function fetchVocabularyImage({ word, originalWord, englishMeaning, context, partOfSpeech }) {
  const queries = getVocabularyImageQueries(word, originalWord, englishMeaning, context);
  for (const query of queries) {
    const illustration = await fetchPixabayImage(query, 'illustration');
    if (illustration) return illustration;
  }
  for (const query of queries) {
    const photo = await fetchPixabayImage(query, 'photo');
    if (photo) return photo;
  }
  return '';
}

function normalizeConfidence(confidence) {
  const value = String(confidence || '').toLowerCase();
  return ['high', 'medium', 'low'].includes(value) ? value : 'low';
}

async function isValidDictionaryWord(word) {
  if (!word) return false;
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    return res.ok;
  } catch (error) {
    console.warn("Dictionary validation error:", error);
    return false;
  }
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

async function fetchPixabayImage(query, imageType = 'photo') {
  try {
    const pixabayKey = '55815075-819f9a7ac5a51a635908a4d54';
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
  const data = await chrome.storage.local.get({ googleApiKey: '' });
  const apiKey = (data.googleApiKey || '').trim();

  if (apiKey) {
    try {
      return await translateWithGoogle(text, apiKey);
    } catch (error) {
      console.warn("Google Cloud API failed, falling back to Google free endpoint:", error.message);
    }
  }

  try {
    return await translateWithGoogleFree(text);
  } catch (fallbackError) {
    console.error("Translation error:", fallbackError);
    return { success: false, error: fallbackError.message };
  }
}

// Google Cloud Translation API v2 (paid, requires API key)
async function translateWithGoogle(text, apiKey) {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: text,
      source: 'en',
      target: 'vi',
      format: 'text'
    })
  });

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

  const response = await fetch(url);
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

  try {
    const dictRes = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
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
  imageUrl = await fetchVocabularyImage({ word, originalWord, englishMeaning, context, partOfSpeech });

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

  const data = await chrome.storage.local.get({ vocabList: [] });
  let list = data.vocabList;

  // Prevent exact duplicates
  const existingIndex = list.findIndex(item => item.word === newVocab.word);
  if (existingIndex >= 0) {
    return { success: false, message: 'Word already in vocabulary list' };
  }

  list.push(newVocab);
  await chrome.storage.local.set({ vocabList: list });
  notifyDueWords(list);

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
