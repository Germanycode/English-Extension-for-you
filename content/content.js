let tooltip = null;
let currentSelection = '';
let currentContextSentence = '';
let tooltipRequestId = 0;
let speechRequestId = 0;

function createTooltip() {
  if (tooltip) return;

  tooltip = document.createElement('div');
  tooltip.id = 'gv-tooltip';
  tooltip.className = 'gv-hide';

  tooltip.innerHTML = `
    <div class="ll-header">
      <span class="ll-logo">GV</span>
      <span class="ll-logo-text">GermanyVocab</span>
      <button class="ll-close-btn" id="gv-close-btn">x</button>
    </div>
    <div class="ll-word-row">
      <span id="ll-selected-word" class="ll-selected-word"></span>
      <div id="ll-pronunciation-row" class="ll-pronunciation-row" style="display:none">
        <button id="ll-speak-btn" class="ll-speak-btn" title="Listen to pronunciation">🔊</button>
        <button id="ll-accent-toggle" class="ll-accent-toggle" title="Switch Accent">US</button>
        <span id="ll-phonetic" class="ll-phonetic"></span>
      </div>
    </div>
    <div id="ll-sentence-prompt" class="ll-sentence-prompt" style="display:none">
      <div id="ll-sentence-wordcount" class="ll-sentence-wordcount"></div>
      <button id="ll-translate-sentence-btn" class="ll-translate-sentence-btn">Translate Sentence</button>
    </div>
    <div class="ll-body" id="ll-body">
      <div class="ll-meaning-block">
        <span class="ll-lang-badge ll-en">EN</span>
        <span id="ll-english-meaning" class="ll-meaning-text">Looking up...</span>
      </div>
      <div class="ll-divider"></div>
      <div class="ll-meaning-block">
        <span class="ll-lang-badge ll-vi">VI</span>
        <span id="ll-vietnamese-meaning" class="ll-meaning-text">Translating...</span>
      </div>
    </div>
    <div class="ll-footer">
      <button id="gv-add-btn" class="ll-add-btn" style="display:none">
        <span>+</span> Add to Vocab
      </button>
    </div>
  `;

  document.body.appendChild(tooltip);

  document.getElementById('gv-add-btn').addEventListener('click', handleAddVocab);
  document.getElementById('gv-close-btn').addEventListener('click', hideTooltip);
  document.getElementById('ll-speak-btn').addEventListener('click', handleSpeak);

  document.getElementById('ll-translate-sentence-btn').addEventListener('click', () => {
    document.getElementById('ll-sentence-prompt').style.display = 'none';
    document.getElementById('ll-body').style.display = 'block';
    const viEl = document.getElementById('ll-vietnamese-meaning');
    const btnEl = document.getElementById('gv-add-btn');
    translateAndRender(currentSelection, viEl, btnEl, tooltipRequestId);
  });

  const accentToggle = document.getElementById('ll-accent-toggle');
  accentToggle.addEventListener('click', () => {
    const current = accentToggle.textContent === 'US' ? 'UK' : 'US';
    accentToggle.textContent = current;
    chrome.storage.local.set({ preferredAccent: current });
    const currentWord = document.getElementById('ll-pronunciation-row')?.dataset.word;
    if (currentWord) {
      document.getElementById('ll-phonetic').textContent = 'Looking up IPA…';
      lookupTooltipPronunciation(currentWord, tooltipRequestId);
    }
  });

  // Load preferred accent
  chrome.storage.local.get({ preferredAccent: 'US' }, (data) => {
    accentToggle.textContent = data.preferredAccent;
  });
}

