let fullVocabList = [];
let dueWords = [];
let sessionTotal = 0;      // total words at start of this session
let currentReviewIndex = 0;
let currentWord = null;
let reviewGateTimer = null;
let questionStartTime = 0; // timestamp when the current question was shown
let reviewSessionTimer = null;
let sessionOutcomeRecordedForCurrent = false;
const reviewSession = {
  startedAt: 0,
  answered: 0,
  correct: 0,
  mistakes: new Map(),
  lastOutcome: null
};
const storyStudy = {
  selectedWords: [],
  exploredWords: new Set(),
  fontScale: 1
};
let liveCoachSocket = null;
let liveCoachStream = null;
let liveCoachAudioContext = null;
let liveCoachSource = null;
let liveCoachProcessor = null;
let liveCoachPlaybackTime = 0;
let liveCoachStarted = false;
let liveCoachSetupComplete = false;
let coachClockTimer = null;
let liveCoachAiSpeakingUntil = 0;
let liveCoachNoiseFloor = 0.006;
let liveCoachActiveSpeechFrames = 0;
let liveCoachSilentFrames = 0;
let liveCoachLastAudioSentAt = 0;
let liveCoachPausedMusic = false;
const liveCoachPlaybackSources = new Set();
const LIVE_COACH_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const LIVE_COACH_INPUT_RATE = 16000;
const LIVE_COACH_MIN_RMS = 0.012;
const LIVE_COACH_STRONG_RMS = 0.075;
const LIVE_COACH_SILENCE_HOLD_FRAMES = 6;
const LIVE_COACH_AI_DUCK_SECONDS = 0.28;
const reviewAnswerSounds = {
  correct: createReviewSound('assets/musics/Right_answer.mp3'),
  wrong: createReviewSound('assets/musics/Wrong answer.mp3')
};

const VOCAB_IMAGE_FALLBACK_PREFIX = 'data:image/svg+xml;charset=UTF-8,';

function createReviewSound(path) {
  const url = chrome.runtime.getURL(path);
  const audio = new Audio(url);
  audio.preload = 'auto';
  audio.volume = 0.75;
  return audio;
}

function playReviewAnswerSound(isCorrect) {
  const sound = isCorrect ? reviewAnswerSounds.correct : reviewAnswerSounds.wrong;
  if (!sound) return;

  sound.pause();
  sound.currentTime = 0;
  sound.play().catch(error => {
    console.warn('Could not play review answer sound:', error);
  });
}

function isGeneratedVocabularyImage(url) {
  return String(url || '').startsWith(VOCAB_IMAGE_FALLBACK_PREFIX);
}

function hasRealVocabularyImage(wordObj) {
  return Boolean(wordObj?.imageUrl) && !isGeneratedVocabularyImage(wordObj.imageUrl);
}

document.addEventListener('DOMContentLoaded', init);

function init() {
  initThemeToggle();
  applyPersonalization();
  loadData();
  setupNavigation();
  initVocabFilters();
  initImportExport();
  initStatisticsView();
  initTypingQuizListeners();
  initTagsSystem();
  document.getElementById('back-to-vocab').addEventListener('click', () => switchView('vocab-view'));
  document.getElementById('generate-story-btn').addEventListener('click', handleGenerateStory);
  document.getElementById('generate-another-story-btn').addEventListener('click', handleGenerateStory);
  document.getElementById('story-max-words').addEventListener('input', updateStorySelection);
  document.getElementById('coach-start-btn').addEventListener('click', startNativeLiveCoach);
  document.getElementById('coach-stop-btn').addEventListener('click', stopNativeLiveCoach);
  document.getElementById('coach-clear-btn').addEventListener('click', clearNativeLiveCoach);
  document.getElementById('batch-delete-btn').addEventListener('click', deleteSelected);
  document.getElementById('next-question-btn').addEventListener('click', handleNextQuestionBtn);
  document.getElementById('summary-audio-btn').addEventListener('click', playSummaryAudio);
  document.getElementById('retry-mistakes-btn').addEventListener('click', startMistakeReview);
  document.addEventListener('keydown', handleReviewShortcuts);

  const summaryAccentToggle = document.getElementById('summary-accent-toggle');
  if (summaryAccentToggle) {
    summaryAccentToggle.addEventListener('click', () => {
      const current = summaryAccentToggle.textContent === 'US' ? 'UK' : 'US';
      summaryAccentToggle.textContent = current;
      chrome.storage.local.set({ preferredAccent: current });
    });
    chrome.storage.local.get({ preferredAccent: 'US' }, (data) => {
      summaryAccentToggle.textContent = data.preferredAccent;
    });
  }

  document.getElementById('gate-start-btn').addEventListener('click', () => startReview(true));
  document.getElementById('gate-shuffle-btn').addEventListener('click', shuffleReviewGateQueue);
  document.getElementById('gate-peek-btn').addEventListener('click', toggleReviewGatePeek);
  document.getElementById('gate-focus-btn').addEventListener('click', pulseReviewGate);
  document.getElementById('select-all-cb').addEventListener('change', e => {
    document.querySelectorAll('.row-cb').forEach(cb => { cb.checked = e.target.checked; });
    updateBatchDeleteBtn();
  });
  document.getElementById('vocab-table').addEventListener('change', e => {
    if (!e.target.classList.contains('row-cb')) return;
    updateBatchDeleteBtn();
    const all = document.querySelectorAll('.row-cb');
    const checked = document.querySelectorAll('.row-cb:checked');
    const selectAllCb = document.getElementById('select-all-cb');
    selectAllCb.indeterminate = checked.length > 0 && checked.length < all.length;
    selectAllCb.checked = all.length > 0 && checked.length === all.length;
  });
  initStoryTranslation();
  initMusicPlayer();
  initAiCoach();
  buildContextModal();

  // Listen for setting changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.vocabList) {
      syncVocabList(changes.vocabList.newValue || []);
    }
    if (area === 'local' && (changes.appName || changes.customIconDataUrl)) {
      applyPersonalization();
    }
    if (area === 'local' && changes.reviewTheme) {
      applyTheme(changes.reviewTheme.newValue || 'dark');
    }
  });
}

// ── Personalization ──

// Theme

function initThemeToggle() {
  chrome.storage.local.get({ reviewTheme: 'dark' }, items => {
    applyTheme(items.reviewTheme);
  });

  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;

  toggle.addEventListener('click', () => {
    const currentTheme = document.body.dataset.theme === 'light' ? 'light' : 'dark';
    const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(nextTheme);
    chrome.storage.local.set({ reviewTheme: nextTheme });
  });
}

function applyTheme(theme) {
  const normalizedTheme = theme === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = normalizedTheme;

  const toggle = document.getElementById('theme-toggle');
  const label = document.getElementById('theme-toggle-label');
  const icon = toggle?.querySelector('.theme-toggle-icon');
  const isLight = normalizedTheme === 'light';

  if (toggle) toggle.setAttribute('aria-pressed', String(isLight));
  if (label) label.textContent = isLight ? 'Dark mode' : 'Light mode';
  if (icon) icon.textContent = isLight ? '☾' : '☀';
}

function applyPersonalization() {
  chrome.storage.local.get({ appName: 'GermanyVocab', customIconDataUrl: '' }, (items) => {
    const name = items.appName || 'GermanyVocab';

    // Update text elements
    document.title = `${name} - Vocab & Review`;
    const logoText = document.querySelector('.logo-text');
    if (logoText) logoText.textContent = name;

    // Update logo images
    const logoImg = document.querySelector('.logo-img');
    if (logoImg) {
      logoImg.src = items.customIconDataUrl || '../assets/icons/icon48.png';
    }

    // Update favicon
    updateFavicon(items.customIconDataUrl || '../assets/icons/icon48.png');
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

// ── Music Player ──────────────────────────────────────────────

function initMusicPlayer() {
  const audio = document.getElementById('bg-audio');
  const toggle = document.getElementById('music-toggle');
  const icon = document.getElementById('music-icon');
  const bar = document.getElementById('music-progress');
  const vol = document.getElementById('music-vol');
  const closeBtn = document.getElementById('music-close');
  const player = document.getElementById('music-player');
  const trackSelect = document.getElementById('music-track-select');
  const title = document.getElementById('music-title');

  if (!audio) return;

  const tracks = window.GV_MUSIC_TRACKS || [];
  const defaultTrack = window.GV_DEFAULT_MUSIC_TRACK || tracks[0] || { id: 'default', title: 'Background Music', src: '../assets/musics/music.mp3' };

  if (trackSelect) {
    trackSelect.innerHTML = '';
    tracks.forEach(track => {
      const option = document.createElement('option');
      option.value = track.id;
      option.textContent = track.title;
      trackSelect.appendChild(option);
    });
  }

  function applyTrack(trackId, shouldKeepPlaying = false) {
    const track = typeof gvFindMusicTrack === 'function' ? gvFindMusicTrack(trackId) : defaultTrack;
    const wasPlaying = shouldKeepPlaying && !audio.paused;

    if (!audio.src.endsWith(track.src.replace('../', ''))) {
      audio.src = track.src;
      audio.load();
    }

    if (title) title.textContent = track.title;
    if (trackSelect) trackSelect.value = track.id;
    bar.style.width = '0%';

    if (wasPlaying) {
      audio.play().catch(() => { });
    }
  }

  chrome.storage.local.get({
    backgroundMusicTrack: defaultTrack.id,
    backgroundMusicVolume: parseFloat(vol.value)
  }, items => {
    applyTrack(items.backgroundMusicTrack);
    audio.volume = Number(items.backgroundMusicVolume);
    vol.value = String(audio.volume);
  });

  // Auto-play on load (browsers require a user gesture first; retry on any interaction)
  const tryAutoPlay = () => {
    audio.play().then(() => {
      icon.textContent = '⏸';
      toggle.classList.add('playing');
      document.removeEventListener('click', tryAutoPlay);
      document.removeEventListener('keydown', tryAutoPlay);
    }).catch(() => { });
  };
  tryAutoPlay();
  document.addEventListener('click', tryAutoPlay, { once: true });
  document.addEventListener('keydown', tryAutoPlay, { once: true });

  // Play / Pause
  toggle.addEventListener('click', () => {
    if (audio.paused) {
      audio.play().then(() => {
        icon.textContent = '⏸';
        toggle.classList.add('playing');
      }).catch(() => { });
    } else {
      audio.pause();
      icon.textContent = '▶';
      toggle.classList.remove('playing');
    }
  });

  // Volume
  vol.addEventListener('input', () => {
    audio.volume = parseFloat(vol.value);
    chrome.storage.local.set({ backgroundMusicVolume: audio.volume });
  });

  if (trackSelect) {
    trackSelect.addEventListener('change', () => {
      applyTrack(trackSelect.value, true);
      chrome.storage.local.set({ backgroundMusicTrack: trackSelect.value });
    });
  }

  // Progress bar
  audio.addEventListener('timeupdate', () => {
    if (audio.duration) {
      const pct = (audio.currentTime / audio.duration) * 100;
      bar.style.width = `${pct}%`;
    }
  });

  // Close / hide player
  closeBtn.addEventListener('click', () => {
    audio.pause();
    player.classList.add('hidden');
  });
}

// ── Navigation ──────────────────────────────────────────────

function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-links li');
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      navItems.forEach(n => n.classList.remove('active'));
      e.currentTarget.classList.add('active');

      const targetId = e.currentTarget.getAttribute('data-target');
      switchView(targetId);

      if (targetId === 'review-view') {
        showReviewGate();
      } else if (targetId === 'stats-view') {
        renderStatistics();
        stopReviewGateTimer();
      } else {
        stopReviewGateTimer();
      }
    });
  });
}

function switchView(viewId) {
  // BUG FIX: only use .active to show/hide views — never rely on .hidden on sections
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');

  // Sync nav highlight
  document.querySelectorAll('.nav-links li').forEach(n => {
    n.classList.toggle('active', n.getAttribute('data-target') === viewId);
  });

  if (viewId !== 'review-view') stopReviewSessionTimer();
}

// ── Data Loading ─────────────────────────────────────────────

function loadData() {
  chrome.storage.local.get({ vocabList: [] }, (data) => {
    fullVocabList = data.vocabList;
    cleanupGeneratedVocabularyImages();
    renderVocabTable();
    prepareReviewSession();
    renderStoryWordList();
    backfillPartOfSpeech();
    renderStatistics();
  });
}

function cleanupGeneratedVocabularyImages() {
  let changed = false;
  fullVocabList.forEach(item => {
    if (isGeneratedVocabularyImage(item.imageUrl)) {
      item.imageUrl = '';
      changed = true;
    }
  });

  if (changed) {
    updateStoredVocabList(list => {
      list.forEach(item => {
        if (isGeneratedVocabularyImage(item.imageUrl)) item.imageUrl = '';
      });
      return list;
    });
  }
}

// ── Vocabulary Table & Filters ───────────────────────────────

let vocabSearchQuery = '';
let vocabMasteryFilter = 'all';
let vocabPosFilter = 'all';
let vocabSortBy = 'date-desc';
let vocabTagFilter = 'all';
let reviewGateTagFilter = 'all';

function initVocabFilters() {
  const searchInput = document.getElementById('vocab-search-input');
  const clearBtn = document.getElementById('vocab-search-clear');
  const masterySelect = document.getElementById('filter-mastery');
  const posSelect = document.getElementById('filter-pos');
  const sortSelect = document.getElementById('filter-sort');
  const tagSelect = document.getElementById('filter-tag');

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      vocabSearchQuery = searchInput.value.trim().toLowerCase();
      if (clearBtn) clearBtn.classList.toggle('hidden', !vocabSearchQuery);
      renderVocabTable();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      vocabSearchQuery = '';
      clearBtn.classList.add('hidden');
      renderVocabTable();
    });
  }

  if (masterySelect) {
    masterySelect.addEventListener('change', () => {
      vocabMasteryFilter = masterySelect.value;
      renderVocabTable();
    });
  }

  if (posSelect) {
    posSelect.addEventListener('change', () => {
      vocabPosFilter = posSelect.value;
      renderVocabTable();
    });
  }

  if (tagSelect) {
    tagSelect.addEventListener('change', () => {
      vocabTagFilter = tagSelect.value;
      renderVocabTable();
    });
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      vocabSortBy = sortSelect.value;
      renderVocabTable();
    });
  }
}

