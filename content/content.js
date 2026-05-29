let tooltip = null;
let currentSelection = '';
let currentContextSentence = '';
let tooltipRequestId = 0;

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
    </div>
    <div class="ll-body">
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
}

function showTooltip(x, y, text, contextSentence = '') {
  createTooltip();
  currentSelection = text;
  currentContextSentence = contextSentence;
  const requestId = ++tooltipRequestId;

  tooltip.classList.remove('gv-hide');

  const viewportWidth = window.innerWidth;
  const tooltipWidth = 300;
  let left = x;
  if (left + tooltipWidth > viewportWidth - 10) {
    left = viewportWidth - tooltipWidth - 10;
  }
  if (left < 10) left = 10;

  tooltip.style.left = `${left + window.scrollX}px`;
  tooltip.style.top = `${y + window.scrollY + 12}px`;

  tooltip.classList.remove('gv-sentence-mode');
  document.getElementById('ll-selected-word').textContent = text;

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

      translateAndRender(translationText, viEl, btnEl, requestId);
      fetchDefinitionAndRender(lemma || normalizedOriginal, enEl, btnEl, requestId);
    });
    return;
  }

  tooltip.classList.add('gv-sentence-mode');
  document.getElementById('ll-selected-word').textContent = 'Sentence translation';
  setEnglishMeaningVisible(false, enEl);
  translateAndRender(text, viEl, btnEl, requestId);
  renderSentenceContext(text, contextSentence, enEl, btnEl, requestId);
}

function translateAndRender(text, viEl, btnEl, requestId) {
  chrome.runtime.sendMessage({ action: "translate", text }, response => {
    if (requestId !== tooltipRequestId) return;

    if (response && response.success) {
      viEl.textContent = response.translation;
      viEl.className = 'll-meaning-text vi';
      btnEl.dataset.translation = response.translation;
      btnEl.style.display = 'flex';
    } else {
      viEl.textContent = 'Translation failed';
      viEl.className = 'll-meaning-text error';
    }
  });
}

function fetchDefinitionAndRender(word, enEl, btnEl, requestId) {
  fetchEnglishDefinition(word).then(({ definition, partOfSpeech }) => {
    if (requestId !== tooltipRequestId) return;

    enEl.textContent = definition;
    enEl.className = 'll-meaning-text en';
    btnEl.dataset.englishMeaning = definition;
    if (!btnEl.dataset.partOfSpeech) {
      btnEl.dataset.partOfSpeech = partOfSpeech;
    }
  }).catch(() => {
    if (requestId !== tooltipRequestId) return;

    enEl.textContent = word;
    enEl.className = 'll-meaning-text';
    btnEl.dataset.englishMeaning = '';
    if (!btnEl.dataset.partOfSpeech) {
      btnEl.dataset.partOfSpeech = '';
    }
  });
}

async function fetchEnglishDefinition(word) {
  try {
    const normalized = normalizeSelectedWord(word);
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(normalized)}`);
    if (!res.ok) throw new Error('Not found');
    const data = await res.json();
    const firstMeaning = data[0]?.meanings?.[0];
    const firstDef = firstMeaning?.definitions?.[0]?.definition;
    const partOfSpeech = firstMeaning?.partOfSpeech || '';
    if (firstDef) {
      return { definition: partOfSpeech ? `(${partOfSpeech}) ${firstDef}` : firstDef, partOfSpeech };
    }
    throw new Error('No definition');
  } catch {
    return { definition: word, partOfSpeech: '' };
  }
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
  if (!selection || selection.length > 500) return false;
  const words = getSelectedWords(selection);
  if (words.length === 0 || words.length > 80) return false;
  return /^[a-zA-Z0-9\s.,!?;:'"()\-]+$/.test(selection);
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

function setEnglishMeaningVisible(isVisible, enEl) {
  const enBlock = enEl?.closest('.ll-meaning-block');
  const divider = enBlock?.nextElementSibling?.classList.contains('ll-divider')
    ? enBlock.nextElementSibling
    : null;

  if (enBlock) enBlock.classList.toggle('hidden', !isVisible);
  if (divider) divider.classList.toggle('hidden', !isVisible);
}