function showTooltip(x, y, text, contextSentence = '') {
  createTooltip();
  currentSelection = text;
  currentContextSentence = contextSentence;
  const requestId = ++tooltipRequestId;

  tooltip.classList.remove('gv-hide');

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const tooltipWidth = 300;
  const tooltipEstimatedHeight = 200;
  let left = x;
  if (left + tooltipWidth > viewportWidth - 10) {
    left = viewportWidth - tooltipWidth - 10;
  }
  if (left < 10) left = 10;

  // Vertical positioning: show below selection by default,
  // but flip above if the tooltip would overflow the viewport bottom.
  let topPos = y + window.scrollY + 12;
  if (y + tooltipEstimatedHeight > viewportHeight - 10) {
    topPos = y + window.scrollY - tooltipEstimatedHeight - 12;
    if (topPos < window.scrollY + 10) topPos = window.scrollY + 10;
  }

  tooltip.style.left = `${left + window.scrollX}px`;
  tooltip.style.top = `${topPos}px`;

  tooltip.classList.remove('gv-sentence-mode');
  document.getElementById('ll-selected-word').textContent = text;

  // Reset pronunciation row
  const pronRow = document.getElementById('ll-pronunciation-row');
  const phoneticEl = document.getElementById('ll-phonetic');
  pronRow.style.display = 'none';
  phoneticEl.textContent = '';
  pronRow.dataset.audioUrl = '';

  const enEl = document.getElementById('ll-english-meaning');
  const viEl = document.getElementById('ll-vietnamese-meaning');
  const btnEl = document.getElementById('gv-add-btn');

  enEl.textContent = 'Looking up...';
  enEl.className = 'll-meaning-text loading';
  viEl.textContent = 'Translating...';
  viEl.className = 'll-meaning-text loading';

  btnEl.style.display = 'none';
  btnEl.innerHTML = '<span>+</span> Add to Vocab';
  btnEl.disabled = false;
  btnEl.className = 'll-add-btn';
  btnEl.dataset.word = normalizeSelectedWord(text);
  btnEl.dataset.originalWord = normalizeSelectedWord(text);
  btnEl.dataset.context = contextSentence;
  btnEl.dataset.partOfSpeech = '';
  btnEl.dataset.lemmaConfidence = '';
  btnEl.dataset.lemmaReason = '';
  btnEl.dataset.translation = '';
  btnEl.dataset.englishMeaning = '';

  const selectedWords = getSelectedWords(text);
  
  const promptEl = document.getElementById('ll-sentence-prompt');
  promptEl.style.display = 'none';
  document.getElementById('ll-body').style.display = 'block';

  if (selectedWords.length === 1) {
    setEnglishMeaningVisible(true, enEl);
    chrome.runtime.sendMessage({
      type: "lemmatizeWord",
      word: text,
      sentence: contextSentence
    }, response => {
      if (requestId !== tooltipRequestId) return;

      const normalizedOriginal = normalizeSelectedWord(text);
      const lemma = response?.success ? normalizeSelectedWord(response.lemma) : normalizedOriginal;
      const translationText = response?.success ? (response.translationText || normalizedOriginal) : normalizedOriginal;

      btnEl.dataset.word = lemma || normalizedOriginal;
      btnEl.dataset.originalWord = normalizedOriginal;
      btnEl.dataset.partOfSpeech = response?.partOfSpeech || '';
      btnEl.dataset.lemmaConfidence = response?.confidence || 'low';
      btnEl.dataset.lemmaReason = response?.reason || 'Lemmatization failed; saved original spelling.';

      document.getElementById('ll-selected-word').textContent =
        lemma && lemma !== normalizedOriginal ? `${text} \u2192 ${lemma}` : text;

      // Translation is intentionally started before the remote dictionary
      // lookup. The selected word remains responsive even when that service
      // is slow or unavailable.
      translateAndRender(translationText, viEl, btnEl, requestId);
      lookupWordMetadataAndRender(lemma || normalizedOriginal, enEl, btnEl, requestId);
    });
    return;
  }

  tooltip.classList.add('gv-sentence-mode');
  document.getElementById('ll-selected-word').textContent = 'Sentence translation';
  setEnglishMeaningVisible(false, enEl);

  document.getElementById('ll-body').style.display = 'none';
  promptEl.style.display = 'flex';
  document.getElementById('ll-sentence-wordcount').textContent = `${selectedWords.length} words selected`;
}