function renderVocabTable() {
  const tbody = document.querySelector('#vocab-table tbody');
  const emptyState = document.getElementById('empty-state');
  const vocabTable = document.getElementById('vocab-table');

  tbody.innerHTML = '';

  updateTagFilterDropdowns();

  let filtered = [...fullVocabList];

  // 1. Search Query Filter
  if (vocabSearchQuery) {
    filtered = filtered.filter(item => {
      const w = String(item.word || '').toLowerCase();
      const vi = String(item.translation || '').toLowerCase();
      const en = String(item.englishMeaning || '').toLowerCase();
      const ctx = String(item.context || '').toLowerCase();
      const tagsStr = Array.isArray(item.tags) ? item.tags.join(' ').toLowerCase() : '';
      return w.includes(vocabSearchQuery) || vi.includes(vocabSearchQuery) || en.includes(vocabSearchQuery) || ctx.includes(vocabSearchQuery) || tagsStr.includes(vocabSearchQuery);
    });
  }

  // 2. Mastery Filter
  if (vocabMasteryFilter !== 'all') {
    filtered = filtered.filter(item => {
      const rep = item.repetition || 0;
      if (vocabMasteryFilter === '0') return rep === 0;
      if (vocabMasteryFilter === '1') return rep === 1;
      if (vocabMasteryFilter === '2') return rep === 2;
      if (vocabMasteryFilter === '3') return rep === 3;
      if (vocabMasteryFilter === '4+') return rep >= 4;
      return true;
    });
  }

  // 3. POS Filter
  if (vocabPosFilter !== 'all') {
    filtered = filtered.filter(item => {
      const pos = String(item.partOfSpeech || '').toLowerCase();
      if (vocabPosFilter === 'other') {
        return !['noun', 'verb', 'adjective', 'adverb'].includes(pos);
      }
      return pos === vocabPosFilter;
    });
  }

  // 4. Tag Filter
  if (vocabTagFilter !== 'all') {
    filtered = filtered.filter(item => {
      return Array.isArray(item.tags) && item.tags.includes(vocabTagFilter);
    });
  }

  // 4. Sort
  filtered.sort((a, b) => {
    switch (vocabSortBy) {
      case 'date-asc': return (a.dateAdded || 0) - (b.dateAdded || 0);
      case 'alpha-asc': return String(a.word || '').localeCompare(String(b.word || ''));
      case 'alpha-desc': return String(b.word || '').localeCompare(String(a.word || ''));
      case 'review-asc': return (a.nextReviewDate || 0) - (b.nextReviewDate || 0);
      case 'mastery-desc': return (b.repetition || 0) - (a.repetition || 0);
      case 'date-desc':
      default: return (b.dateAdded || 0) - (a.dateAdded || 0);
    }
  });

  // Update subtitle
  const statsSub = document.getElementById('vocab-stats-sub');
  if (statsSub) {
    const dueCount = fullVocabList.filter(item => !item.nextReviewDate || item.nextReviewDate <= Date.now()).length;
    if (filtered.length !== fullVocabList.length) {
      statsSub.textContent = `Showing ${filtered.length} of ${fullVocabList.length} words (${dueCount} due today)`;
    } else {
      statsSub.textContent = `${fullVocabList.length} words collected (${dueCount} due for review today)`;
    }
  }

  if (fullVocabList.length === 0) {
    emptyState.classList.remove('hidden');
    vocabTable.classList.add('hidden');
    const emptyTitle = document.getElementById('empty-title');
    const emptyDesc = document.getElementById('empty-desc');
    if (emptyTitle) emptyTitle.textContent = "No words yet!";
    if (emptyDesc) emptyDesc.textContent = "Select any English word on a website to start building your vocabulary.";
    return;
  }

  if (filtered.length === 0) {
    emptyState.classList.remove('hidden');
    vocabTable.classList.add('hidden');
    const emptyTitle = document.getElementById('empty-title');
    const emptyDesc = document.getElementById('empty-desc');
    if (emptyTitle) emptyTitle.textContent = "No matching words found";
    if (emptyDesc) emptyDesc.textContent = "Try changing your search terms or resetting the filters.";
    return;
  }

  emptyState.classList.add('hidden');
  vocabTable.classList.remove('hidden');

  const sorted = filtered;

  sorted.forEach(item => {
    const tr = document.createElement('tr');
    const now = new Date().getTime();

    let nextReviewHtml;
    if (!item.nextReviewDate || item.nextReviewDate <= now) {
      nextReviewHtml = `<span class="review-date-now">Due now</span>`;
    } else {
      const dateStr = new Date(item.nextReviewDate).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric'
      });
      nextReviewHtml = `<span class="review-date-future">${dateStr}</span>`;
    }

    const enMeaning = escapeHtml(item.englishMeaning || '—');
    const viTranslation = escapeHtml(item.translation || '—');
    const context = item.context || '';

    // Part-of-speech badge
    const pos = (item.partOfSpeech || '').toLowerCase();
    const posBadgeMap = {
      noun: { label: 'noun', cls: 'pos-noun' },
      verb: { label: 'verb', cls: 'pos-verb' },
      adjective: { label: 'adj', cls: 'pos-adj' },
      adverb: { label: 'adv', cls: 'pos-adv' },
      pronoun: { label: 'pron', cls: 'pos-pron' },
      preposition: { label: 'prep', cls: 'pos-prep' },
      conjunction: { label: 'conj', cls: 'pos-conj' },
      interjection: { label: 'interj', cls: 'pos-interj' },
    };
    const badge = posBadgeMap[pos];
    const posBadgeHtml = badge
      ? `<span class="pos-badge ${badge.cls}">${badge.label}</span>`
      : (pos ? `<span class="pos-badge pos-other">${pos}</span>` : '<span class="pos-badge pos-unknown">—</span>');

    const repetition = item.repetition || 0;
    let masteryClass = 'mastery-0';
    let masteryLabel = 'New';
    if (repetition === 1) { masteryClass = 'mastery-1'; masteryLabel = 'Learning'; }
    else if (repetition === 2) { masteryClass = 'mastery-2'; masteryLabel = 'Familiar'; }
    else if (repetition === 3) { masteryClass = 'mastery-3'; masteryLabel = 'Known'; }
    else if (repetition >= 4) { masteryClass = 'mastery-4'; masteryLabel = 'Mastered'; }

    const masteryHtml = `<span class="mastery-badge ${masteryClass}">${masteryLabel}</span>`;

    const tags = Array.isArray(item.tags) ? item.tags : [];
    const tagsHtml = tags.length > 0
      ? `<div class="word-tags-row">${tags.map(t => `<span class="tag-pill">#${escapeHtml(t)}</span>`).join('')}</div>`
      : '';

    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="row-cb" data-id="${escapeHtml(item.id)}"></td>
      <td>
        <a href="#" class="vocab-word-link" data-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.word)}</strong></a>${posBadgeHtml}
        ${tagsHtml}
      </td>
      <td class="en-meaning-cell" title="${enMeaning}">${enMeaning}</td>
      <td class="vi-cell">${viTranslation}</td>
      <td class="context-cell">
        <span class="ctx-text" title="${escapeHtml(context)}">${context ? escapeHtml(context) : '—'}</span>
        <button class="btn sm outline edit-ctx-btn" data-id="${escapeHtml(item.id)}" title="Edit context">✏ Edit</button>
      </td>
      <td>${masteryHtml}</td>
      <td>${nextReviewHtml}</td>
      <td>
        <button class="btn sm outline tag-edit-btn" data-id="${escapeHtml(item.id)}" title="Manage tags">🏷 Tag</button>
        <button class="btn sm outline youglish-btn" data-word="${escapeHtml(item.word)}" title="Open this word on YouGlish">YouGlish</button>
        <button class="btn sm danger delete-btn" data-id="${escapeHtml(item.id)}">🗑 Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', deleteWord);
  });
  document.querySelectorAll('.edit-ctx-btn').forEach(btn => {
    btn.addEventListener('click', openContextModal);
  });
  document.querySelectorAll('.tag-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      openTagModal(e.currentTarget.getAttribute('data-id'));
    });
  });
  document.querySelectorAll('.youglish-btn').forEach(btn => {
    btn.addEventListener('click', openYouGlish);
  });
  document.querySelectorAll('.vocab-word-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showWordDetails(e.currentTarget.getAttribute('data-id'));
    });
  });

  const selectAllCb = document.getElementById('select-all-cb');
  if (selectAllCb) { selectAllCb.checked = false; selectAllCb.indeterminate = false; }
  updateBatchDeleteBtn();
}

function deleteWord(e) {
  const id = e.target.getAttribute('data-id');
  if (confirm('Delete this word from your vocabulary?')) {
    // BUG FIX: convert both sides to string to avoid number/string mismatch
    updateStoredVocabList(list => list.filter(w => String(w.id) !== id)).then(() => {
      loadData();
    });
  }
}

function openYouGlish(e) {
  const word = String(e.currentTarget.getAttribute('data-word') || '').trim();
  if (!word) return;

  const url = `https://youglish.com/pronounce/${encodeURIComponent(word)}/english`;
  chrome.tabs.create({ url });
}

// ── Context Modal ─────────────────────────────────────────────

