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


  chrome.storage.local.get({ vocabList: [] }, (data) => {
    const list = data.vocabList;

    // -- Total words
    document.getElementById('total-words').textContent = list.length;

    // -- Due count (same fix as review.js: missing nextReviewDate = due now)
    const now = new Date().getTime();
    const dueCount = list.filter(item => !item.nextReviewDate || item.nextReviewDate <= now).length;
    document.getElementById('due-words').textContent = dueCount;

    // -- Most recently added word
    if (list.length > 0) {
      const recent = [...list].sort((a, b) => b.dateAdded - a.dateAdded)[0];
      renderRecentWord(recent);
    }
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

function renderRecentWord(word) {
  const block = document.getElementById('recent-word-block');

  // Determine next review display
  const now = new Date().getTime();
  let reviewText = 'Due now';
  if (word.nextReviewDate && word.nextReviewDate > now) {
    reviewText = `Review: ${new Date(word.nextReviewDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  }

  block.innerHTML = `
    <div class="recent-word">
      ${escapeHtml(word.word)}
    </div>
    <div class="recent-meaning">
      <div class="meaning-row">
        <span class="lang-badge en">EN</span>
        <span class="meaning-text">${escapeHtml(word.englishMeaning || word.word)}</span>
      </div>
      <div class="meaning-row">
        <span class="lang-badge vi">VI</span>
        <span class="meaning-text vi-text">${escapeHtml(word.translation || '—')}</span>
      </div>
    </div>
    <div style="margin-top:10px; font-size:11px; color:#475569;">
      ${reviewText}
      ${word.context ? `<span style="margin-left:8px; font-style:italic; color:#334155;">"${escapeHtml(word.context.substring(0, 60))}${word.context.length > 60 ? '…' : ''}"</span>` : ''}
    </div>
  `;
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