function translateAndRender(text, viEl, btnEl, requestId) {
  chrome.runtime.sendMessage({ action: "translate", text }, response => {
    if (requestId !== tooltipRequestId) return;

    if (response && response.success) {
      viEl.textContent = response.translation;
      viEl.className = 'll-meaning-text vi';
      btnEl.dataset.translation = response.translation;
      if (!tooltip.classList.contains('gv-sentence-mode')) {
        btnEl.style.display = 'flex';
      }
    } else {
      viEl.textContent = 'Translation failed';
      viEl.className = 'll-meaning-text error';
    }
  });
}

function lookupWordMetadataAndRender(word, enEl, btnEl, requestId) {
  chrome.runtime.sendMessage({ action: 'lookupDictionary', word }, response => {
    if (requestId !== tooltipRequestId) return;

    const definition = response?.success ? (response.definition || word) : word;
    enEl.textContent = definition;
    enEl.className = response?.success ? 'll-meaning-text en' : 'll-meaning-text';
    btnEl.dataset.englishMeaning = response?.success ? definition : '';
    if (!btnEl.dataset.partOfSpeech) {
      btnEl.dataset.partOfSpeech = response?.partOfSpeech || '';
    }

    const pronRow = document.getElementById('ll-pronunciation-row');
    const phoneticEl = document.getElementById('ll-phonetic');
    if (pronRow && phoneticEl) {
      pronRow.dataset.word = normalizeSelectedWord(word);
      const phonetic = response?.success ? (response.phonetic || '') : '';
      phoneticEl.textContent = phonetic || 'Looking up IPA…';
      pronRow.style.display = 'flex';
      if (!phonetic) {
        lookupTooltipPronunciation(word, requestId);
      }
    }
  });
}

function lookupTooltipPronunciation(word, requestId) {
  const accent = document.getElementById('ll-accent-toggle')?.textContent === 'UK' ? 'UK' : 'US';
  chrome.runtime.sendMessage({ action: 'lookupPronunciation', word, accent }, response => {
    if (requestId !== tooltipRequestId) return;
    const phoneticEl = document.getElementById('ll-phonetic');
    if (phoneticEl) {
      phoneticEl.textContent = response?.success ? response.phonetic : 'IPA unavailable';
    }
  });
}

function hideTooltip() {
  if (tooltip && !tooltip.classList.contains('gv-hide')) {
    tooltip.classList.add('gv-hide');
  }
}

function handleAddVocab(e) {
  const btn = e.currentTarget;
  btn.innerHTML = '<span class="ll-spin">...</span> Saving...';
  btn.disabled = true;

  chrome.runtime.sendMessage({
    action: "saveVocab",
    vocabData: {
      word: btn.dataset.word || currentSelection,
      originalWord: btn.dataset.originalWord || currentSelection,
      translation: btn.dataset.translation || '',
      englishMeaning: btn.dataset.englishMeaning || btn.dataset.word || currentSelection,
      context: btn.dataset.context || currentContextSentence || '',
      partOfSpeech: btn.dataset.partOfSpeech || '',
      lemmaConfidence: btn.dataset.lemmaConfidence || '',
      lemmaReason: btn.dataset.lemmaReason || ''
    }
  }, response => {
    if (response && response.success) {
      btn.innerHTML = 'Added!';
      btn.className = 'll-add-btn success';
      setTimeout(hideTooltip, 1500);
    } else {
      btn.innerHTML = response?.message || 'Already saved';
      btn.className = 'll-add-btn already';
      setTimeout(hideTooltip, 2000);
    }
  });
}

document.addEventListener('mouseup', e => {
  if (tooltip && tooltip.contains(e.target)) return;

  const selectionObj = window.getSelection();
  const selection = normalizeSelectionText(selectionObj.toString());

  if (isTranslatableSelection(selection)) {
    showTooltip(e.clientX, e.clientY, selection, getSelectionSentence(selectionObj));
  } else {
    hideTooltip();
  }
});

document.addEventListener('mousedown', e => {
  if (tooltip && !tooltip.contains(e.target)) {
    hideTooltip();
  }
});