function buildContextModal() {
  const modal = document.createElement('div');
  modal.id = 'ctx-modal';
  modal.innerHTML = `
    <div class="ctx-modal-backdrop" id="ctx-backdrop"></div>
    <div class="ctx-modal-box">
      <div class="ctx-modal-header">
        <span class="ctx-modal-title">✏ Edit Context</span>
        <button class="ctx-modal-close" id="ctx-modal-close">✕</button>
      </div>
      <p class="ctx-modal-hint">Provide a sentence or phrase that helps you remember this word in context.</p>
      <textarea id="ctx-textarea" class="ctx-textarea" rows="4" maxlength="300" placeholder="e.g. She gave an eloquent speech that moved everyone in the room."></textarea>
      <div class="ctx-char-count"><span id="ctx-char-count">0</span> / 300</div>
      <div class="ctx-modal-actions">
        <button class="btn outline" id="ctx-cancel-btn">Cancel</button>
        <button class="btn primary" id="ctx-save-btn">💾 Save Context</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('ctx-modal-close').addEventListener('click', closeContextModal);
  document.getElementById('ctx-cancel-btn').addEventListener('click', closeContextModal);
  document.getElementById('ctx-backdrop').addEventListener('click', closeContextModal);
  document.getElementById('ctx-save-btn').addEventListener('click', saveContext);
  document.getElementById('ctx-textarea').addEventListener('input', () => {
    const len = document.getElementById('ctx-textarea').value.length;
    document.getElementById('ctx-char-count').textContent = len;
  });
}

let editingWordId = null;

function openContextModal(e) {
  editingWordId = e.currentTarget.getAttribute('data-id');
  const word = fullVocabList.find(w => String(w.id) === editingWordId);
  if (!word) return;

  const textarea = document.getElementById('ctx-textarea');
  textarea.value = word.context || '';
  document.getElementById('ctx-char-count').textContent = textarea.value.length;

  document.getElementById('ctx-modal').classList.add('open');
  textarea.focus();
}

function closeContextModal() {
  document.getElementById('ctx-modal').classList.remove('open');
  editingWordId = null;
}

function saveContext() {
  if (!editingWordId) return;
  const newContext = document.getElementById('ctx-textarea').value.trim();
  const idx = fullVocabList.findIndex(w => String(w.id) === editingWordId);
  if (idx !== -1) {
    persistVocabularyWord(fullVocabList[idx], { context: newContext }).then(() => {
      closeContextModal();
      renderVocabTable();
    });
  }
}

// ── Badge ─────────────────────────────────────────────────────

function updateBadge() {
  const now = new Date().getTime();
  // BUG FIX: words missing nextReviewDate are immediately due
  const count = fullVocabList.filter(item => !item.nextReviewDate || item.nextReviewDate <= now).length;
  const badge = document.getElementById('due-badge');
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-block' : 'none';
}

// ── Review Session ────────────────────────────────────────────

function prepareReviewSession() {
  const now = new Date().getTime();
  let pool = fullVocabList.filter(item => !item.nextReviewDate || item.nextReviewDate <= now);

  if (reviewGateTagFilter !== 'all') {
    pool = pool.filter(item => Array.isArray(item.tags) && item.tags.includes(reviewGateTagFilter));
  }

  dueWords = pool;
  dueWords.sort(() => Math.random() - 0.5);

  updateBadge();
}

function showReviewGate() {
  prepareReviewSession();
  stopReviewGateTimer();
  stopReviewSessionTimer();
  currentReviewIndex = 0;
  sessionTotal = dueWords.length;
  updateProgressRing(0, sessionTotal);

  document.getElementById('review-gate').classList.remove('hidden');
  document.getElementById('review-container').classList.add('hidden');
  document.getElementById('review-summary-panel').classList.add('hidden');
  document.getElementById('review-complete').classList.add('hidden');
  document.getElementById('review-session-bar').classList.add('hidden');
  document.querySelectorAll('.question-block').forEach(el => el.classList.add('hidden'));

  renderReviewGate();
  reviewGateTimer = setInterval(renderReviewGate, 1000);
}

function renderReviewGate() {
  const now = Date.now();
  let pool = fullVocabList.filter(item => !item.nextReviewDate || item.nextReviewDate <= now);
  if (reviewGateTagFilter !== 'all') {
    pool = pool.filter(item => Array.isArray(item.tags) && item.tags.includes(reviewGateTagFilter));
  }
  const dueCount = pool.length;
  const futureReviews = fullVocabList
    .filter(item => item.nextReviewDate && item.nextReviewDate > now)
    .sort((a, b) => a.nextReviewDate - b.nextReviewDate);
  const nextReviewDate = futureReviews[0]?.nextReviewDate || null;

  const dueEl = document.getElementById('gate-due-count');
  const timeEl = document.getElementById('gate-next-time');
  const titleEl = document.getElementById('gate-title');
  const subtitleEl = document.getElementById('gate-subtitle');
  const startBtn = document.getElementById('gate-start-btn');
  const progressEl = document.getElementById('review-progress');

  dueEl.textContent = dueCount;
  startBtn.disabled = dueCount === 0;

  if (dueCount !== dueWords.length) {
    dueWords = pool;
    updateBadge();
  }

  if (dueCount > 0) {
    titleEl.textContent = `${dueCount} word${dueCount === 1 ? '' : 's'} ready`;
    subtitleEl.textContent = 'Your review queue is open. Start now or warm up first.';
    timeEl.textContent = nextReviewDate ? formatTimeLeft(nextReviewDate - now) : 'No later queue';
    progressEl.textContent = `${dueCount} ready to review`;
  } else {
    titleEl.textContent = 'No words due right now';
    subtitleEl.textContent = nextReviewDate
      ? 'The next review section unlocks when your next word becomes due.'
      : 'Save more words from a webpage to create your next review queue.';
    timeEl.textContent = nextReviewDate ? formatTimeLeft(nextReviewDate - now) : '--';
    progressEl.textContent = '0 left today';
  }

  updateReviewGatePeek();
}

function stopReviewGateTimer() {
  if (reviewGateTimer) {
    clearInterval(reviewGateTimer);
    reviewGateTimer = null;
  }
}

function formatTimeLeft(ms) {
  if (ms <= 0) return 'Ready now';
  const totalSeconds = Math.ceil(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function shuffleReviewGateQueue() {
  prepareReviewSession();
  document.getElementById('gate-play-message').textContent =
    dueWords.length > 1 ? 'Queue shuffled. The next question order will feel less predictable.' : 'Add more due words to make shuffling useful.';
  updateReviewGatePeek();
}

function toggleReviewGatePeek() {
  const list = document.getElementById('gate-peek-list');
  list.classList.toggle('hidden');
  document.getElementById('gate-peek-btn').textContent = list.classList.contains('hidden') ? 'Peek Words' : 'Hide Peek';
  document.getElementById('gate-play-message').textContent = list.classList.contains('hidden')
    ? 'Queue preview tucked away.'
    : 'Previewing the first few due words. No answers spoiled.';
  updateReviewGatePeek();
}

function updateReviewGatePeek() {
  const list = document.getElementById('gate-peek-list');
  if (!list || list.classList.contains('hidden')) return;

  const words = dueWords.slice(0, 12);
  if (words.length === 0) {
    list.innerHTML = '<span class="gate-chip muted">No due words yet</span>';
    return;
  }

  list.innerHTML = words
    .map(item => `<span class="gate-chip">${escapeHtml(item.word || '')}</span>`)
    .join('');
}

function pulseReviewGate() {
  const gate = document.getElementById('review-gate');
  gate.classList.remove('pulse');
  void gate.offsetWidth;
  gate.classList.add('pulse');
  document.getElementById('gate-play-message').textContent = 'Focus pulse armed. Take a breath, then start when ready.';
}

function resetReviewSessionMetrics() {
  reviewSession.startedAt = Date.now();
  reviewSession.answered = 0;
  reviewSession.correct = 0;
  reviewSession.mistakes.clear();
  reviewSession.lastOutcome = null;
  const bar = document.getElementById('review-session-bar');
  bar?.classList.remove('hidden');
  startReviewSessionTimer();
  updateReviewSessionBar();
}

function startReviewSessionTimer() {
  stopReviewSessionTimer();
  reviewSessionTimer = setInterval(updateReviewSessionBar, 1000);
}

function stopReviewSessionTimer() {
  if (reviewSessionTimer) {
    clearInterval(reviewSessionTimer);
    reviewSessionTimer = null;
  }
}

function formatSessionDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function updateReviewSessionBar() {
  const answeredEl = document.getElementById('session-answered');
  const accuracyEl = document.getElementById('session-accuracy');
  const timeEl = document.getElementById('session-time');
  const focusEl = document.getElementById('session-focus');
  const total = Math.max(sessionTotal, reviewSession.answered);
  if (answeredEl) answeredEl.textContent = `${reviewSession.answered}/${total}`;
  if (accuracyEl) accuracyEl.textContent = reviewSession.answered
    ? `${Math.round((reviewSession.correct / reviewSession.answered) * 100)}%`
    : '—';
  if (timeEl) timeEl.textContent = formatSessionDuration(Date.now() - reviewSession.startedAt);
  if (focusEl) {
    focusEl.textContent = reviewSession.mistakes.size
      ? `${reviewSession.mistakes.size} to revisit`
      : (reviewSession.answered ? 'On track' : 'New session');
  }
}

function recordCurrentSessionOutcome(isCorrect) {
  if (sessionOutcomeRecordedForCurrent || !currentWord) return;
  sessionOutcomeRecordedForCurrent = true;
  reviewSession.answered++;
  if (isCorrect) {
    reviewSession.correct++;
    reviewSession.mistakes.delete(String(currentWord.id));
  } else {
    reviewSession.mistakes.set(String(currentWord.id), currentWord);
  }
  reviewSession.lastOutcome = { isCorrect, word: currentWord.word };
  updateReviewSessionBar();
}

function renderReviewComplete() {
  stopReviewSessionTimer();
  updateReviewSessionBar();
  document.getElementById('review-session-bar')?.classList.toggle('hidden', reviewSession.answered === 0);
  const completeMessage = document.getElementById('review-complete-message');
  const statsEl = document.getElementById('review-complete-stats');
  const retryBtn = document.getElementById('retry-mistakes-btn');
  const hasAnswers = reviewSession.answered > 0;
  const accuracy = reviewSession.answered
    ? Math.round((reviewSession.correct / reviewSession.answered) * 100)
    : 0;

  if (hasAnswers) {
    addGamificationXP(30, 'Completed review session');
  }

  if (completeMessage) {
    completeMessage.textContent = hasAnswers
      ? (reviewSession.mistakes.size ? 'Nice work. Finish with a short error-correction round to lock in the difficult words.' : 'Clean session. Your recall was consistent today.')
      : 'You have no words due right now. Add words or return when the next review opens.';
  }
  if (statsEl) {
    statsEl.classList.toggle('hidden', !hasAnswers);
    statsEl.innerHTML = hasAnswers
      ? `<span><strong>${reviewSession.answered}</strong> reviewed</span><span><strong>${accuracy}%</strong> accuracy</span><span><strong>${formatSessionDuration(Date.now() - reviewSession.startedAt)}</strong> focused</span>`
      : '';
  }
  if (retryBtn) retryBtn.classList.toggle('hidden', reviewSession.mistakes.size === 0);
}

function startMistakeReview() {
  const mistakes = [...reviewSession.mistakes.values()];
  if (!mistakes.length) return;
  dueWords = mistakes;
  currentReviewIndex = 0;
  sessionTotal = dueWords.length;
  sessionOutcomeRecordedForCurrent = false;
  document.getElementById('review-complete').classList.add('hidden');
  resetReviewSessionMetrics();
  renderNextQuestion();
}

function handleReviewShortcuts(event) {
  if (!document.getElementById('review-view')?.classList.contains('active')) return;
  if (event.target.matches('input, textarea, select, button')) return;
  if (/^[1-4]$/.test(event.key)) {
    const options = [...document.querySelectorAll('.question-block:not(.hidden) .mcq-btn:not(:disabled)')];
    const option = options[Number(event.key) - 1];
    if (option) option.click();
  }
}

function startReview(usePreparedQueue = false) {
  if (!usePreparedQueue) {
    prepareReviewSession();
  }
  currentReviewIndex = 0;
  sessionTotal = dueWords.length;
  stopReviewGateTimer();
  resetReviewSessionMetrics();

  updateProgressRing(0, sessionTotal);
  document.getElementById('review-gate').classList.add('hidden');

  if (dueWords.length === 0) {
    document.getElementById('review-container').classList.add('hidden');
    document.getElementById('review-complete').classList.remove('hidden');
    document.getElementById('review-progress').textContent = '0 left today';
    renderReviewComplete();
    return;
  }

  document.getElementById('review-container').classList.remove('hidden');
  document.getElementById('review-complete').classList.add('hidden');
  renderNextQuestion();
}

function renderNextQuestion() {
  if (currentReviewIndex >= dueWords.length) {
    document.getElementById('review-container').classList.add('hidden');
    document.getElementById('review-complete').classList.remove('hidden');
    document.getElementById('review-gate').classList.add('hidden');
    updateProgressRing(sessionTotal, sessionTotal);
    renderReviewComplete();
    return;
  }

  document.getElementById('review-container').classList.remove('hidden');
  document.getElementById('review-gate').classList.add('hidden');
  questionStartTime = Date.now();
  sessionOutcomeRecordedForCurrent = false;

  currentWord = dueWords[currentReviewIndex];
  preloadUpcomingReviewImages(currentReviewIndex + 1);
  const remaining = dueWords.length - currentReviewIndex;
  document.getElementById('review-progress').textContent =
    `${remaining} word${remaining !== 1 ? 's' : ''} left today`;

  updateProgressRing(currentReviewIndex, sessionTotal);

  document.querySelectorAll('.question-block').forEach(el => el.classList.add('hidden'));

  const rep = currentWord.repetition || 0;
  let type = 'mcq';

  if (rep === 1) {
    if (hasRealVocabularyImage(currentWord)) {
      type = 'picture';
    } else {
      fetchMissingMedia(currentWord);
    }
  }
  else if (rep === 2 && fullVocabList.length >= 4) type = 'match';
  else if (rep === 3) {
    if (Math.random() > 0.4) type = 'typing';
    else if (hasCollocations(currentWord)) type = 'collocation';
    else if (hasSynonymsOrAntonyms(currentWord)) type = 'synonym';
  }
  else if (rep >= 4) {
    const roll = Math.random();
    if (roll < 0.4) type = 'typing';
    else if (roll < 0.7 && hasCollocations(currentWord)) type = 'collocation';
    else type = 'sentence';
  }

  switch (type) {
    case 'mcq': renderMCQ(); break;
    case 'picture': renderPicture(); break;
    case 'match': renderMatch(); break;
    case 'synonym': renderSynonym(); break;
    case 'collocation': renderCollocation(); break;
    case 'sentence': renderSentence(); break;
    case 'typing': renderTypingQuestion(); break;
  }
}

function preloadUpcomingReviewImages(startIndex) {
  dueWords.slice(startIndex, startIndex + 3)
    .filter(hasRealVocabularyImage)
    .forEach(wordObj => {
      const preload = new Image();
      preload.decoding = 'async';
      preload.src = wordObj.imageUrl;
    });
}

// ── Question Renderers ────────────────────────────────────────

function renderMCQ() {
  document.getElementById('qt-mcq').classList.remove('hidden');
  const isReverse = Math.random() > 0.5;
  const container = document.getElementById('qt-mcq-options');
  container.innerHTML = '';

  let options = [];
  let distractors = [];
  let correctText = '';

  if (isReverse) {
    document.getElementById('qt-mcq-label').textContent = "Which word matches this meaning?";
    document.getElementById('qt-mcq-word').textContent = currentWord.translation;
    document.getElementById('qt-mcq-context').textContent = '';

    correctText = currentWord.word;
    options = [correctText];
    distractors = fullVocabList.filter(w => w.id !== currentWord.id).map(w => w.word);
    const dummy = ['apple', 'school', 'computer', 'happy', 'work', 'beautiful', 'fast', 'sad', 'smart', 'free'];
    distractors = [...distractors, ...dummy].sort(() => Math.random() - 0.5);
  } else {
    document.getElementById('qt-mcq-label').textContent = "What does this mean?";
    document.getElementById('qt-mcq-word').textContent = currentWord.word;
    document.getElementById('qt-mcq-context').textContent =
      currentWord.context ? `"${currentWord.context.substring(0, 120)}${currentWord.context.length > 120 ? '…' : ''}"` : '';

    correctText = currentWord.translation;
    options = [correctText];
    distractors = fullVocabList.filter(w => w.id !== currentWord.id).map(w => w.translation);
    const dummy = ['quả táo', 'đi học', 'máy tính', 'hạnh phúc', 'công việc', 'xinh đẹp', 'nhanh nhẹn', 'buồn bã', 'thông minh', 'tự do'];
    distractors = [...distractors, ...dummy].sort(() => Math.random() - 0.5);
  }

  for (const d of distractors) {
    if (options.length >= 4) break;
    if (!options.includes(d)) options.push(d);
  }
  options.sort(() => Math.random() - 0.5);

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'mcq-btn';
    btn.textContent = opt;
    btn.onclick = () => handleAnswer(opt === correctText, btn, '#qt-mcq-options .mcq-btn', correctText);
    container.appendChild(btn);
  });
}

function renderPicture() {
  document.getElementById('qt-picture').classList.remove('hidden');
  const img = document.getElementById('qt-picture-img');
  img.onerror = () => {
    img.onerror = null;
    persistVocabularyWord(currentWord, { imageUrl: '' });
    document.getElementById('qt-picture').classList.add('hidden');
    renderMCQ();
  };
  img.decoding = 'async';
  img.src = currentWord.imageUrl;

  const container = document.getElementById('qt-picture-options');
  container.innerHTML = '';

  let distractors = fullVocabList.filter(w => w.id !== currentWord.id).map(w => w.word);
  const dummy = ['apple', 'school', 'computer', 'happy', 'work', 'beautiful', 'fast', 'sad', 'smart', 'free'];
  distractors = [...distractors, ...dummy].sort(() => Math.random() - 0.5);

  let options = [currentWord.word];
  for (const d of distractors) {
    if (options.length >= 4) break;
    if (!options.includes(d)) options.push(d);
  }
  options.sort(() => Math.random() - 0.5);

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'mcq-btn';
    btn.textContent = opt;
    btn.onclick = () => handleAnswer(opt === currentWord.word, btn, '#qt-picture-options .mcq-btn', currentWord.word);
    container.appendChild(btn);
  });
}

function renderSynonym() {
  document.getElementById('qt-synonym').classList.remove('hidden');

  const useSyn = currentWord.synonyms && currentWord.synonyms.length > 0;
  const useAnt = currentWord.antonyms && currentWord.antonyms.length > 0;

  let mode = 'synonym';
  if (useSyn && useAnt) mode = Math.random() > 0.5 ? 'synonym' : 'antonym';
  else if (useAnt) mode = 'antonym';

  document.getElementById('qt-synonym-label').textContent = `Choose a ${mode} for:`;
  document.getElementById('qt-synonym-word').textContent = currentWord.word;

  const correctAns = mode === 'synonym' ? currentWord.synonyms[0] : currentWord.antonyms[0];
  const container = document.getElementById('qt-synonym-options');
  container.innerHTML = '';

  let distractors = fullVocabList.filter(w => w.id !== currentWord.id).map(w => w.word);
  const dummy = ['apple', 'school', 'computer', 'happy', 'work', 'beautiful', 'fast', 'sad', 'smart', 'free'];
  distractors = [...distractors, ...dummy].sort(() => Math.random() - 0.5);

  let options = [correctAns];
  for (const d of distractors) {
    if (options.length >= 4) break;
    if (!options.includes(d) && !currentWord.synonyms?.includes(d) && !currentWord.antonyms?.includes(d)) options.push(d);
  }
  options.sort(() => Math.random() - 0.5);

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'mcq-btn';
    btn.textContent = opt;
    btn.onclick = () => handleAnswer(opt === correctAns, btn, '#qt-synonym-options .mcq-btn', correctAns);
    container.appendChild(btn);
  });
}

function hasSynonymsOrAntonyms(wordObj) {
  return (Array.isArray(wordObj.synonyms) && wordObj.synonyms.length > 0)
    || (Array.isArray(wordObj.antonyms) && wordObj.antonyms.length > 0);
}

function hasCollocations(wordObj) {
  return Array.isArray(wordObj?.collocations) && wordObj.collocations.length > 0;
}

function renderCollocation() {
  const collocations = getUsableCollocations(currentWord);
  if (!collocations.length) {
    renderSentence();
    return;
  }

  document.getElementById('qt-collocation').classList.remove('hidden');
  const target = collocations[Math.floor(Math.random() * collocations.length)];
  const correctText = target.collocate || getMissingCollocationPart(target.phrase, currentWord.word);
  const container = document.getElementById('qt-collocation-options');
  container.innerHTML = '';

  document.getElementById('qt-collocation-label').textContent = target.prompt || 'Choose the natural collocation';
  document.getElementById('qt-collocation-word').textContent = currentWord.word;
  document.getElementById('qt-collocation-pattern').textContent = target.pattern || '';
  document.getElementById('qt-collocation-cloze').textContent = buildCollocationCloze(target, currentWord.word);

  const distractors = buildCollocationDistractors(correctText);
  const options = [correctText];
  for (const item of distractors) {
    if (options.length >= 4) break;
    if (item && !options.includes(item)) options.push(item);
  }
  options.sort(() => Math.random() - 0.5);

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'mcq-btn';
    btn.textContent = opt;
    btn.onclick = () => handleAnswer(opt === correctText, btn, '#qt-collocation-options .mcq-btn', correctText);
    container.appendChild(btn);
  });
}

function getUsableCollocations(wordObj) {
  return (wordObj.collocations || [])
    .filter(item => item && item.phrase && (item.collocate || getMissingCollocationPart(item.phrase, wordObj.word)))
    .slice(0, 8);
}

function buildCollocationCloze(collocation, word) {
  const phrase = String(collocation.phrase || '').trim();
  const collocate = String(collocation.collocate || '').trim();
  if (collocate && phrase.toLowerCase().includes(collocate.toLowerCase())) {
    return phrase.replace(new RegExp(`\\b${escapeRegExp(collocate)}\\b`, 'i'), '____');
  }
  const baseWord = String(word || '').trim();
  return phrase.replace(new RegExp(`\\b${escapeRegExp(baseWord)}\\b`, 'i'), baseWord) || `${baseWord} ____`;
}

function getMissingCollocationPart(phrase, word) {
  const parts = String(phrase || '').split(/\s+/).filter(Boolean);
  const base = String(word || '').toLowerCase();
  return parts.find(part => part.toLowerCase() !== base) || '';
}

function buildCollocationDistractors(correctText) {
  const fromCollocations = fullVocabList
    .flatMap(item => item.collocations || [])
    .map(item => item.collocate)
    .filter(Boolean);
  const fromWords = fullVocabList.map(item => item.word).filter(Boolean);
  const dummy = ['strong', 'heavy', 'deep', 'major', 'serious', 'clear', 'common', 'natural', 'make', 'take', 'give', 'reach'];
  return [...new Set([...fromCollocations, ...fromWords, ...dummy])]
    .filter(item => item && item !== correctText)
    .sort(() => Math.random() - 0.5);
}

let matchSelectedWord = null;
let matchSelectedDef = null;
let matchPairs = [];
let matchCorrectCount = 0;
let matchFailedWords = new Set();

function renderMatch() {
  document.getElementById('qt-match').classList.remove('hidden');
  const wordsCol = document.getElementById('qt-match-words');
  const defsCol = document.getElementById('qt-match-defs');
  wordsCol.innerHTML = '';
  defsCol.innerHTML = '';

  matchSelectedWord = null;
  matchSelectedDef = null;
  matchCorrectCount = 0;
  matchFailedWords.clear();

  let pool = fullVocabList.filter(w => w.id !== currentWord.id).sort(() => Math.random() - 0.5).slice(0, 3);
  pool.push(currentWord);

  matchPairs = pool.map(w => ({ word: w.word, def: w.translation, wordObj: w }));

  const words = [...matchPairs].sort(() => Math.random() - 0.5);
  const defs = [...matchPairs].sort(() => Math.random() - 0.5);

  words.forEach(item => {
    const el = document.createElement('div');
    el.className = 'qt-match-item word-item';
    el.textContent = item.word;
    el.onclick = () => onMatchClick(el, 'word', item.word);
    wordsCol.appendChild(el);
  });

  defs.forEach(item => {
    const el = document.createElement('div');
    el.className = 'qt-match-item def-item';
    el.textContent = item.def;
    el.onclick = () => onMatchClick(el, 'def', item.def);
    defsCol.appendChild(el);
  });
}

function onMatchClick(el, type, val) {
  if (el.classList.contains('matched')) return;

  if (type === 'word') {
    document.querySelectorAll('.word-item').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    matchSelectedWord = { el, val };
  } else {
    document.querySelectorAll('.def-item').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    matchSelectedDef = { el, val };
  }

  if (matchSelectedWord && matchSelectedDef) {
    const pair = matchPairs.find(p => p.word === matchSelectedWord.val);
    const wordObjWord = pair ? pair.wordObj : null;
    const pairDef = matchPairs.find(p => p.def === matchSelectedDef.val);
    const wordObjDef = pairDef ? pairDef.wordObj : null;

    if (pair && pair.def === matchSelectedDef.val) {
      playReviewAnswerSound(true);
      matchSelectedWord.el.classList.remove('selected');
      matchSelectedWord.el.classList.add('matched');
      matchSelectedDef.el.classList.remove('selected');
      matchSelectedDef.el.classList.add('matched');
      matchCorrectCount++;

      const wObj = pair.wordObj;
      if (!matchFailedWords.has(wObj.id)) {
        if (wObj.id === currentWord.id) {
          updateSM2(wObj, 4);
          recordCurrentSessionOutcome(true);
          recordReviewResult(true);
        } else {
          // The other cards are only distractors. A match counts as a review just
          // for words still waiting in this session; everything else keeps its schedule.
          const dueIdx = dueWords.findIndex(w => w.id === wObj.id);
          if (dueIdx > currentReviewIndex) {
            updateSM2(wObj, 4);
            dueWords.splice(dueIdx, 1);
            sessionTotal--;
            updateProgressRing(currentReviewIndex, sessionTotal);
            document.getElementById('review-progress').textContent =
              `${dueWords.length - currentReviewIndex} word${(dueWords.length - currentReviewIndex) !== 1 ? 's' : ''} left today`;
          }
        }
      }

      if (matchCorrectCount === 4) {
        setTimeout(() => showSummaryPanel(), 1000);
      }
    } else {
      playReviewAnswerSound(false);
      matchSelectedWord.el.classList.add('error');
      matchSelectedDef.el.classList.add('error');
      const wEl = matchSelectedWord.el;
      const dEl = matchSelectedDef.el;
      setTimeout(() => {
        wEl.classList.remove('error', 'selected');
        dEl.classList.remove('error', 'selected');
      }, 400);

      if (wordObjWord) matchFailedWords.add(wordObjWord.id);
      if (wordObjDef) matchFailedWords.add(wordObjDef.id);

      const isCurrentWordInvolved = (wordObjWord && wordObjWord.id === currentWord.id) || (wordObjDef && wordObjDef.id === currentWord.id);

      if (isCurrentWordInvolved) {
        updateSM2(currentWord, 0);
        recordCurrentSessionOutcome(false);
        recordReviewResult(false);
        setTimeout(() => showSummaryPanel(), 1000);
      } else {
        // Same rule for mistakes: only words still waiting in this session are penalised.
        [wordObjWord, wordObjDef].forEach(wObj => {
          if (wObj && dueWords.findIndex(w => w.id === wObj.id) > currentReviewIndex) {
            updateSM2(wObj, 0);
          }
        });
      }
    }
    matchSelectedWord = null;
    matchSelectedDef = null;
  }
}

function renderSentence() {
  document.getElementById('qt-sentence').classList.remove('hidden');
  document.getElementById('qt-sentence-word').textContent = currentWord.word;
  document.getElementById('qt-sentence-input').value = '';
  document.getElementById('qt-sentence-feedback').className = 'hidden';

  const submitBtn = document.getElementById('qt-sentence-submit');
  submitBtn.disabled = false;
  submitBtn.textContent = 'Submit';

  submitBtn.onclick = async () => {
    const sentence = document.getElementById('qt-sentence-input').value.trim();
    if (!sentence) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Checking...';

    chrome.runtime.sendMessage({
      action: "evaluateSentence",
      word: currentWord.word,
      sentence: sentence
    }, response => {
      const feedbackEl = document.getElementById('qt-sentence-feedback');
      const iconEl = document.getElementById('qt-sentence-icon');
      const msgEl = document.getElementById('qt-sentence-msg');

      feedbackEl.className = '';
      if (response && response.success && response.result) {
        const isCorrect = response.result.correct;
        playReviewAnswerSound(isCorrect);
        feedbackEl.classList.add(isCorrect ? 'correct' : 'wrong');
        iconEl.textContent = isCorrect ? '✅' : '❌';
        msgEl.textContent = response.result.feedback || (isCorrect ? 'Great sentence!' : 'That doesn\'t seem right.');

        updateSM2(currentWord, isCorrect ? 4 : 0);
        recordCurrentSessionOutcome(isCorrect);
        recordReviewResult(isCorrect);
        setTimeout(() => showSummaryPanel(), 3500);
      } else {
        feedbackEl.classList.add('wrong');
        iconEl.textContent = '⚠️';
        msgEl.textContent = response?.error || 'Failed to check sentence. Please try again.';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit';
      }
    });
  };
}

// ── Answer Handler ────────────────────────────────────────────

function calculateAnswerQuality(isCorrect) {
  if (!isCorrect) return 0;
  const elapsedMs = Date.now() - (questionStartTime || Date.now());
  const elapsedSec = elapsedMs / 1000;
  // Fast correct = 5, moderate = 4, slow but correct = 3
  if (elapsedSec < 3) return 5;
  if (elapsedSec < 8) return 4;
  return 3;
}

function handleAnswer(isCorrect, btnElement, allBtnsSelector, correctText) {
  const allBtns = document.querySelectorAll(allBtnsSelector);
  allBtns.forEach(b => b.disabled = true);
  playReviewAnswerSound(isCorrect);

  if (isCorrect) {
    btnElement.classList.add('correct');
  } else {
    btnElement.classList.add('wrong');
    allBtns.forEach(b => {
      if (b.textContent === correctText) {
        b.classList.add('correct');
      }
    });
  }

  const quality = calculateAnswerQuality(isCorrect);
  updateSM2(currentWord, quality);
  recordCurrentSessionOutcome(isCorrect);
  recordReviewResult(isCorrect);

  setTimeout(() => {
    showSummaryPanel();
  }, 1500);
}

// ── Summary Panel ─────────────────────────────────────────────

async function showSummaryPanel() {
  document.getElementById('review-container').classList.add('hidden');
  document.getElementById('review-gate').classList.add('hidden');
  const panel = document.getElementById('review-summary-panel');
  panel.classList.remove('hidden');

  document.getElementById('next-question-btn').classList.remove('hidden');
  const outcome = document.getElementById('summary-outcome');
  if (outcome && reviewSession.lastOutcome?.word === currentWord?.word) {
    outcome.textContent = reviewSession.lastOutcome.isCorrect
      ? 'Correct — keep the recall strong with the example below.'
      : 'Not quite — take a moment to connect the word, meaning, and example.';
    outcome.className = `summary-outcome ${reviewSession.lastOutcome.isCorrect ? 'correct' : 'wrong'}`;
  } else if (outcome) {
    outcome.className = 'summary-outcome hidden';
  }
  const backBtn = document.getElementById('back-to-list-btn');
  if (backBtn) backBtn.classList.add('hidden');

  await populateSummaryPanel(currentWord);
}

async function showWordDetails(wordId) {
  const wordObj = fullVocabList.find(w => String(w.id) === String(wordId));
  if (!wordObj) return;

  switchView('review-view');
  stopReviewGateTimer();

  document.getElementById('review-gate').classList.add('hidden');
  document.getElementById('review-container').classList.add('hidden');
  document.getElementById('review-complete').classList.add('hidden');

  currentWord = wordObj;
  const panel = document.getElementById('review-summary-panel');
  panel.classList.remove('hidden');
  document.getElementById('summary-outcome')?.classList.add('hidden');

  let backBtn = document.getElementById('back-to-list-btn');
  if (!backBtn) {
    backBtn = document.createElement('button');
    backBtn.id = 'back-to-list-btn';
    backBtn.className = 'btn outline';
    backBtn.textContent = '← Back to List';
    backBtn.onclick = () => {
      document.getElementById('review-summary-panel').classList.add('hidden');
      switchView('vocab-view');
    };
    document.querySelector('.summary-actions').appendChild(backBtn);
  }
  document.getElementById('next-question-btn').classList.add('hidden');
  backBtn.classList.remove('hidden');

  await populateSummaryPanel(wordObj);
}

function populateSummaryPanel(wordObj) {
  document.getElementById('summary-word').textContent = wordObj.word;
  document.getElementById('summary-meaning').textContent = wordObj.englishMeaning || '—';
  document.getElementById('summary-translation').textContent = wordObj.translation || '—';
  document.getElementById('summary-example').textContent = wordObj.context || '—';
  renderSummaryCollocations(wordObj);

  renderSummaryImage(wordObj);

  // Enrichment must never block the detail panel. Each task updates its own
  // part of the panel as soon as it completes.
  if (!wordObj.imageUrl || !wordObj.pronunciation || !hasCollocations(wordObj)) {
    void fetchMissingMedia(wordObj).then(() => {
      if (String(currentWord?.id) !== String(wordObj.id)) return;
      renderSummaryCollocations(wordObj);
      updateSummaryIpa(wordObj);
    });
  }

  updateSummaryIpa(wordObj);
}

function updateSummaryIpa(wordObj) {
  const ipaEl = document.getElementById('summary-ipa');
  if (wordObj.pronunciation) {
    ipaEl.textContent = wordObj.pronunciation;
    ipaEl.classList.remove('hidden');
  } else {
    ipaEl.classList.add('hidden');
  }
}

function renderSummaryImage(wordObj) {
  const imgEl = document.getElementById('summary-image');
  const imgPlaceholder = document.getElementById('summary-image-placeholder');
  if (!imgEl || !imgPlaceholder) return;

  if (hasRealVocabularyImage(wordObj)) {
    imgEl.classList.add('hidden');
    imgPlaceholder.classList.remove('hidden');
    imgPlaceholder.textContent = 'Loading image…';
    imgEl.decoding = 'async';
    imgEl.onload = () => {
      if (String(currentWord?.id) !== String(wordObj.id)) return;
      imgEl.classList.remove('hidden');
      imgPlaceholder.classList.add('hidden');
    };
    imgEl.onerror = () => {
      if (String(currentWord?.id) !== String(wordObj.id)) return;
      persistVocabularyWord(wordObj, { imageUrl: '' });
      imgEl.classList.add('hidden');
      imgPlaceholder.classList.remove('hidden');
      imgPlaceholder.textContent = 'No image available';
    };
    imgEl.src = wordObj.imageUrl;
  } else {
    imgEl.classList.add('hidden');
    imgPlaceholder.classList.remove('hidden');
    imgPlaceholder.textContent = 'No image available';
  }
}

async function fetchMissingMedia(wordObj) {
  // Save only the fields this lookup fills in, so it can't overwrite
  // anything else that changed on the word while the requests were running.
  const changes = {};
  const imageTask = !hasRealVocabularyImage(wordObj)
    ? fetchVocabularyImage(wordObj).then(imageUrl => {
        if (!imageUrl || imageUrl === wordObj.imageUrl) return false;
        persistVocabularyWord(wordObj, { imageUrl });
        if (String(currentWord?.id) === String(wordObj.id)) {
          renderSummaryImage(wordObj);
        }
        return true;
      })
    : Promise.resolve(false);

  if (!wordObj.pronunciation && !wordObj.audioUrl) {
    try {
      const dictRes = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(wordObj.word)}`);
      if (dictRes.ok) {
        const dictData = await dictRes.json();
        const phonetics = dictData[0]?.phonetics || [];
        const validPhonetic = phonetics.find(p => p.text && p.audio) || phonetics.find(p => p.text) || phonetics[0];
        if (validPhonetic) {
          changes.pronunciation = validPhonetic.text || '';
          changes.audioUrl = validPhonetic.audio || '';
        }

        let dictExample = '';
        let synonyms = [];
        let antonyms = [];
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
        changes.synonyms = [...new Set(synonyms)].slice(0, 5);
        changes.antonyms = [...new Set(antonyms)].slice(0, 5);

        if (dictExample) {
          changes.context = dictExample; // Upgrade messy context to clean dictionary example
          // Dynamically update the summary panel if it's currently showing
          const exampleEl = document.getElementById('summary-example');
          if (exampleEl) exampleEl.textContent = dictExample;
        }
      }
    } catch (e) { console.warn("Dict API error:", e); }
    Object.assign(wordObj, changes);
  }

  if (!hasCollocations(wordObj)) {
    try {
      const response = await sendRuntimeMessage({
        action: 'fetchCollocations',
        word: wordObj.word,
        partOfSpeech: wordObj.partOfSpeech || ''
      });
      if (response?.success && Array.isArray(response.collocations)) {
        wordObj.collocations = response.collocations;
        changes.collocations = response.collocations;
      }
    } catch (e) {
      console.warn("Collocation fetch error:", e);
    }
  }

  if (wordObj.pronunciation === undefined) wordObj.pronunciation = '';
  if (wordObj.audioUrl === undefined) wordObj.audioUrl = '';
  if (isGeneratedVocabularyImage(wordObj.imageUrl)) {
    wordObj.imageUrl = '';
    changes.imageUrl = '';
  }

  // A real image found above has already been saved; don't clear it again.
  if (await imageTask) delete changes.imageUrl;

  if (Object.keys(changes).length > 0) {
    persistVocabularyWord(wordObj, changes);
  }
}

