document.addEventListener('DOMContentLoaded', () => {
  // ── Apply personalization (custom name & icon) ──
  applyPersonalization();

  // Listen for setting changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.appName || changes.customIconDataUrl)) {
      applyPersonalization();
    }
  });

  // ── Tab switching ──
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  // ── Sentence Translator ──
  const sentenceInput = document.getElementById('sentence-input');
  const translateBtn  = document.getElementById('translate-btn');
  const resultBox     = document.getElementById('translation-result');
  const charCount     = document.getElementById('char-count');
  const copyBtn       = document.getElementById('copy-btn');

  // Character counter
  sentenceInput.addEventListener('input', () => {
    const len = sentenceInput.value.length;
    charCount.textContent = len;
    const counter = charCount.parentElement;
    counter.classList.toggle('warn', len > 400);
  });

  // Translate on button click
  translateBtn.addEventListener('click', () => {
    const text = sentenceInput.value.trim();
    if (!text) return;

    translateBtn.disabled = true;
    translateBtn.innerHTML = '<span class="ll-spin">⟳</span> Translating…';
    resultBox.textContent = 'Translating…';
    resultBox.className = 'translator-result';
    copyBtn.style.display = 'none';

    chrome.runtime.sendMessage({ action: 'translate', text }, response => {
      translateBtn.disabled = false;
      translateBtn.innerHTML = '<span>🌐</span> Translate Sentence';

      if (response && response.success) {
        resultBox.textContent = response.translation;
        resultBox.className = 'translator-result has-result';
        copyBtn.style.display = 'flex';
      } else {
        resultBox.textContent = '⚠ Translation failed. Please try again.';
        resultBox.className = 'translator-result error-state';
      }
    });
  });

  // Also translate on Ctrl+Enter
  sentenceInput.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      translateBtn.click();
    }
  });

  // Copy to clipboard
  copyBtn.addEventListener('click', () => {
    const text = resultBox.textContent;
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.innerHTML = '<span>✓</span> Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.innerHTML = '<span>📋</span> Copy';
        copyBtn.classList.remove('copied');
      }, 2000);
    });
  });


  chrome.storage.local.get({
    vocabList: [],
    reviewStreak: { currentStreak: 0 },
    userGamification: { xp: 0, level: 1 }
  }, (data) => {
    const list = data.vocabList || [];

    // -- Total words
    const totalEl = document.getElementById('total-words');
    if (totalEl) totalEl.textContent = list.length;

    // -- Due count
    const now = Date.now();
    const dueCount = list.filter(item => !item.nextReviewDate || item.nextReviewDate <= now).length;
    const dueEl = document.getElementById('due-words');
    if (dueEl) dueEl.textContent = dueCount;

    // -- Streak
    const streakEl = document.getElementById('streak-days');
    if (streakEl) streakEl.textContent = data.reviewStreak?.currentStreak || 0;

    // -- Level & XP
    const gamification = data.userGamification || { xp: 0, level: 1 };
    const levelBadge = document.getElementById('popup-level-badge');
    const xpText = document.getElementById('popup-xp-text');
    if (levelBadge) levelBadge.textContent = `Lv. ${gamification.level || 1}`;
    if (xpText) xpText.textContent = `${gamification.xp || 0} XP`;
  });

  // ── Quick Translate ──
  const qtInput    = document.getElementById('qt-word-input');
  const qtSearchBtn = document.getElementById('qt-search-btn');
  const qtResult   = document.getElementById('qt-result');
  const qtHeading  = document.getElementById('qt-word-heading');
  const qtEn       = document.getElementById('qt-en-meaning');
  const qtVi       = document.getElementById('qt-vi-meaning');
  const qtAddBtn   = document.getElementById('qt-add-btn');
  const qtIdleHint = document.getElementById('qt-idle-hint');
  const qtPronRow  = document.getElementById('qt-pronunciation-row');
  const qtPhonetic = document.getElementById('qt-phonetic');
  const qtSpeakBtn = document.getElementById('qt-speak-btn');
  const qtAccentToggle = document.getElementById('qt-accent-toggle');

  // Load preferred accent
  chrome.storage.local.get({ preferredAccent: 'US' }, (data) => {
    if (qtAccentToggle) qtAccentToggle.textContent = data.preferredAccent;
  });

  if (qtAccentToggle) {
    qtAccentToggle.addEventListener('click', () => {
      const current = qtAccentToggle.textContent === 'US' ? 'UK' : 'US';
      qtAccentToggle.textContent = current;
      chrome.storage.local.set({ preferredAccent: current });
      const currentWord = qtPronRow?.dataset.word;
      if (currentWord) {
        qtPhonetic.textContent = 'Looking up IPA…';
        lookupPopupPronunciation(currentWord, quickTranslateRequestId);
      }
    });
  }

  // Store the current lookup data for saving
  let qtData = {};
  let quickTranslateRequestId = 0;
  let quickSpeechRequestId = 0;

  function doQuickTranslate() {
    const raw = qtInput.value.trim();
    if (!raw) return;
    const requestId = ++quickTranslateRequestId;

    // Reset UI
    qtIdleHint.style.display = 'none';
    qtResult.classList.add('visible');
    qtHeading.textContent = raw;
    qtEn.textContent = 'Looking up…';
    qtEn.className = 'qt-meaning-text loading';
    qtVi.textContent = 'Translating…';
    qtVi.className = 'qt-meaning-text loading';
    qtAddBtn.style.display = 'none';
    qtAddBtn.disabled = false;
    qtAddBtn.innerHTML = '<span>+</span> Add to Vocab';
    qtAddBtn.className = 'qt-add-btn';
    qtSearchBtn.disabled = true;

    // Reset pronunciation
    qtPronRow.style.display = 'none';
    qtPhonetic.textContent = '';
    qtPronRow.dataset.word = '';

    qtData = {
      originalWord: normalizeWord(raw),
      word: normalizeWord(raw),
      translation: '',
      englishMeaning: '',
      partOfSpeech: '',
      lemmaConfidence: '',
      lemmaReason: '',
      context: ''
    };

    // Step 1: Lemmatize the word
    chrome.runtime.sendMessage({
      type: 'lemmatizeWord',
      word: raw,
      sentence: ''
    }, response => {
      if (requestId !== quickTranslateRequestId) return;
      const normalizedOriginal = normalizeWord(raw);
      const lemma = response?.success ? normalizeWord(response.lemma) : normalizedOriginal;

      qtData.word = lemma || normalizedOriginal;
      qtData.originalWord = normalizedOriginal;
      qtData.partOfSpeech = response?.partOfSpeech || '';
      qtData.lemmaConfidence = response?.confidence || 'low';
      qtData.lemmaReason = response?.reason || '';

      // Update heading with lemma info
      let headingHtml = escapeHtml(lemma || raw);
      if (lemma && lemma !== normalizedOriginal) {
        headingHtml = `${escapeHtml(raw)} <span class="qt-lemma-arrow">→</span> ${escapeHtml(lemma)}`;
      }
      if (qtData.partOfSpeech) {
        headingHtml += ` <span class="qt-pos-badge">${escapeHtml(qtData.partOfSpeech)}</span>`;
      }
      qtHeading.innerHTML = headingHtml;

      // Step 2: Translate (use lemma for better translation)
      const translationWord = response?.translationText || lemma || normalizedOriginal;
      chrome.runtime.sendMessage({ action: 'translate', text: translationWord }, tRes => {
        if (requestId !== quickTranslateRequestId) return;
        qtSearchBtn.disabled = false;
        if (tRes?.success) {
          qtVi.textContent = tRes.translation;
          qtVi.className = 'qt-meaning-text vi';
          qtData.translation = tRes.translation;
          qtAddBtn.style.display = 'flex';
        } else {
          qtVi.textContent = 'Translation failed';
          qtVi.className = 'qt-meaning-text error';
        }
      });

      // Metadata is optional and shares one timeout-protected dictionary call.
      // It never blocks the translation displayed above.
      chrome.runtime.sendMessage({ action: 'lookupDictionary', word: lemma || normalizedOriginal }, dictRes => {
        if (requestId !== quickTranslateRequestId) return;

        const definition = dictRes?.success ? (dictRes.definition || lemma || normalizedOriginal) : (lemma || normalizedOriginal);
        qtEn.textContent = definition;
        qtEn.className = 'qt-meaning-text';
        qtData.englishMeaning = dictRes?.success ? definition : '';
        if (!qtData.partOfSpeech && dictRes?.partOfSpeech) {
          qtData.partOfSpeech = dictRes.partOfSpeech;
          const existingBadge = qtHeading.querySelector('.qt-pos-badge');
          if (!existingBadge) {
            qtHeading.insertAdjacentHTML('beforeend', ` <span class="qt-pos-badge">${escapeHtml(dictRes.partOfSpeech)}</span>`);
          }
        }

        qtPronRow.dataset.word = normalizeWord(lemma || normalizedOriginal);
        const phonetic = dictRes?.success ? (dictRes.phonetic || '') : '';
        qtPhonetic.textContent = phonetic || 'Looking up IPA…';
        qtPronRow.style.display = 'flex';
        if (!phonetic) {
          lookupPopupPronunciation(lemma || normalizedOriginal, requestId);
        }
      });
    });
  }

  function lookupPopupPronunciation(word, requestId) {
    const accent = qtAccentToggle?.textContent === 'UK' ? 'UK' : 'US';
    chrome.runtime.sendMessage({ action: 'lookupPronunciation', word, accent }, response => {
      if (requestId !== quickTranslateRequestId) return;
      qtPhonetic.textContent = response?.success ? response.phonetic : 'IPA unavailable';
    });
  }

  // Trigger translate on button click or Enter key
  qtSearchBtn.addEventListener('click', doQuickTranslate);
  qtInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') doQuickTranslate();
  });

  // Auto-focus the input when the popup opens
  qtInput.focus();

  // Speaker button click handler
  qtSpeakBtn.addEventListener('click', () => {
    const word = qtPronRow.dataset.word || '';
    if (!word) return;

    const speechRequestId = ++quickSpeechRequestId;
    const lang = qtAccentToggle?.textContent === 'UK' ? 'en-GB' : 'en-US';
    qtSpeakBtn.classList.add('playing');
    chrome.runtime.sendMessage({ action: 'speakText', text: word, lang }, response => {
      if (speechRequestId !== quickSpeechRequestId) return;
      if (response?.success) {
        qtSpeakBtn.classList.remove('playing');
        return;
      }
      speakWithBrowserVoice(word, lang, () => {
        if (speechRequestId === quickSpeechRequestId) qtSpeakBtn.classList.remove('playing');
      });
    });
  });

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

  // Save word to vocab
  qtAddBtn.addEventListener('click', () => {
    qtAddBtn.disabled = true;
    qtAddBtn.innerHTML = '<span class="ll-spin">…</span> Saving…';

    chrome.runtime.sendMessage({
      action: 'saveVocab',
      vocabData: {
        word: qtData.word,
        originalWord: qtData.originalWord,
        translation: qtData.translation,
        englishMeaning: qtData.englishMeaning || qtData.word,
        context: qtData.context || '',
        partOfSpeech: qtData.partOfSpeech || '',
        lemmaConfidence: qtData.lemmaConfidence || '',
        lemmaReason: qtData.lemmaReason || ''
      }
    }, response => {
      if (response?.success) {
        qtAddBtn.innerHTML = '✓ Added!';
        qtAddBtn.className = 'qt-add-btn success';
        // Update total count and gamification
        chrome.storage.local.get({ vocabList: [], userGamification: { xp: 0, level: 1 } }, data => {
          document.getElementById('total-words').textContent = data.vocabList.length;
          const gamer = data.userGamification || { xp: 0, level: 1 };
          const levelBadge = document.getElementById('popup-level-badge');
          const xpText = document.getElementById('popup-xp-text');
          if (levelBadge) levelBadge.textContent = `Lv. ${gamer.level || 1}`;
          if (xpText) xpText.textContent = `${gamer.xp || 0} XP`;
        });
      } else {
        qtAddBtn.innerHTML = response?.message || 'Already saved';
        qtAddBtn.className = 'qt-add-btn already';
      }
    });
  });

  // -- Open review page in new tab
  document.getElementById('open-review').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('review/review.html') });
  });

  // -- Open options page
  document.getElementById('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ── PDF Viewer button ──────────────────────────────────────────
  // Always open the viewer page directly — it has its own URL input dialog.
  // Query the active tab AT click time to avoid async race conditions.
  document.getElementById('open-pdf-btn').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      let viewerUrl = chrome.runtime.getURL('pdf-viewer/pdf-viewer.html');

      // If the current tab is already a PDF, pass it straight to the viewer
      if (tab && tab.url && tab.url.toLowerCase().endsWith('.pdf')) {
        viewerUrl += '?file=' + encodeURIComponent(tab.url);
      }
      // Otherwise open viewer with no file — user can paste path in the viewer's dialog

      chrome.tabs.create({ url: viewerUrl });
      window.close();
    });
  });
});

function normalizeWord(word) {
  return String(word || '').trim().toLowerCase().replace(/^[^a-z']+|[^a-z']+$/g, '');
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function applyPersonalization() {
  chrome.storage.local.get({ appName: '', customIconDataUrl: '' }, ({ appName, customIconDataUrl }) => {
    if (appName) {
      const logoText = document.querySelector('.logo-text');
      if (logoText) logoText.textContent = appName;
      document.title = appName;
    }
    const iconUrl = customIconDataUrl || '../assets/icons/icon48.png';
    const logoImg = document.querySelector('.logo-img');
    if (logoImg) logoImg.src = iconUrl;
    
    updateFavicon(iconUrl);
  });
}

function updateFavicon(url) {
  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.getElementsByTagName('head')[0].appendChild(link);
  }
  link.href = url;
}