function getSelectionSentence(selection) {
  if (!selection || selection.rangeCount === 0) return '';

  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const textSource = (container.nodeType === Node.TEXT_NODE ? container.parentNode?.innerText : container.innerText) || '';
  const normalizedSource = textSource.replace(/\s+/g, ' ').trim();
  if (!normalizedSource) return '';

  const selectedText = selection.toString().trim();
  const selectedIndex = normalizedSource.toLowerCase().indexOf(selectedText.toLowerCase());
  if (selectedIndex === -1) {
    return normalizedSource.substring(0, 240);
  }

  const before = normalizedSource.slice(0, selectedIndex);
  const after = normalizedSource.slice(selectedIndex + selectedText.length);
  const sentenceStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?')) + 1;
  const sentenceEndCandidates = ['.', '!', '?']
    .map(mark => after.indexOf(mark))
    .filter(index => index !== -1);
  const sentenceEnd = sentenceEndCandidates.length > 0
    ? selectedIndex + selectedText.length + Math.min(...sentenceEndCandidates) + 1
    : normalizedSource.length;

  return normalizedSource.slice(sentenceStart, sentenceEnd).trim().substring(0, 300);
}

function normalizeSelectedWord(word) {
  return String(word || '').trim().toLowerCase().replace(/^[^a-z']+|[^a-z']+$/g, '');
}

function normalizeSelectionText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function getSelectedWords(text) {
  return String(text || '').match(/[a-zA-Z]+(?:[-'][a-zA-Z]+)*/g) || [];
}

function isTranslatableSelection(selection) {
  if (!selection) return false;
  const words = getSelectedWords(selection);
  // Limit to 50 words to prevent API quota abuse with very large selections
  return words.length > 0 && words.length <= 50;
}

function renderSentenceContext(text, contextSentence, enEl, btnEl, requestId) {
  if (requestId !== tooltipRequestId) return;

  enEl.textContent = '';
  enEl.className = 'll-meaning-text';
  btnEl.dataset.englishMeaning = text;
  btnEl.dataset.word = text;
  btnEl.dataset.originalWord = text;
  btnEl.dataset.context = contextSentence || text;
  btnEl.dataset.partOfSpeech = 'sentence';
  btnEl.dataset.lemmaConfidence = '';
  btnEl.dataset.lemmaReason = 'Saved as a sentence selection; lemmatization is only used for single words.';
}

// ── Pronunciation playback via Chrome TTS ──

function handleSpeak() {
  const pronRow = document.getElementById('ll-pronunciation-row');
  const speakBtn = document.getElementById('ll-speak-btn');
  const accentToggle = document.getElementById('ll-accent-toggle');
  const word = pronRow?.dataset.word || '';

  if (!word || !speakBtn) return;

  const currentSpeechRequestId = ++speechRequestId;
  const lang = accentToggle?.textContent === 'UK' ? 'en-GB' : 'en-US';
  speakBtn.classList.add('playing');
  chrome.runtime.sendMessage({ action: 'speakText', text: word, lang }, response => {
    if (currentSpeechRequestId !== speechRequestId) return;
    if (response?.success) {
      speakBtn.classList.remove('playing');
      return;
    }
    speakWithBrowserVoice(word, lang, () => {
      if (currentSpeechRequestId === speechRequestId) speakBtn.classList.remove('playing');
    });
  });
}

function speakWithBrowserVoice(text, lang, onFinished) {
  if (!('speechSynthesis' in window)) {
    onFinished();
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = 0.9;
  utterance.onend = utterance.onerror = onFinished;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function setEnglishMeaningVisible(isVisible, enEl) {
  const enBlock = enEl?.closest('.ll-meaning-block');
  const divider = enBlock?.nextElementSibling?.classList.contains('ll-divider')
    ? enBlock.nextElementSibling
    : null;

  if (enBlock) enBlock.classList.toggle('hidden', !isVisible);
  if (divider) divider.classList.toggle('hidden', !isVisible);
}

// ── Context menu handler: translate selected text from right-click ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'gv-context-menu-translate') {
    const text = normalizeSelectionText(message.text || '');
    if (!isTranslatableSelection(text)) return;

    // Use position from the background script if available, otherwise center of viewport
    const pos = message.position;
    const x = pos?.x ?? window.innerWidth / 2 - 150;
    const y = pos?.y ?? window.innerHeight / 3;
    const contextSentence = message.contextSentence || '';

    showTooltip(x, y, text, contextSentence);
  }
});