async function requestVocabularyImage(wordObj) {
  try {
    const response = await sendRuntimeMessage({
      action: 'fetchVocabularyImage',
      vocab: {
        word: wordObj.word,
        originalWord: wordObj.originalWord,
        englishMeaning: wordObj.englishMeaning,
        context: wordObj.context,
        partOfSpeech: wordObj.partOfSpeech
      }
    });
    return response?.success ? response.imageUrl : '';
  } catch (error) {
    console.warn('Vocabulary image request failed:', error);
    return '';
  }
}

function renderSummaryCollocations(wordObj) {
  const el = document.getElementById('summary-collocations');
  if (!el) return;
  const contextEl = document.getElementById('summary-collocation-context');
  if (contextEl) {
    contextEl.classList.add('hidden');
    contextEl.innerHTML = '';
  }

  const collocations = getUsableCollocations(wordObj);
  if (!collocations.length) {
    el.textContent = '—';
    return;
  }

  el.innerHTML = collocations
    .slice(0, 5)
    .map((item, index) => `<button type="button" class="collocation-pill" data-collocation-index="${index}" title="${escapeHtml(item.pattern || item.source || '')}">${escapeHtml(item.phrase)}</button>`)
    .join('');
  el.querySelectorAll('.collocation-pill').forEach(button => {
    button.addEventListener('click', () => showCollocationContext(wordObj, Number(button.dataset.collocationIndex)));
  });
}

async function showCollocationContext(wordObj, collocationIndex) {
  const contextEl = document.getElementById('summary-collocation-context');
  if (!contextEl) return;

  const collocations = getUsableCollocations(wordObj);
  const collocation = collocations[collocationIndex];
  if (!collocation) return;

  contextEl.classList.remove('hidden');
  if (collocation.context) {
    renderCollocationContext(contextEl, collocation);
    return;
  }

  contextEl.innerHTML = `
    <div class="collocation-context-title">${escapeHtml(collocation.phrase)}</div>
    <div class="collocation-context-loading">Loading usage context...</div>
  `;

  const response = await sendRuntimeMessage({
    action: 'explainCollocation',
    word: wordObj.word,
    collocation
  });

  if (response?.success && response.context) {
    collocation.context = response.context;
    const original = (wordObj.collocations || []).find(item => item.phrase === collocation.phrase);
    if (original) original.context = response.context;
    persistVocabularyWord(wordObj, { collocations: wordObj.collocations });
    renderCollocationContext(contextEl, collocation);
  } else {
    contextEl.innerHTML = `
      <div class="collocation-context-title">${escapeHtml(collocation.phrase)}</div>
      <div class="collocation-context-error">${escapeHtml(response?.error || 'Could not load usage context.')}</div>
    `;
  }
}

function renderCollocationContext(container, collocation) {
  const context = collocation.context || {};
  container.innerHTML = `
    <div class="collocation-context-title">${escapeHtml(collocation.phrase)}</div>
    <div class="collocation-context-row">
      <span>Meaning</span>
      <p>${escapeHtml(context.meaning || '—')}</p>
    </div>
    <div class="collocation-context-row">
      <span>Example</span>
      <p class="italic">${escapeHtml(context.example || '—')}</p>
    </div>
    <div class="collocation-context-row">
      <span>Note</span>
      <p>${escapeHtml(context.note || '—')}</p>
    </div>
  `;
}

// Image fetching is delegated to background.js to avoid duplicating API logic
// and to keep API keys centralized in the service worker.
async function fetchVocabularyImage(wordObj) {
  try {
    const response = await sendRuntimeMessage({
      action: 'fetchVocabularyImage',
      vocab: {
        word: wordObj.word,
        originalWord: wordObj.originalWord,
        englishMeaning: wordObj.englishMeaning,
        context: wordObj.context,
        partOfSpeech: wordObj.partOfSpeech
      }
    });
    return response?.success ? response.imageUrl : '';
  } catch (error) {
    console.warn('Vocabulary image fetch failed:', error);
    return '';
  }
}

// Every vocabulary write starts from the latest stored list. Writing this
// page's fullVocabList back erased words saved from other tabs while the
// dashboard was open. Writes are queued so quick updates from this page
// (several matches in one Matching Game, say) can't overwrite each other.
let vocabWriteQueue = Promise.resolve();

function updateStoredVocabList(applyChanges) {
  const write = vocabWriteQueue.then(async () => {
    const data = await chrome.storage.local.get({ vocabList: [] });
    const latestList = Array.isArray(data.vocabList) ? data.vocabList : [];
    const nextList = applyChanges(latestList);
    if (!nextList) return;
    await chrome.storage.local.set({ vocabList: nextList });
    syncVocabList(nextList);
  });
  vocabWriteQueue = write.catch(error => console.warn('Vocabulary save failed:', error));
  return vocabWriteQueue;
}

// Saves the given fields on one word and mirrors them on the in-memory object.
function persistVocabularyWord(wordObj, changes) {
  Object.assign(wordObj, changes);
  return updateStoredVocabList(list => {
    const storedWord = list.find(w => String(w.id) === String(wordObj.id));
    // Deleted in another tab: don't bring it back.
    if (!storedWord) return null;
    Object.assign(storedWord, changes);
    return list;
  });
}

// Keeps fullVocabList in step with storage. Existing objects are updated in
// place because the review queue and the current question hold references to them.
function syncVocabList(latestList) {
  const existingById = new Map(fullVocabList.map(w => [String(w.id), w]));
  const idsChanged = latestList.length !== fullVocabList.length
    || latestList.some(w => !existingById.has(String(w.id)));

  fullVocabList = latestList.map(latestWord => {
    const existing = existingById.get(String(latestWord.id));
    return existing ? Object.assign(existing, latestWord) : latestWord;
  });

  updateBadge();
  if (idsChanged) renderVocabTable();
}

function sendRuntimeMessage(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, response => resolve(response));
  });
}

function handleNextQuestionBtn() {
  document.getElementById('review-summary-panel').classList.add('hidden');
  currentReviewIndex++;
  renderNextQuestion();
}

function playSummaryAudio() {
  if (currentWord && currentWord.word) {
    const toggleBtn = document.getElementById('summary-accent-toggle');
    const accent = toggleBtn ? toggleBtn.textContent : 'US';
    speakReviewWord(currentWord.word, accent);
  }
}

function speakReviewWord(word, accent = 'US') {
  const text = String(word || '').trim();
  if (!text) return;
  const lang = accent === 'UK' ? 'en-GB' : 'en-US';
  const audioBtn = document.getElementById('summary-audio-btn');
  if (audioBtn) audioBtn.style.transform = 'scale(1.2)';
  chrome.runtime.sendMessage({ action: 'speakText', text, lang }, () => {
    if (audioBtn) audioBtn.style.transform = 'scale(1)';
  });
}

// ── SM-2 Algorithm ────────────────────────────────────────────
// Full SM-2 implementation with adaptive ease factor.
// quality: 0 = wrong/blackout, 1-2 = wrong with partial recall,
//          3 = correct but hard, 4 = correct, 5 = perfect/instant

function updateSM2(wordObj, quality) {
  let repetition = wordObj.repetition || 0;
  let easeFactor = wordObj.easeFactor || 2.5;
  let interval = wordObj.interval || 0;

  if (quality >= 3) {
    // Correct answer: advance through the schedule
    if (repetition === 0) {
      interval = 20 / (24 * 60); // First correct: review in 20 minutes
    } else if (repetition === 1) {
      interval = 1; // Second correct: review in 1 day
    } else {
      // From rep 2+: use the adaptive ease factor. Keep at least one day so a
      // word imported without an interval doesn't stay due forever.
      interval = Math.max(1, Math.round(interval * easeFactor));
    }
    repetition++;
  } else {
    // Wrong answer: reset to short interval
    repetition = 0;
    interval = 20 / (24 * 60); // Review again in 20 minutes
  }

  // Update ease factor based on answer quality (core SM-2 formula)
  // This makes the algorithm ADAPTIVE: easy words get longer intervals,
  // hard words get shorter intervals over time.
  easeFactor = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  easeFactor = Math.max(1.3, easeFactor); // Floor at 1.3 per SM-2 spec

  // Cap interval at 365 days for mastered words (was 14 days max before)
  interval = Math.min(interval, 365);

  const now = Date.now();
  persistVocabularyWord(wordObj, {
    repetition,
    easeFactor,
    interval,
    nextReviewDate: now + interval * 24 * 60 * 60 * 1000
  }).then(() => {
    updateBadge();
    renderVocabTable();
  });
}

// ── Progress Ring ─────────────────────────────────────────────

function updateProgressRing(done, total) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const circumference = 125.66; // 2π × r=20
  const offset = circumference - (pct / 100) * circumference;

  const fill = document.getElementById('progress-ring-fill');
  if (fill) fill.style.strokeDashoffset = offset;

  const pctEl = document.getElementById('progress-pct');
  if (pctEl) pctEl.textContent = `${pct}%`;
}

// ── Import & Export ───────────────────────────────────────────

function initImportExport() {
  const exportDropdownBtn = document.getElementById('export-dropdown-btn');
  const exportDropdownMenu = document.getElementById('export-dropdown-menu');
  const exportJsonBtn = document.getElementById('export-json-btn');
  const exportCsvBtn = document.getElementById('export-csv-btn');
  const importBtn = document.getElementById('import-btn');
  const importFileInput = document.getElementById('import-file-input');

  if (exportDropdownBtn && exportDropdownMenu) {
    exportDropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportDropdownMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
      exportDropdownMenu.classList.add('hidden');
    });
  }

  if (exportJsonBtn) {
    exportJsonBtn.addEventListener('click', () => {
      exportData();
    });
  }

  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', () => {
      exportCsvData();
    });
  }

  if (importBtn && importFileInput) {
    importBtn.addEventListener('click', () => {
      importFileInput.click();
    });

    importFileInput.addEventListener('change', handleImportFileSelected);
  }

  const importCloseBtn = document.getElementById('import-modal-close');
  const importCancelBtn = document.getElementById('import-cancel-btn');
  const importBackdrop = document.getElementById('import-backdrop');
  const importConfirmBtn = document.getElementById('import-confirm-btn');

  [importCloseBtn, importCancelBtn, importBackdrop].forEach(el => {
    if (el) el.addEventListener('click', closeImportModal);
  });

  if (importConfirmBtn) {
    importConfirmBtn.addEventListener('click', confirmImport);
  }
}

function exportData() {
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(fullVocabList, null, 2));
  const a = document.createElement('a');
  a.setAttribute('href', dataStr);
  a.setAttribute('download', `germanyvocab_export_${new Date().toISOString().slice(0, 10)}.json`);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function exportCsvData() {
  if (fullVocabList.length === 0) {
    alert('No vocabulary words to export.');
    return;
  }

  const headers = ['Word', 'Part of Speech', 'English Meaning', 'Vietnamese Translation', 'Context', 'Repetition', 'Ease Factor', 'Interval Days', 'Next Review Date', 'Date Added'];
  const rows = fullVocabList.map(item => [
    escapeCsvCell(item.word || ''),
    escapeCsvCell(item.partOfSpeech || ''),
    escapeCsvCell(item.englishMeaning || ''),
    escapeCsvCell(item.translation || ''),
    escapeCsvCell(item.context || ''),
    item.repetition || 0,
    (item.easeFactor || 2.5).toFixed(2),
    (item.interval || 0).toFixed(1),
    item.nextReviewDate ? new Date(item.nextReviewDate).toISOString() : '',
    item.dateAdded ? new Date(item.dateAdded).toISOString() : ''
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.setAttribute('href', url);
  a.setAttribute('download', `germanyvocab_export_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeCsvCell(str) {
  const cell = String(str || '');
  if (cell.includes(',') || cell.includes('"') || cell.includes('\n') || cell.includes('\r')) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

let pendingImportWords = [];

function handleImportFileSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const content = event.target.result;
      if (file.name.endsWith('.json')) {
        parseJsonImport(content);
      } else if (file.name.endsWith('.csv')) {
        parseCsvImport(content);
      } else {
        alert('Unsupported file format. Please choose a .json or .csv file.');
      }
    } catch (err) {
      alert(`Could not parse file: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
}

function parseJsonImport(content) {
  const data = JSON.parse(content);
  const words = Array.isArray(data) ? data : (data.vocabList || []);
  if (!Array.isArray(words) || words.length === 0) {
    alert('No valid vocabulary array found in this JSON file.');
    return;
  }
  openImportModal(words);
}

function parseCsvImport(content) {
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length <= 1) {
    alert('CSV file is empty or has only a header row.');
    return;
  }

  const firstLine = lines[0].toLowerCase();
  const hasHeader = firstLine.includes('word') || firstLine.includes('meaning') || firstLine.includes('translation');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const words = [];
  dataLines.forEach(line => {
    const cols = parseCsvLine(line);
    if (!cols || !cols[0]) return;
    words.push({
      id: String(Date.now() + Math.random()),
      word: cols[0].trim(),
      partOfSpeech: cols[1]?.trim() || '',
      englishMeaning: cols[2]?.trim() || cols[0].trim(),
      translation: cols[3]?.trim() || cols[2]?.trim() || '',
      context: cols[4]?.trim() || '',
      repetition: Number(cols[5]) || 0,
      easeFactor: Number(cols[6]) || 2.5,
      interval: Number(cols[7]) || 0,
      nextReviewDate: parseCsvDate(cols[8]),
      dateAdded: parseCsvDate(cols[9])
    });
  });

  if (words.length === 0) {
    alert('No valid words could be read from this CSV file.');
    return;
  }
  openImportModal(words);
}

// CSV export writes ISO dates. Blank or unreadable cells become undefined, so
// import keeps the saved value (or uses its default) instead of resetting it.
function parseCsvDate(value) {
  const time = Date.parse(String(value || '').trim());
  return Number.isNaN(time) ? undefined : time;
}

function parseCsvLine(text) {
  const re = /(?:,|\n|^)("(?:(?:"")*[^"]*)*"|[^",\n]*|(?:\n|$))/g;
  const row = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    let val = match[1];
    if (val === undefined) continue;
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/""/g, '"');
    }
    row.push(val);
    if (match.index + match[0].length >= text.length) break;
  }
  return row;
}

function openImportModal(incomingWords) {
  pendingImportWords = incomingWords.filter(w => w && (w.word || w.id));
  const existingMap = new Map(fullVocabList.map(w => [String(w.word || '').toLowerCase(), w]));

  let duplicateCount = 0;
  let newCount = 0;
  const previewList = document.getElementById('import-preview-list');
  if (previewList) previewList.innerHTML = '';

  pendingImportWords.forEach(w => {
    const norm = String(w.word || '').toLowerCase();
    const isDup = existingMap.has(norm);
    if (isDup) duplicateCount++;
    else newCount++;

    if (previewList && previewList.children.length < 50) {
      const item = document.createElement('div');
      item.className = 'import-preview-item';
      item.innerHTML = `<strong>${escapeHtml(w.word)}</strong> <span>${escapeHtml(w.translation || w.englishMeaning || '')} ${isDup ? '(existing)' : '(new)'}</span>`;
      previewList.appendChild(item);
    }
  });

  const summary = document.getElementById('import-summary-text');
  if (summary) {
    summary.textContent = `Found ${pendingImportWords.length} words (${newCount} new, ${duplicateCount} duplicates).`;
  }

  document.getElementById('import-modal')?.classList.remove('hidden');
  document.getElementById('import-backdrop')?.classList.remove('hidden');
}

function closeImportModal() {
  document.getElementById('import-modal')?.classList.add('hidden');
  document.getElementById('import-backdrop')?.classList.add('hidden');
  pendingImportWords = [];
}

function confirmImport() {
  const mode = document.querySelector('input[name="import-mode"]:checked')?.value || 'merge';
  const incomingWords = pendingImportWords;

  let added = 0;
  let updated = 0;

  updateStoredVocabList(list => {
    const existingMap = new Map(list.map(w => [String(w.word || '').toLowerCase(), w]));

    incomingWords.forEach(w => {
      const norm = String(w.word || '').toLowerCase();
      if (existingMap.has(norm)) {
        if (mode === 'overwrite') {
          const existing = existingMap.get(norm);
          // Keep the saved word's id (a CSV row gets a freshly generated one) and
          // don't let cells the file left empty wipe saved values.
          Object.entries(w).forEach(([key, value]) => {
            if (key !== 'id' && value !== undefined) existing[key] = value;
          });
          updated++;
        }
      } else {
        const newEntry = {
          id: w.id || String(Date.now() + Math.random()),
          word: String(w.word || '').trim(),
          translation: w.translation || '',
          englishMeaning: w.englishMeaning || w.word,
          partOfSpeech: w.partOfSpeech || '',
          context: w.context || '',
          repetition: w.repetition || 0,
          easeFactor: w.easeFactor || 2.5,
          interval: w.interval || 0,
          nextReviewDate: w.nextReviewDate || Date.now(),
          dateAdded: w.dateAdded || Date.now()
        };
        list.push(newEntry);
        existingMap.set(norm, newEntry);
        added++;
      }
    });
    return list;
  }).then(() => {
    closeImportModal();
    loadData();
    renderStatistics();
    alert(`Import complete: ${added} words added, ${updated} words updated.`);
  });
}

// ── Statistics Dashboard ──────────────────────────────────────

function initStatisticsView() {
  const refreshBtn = document.getElementById('refresh-stats-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', renderStatistics);
  }
}

function recordReviewResult(isCorrect) {
  addGamificationXP(isCorrect ? 15 : 5, isCorrect ? 'Correct recall' : 'Review practice');

  chrome.storage.local.get({
    reviewStreak: { currentStreak: 0, lastReviewDate: '', longestStreak: 0 },
    reviewStats: { totalReviews: 0, correctReviews: 0, history: {} }
  }, data => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const streak = data.reviewStreak || { currentStreak: 0, lastReviewDate: '', longestStreak: 0 };
    const stats = data.reviewStats || { totalReviews: 0, correctReviews: 0, history: {} };

    stats.totalReviews = (stats.totalReviews || 0) + 1;
    if (isCorrect) {
      stats.correctReviews = (stats.correctReviews || 0) + 1;
    }
    stats.history = stats.history || {};
    stats.history[todayStr] = (stats.history[todayStr] || 0) + 1;

    if (streak.lastReviewDate !== todayStr) {
      if (!streak.lastReviewDate) {
        streak.currentStreak = 1;
      } else {
        const last = new Date(streak.lastReviewDate);
        const today = new Date(todayStr);
        const diffDays = Math.round((today - last) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
          streak.currentStreak = (streak.currentStreak || 0) + 1;
        } else if (diffDays > 1) {
          streak.currentStreak = 1;
        }
      }
      streak.lastReviewDate = todayStr;
      if (streak.currentStreak > (streak.longestStreak || 0)) {
        streak.longestStreak = streak.currentStreak;
      }
    }

    chrome.storage.local.set({ reviewStreak: streak, reviewStats: stats }, () => {
      renderStatistics();
    });
  });
}

function renderStatistics() {
  chrome.storage.local.get({
    reviewStreak: { currentStreak: 0, lastReviewDate: '', longestStreak: 0 },
    reviewStats: { totalReviews: 0, correctReviews: 0, history: {} }
  }, data => {
    const streak = data.reviewStreak || { currentStreak: 0, lastReviewDate: '', longestStreak: 0 };
    const stats = data.reviewStats || { totalReviews: 0, correctReviews: 0, history: {} };

    // 1. Streak
    const streakEl = document.getElementById('stats-streak');
    const streakHint = document.getElementById('stats-streak-hint');
    if (streakEl) streakEl.textContent = streak.currentStreak || 0;
    if (streakHint) {
      streakHint.textContent = streak.longestStreak > 0
        ? `Best streak: ${streak.longestStreak} days!`
        : `Review words every day to build your streak!`;
    }

    // 2. Total Words & Due
    const totalWords = fullVocabList.length;
    const now = Date.now();
    const dueWordsCount = fullVocabList.filter(item => !item.nextReviewDate || item.nextReviewDate <= now).length;
    const totalWordsEl = document.getElementById('stats-total-words');
    const dueWordsEl = document.getElementById('stats-due-words');
    if (totalWordsEl) totalWordsEl.textContent = totalWords;
    if (dueWordsEl) dueWordsEl.textContent = dueWordsCount;

    // 3. Mastered Words (rep >= 4)
    const masteredWordsCount = fullVocabList.filter(item => (item.repetition || 0) >= 4).length;
    const masteryPct = totalWords > 0 ? Math.round((masteredWordsCount / totalWords) * 100) : 0;
    const masteredWordsEl = document.getElementById('stats-mastered-words');
    const masteryRateEl = document.getElementById('stats-mastery-rate');
    if (masteredWordsEl) masteredWordsEl.textContent = masteredWordsCount;
    if (masteryRateEl) masteryRateEl.textContent = `${masteryPct}%`;

    // 4. Accuracy & Total Reviews
    const totalReviews = stats.totalReviews || 0;
    const correctReviews = stats.correctReviews || 0;
    const accRate = totalReviews > 0 ? Math.round((correctReviews / totalReviews) * 100) : 100;
    const accuracyEl = document.getElementById('stats-accuracy');
    const totalReviewsEl = document.getElementById('stats-total-reviews');
    if (accuracyEl) accuracyEl.textContent = `${accRate}%`;
    if (totalReviewsEl) totalReviewsEl.textContent = totalReviews;

    // 5. Mastery Distribution Bars
    const buckets = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    fullVocabList.forEach(w => {
      const rep = w.repetition || 0;
      if (rep === 0) buckets[0]++;
      else if (rep === 1) buckets[1]++;
      else if (rep === 2) buckets[2]++;
      else if (rep === 3) buckets[3]++;
      else buckets[4]++;
    });

    const setBar = (id, count, total) => {
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      const countEl = document.getElementById(`stats-count-${id}`);
      const barEl = document.getElementById(`stats-bar-${id}`);
      if (countEl) countEl.textContent = `${count} words (${pct}%)`;
      if (barEl) barEl.style.width = `${pct}%`;
    };

    setBar('new', buckets[0], totalWords);
    setBar('learning', buckets[1], totalWords);
    setBar('familiar', buckets[2], totalWords);
    setBar('known', buckets[3], totalWords);
    setBar('mastered', buckets[4], totalWords);

    // 6. 7-Day Activity Chart
    const activityChart = document.getElementById('stats-activity-chart');
    if (activityChart) {
      activityChart.innerHTML = '';
      const days = [];
      const history = stats.history || {};

      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().slice(0, 10);
        const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short' });
        const count = history[dateStr] || 0;
        days.push({ dayLabel, count });
      }

      const maxCount = Math.max(...days.map(d => d.count), 5);

      days.forEach(d => {
        const col = document.createElement('div');
        col.className = 'activity-col';
        const heightPct = Math.round((d.count / maxCount) * 100);
        col.innerHTML = `
          <span class="activity-count-label">${d.count}</span>
          <div class="activity-bar-fill" style="height: ${Math.max(4, heightPct)}%"></div>
          <span class="activity-day-label">${d.dayLabel}</span>
        `;
        activityChart.appendChild(col);
      });
    }

    // 7. POS Breakdown
    const posList = document.getElementById('stats-pos-list');
    if (posList) {
      posList.innerHTML = '';
      const posCounts = {};
      fullVocabList.forEach(w => {
        const p = (w.partOfSpeech || 'other').toLowerCase();
        posCounts[p] = (posCounts[p] || 0) + 1;
      });

      const sortedPos = Object.entries(posCounts).sort((a, b) => b[1] - a[1]);
      if (sortedPos.length === 0) {
        posList.innerHTML = '<span class="muted">No words categorized yet</span>';
      } else {
        sortedPos.slice(0, 6).forEach(([pos, count]) => {
          const row = document.createElement('div');
          row.className = 'pos-breakdown-row';
          const pct = totalWords > 0 ? Math.round((count / totalWords) * 100) : 0;
          row.innerHTML = `
            <span class="pos-badge pos-${pos}">${pos}</span>
            <span class="muted">${count} words (${pct}%)</span>
          `;
          posList.appendChild(row);
        });
      }
    }

    // 8. Gamification & Badges
    renderGamification();
  });
}

// ── Typing Quiz Question ──────────────────────────────────────

let typingHintRevealed = false;

function initTypingQuizListeners() {
  const submitBtn = document.getElementById('qt-typing-submit');
  const inputEl = document.getElementById('qt-typing-input');
  const hintBtn = document.getElementById('qt-typing-hint-btn');
  const listenBtn = document.getElementById('qt-typing-listen-btn');

  if (submitBtn) submitBtn.addEventListener('click', handleTypingSubmit);
  if (hintBtn) hintBtn.addEventListener('click', handleTypingHint);
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleTypingSubmit();
    });
  }

  if (listenBtn) {
    listenBtn.addEventListener('click', () => {
      if (currentWord && currentWord.word) {
        speakReviewWord(currentWord.word, 'US');
      }
    });
  }
}

function renderTypingQuestion() {
  document.getElementById('qt-typing').classList.remove('hidden');
  typingHintRevealed = false;

  const meaningEl = document.getElementById('qt-typing-meaning');
  const posEl = document.getElementById('qt-typing-pos');
  const contextEl = document.getElementById('qt-typing-context');
  const inputEl = document.getElementById('qt-typing-input');
  const hintText = document.getElementById('qt-typing-hint-text');
  const feedbackEl = document.getElementById('qt-typing-feedback');
  const submitBtn = document.getElementById('qt-typing-submit');

  if (meaningEl) meaningEl.textContent = currentWord.translation || currentWord.englishMeaning;
  if (posEl) posEl.textContent = currentWord.partOfSpeech || 'word';

  if (contextEl) {
    if (currentWord.context) {
      const reg = new RegExp(escapeRegExp(currentWord.word), 'gi');
      contextEl.textContent = currentWord.context.replace(reg, '_______');
    } else {
      contextEl.textContent = '';
    }
  }

  if (inputEl) {
    inputEl.value = '';
    inputEl.disabled = false;
    setTimeout(() => inputEl.focus(), 100);
  }

  if (hintText) {
    hintText.classList.add('hidden');
    hintText.textContent = '';
  }

  if (feedbackEl) {
    feedbackEl.classList.add('hidden');
    feedbackEl.className = 'typing-feedback hidden';
    feedbackEl.textContent = '';
  }

  if (submitBtn) submitBtn.disabled = false;
}

function handleTypingHint() {
  if (!currentWord || !currentWord.word) return;
  typingHintRevealed = true;
  const word = currentWord.word.trim();
  const hintText = document.getElementById('qt-typing-hint-text');
  if (!hintText) return;

  let hint = '';
  if (word.length <= 2) {
    hint = `${word[0]} _`;
  } else {
    hint = `${word[0]} ${'_ '.repeat(word.length - 2)}${word[word.length - 1]}`;
  }
  hintText.textContent = hint;
  hintText.classList.remove('hidden');
  document.getElementById('qt-typing-input')?.focus();
}

function handleTypingSubmit() {
  const inputEl = document.getElementById('qt-typing-input');
  const submitBtn = document.getElementById('qt-typing-submit');
  const feedbackEl = document.getElementById('qt-typing-feedback');
  if (!inputEl || !currentWord) return;

  const typed = inputEl.value.trim().toLowerCase();
  const target = String(currentWord.word || '').trim().toLowerCase();
  const isCorrect = typed === target;

  inputEl.disabled = true;
  if (submitBtn) submitBtn.disabled = true;
  playReviewAnswerSound(isCorrect);

  if (feedbackEl) {
    feedbackEl.classList.remove('hidden');
    if (isCorrect) {
      feedbackEl.className = 'typing-feedback correct';
      feedbackEl.textContent = '✓ Correct! Excellent spelling!';
    } else {
      feedbackEl.className = 'typing-feedback wrong';
      feedbackEl.textContent = `✗ Incorrect. The correct word is: "${currentWord.word}"`;
    }
  }

  let quality = 0;
  if (isCorrect) {
    const elapsedSec = (Date.now() - (questionStartTime || Date.now())) / 1000;
    if (!typingHintRevealed && elapsedSec < 4) quality = 5;
    else if (!typingHintRevealed && elapsedSec < 8) quality = 4;
    else quality = 3;
  } else {
    quality = 0;
  }

  updateSM2(currentWord, quality);
  recordCurrentSessionOutcome(isCorrect);
  recordReviewResult(isCorrect);

  setTimeout(() => {
    showSummaryPanel();
  }, 1800);
}

// ── Utilities ─────────────────────────────────────────────────

// ── Story Mode ────────────────────────────────────────────────

// AI Speaking Coach

function initAiCoach() {
  setCoachStatus('Ready');
  setNativeLiveButtons(false);
  resetCoachChat();
  updateCoachClock();
  if (!coachClockTimer) coachClockTimer = setInterval(updateCoachClock, 30000);
  addCoachEvent('Native Gemini Live is ready.');

  if (!navigator.mediaDevices?.getUserMedia) {
    showCoachError('Microphone capture is not available in this browser.');
    document.getElementById('coach-start-btn').disabled = true;
  }
}

async function startNativeLiveCoach() {
  if (liveCoachStarted) return;
  clearCoachError();
  setCoachStatus('Connecting');
  setNativeLiveButtons(true);

  try {
    const data = await chrome.storage.local.get({ geminiApiKey: '' });
    const apiKey = (data.geminiApiKey || '').trim();
    if (!apiKey) throw new Error('Gemini API Key is missing. Please add it in the extension settings.');

    const audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: LIVE_COACH_INPUT_RATE
    });
    liveCoachAudioContext = audioContext;
    await audioContext.resume();
    // Stop can be pressed while audio is starting or the mic prompt is open.
    if (liveCoachAudioContext !== audioContext) return;
    liveCoachPlaybackTime = audioContext.currentTime;
    pauseMusicForLiveCoach();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        channelCount: { ideal: 1 },
        sampleRate: { ideal: LIVE_COACH_INPUT_RATE }
      }
    });
    if (liveCoachAudioContext !== audioContext) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    liveCoachStream = stream;

    const socket = new WebSocket(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`
    );
    liveCoachSocket = socket;

    // Ignore events from a socket that has been stopped or replaced, so a late
    // close from an old session can't shut down the current one.
    socket.onopen = () => {
      if (liveCoachSocket !== socket) return;
      liveCoachStarted = true;
      addCoachEvent('Connected to Gemini Live.');
      sendNativeLiveSetup();
    };

    socket.onmessage = async event => {
      try {
        const message = await parseNativeLiveMessage(event.data);
        if (liveCoachSocket !== socket) return;
        handleNativeLiveMessage(message);
      } catch (error) {
        showCoachError(`Could not read Gemini Live message: ${error.message}`);
      }
    };

    socket.onerror = () => {
      if (liveCoachSocket !== socket) return;
      showCoachError('Gemini Live WebSocket error. Check your API key and Live API access.');
      stopNativeLiveCoach();
    };

    socket.onclose = event => {
      const closeDetail = event.reason || `code ${event.code}`;
      addCoachEvent(`Live session closed: ${closeDetail}`);
      if (liveCoachSocket === socket) stopNativeLiveCoach(false);
    };
  } catch (error) {
    showCoachError(error.message);
    stopNativeLiveCoach();
  }
}

function sendNativeLiveSetup() {
  const setup = {
    setup: {
      model: `models/${LIVE_COACH_MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO']
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: {
        parts: [{
          text: `You are an English speaking coach. Speak naturally in simple English. Keep replies short. Wait until the learner has clearly finished speaking before answering. Do not interrupt short pauses. Help the learner improve speaking confidence, pronunciation, grammar, and vocabulary. Ask one easy follow-up question when useful.`
        }]
      }
    }
  };
  liveCoachSocket.send(JSON.stringify(setup));
}

function processLiveCoachAudioChunk(input) {
  if (!liveCoachStarted || liveCoachSocket?.readyState !== WebSocket.OPEN) return;

  // Calculate volume for UI animation
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    sum += input[i] * input[i];
  }
  const rms = Math.sqrt(sum / input.length);
  updateLiveCoachNoiseFloor(rms);
  const threshold = Math.max(LIVE_COACH_MIN_RMS, liveCoachNoiseFloor * 2.6);
  const volume = Math.min(1, Math.max(0, (rms - liveCoachNoiseFloor) * 14));
  const pulseEl = document.getElementById('coach-pulse');
  if (pulseEl && pulseEl.classList.contains('active')) {
    // Use CSS variable to animate the orb based on mic input
    pulseEl.style.setProperty('--mic-volume', volume.toFixed(3));
  }

  if (!shouldSendLiveCoachAudio(rms, threshold)) return;

  const audioInput = resampleFloat32(input, liveCoachAudioContext.sampleRate, LIVE_COACH_INPUT_RATE);
  const pcm16 = float32ToPcm16(audioInput);
  const base64Audio = arrayBufferToBase64(pcm16.buffer);
  liveCoachSocket.send(JSON.stringify({
    realtimeInput: {
      audio: {
        data: base64Audio,
        mimeType: `audio/pcm;rate=${LIVE_COACH_INPUT_RATE}`
      }
    }
  }));
}

async function startNativeLiveMicrophone() {
  const audioContext = liveCoachAudioContext;
  liveCoachSource = audioContext.createMediaStreamSource(liveCoachStream);
  resetLiveCoachVoiceGate();

  let useWorklet = false;
  if (audioContext.audioWorklet) {
    try {
      await audioContext.audioWorklet.addModule('audio-recorder-worklet.js');
      // The coach may have been stopped while the worklet was loading.
      if (liveCoachAudioContext !== audioContext) return;
      liveCoachProcessor = new AudioWorkletNode(audioContext, 'audio-recorder-processor');
      liveCoachProcessor.port.onmessage = event => {
        if (event.data?.audioData) {
          processLiveCoachAudioChunk(event.data.audioData);
        }
      };
      liveCoachSource.connect(liveCoachProcessor);
      liveCoachProcessor.connect(liveCoachAudioContext.destination);
      useWorklet = true;
    } catch (err) {
      console.warn('AudioWorklet failed, falling back to ScriptProcessor:', err);
    }
  }

  if (liveCoachAudioContext !== audioContext) return;
  if (!useWorklet) {
    liveCoachProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    liveCoachProcessor.onaudioprocess = event => {
      processLiveCoachAudioChunk(event.inputBuffer.getChannelData(0));
    };
    liveCoachSource.connect(liveCoachProcessor);
    liveCoachProcessor.connect(liveCoachAudioContext.destination);
  }

  addCoachEvent('Microphone is streaming.');
}

function resetLiveCoachVoiceGate() {
  liveCoachNoiseFloor = 0.006;
  liveCoachActiveSpeechFrames = 0;
  liveCoachSilentFrames = 0;
  liveCoachLastAudioSentAt = 0;
  liveCoachAiSpeakingUntil = 0;
}

function updateLiveCoachNoiseFloor(rms) {
  if (rms < LIVE_COACH_STRONG_RMS) {
    liveCoachNoiseFloor = (liveCoachNoiseFloor * 0.96) + (Math.min(rms, 0.04) * 0.04);
  }
}

function shouldSendLiveCoachAudio(rms, threshold) {
  const now = liveCoachAudioContext?.currentTime || 0;
  const aiIsSpeaking = now < liveCoachAiSpeakingUntil;
  const isVoice = rms >= threshold;
  const isStrongVoice = rms >= LIVE_COACH_STRONG_RMS;

  if (aiIsSpeaking && !isStrongVoice) {
    liveCoachSilentFrames++;
    return false;
  }

  if (isVoice) {
    liveCoachActiveSpeechFrames++;
    liveCoachSilentFrames = 0;
    liveCoachLastAudioSentAt = now;
    return liveCoachActiveSpeechFrames >= 2 || isStrongVoice;
  }

  liveCoachActiveSpeechFrames = 0;
  liveCoachSilentFrames++;
  if (liveCoachSilentFrames <= LIVE_COACH_SILENCE_HOLD_FRAMES && now - liveCoachLastAudioSentAt < 0.8) {
    liveCoachLastAudioSentAt = now;
    return true;
  }

  return false;
}

function handleNativeLiveMessage(message) {
  if (message.setupComplete) {
    if (!liveCoachSetupComplete) {
      liveCoachSetupComplete = true;
      setCoachStatus('Live');
      startNativeLiveMicrophone();
    }
    addCoachEvent('Gemini Live setup complete.');
  }

  const serverContent = message.serverContent || message.server_content;
  if (!serverContent) return;

  if (serverContent.interrupted) {
    stopLiveCoachPlayback();
    closeCoachTranscripts('ai');
    addCoachEvent('You interrupted Gemini.');
  }

  const inputText = (serverContent.inputTranscription || serverContent.input_transcription)?.text;
  if (inputText) appendCoachTranscript('user', inputText);
  const outputText = (serverContent.outputTranscription || serverContent.output_transcription)?.text;
  if (outputText) appendCoachTranscript('ai', outputText);

  const parts = serverContent.modelTurn?.parts || serverContent.model_turn?.parts || [];
  parts.forEach(part => {
    const inlineData = part.inlineData || part.inline_data;
    const audioData = inlineData?.data;
    if (audioData) playNativeLiveAudio(audioData);
  });

  if (serverContent.turnComplete || serverContent.turn_complete) {
    closeCoachTranscripts();
  }
}

async function parseNativeLiveMessage(data) {
  if (typeof data === 'string') {
    return JSON.parse(data);
  }

  if (data instanceof Blob) {
    return JSON.parse(await data.text());
  }

  if (data instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(data));
  }

  throw new Error(`Unsupported message type: ${Object.prototype.toString.call(data)}`);
}

function playNativeLiveAudio(base64Audio) {
  if (!liveCoachAudioContext) return;
  const bytes = base64ToUint8Array(base64Audio);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const audioBuffer = liveCoachAudioContext.createBuffer(1, samples.length, 24000);
  const channel = audioBuffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) {
    channel[i] = Math.max(-1, Math.min(1, samples[i] / 32768));
  }

  const source = liveCoachAudioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(liveCoachAudioContext.destination);
  // Remember scheduled chunks so an interruption or Stop can silence them.
  liveCoachPlaybackSources.add(source);
  source.onended = () => liveCoachPlaybackSources.delete(source);
  const startAt = Math.max(liveCoachPlaybackTime, liveCoachAudioContext.currentTime);
  source.start(startAt);
  liveCoachPlaybackTime = startAt + audioBuffer.duration;
  liveCoachAiSpeakingUntil = Math.max(liveCoachAiSpeakingUntil, liveCoachPlaybackTime + LIVE_COACH_AI_DUCK_SECONDS);
}

function stopLiveCoachPlayback() {
  liveCoachPlaybackSources.forEach(source => {
    try {
      source.stop();
    } catch {
      // Already finished.
    }
  });
  liveCoachPlaybackSources.clear();
  liveCoachPlaybackTime = liveCoachAudioContext?.currentTime || 0;
  // The AI is silent now, so let the learner's voice through straight away.
  liveCoachAiSpeakingUntil = 0;
}

function pauseMusicForLiveCoach() {
  const audio = document.getElementById('bg-audio');
  if (!audio || audio.paused) {
    liveCoachPausedMusic = false;
    return;
  }

  liveCoachPausedMusic = true;
  audio.pause();
  const icon = document.getElementById('music-icon');
  if (icon) icon.textContent = '▶';
  document.getElementById('music-toggle')?.classList.remove('playing');
}

function resumeMusicAfterLiveCoach() {
  const audio = document.getElementById('bg-audio');
  if (!audio || !liveCoachPausedMusic) return;

  liveCoachPausedMusic = false;
  audio.play().then(() => {
    const icon = document.getElementById('music-icon');
    if (icon) icon.textContent = '⏸';
    document.getElementById('music-toggle')?.classList.add('playing');
  }).catch(() => { });
}

function stopNativeLiveCoach(closeSocket = true) {
  liveCoachStarted = false;
  liveCoachSetupComplete = false;
  stopLiveCoachPlayback();
  resetLiveCoachVoiceGate();
  resumeMusicAfterLiveCoach();
  setNativeLiveButtons(false);
  setCoachStatus('Ready');

  if (liveCoachProcessor) {
    liveCoachProcessor.disconnect();
    if (liveCoachProcessor.port) {
      liveCoachProcessor.port.onmessage = null;
    }
    liveCoachProcessor.onaudioprocess = null;
    liveCoachProcessor = null;
  }
  if (liveCoachSource) {
    liveCoachSource.disconnect();
    liveCoachSource = null;
  }
  if (liveCoachStream) {
    liveCoachStream.getTracks().forEach(track => track.stop());
    liveCoachStream = null;
  }
  if (closeSocket && liveCoachSocket) {
    liveCoachSocket.close();
  }
  liveCoachSocket = null;
  if (liveCoachAudioContext) {
    // Every Start creates a new AudioContext; close this one so they don't pile up.
    liveCoachAudioContext.close().catch(() => { });
    liveCoachAudioContext = null;
  }
}

function clearNativeLiveCoach() {
  stopNativeLiveCoach();
  clearCoachError();
  resetCoachChat();
  const log = document.getElementById('coach-event-log');
  if (log) log.innerHTML = '';
  addCoachEvent('Native Gemini Live is ready.');
}

function setNativeLiveButtons(isLive) {
  const startBtn = document.getElementById('coach-start-btn');
  const stopBtn = document.getElementById('coach-stop-btn');
  if (startBtn) startBtn.disabled = isLive;
  if (stopBtn) stopBtn.disabled = !isLive;
  document.getElementById('coach-pulse')?.classList.toggle('active', isLive);
  document.getElementById('coach-voice-pill')?.classList.toggle('active', isLive);
}

function setCoachStatus(text) {
  const statusEl = document.getElementById('coach-status');
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle('listening', text === 'Live');
}

function showCoachError(message) {
  const errorEl = document.getElementById('coach-error');
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }
  addCoachEvent(message);
}

function clearCoachError() {
  const errorEl = document.getElementById('coach-error');
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }
}

function resetCoachChat() {
  const log = document.getElementById('coach-chat-log');
  if (!log) return;
  log.innerHTML = '';
  appendCoachBubble('ai', 'Hello. What would you like to practice today?', false);
}

function appendCoachBubble(role, text, mergeWithPrevious = true) {
  const log = document.getElementById('coach-chat-log');
  const cleanText = String(text || '').trim();
  if (!log || !cleanText) return;

  const normalizedRole = role === 'user' ? 'user' : 'ai';
  const lastMessage = log.lastElementChild;
  if (
    mergeWithPrevious &&
    lastMessage?.dataset.role === normalizedRole &&
    lastMessage.querySelector('.coach-bubble p')
  ) {
    const textEl = lastMessage.querySelector('.coach-bubble p');
    textEl.textContent = `${textEl.textContent} ${cleanText}`.trim();
    log.scrollTop = log.scrollHeight;
    return;
  }

  const message = document.createElement('div');
  message.className = `coach-message coach-message-${normalizedRole}`;
  message.dataset.role = normalizedRole;

  const avatar = document.createElement('div');
  avatar.className = 'coach-avatar';
  avatar.textContent = normalizedRole === 'user' ? 'You' : 'AI';

  const bubble = document.createElement('div');
  bubble.className = 'coach-bubble';
  const paragraph = document.createElement('p');
  paragraph.textContent = cleanText;
  bubble.appendChild(paragraph);

  message.appendChild(avatar);
  message.appendChild(bubble);
  log.appendChild(message);
  log.scrollTop = log.scrollHeight;
}

// Live transcription arrives in small pieces that carry their own spacing.
// Each piece is added to the speaker's open bubble until the turn ends.
function appendCoachTranscript(role, chunk) {
  const log = document.getElementById('coach-chat-log');
  if (!log) return;

  const lastMessage = log.lastElementChild;
  const textEl = lastMessage?.querySelector('.coach-bubble p');
  if (lastMessage?.dataset.role === role && lastMessage.dataset.transcript === 'open' && textEl) {
    lastMessage.dataset.rawText += chunk;
    textEl.textContent = lastMessage.dataset.rawText.trim();
    log.scrollTop = log.scrollHeight;
    return;
  }

  if (!chunk.trim()) return;
  appendCoachBubble(role, chunk, false);
  log.lastElementChild.dataset.transcript = 'open';
  log.lastElementChild.dataset.rawText = chunk;
}

function closeCoachTranscripts(role) {
  const selector = role
    ? `#coach-chat-log [data-transcript="open"][data-role="${role}"]`
    : '#coach-chat-log [data-transcript="open"]';
  document.querySelectorAll(selector).forEach(message => {
    message.dataset.transcript = 'closed';
  });
}

function updateCoachClock() {
  const clockEl = document.getElementById('coach-clock');
  if (!clockEl) return;
  clockEl.textContent = new Date().toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  });
}

function addCoachEvent(text) {
  const log = document.getElementById('coach-event-log');
  if (!log) return;
  const item = document.createElement('div');
  item.className = 'coach-event-item';
  item.textContent = `${new Date().toLocaleTimeString()} - ${text}`;
  log.prepend(item);
}

function float32ToPcm16(float32Array) {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm16;
}

function resampleFloat32(float32Array, sourceRate, targetRate) {
  if (sourceRate === targetRate) return float32Array;
  const ratio = sourceRate / targetRate;
  const newLength = Math.max(1, Math.round(float32Array.length / ratio));
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const sourceIndex = i * ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(leftIndex + 1, float32Array.length - 1);
    const weight = sourceIndex - leftIndex;
    result[i] = float32Array[leftIndex] * (1 - weight) + float32Array[rightIndex] * weight;
  }

  return result;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Story Mode

function renderStoryWordList() {
  const container = document.getElementById('story-word-list');
  if (!container) return;
  container.innerHTML = '';

  fullVocabList.forEach(item => {
    const wrapper = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'story-word-checkbox';
    cb.value = item.word;
    cb.addEventListener('change', updateStorySelection);

    const span = document.createElement('span');
    span.className = 'story-word-label';
    const word = document.createElement('strong');
    word.textContent = item.word;
    const meaning = document.createElement('small');
    meaning.textContent = item.translation || item.englishMeaning || 'No saved meaning';
    span.append(word, meaning);

    wrapper.appendChild(cb);
    wrapper.appendChild(span);
    container.appendChild(wrapper);
  });
  updateStorySelection();
}

function updateStorySelection() {
  const checkboxes = document.querySelectorAll('.story-word-checkbox');
  const countEl = document.getElementById('story-selected-count');
  const maxEl = document.getElementById('story-max-count');
  const maxWords = getStoryMaxWords();

  const checkedList = Array.from(document.querySelectorAll('.story-word-checkbox:checked'));
  if (checkedList.length > maxWords) {
    checkedList.slice(maxWords).forEach(cb => { cb.checked = false; });
  }
  const checked = document.querySelectorAll('.story-word-checkbox:checked');

  if (countEl) countEl.textContent = checked.length;
  if (maxEl) maxEl.textContent = maxWords;

  if (checked.length >= maxWords) {
    checkboxes.forEach(cb => {
      if (!cb.checked) cb.disabled = true;
    });
  } else {
    checkboxes.forEach(cb => cb.disabled = false);
  }
}

function handleGenerateStory() {
  const checked = document.querySelectorAll('.story-word-checkbox:checked');
  let selectedWords = Array.from(checked).map(cb => cb.value);
  const level = document.getElementById('story-level')?.value || 'A2';
  const genre = document.getElementById('story-genre')?.value || 'daily life';
  const wordSource = document.getElementById('story-word-source')?.value || 'due';
  const maxWords = getStoryMaxWords();

  if (selectedWords.length === 0) {
    selectedWords = chooseStoryWords(wordSource, maxWords);
  } else {
    selectedWords = selectedWords.slice(0, maxWords);
  }

  if (selectedWords.length === 0) {
    alert(wordSource === 'due' ? "You don't have any due words right now." : "You don't have any vocabulary words yet!");
    return;
  }

  const outputContainer = document.getElementById('story-output-container');
  const loadingEl = document.getElementById('story-loading');
  const contentEl = document.getElementById('story-content');
  const errorEl = document.getElementById('story-error');
  const btn = document.getElementById('generate-story-btn');
  const anotherBtn = document.getElementById('generate-another-story-btn');

  outputContainer.classList.remove('hidden');
  loadingEl.classList.remove('hidden');
  contentEl.textContent = '';
  errorEl.classList.add('hidden');
  anotherBtn.classList.add('hidden');
  btn.disabled = true;
  anotherBtn.disabled = true;

  chrome.runtime.sendMessage({
    action: "generateStory",
    words: selectedWords,
    level,
    genre
  }, response => {
    btn.disabled = false;
    anotherBtn.disabled = false;
    loadingEl.classList.add('hidden');

    if (response && response.success) {
      renderStoryPackage(response.storyData || response.story, selectedWords);
      anotherBtn.classList.remove('hidden');
    } else {
      errorEl.textContent = response ? response.error : "Failed to connect to background script.";
      errorEl.classList.remove('hidden');
    }
  });
}

function getStoryMaxWords() {
  const input = document.getElementById('story-max-words');
  const value = parseInt(input?.value || '5', 10);
  const clamped = Math.min(7, Math.max(3, Number.isNaN(value) ? 5 : value));
  if (input) input.value = String(clamped);
  return clamped;
}

function chooseStoryWords(source, maxWords) {
  const now = Date.now();
  const pool = source === 'due'
    ? fullVocabList.filter(item => !item.nextReviewDate || item.nextReviewDate <= now)
    : fullVocabList;

  return [...pool]
    .sort(() => 0.5 - Math.random())
    .slice(0, maxWords)
    .map(item => item.word)
    .filter(Boolean);
}

function renderStoryPackage(storyData, selectedWords) {
  if (typeof storyData === 'string') {
    renderStoryWithHighlights(storyData, selectedWords);
    return;
  }

  const contentEl = document.getElementById('story-content');
  contentEl.innerHTML = '';
  storyStudy.selectedWords = selectedWords.map(word => String(word).toLowerCase());
  storyStudy.exploredWords.clear();
  storyStudy.fontScale = 1;

  const hero = document.createElement('div');
  hero.className = 'story-image-wrap';
  if (storyData?.imageUrl) {
    const img = document.createElement('img');
    img.src = storyData.imageUrl;
    img.alt = storyData.imagePrompt || storyData.title || 'Generated story image';
    hero.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'story-image-placeholder';
    placeholder.textContent = 'No image found for this story';
    hero.appendChild(placeholder);
  }
  contentEl.appendChild(hero);

  const title = document.createElement('h4');
  title.className = 'story-json-title';
  title.textContent = storyData?.title || 'Vocabulary Story';
  contentEl.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'story-json-meta';
  meta.textContent = [storyData?.level, storyData?.genre].filter(Boolean).join(' • ');
  contentEl.appendChild(meta);

  const readingTools = document.createElement('div');
  readingTools.className = 'story-reading-tools';
  const progress = document.createElement('span');
  progress.id = 'story-reading-progress';
  progress.className = 'story-reading-progress';
  readingTools.appendChild(progress);
  const audioBtn = document.createElement('button');
  audioBtn.type = 'button';
  audioBtn.className = 'btn sm outline';
  audioBtn.textContent = '🔊 Listen';
  audioBtn.addEventListener('click', () => playStoryAudio(storyData?.story || ''));
  const smallerBtn = document.createElement('button');
  smallerBtn.type = 'button';
  smallerBtn.className = 'story-text-control';
  smallerBtn.textContent = 'A−';
  smallerBtn.title = 'Decrease reading size';
  const largerBtn = document.createElement('button');
  largerBtn.type = 'button';
  largerBtn.className = 'story-text-control';
  largerBtn.textContent = 'A+';
  largerBtn.title = 'Increase reading size';
  readingTools.append(audioBtn, smallerBtn, largerBtn);
  contentEl.appendChild(readingTools);

  const body = document.createElement('div');
  body.className = 'story-json-body';
  contentEl.appendChild(body);
  renderStoryWithHighlights(storyData?.story || '', selectedWords, body);
  smallerBtn.addEventListener('click', () => setStoryFontScale(body, -0.1));
  largerBtn.addEventListener('click', () => setStoryFontScale(body, 0.1));
  updateStoryReadingProgress();

  const definitions = Array.isArray(storyData?.simpleDefinitions)
    ? storyData.simpleDefinitions
    : (Array.isArray(storyData?.targetWords) ? storyData.targetWords : []);

  if (definitions.length > 0) {
    const wordsBlock = document.createElement('div');
    wordsBlock.className = 'story-json-section';
    const heading = document.createElement('h5');
    heading.textContent = 'Vocabulary lab — recall first, then reveal';
    wordsBlock.appendChild(heading);
    definitions.forEach(item => {
      const row = document.createElement('details');
      row.className = 'story-definition-card';
      const summary = document.createElement('summary');
      summary.textContent = typeof item === 'string' ? item.split(':')[0] : (item.word || 'Target word');
      const definition = document.createElement('div');
      definition.className = 'story-json-row';
      if (typeof item === 'string') {
        definition.textContent = item.includes(':') ? item.slice(item.indexOf(':') + 1).trim() : item;
      } else {
        definition.textContent = `${item.meaning || item.simpleMeaning || 'No definition returned.'}${item.exampleSentence ? ' Example: ' + item.exampleSentence : ''}`;
      }
      row.append(summary, definition);
      wordsBlock.appendChild(row);
    });
    contentEl.appendChild(wordsBlock);
  }

  const questions = Array.isArray(storyData?.comprehensionQuestions)
    ? storyData.comprehensionQuestions
    : (Array.isArray(storyData?.questions) ? storyData.questions : []);

  if (questions.length > 0) {
    const questionBlock = document.createElement('div');
    questionBlock.className = 'story-json-section';
    const heading = document.createElement('h5');
    heading.textContent = 'Comprehension check';
    questionBlock.appendChild(heading);
    questions.slice(0, 3).forEach((item, index) => {
      questionBlock.appendChild(createStoryQuestionCard(item, index));
    });
    contentEl.appendChild(questionBlock);
  }
}

function setStoryFontScale(body, change) {
  storyStudy.fontScale = Math.min(1.35, Math.max(0.9, storyStudy.fontScale + change));
  body.style.fontSize = `${storyStudy.fontScale}em`;
}

function playStoryAudio(storyText) {
  const text = String(storyText || '').trim();
  if (!text) return;
  chrome.runtime.sendMessage({ action: 'speakText', text, lang: 'en-US' });
}

function updateStoryReadingProgress() {
  const progress = document.getElementById('story-reading-progress');
  if (!progress) return;
  progress.textContent = `${storyStudy.exploredWords.size}/${storyStudy.selectedWords.length} target words explored`;
}

function createStoryQuestionCard(item, index) {
  const card = document.createElement('article');
  card.className = 'story-question-card';
  const question = document.createElement('p');
  question.className = 'story-question-text';
  question.textContent = `${index + 1}. ${item.question || 'What happened in the story?'}`;
  const input = document.createElement('textarea');
  input.rows = 2;
  input.placeholder = 'Answer from memory before revealing the model answer…';
  const actions = document.createElement('div');
  actions.className = 'story-question-actions';
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.className = 'btn sm outline';
  reveal.textContent = 'Reveal model answer';
  const answer = document.createElement('div');
  answer.className = 'story-model-answer hidden';
  answer.textContent = item.answer || 'No model answer returned.';
  reveal.addEventListener('click', () => {
    answer.classList.toggle('hidden');
    reveal.textContent = answer.classList.contains('hidden') ? 'Reveal model answer' : 'Hide model answer';
  });
  actions.appendChild(reveal);
  card.append(question, input, actions, answer);
  return card;
}

function updateBatchDeleteBtn() {
  const checked = document.querySelectorAll('.row-cb:checked');
  const btn = document.getElementById('batch-delete-btn');
  const countEl = document.getElementById('batch-count');
  if (checked.length > 0) {
    btn.classList.remove('hidden');
    countEl.textContent = checked.length;
  } else {
    btn.classList.add('hidden');
  }
}

function deleteSelected() {
  const checked = document.querySelectorAll('.row-cb:checked');
  const ids = new Set(Array.from(checked).map(cb => cb.dataset.id));
  if (ids.size === 0) return;
  const label = ids.size === 1 ? '1 word' : `${ids.size} words`;
  if (!confirm(`Delete ${label} from your vocabulary?`)) return;
  updateStoredVocabList(list => list.filter(w => !ids.has(String(w.id)))).then(() => { loadData(); });
}

function renderStoryWithHighlights(storyText, selectedWords, targetEl = null) {
  const contentEl = targetEl || document.getElementById('story-content');
  const vocabSet = new Set(selectedWords.map(w => w.toLowerCase()));
  contentEl.innerHTML = '';

  // Split into alternating [non-word, word, non-word, word, ...] segments
  const parts = storyText.split(/(\b[a-zA-Z']+\b)/);
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      contentEl.appendChild(document.createTextNode(part));
    } else {
      const span = document.createElement('span');
      span.className = 'story-word';
      span.textContent = part;
      if (vocabSet.has(part.toLowerCase())) {
        span.classList.add('story-vocab-highlight');
      }
      contentEl.appendChild(span);
    }
  });
}

function initStoryTranslation() {
  const contentEl = document.getElementById('story-content');
  if (!contentEl) return;

  contentEl.addEventListener('click', e => {
    const wordSpan = e.target.closest('.story-word');
    removeStoryTooltip();
    if (!wordSpan) return;

    const word = wordSpan.textContent.trim();
    if (!word) return;

    if (wordSpan.classList.contains('story-vocab-highlight')) {
      wordSpan.classList.add('explored');
      storyStudy.exploredWords.add(word.toLowerCase());
      updateStoryReadingProgress();
    }

    const tooltip = document.createElement('div');
    tooltip.className = 'story-translate-tooltip';
    tooltip.textContent = '…';
    document.body.appendChild(tooltip);

    const rect = wordSpan.getBoundingClientRect();
    tooltip.style.left = (rect.left + window.scrollX) + 'px';
    tooltip.style.top = (rect.bottom + window.scrollY + 6) + 'px';

    chrome.runtime.sendMessage({ action: 'translate', text: word }, response => {
      if (response && response.success) {
        tooltip.textContent = response.translation;
      } else {
        tooltip.textContent = 'Could not translate';
        tooltip.classList.add('story-translate-error');
      }
    });
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.story-word') && !e.target.closest('.story-translate-tooltip')) {
      removeStoryTooltip();
    }
  });
}

function removeStoryTooltip() {
  document.querySelectorAll('.story-translate-tooltip').forEach(el => el.remove());
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Backfill Missing Data ─────────────────────────────────────
// Fetch part-of-speech for legacy words that were saved without it.

function backfillPartOfSpeech() {
  const wordsNeedingPos = fullVocabList.filter(item =>
    item.word && !item.partOfSpeech
  );
  if (wordsNeedingPos.length === 0) return;

  // Process in small batches to avoid overwhelming the API
  const batch = wordsNeedingPos.slice(0, 5);
  const foundPos = new Map();

  Promise.allSettled(
    batch.map(item =>
      sendRuntimeMessage({ action: 'lookupDictionary', word: item.word })
        .then(response => {
          if (response?.success && response.partOfSpeech) {
            item.partOfSpeech = response.partOfSpeech;
            foundPos.set(String(item.id), response.partOfSpeech);
          }
        })
    )
  ).then(() => {
    if (foundPos.size === 0) return;
    updateStoredVocabList(list => {
      list.forEach(w => {
        if (foundPos.has(String(w.id)) && !w.partOfSpeech) w.partOfSpeech = foundPos.get(String(w.id));
      });
      return list;
    });
  });
}

// ── Word Groups & Tags System ─────────────────────────────────

let currentTagWordId = null;
let workingTags = [];

function updateTagFilterDropdowns() {
  const filterTagSelect = document.getElementById('filter-tag');
  const gateTagSelect = document.getElementById('gate-tag-filter');
  if (!filterTagSelect && !gateTagSelect) return;

  const tagSet = new Set();
  fullVocabList.forEach(w => {
    if (Array.isArray(w.tags)) {
      w.tags.forEach(t => {
        const trimmed = String(t || '').trim();
        if (trimmed) tagSet.add(trimmed);
      });
    }
  });

  const sortedTags = Array.from(tagSet).sort((a, b) => a.localeCompare(b));

  if (filterTagSelect) {
    const currentVal = filterTagSelect.value;
    filterTagSelect.innerHTML = '<option value="all">All Tags</option>';
    sortedTags.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = `#${t}`;
      filterTagSelect.appendChild(opt);
    });
    if (sortedTags.includes(currentVal)) {
      filterTagSelect.value = currentVal;
    } else {
      filterTagSelect.value = 'all';
      vocabTagFilter = 'all';
    }
  }

  if (gateTagSelect) {
    const currentVal = gateTagSelect.value;
    gateTagSelect.innerHTML = '<option value="all">All Tags (Entire Queue)</option>';
    sortedTags.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = `#${t}`;
      gateTagSelect.appendChild(opt);
    });
    if (sortedTags.includes(currentVal)) {
      gateTagSelect.value = currentVal;
    } else {
      gateTagSelect.value = 'all';
      reviewGateTagFilter = 'all';
    }
  }
}

function initTagsSystem() {
  const modalClose = document.getElementById('tag-modal-close');
  const modalCancel = document.getElementById('tag-modal-cancel');
  const modalBackdrop = document.getElementById('tag-backdrop');
  const modalSave = document.getElementById('tag-modal-save');
  const addBtn = document.getElementById('add-tag-btn');
  const tagInput = document.getElementById('new-tag-input');
  const gateTagSelect = document.getElementById('gate-tag-filter');

  [modalClose, modalCancel, modalBackdrop].forEach(el => {
    if (el) el.addEventListener('click', closeTagModal);
  });

  if (modalSave) modalSave.addEventListener('click', saveWordTags);
  if (addBtn) addBtn.addEventListener('click', addTagToCurrentWord);

  if (tagInput) {
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTagToCurrentWord();
      }
    });
  }

  document.querySelectorAll('#suggested-chips .sug-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag || btn.textContent.trim();
      if (tag && !workingTags.includes(tag)) {
        workingTags.push(tag);
        renderWorkingTags();
      }
    });
  });

  if (gateTagSelect) {
    gateTagSelect.addEventListener('change', () => {
      reviewGateTagFilter = gateTagSelect.value;
      prepareReviewSession();
      renderReviewGate();
    });
  }
}

function openTagModal(wordId) {
  const wordObj = fullVocabList.find(w => String(w.id) === String(wordId));
  if (!wordObj) return;

  currentTagWordId = wordId;
  workingTags = Array.isArray(wordObj.tags) ? [...wordObj.tags] : [];

  const wordTitle = document.getElementById('tag-modal-word-title');
  if (wordTitle) wordTitle.textContent = `Tagging: "${wordObj.word}"`;

  const tagInput = document.getElementById('new-tag-input');
  if (tagInput) tagInput.value = '';

  renderWorkingTags();

  document.getElementById('tag-modal')?.classList.remove('hidden');
  document.getElementById('tag-backdrop')?.classList.remove('hidden');

  setTimeout(() => tagInput?.focus(), 100);
}

function closeTagModal() {
  document.getElementById('tag-modal')?.classList.add('hidden');
  document.getElementById('tag-backdrop')?.classList.add('hidden');
  currentTagWordId = null;
  workingTags = [];
}

function renderWorkingTags() {
  const wrap = document.getElementById('current-tags-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';

  if (workingTags.length === 0) {
    wrap.innerHTML = '<span class="muted" style="font-size: 12px;">No tags yet. Add tags or click suggestions below.</span>';
    return;
  }

  workingTags.forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `#${escapeHtml(tag)} <button type="button" class="tag-remove-btn" title="Remove tag" data-tag="${escapeHtml(tag)}">&times;</button>`;
    wrap.appendChild(chip);
  });

  wrap.querySelectorAll('.tag-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tagToRemove = btn.dataset.tag;
      workingTags = workingTags.filter(t => t !== tagToRemove);
      renderWorkingTags();
    });
  });
}

function addTagToCurrentWord() {
  const input = document.getElementById('new-tag-input');
  if (!input) return;
  let tag = input.value.trim().replace(/^#+/, '');
  if (!tag) return;

  tag = tag.slice(0, 24).replace(/,/g, '');

  if (!workingTags.includes(tag)) {
    workingTags.push(tag);
    renderWorkingTags();
  }
  input.value = '';
}

function saveWordTags() {
  if (!currentTagWordId) return;
  const wordObj = fullVocabList.find(w => String(w.id) === String(currentTagWordId));
  if (wordObj) {
    const hadTags = Array.isArray(wordObj.tags) && wordObj.tags.length > 0;
    persistVocabularyWord(wordObj, { tags: [...workingTags] });

    if (!hadTags && workingTags.length > 0) {
      addGamificationXP(10, 'First time tagging a word');
    }

    renderVocabTable();
    updateTagFilterDropdowns();
  }
  closeTagModal();
}

// ── Gamification & Badges System ──────────────────────────────

const LEVEL_DEFINITIONS = [
  { level: 1, title: 'Word Apprentice', minXp: 0, maxXp: 150 },
  { level: 2, title: 'Vocabulary Explorer', minXp: 150, maxXp: 350 },
  { level: 3, title: 'Memory Adept', minXp: 350, maxXp: 650 },
  { level: 4, title: 'Linguistic Scholar', minXp: 650, maxXp: 1050 },
  { level: 5, title: 'Polyglot Novice', minXp: 1050, maxXp: 1550 },
  { level: 6, title: 'Polyglot Adept', minXp: 1550, maxXp: 2200 },
  { level: 7, title: 'Fluency Master', minXp: 2200, maxXp: 3000 },
  { level: 8, title: 'Lexicon Legend', minXp: 3000, maxXp: 4000 },
  { level: 9, title: 'Grandmaster of Tongues', minXp: 4000, maxXp: 5500 },
  { level: 10, title: 'Language Deity', minXp: 5500, maxXp: Infinity }
];

const BADGES_DEFINITIONS = [
  {
    id: 'first_word',
    icon: '🌱',
    title: 'First Step',
    desc: 'Add your first vocabulary word',
    check: (words, streak, stats) => words.length >= 1
  },
  {
    id: 'vocab_10',
    icon: '📚',
    title: 'Word Collector',
    desc: 'Collect 10 vocabulary words',
    check: (words, streak, stats) => words.length >= 10
  },
  {
    id: 'vocab_50',
    icon: '📖',
    title: 'Lexicon Builder',
    desc: 'Collect 50 vocabulary words',
    check: (words, streak, stats) => words.length >= 50
  },
  {
    id: 'vocab_100',
    icon: '🏛️',
    title: 'Walking Dictionary',
    desc: 'Collect 100 vocabulary words',
    check: (words, streak, stats) => words.length >= 100
  },
  {
    id: 'streak_3',
    icon: '🔥',
    title: 'Habit Builder',
    desc: 'Maintain a 3-day review streak',
    check: (words, streak, stats) => (streak.currentStreak >= 3 || streak.longestStreak >= 3)
  },
  {
    id: 'streak_7',
    icon: '⚡',
    title: 'Unstoppable Flame',
    desc: 'Reach a 7-day review streak',
    check: (words, streak, stats) => (streak.currentStreak >= 7 || streak.longestStreak >= 7)
  },
  {
    id: 'master_5',
    icon: '⭐',
    title: 'Word Master',
    desc: 'Master 5 words (Repetition 4+)',
    check: (words, streak, stats) => words.filter(w => (w.repetition || 0) >= 4).length >= 5
  },
  {
    id: 'master_20',
    icon: '👑',
    title: 'Linguistic Royalty',
    desc: 'Master 20 words (Repetition 4+)',
    check: (words, streak, stats) => words.filter(w => (w.repetition || 0) >= 4).length >= 20
  },
  {
    id: 'review_25',
    icon: '🎯',
    title: 'Dedicated Mind',
    desc: 'Answer 25 review questions',
    check: (words, streak, stats) => (stats.totalReviews || 0) >= 25
  },
  {
    id: 'review_100',
    icon: '🏆',
    title: 'Century Reviewer',
    desc: 'Answer 100 review questions',
    check: (words, streak, stats) => (stats.totalReviews || 0) >= 100
  },
  {
    id: 'tagger',
    icon: '🏷️',
    title: 'Curator',
    desc: 'Tag vocabulary words into groups',
    check: (words, streak, stats) => words.some(w => Array.isArray(w.tags) && w.tags.length > 0)
  },
  {
    id: 'polyglot',
    icon: '🚀',
    title: 'High Climber',
    desc: 'Advance to learning Level 3 or higher',
    check: (words, streak, stats, gamer) => (gamer.level || 1) >= 3
  }
];

function getLevelInfo(totalXp) {
  const xp = Math.max(0, totalXp || 0);
  let currentLevelObj = LEVEL_DEFINITIONS[0];

  for (let i = LEVEL_DEFINITIONS.length - 1; i >= 0; i--) {
    if (xp >= LEVEL_DEFINITIONS[i].minXp) {
      currentLevelObj = LEVEL_DEFINITIONS[i];
      break;
    }
  }

  const level = currentLevelObj.level;
  const title = currentLevelObj.title;
  const isMax = currentLevelObj.maxXp === Infinity;
  const minXp = currentLevelObj.minXp;
  const maxXp = currentLevelObj.maxXp;
  const progressInLevel = isMax ? 100 : (xp - minXp);
  const span = isMax ? 100 : (maxXp - minXp);
  const progressPct = isMax ? 100 : Math.min(100, Math.max(0, Math.round((progressInLevel / span) * 100)));

  return {
    level,
    title,
    xp,
    minXp,
    maxXp,
    progressInLevel,
    span,
    progressPct,
    nextLevel: isMax ? level : level + 1,
    isMax
  };
}

function addGamificationXP(amount, reason = '') {
  chrome.storage.local.get({
    userGamification: { xp: 0, level: 1, badges: [] }
  }, data => {
    const gamer = data.userGamification || { xp: 0, level: 1, badges: [] };
    const oldXp = gamer.xp || 0;

    const newXp = oldXp + amount;
    const levelInfo = getLevelInfo(newXp);
    gamer.xp = newXp;
    gamer.level = levelInfo.level;
    gamer.badges = gamer.badges || [];

    chrome.storage.local.set({ userGamification: gamer }, () => {
      const statsView = document.getElementById('stats-view');
      if (statsView && statsView.classList.contains('active')) {
        renderGamification();
      }
    });
  });
}

function renderGamification() {
  chrome.storage.local.get({
    userGamification: { xp: 0, level: 1, badges: [] },
    reviewStreak: { currentStreak: 0, lastReviewDate: '', longestStreak: 0 },
    reviewStats: { totalReviews: 0, correctReviews: 0, history: {} }
  }, data => {
    const gamer = data.userGamification || { xp: 0, level: 1, badges: [] };
    const streak = data.reviewStreak || { currentStreak: 0, lastReviewDate: '', longestStreak: 0 };
    const stats = data.reviewStats || { totalReviews: 0, correctReviews: 0, history: {} };

    const levelInfo = getLevelInfo(gamer.xp || 0);

    const gamerTitle = document.getElementById('gamer-title');
    const gamerLevelPill = document.getElementById('gamer-level-pill');
    const gamerTotalXp = document.getElementById('gamer-total-xp');
    const gamerNextLevel = document.getElementById('gamer-next-level');
    const gamerXpProgressText = document.getElementById('gamer-xp-progress-text');
    const gamerXpBar = document.getElementById('gamer-xp-bar');

    if (gamerTitle) gamerTitle.textContent = levelInfo.title;
    if (gamerLevelPill) gamerLevelPill.textContent = `Level ${levelInfo.level}`;
    if (gamerTotalXp) gamerTotalXp.textContent = levelInfo.xp;

    if (gamerNextLevel) {
      gamerNextLevel.textContent = levelInfo.isMax ? 'Max Level' : `Level ${levelInfo.nextLevel}`;
    }

    if (gamerXpProgressText) {
      if (levelInfo.isMax) {
        gamerXpProgressText.textContent = `${levelInfo.xp} XP (Mastered)`;
      } else {
        gamerXpProgressText.textContent = `${levelInfo.progressInLevel} / ${levelInfo.span} XP`;
      }
    }

    if (gamerXpBar) {
      gamerXpBar.style.width = `${levelInfo.progressPct}%`;
    }

    const unlockedBadgesSet = new Set(gamer.badges || []);
    let newlyUnlocked = false;

    BADGES_DEFINITIONS.forEach(b => {
      if (!unlockedBadgesSet.has(b.id)) {
        if (b.check(fullVocabList, streak, stats, gamer)) {
          unlockedBadgesSet.add(b.id);
          newlyUnlocked = true;
        }
      }
    });

    if (newlyUnlocked) {
      gamer.badges = Array.from(unlockedBadgesSet);
      chrome.storage.local.set({ userGamification: gamer });
    }

    const badgesContainer = document.getElementById('badges-container');
    if (badgesContainer) {
      badgesContainer.innerHTML = '';
      BADGES_DEFINITIONS.forEach(b => {
        const isUnlocked = unlockedBadgesSet.has(b.id);
        const card = document.createElement('div');
        card.className = `badge-card ${isUnlocked ? 'unlocked' : 'locked'}`;
        card.innerHTML = `
          <div class="badge-icon">${isUnlocked ? b.icon : '🔒'}</div>
          <div class="badge-title">${escapeHtml(b.title)}</div>
          <div class="badge-desc">${escapeHtml(b.desc)}</div>
          <span class="badge-status-tag">${isUnlocked ? 'Unlocked ✓' : 'Locked'}</span>
        `;
        badgesContainer.appendChild(card);
      });
    }
  });
}
