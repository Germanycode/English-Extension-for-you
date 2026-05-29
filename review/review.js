let fullVocabList = [];
let dueWords = [];
let sessionTotal = 0;      // total words at start of this session
let currentReviewIndex = 0;
let currentWord = null;
let reviewGateTimer = null;
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
  document.getElementById('export-btn').addEventListener('click', exportData);
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
    chrome.storage.local.set({ vocabList: fullVocabList });
  }
}

// ── Vocabulary Table ─────────────────────────────────────────

function renderVocabTable() {
  // BUG FIX: use the specific ID selector, not querySelector('table') which grabs the first match
  const tbody = document.querySelector('#vocab-table tbody');
  const emptyState = document.getElementById('empty-state');
  const vocabTable = document.getElementById('vocab-table');

  tbody.innerHTML = '';

  if (fullVocabList.length === 0) {
    emptyState.classList.remove('hidden');
    vocabTable.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  vocabTable.classList.remove('hidden');

  // Sort newest first
  const sorted = [...fullVocabList].sort((a, b) => b.dateAdded - a.dateAdded);

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

    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="row-cb" data-id="${escapeHtml(item.id)}"></td>
      <td><a href="#" class="vocab-word-link" data-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.word)}</strong></a>${posBadgeHtml}</td>
      <td class="en-meaning-cell" title="${enMeaning}">${enMeaning}</td>
      <td class="vi-cell">${viTranslation}</td>
      <td class="context-cell">
        <span class="ctx-text" title="${escapeHtml(context)}">${context ? escapeHtml(context) : '—'}</span>
        <button class="btn sm outline edit-ctx-btn" data-id="${escapeHtml(item.id)}" title="Edit context">✏ Edit</button>
      </td>
      <td>${masteryHtml}</td>
      <td>${nextReviewHtml}</td>
      <td>
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
    fullVocabList = fullVocabList.filter(w => String(w.id) !== id);
    chrome.storage.local.set({ vocabList: fullVocabList }, () => {
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
    fullVocabList[idx].context = newContext;
    chrome.storage.local.set({ vocabList: fullVocabList }, () => {
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
  // BUG FIX: include words with missing nextReviewDate
  dueWords = fullVocabList.filter(item => !item.nextReviewDate || item.nextReviewDate <= now);

  // Shuffle
  dueWords.sort(() => Math.random() - 0.5);

  updateBadge();
}

function showReviewGate() {
  prepareReviewSession();
  stopReviewGateTimer();
  currentReviewIndex = 0;
  sessionTotal = dueWords.length;
  updateProgressRing(0, sessionTotal);

  document.getElementById('review-gate').classList.remove('hidden');
  document.getElementById('review-container').classList.add('hidden');
  document.getElementById('review-summary-panel').classList.add('hidden');
  document.getElementById('review-complete').classList.add('hidden');
  document.querySelectorAll('.question-block').forEach(el => el.classList.add('hidden'));

  renderReviewGate();
  reviewGateTimer = setInterval(renderReviewGate, 1000);
}

function renderReviewGate() {
  const now = Date.now();
  const dueCount = fullVocabList.filter(item => !item.nextReviewDate || item.nextReviewDate <= now).length;
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
    dueWords = fullVocabList.filter(item => !item.nextReviewDate || item.nextReviewDate <= now);
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

function startReview(usePreparedQueue = false) {
  if (!usePreparedQueue) {
    prepareReviewSession();
  }
  currentReviewIndex = 0;
  sessionTotal = dueWords.length;
  stopReviewGateTimer();

  updateProgressRing(0, sessionTotal);
  document.getElementById('review-gate').classList.add('hidden');

  if (dueWords.length === 0) {
    document.getElementById('review-container').classList.add('hidden');
    document.getElementById('review-complete').classList.remove('hidden');
    document.getElementById('review-progress').textContent = '0 left today';
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
    return;
  }

  document.getElementById('review-container').classList.remove('hidden');
  document.getElementById('review-gate').classList.add('hidden');

  currentWord = dueWords[currentReviewIndex];
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
  else if (rep === 3 && hasCollocations(currentWord)) type = 'collocation';
  else if (rep === 3 && ((currentWord.synonyms && currentWord.synonyms.length > 0) || (currentWord.antonyms && currentWord.antonyms.length > 0))) type = 'synonym';
  else if (rep >= 4) type = hasCollocations(currentWord) && Math.random() > 0.5 ? 'collocation' : 'sentence';

  switch (type) {
    case 'mcq': renderMCQ(); break;
    case 'picture': renderPicture(); break;
    case 'match': renderMatch(); break;
    case 'synonym': renderSynonym(); break;
    case 'collocation': renderCollocation(); break;
    case 'sentence': renderSentence(); break;
  }
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
    currentWord.imageUrl = '';
    persistVocabularyWord(currentWord);
    document.getElementById('qt-picture').classList.add('hidden');
    renderMCQ();
  };
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
        updateSM2(wObj, 4);
        if (wObj.id !== currentWord.id) {
          const dueIdx = dueWords.findIndex(w => w.id === wObj.id);
          if (dueIdx > currentReviewIndex) {
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
        setTimeout(() => showSummaryPanel(), 1000);
      } else {
        if (wordObjWord) updateSM2(wordObjWord, 0);
        if (wordObjDef) updateSM2(wordObjDef, 0);
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

  const quality = isCorrect ? 4 : 0;
  updateSM2(currentWord, quality);

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

async function populateSummaryPanel(wordObj) {
  document.getElementById('summary-word').textContent = wordObj.word;
  document.getElementById('summary-meaning').textContent = wordObj.englishMeaning || '—';
  document.getElementById('summary-translation').textContent = wordObj.translation || '—';
  document.getElementById('summary-example').textContent = wordObj.context || '—';
  renderSummaryCollocations(wordObj);

  const imgEl = document.getElementById('summary-image');
  const imgPlaceholder = document.getElementById('summary-image-placeholder');
  imgEl.classList.add('hidden');
  imgPlaceholder.classList.remove('hidden');
  imgPlaceholder.textContent = 'Loading image...';
  imgEl.onerror = () => {
    imgEl.onerror = null;
    wordObj.imageUrl = '';
    persistVocabularyWord(wordObj);
    imgEl.classList.add('hidden');
    imgPlaceholder.classList.remove('hidden');
    imgPlaceholder.textContent = 'No image available';
  };

  // Fetch missing media whenever imageUrl, pronunciation, or collocations are absent.
  if (!wordObj.imageUrl || !wordObj.pronunciation || !hasCollocations(wordObj)) {
    await fetchMissingMedia(wordObj);
    renderSummaryCollocations(wordObj);
  }

  const ipaEl = document.getElementById('summary-ipa');
  if (wordObj.pronunciation) {
    ipaEl.textContent = wordObj.pronunciation;
    ipaEl.classList.remove('hidden');
  } else {
    ipaEl.classList.add('hidden');
  }

  if (hasRealVocabularyImage(wordObj)) {
    imgEl.src = wordObj.imageUrl;
    imgEl.classList.remove('hidden');
    imgPlaceholder.classList.add('hidden');
  } else {
    imgEl.classList.add('hidden');
    imgPlaceholder.classList.remove('hidden');
    imgPlaceholder.textContent = 'No image available';
  }
}

async function fetchMissingMedia(wordObj) {
  let updated = false;

  if (!wordObj.pronunciation && !wordObj.audioUrl) {
    try {
      const dictRes = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(wordObj.word)}`);
      if (dictRes.ok) {
        const dictData = await dictRes.json();
        const phonetics = dictData[0]?.phonetics || [];
        const validPhonetic = phonetics.find(p => p.text && p.audio) || phonetics.find(p => p.text) || phonetics[0];
        if (validPhonetic) {
          wordObj.pronunciation = validPhonetic.text || '';
          wordObj.audioUrl = validPhonetic.audio || '';
          updated = true;
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
        wordObj.synonyms = [...new Set(synonyms)].slice(0, 5);
        wordObj.antonyms = [...new Set(antonyms)].slice(0, 5);

        if (dictExample) {
          wordObj.context = dictExample; // Upgrade messy context to clean dictionary example
          updated = true;
          // Dynamically update the summary panel if it's currently showing
          const exampleEl = document.getElementById('summary-example');
          if (exampleEl) exampleEl.textContent = dictExample;
        }
      }
    } catch (e) { console.warn("Dict API error:", e); }
  }

  if (!hasRealVocabularyImage(wordObj)) {
    const imageUrl = await fetchVocabularyImage(wordObj);
    if (imageUrl && imageUrl !== wordObj.imageUrl) {
      wordObj.imageUrl = imageUrl;
      updated = true;
    }
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
        updated = true;
      }
    } catch (e) {
      console.warn("Collocation fetch error:", e);
    }
  }

  if (wordObj.pronunciation === undefined) wordObj.pronunciation = '';
  if (wordObj.audioUrl === undefined) wordObj.audioUrl = '';
  if (isGeneratedVocabularyImage(wordObj.imageUrl)) {
    wordObj.imageUrl = '';
    updated = true;
  }

  if (updated) {
    persistVocabularyWord(wordObj);
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
    persistVocabularyWord(wordObj);
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

function getVocabularyImageQueries(wordObj) {
  const word = String(wordObj.word || '').trim();
  const originalWord = String(wordObj.originalWord || '').trim();
  const stopWords = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'used', 'use', 'person', 'thing', 'someone', 'something']);
  const candidates = [
    word,
    originalWord,
    `${word} illustration`,
    `${word} concept`,
    `${word} object`
  ];
  const sourceText = `${wordObj.englishMeaning || ''} ${wordObj.context || ''}`.toLowerCase();
  const keywords = sourceText
    .match(/[a-z][a-z'-]{3,}/g)
    ?.filter(item => !stopWords.has(item) && item !== word)
    .slice(0, 4) || [];
  if (keywords.length > 0) candidates.push(`${word} ${keywords.join(' ')}`);
  return [...new Set(candidates.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 6);
}

async function fetchVocabularyImage(wordObj) {
  const queries = getVocabularyImageQueries(wordObj);
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
  } catch (e) {
    console.warn("Pixabay API error:", e);
    return '';
  }
}

function persistVocabularyWord(wordObj) {
  const idx = fullVocabList.findIndex(w => w.id === wordObj.id);
  if (idx !== -1) {
    fullVocabList[idx] = wordObj;
    chrome.storage.local.set({ vocabList: fullVocabList });
  }
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
  if (currentWord && currentWord.audioUrl) {
    const audio = new Audio(currentWord.audioUrl);
    audio.play().catch(e => console.error("Audio play error", e));
  } else if (currentWord && currentWord.word) {
    const utterance = new SpeechSynthesisUtterance(currentWord.word);
    utterance.lang = 'en-US';
    speechSynthesis.speak(utterance);
  }
}

// ── SM-2 Algorithm ────────────────────────────────────────────

function updateSM2(wordObj, quality) {
  const intervals = [0, 20 / (24 * 60), 1, 3, 7, 14];

  if (quality >= 3) {
    // BUG FIX: guard against undefined repetition (NaN)
    wordObj.repetition = (wordObj.repetition || 0) + 1;
    wordObj.interval = wordObj.repetition >= intervals.length
      ? 14
      : intervals[wordObj.repetition];
  } else {
    wordObj.repetition = 0;
    wordObj.interval = 20 / (24 * 60); // wrong: review again in 20 minutes
  }

  const now = new Date().getTime();
  wordObj.nextReviewDate = now + wordObj.interval * 24 * 60 * 60 * 1000;

  const idx = fullVocabList.findIndex(w => w.id === wordObj.id);
  if (idx !== -1) fullVocabList[idx] = wordObj;

  chrome.storage.local.set({ vocabList: fullVocabList }, () => {
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

// ── Export ────────────────────────────────────────────────────

function exportData() {
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(fullVocabList, null, 2));
  const a = document.createElement('a');
  a.setAttribute('href', dataStr);
  a.setAttribute('download', 'germanyvocab_vocab.json');
  document.body.appendChild(a);
  a.click();
  a.remove();
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

    liveCoachAudioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: LIVE_COACH_INPUT_RATE
    });
    await liveCoachAudioContext.resume();
    liveCoachPlaybackTime = liveCoachAudioContext.currentTime;
    pauseMusicForLiveCoach();

    liveCoachStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        channelCount: { ideal: 1 },
        sampleRate: { ideal: LIVE_COACH_INPUT_RATE }
      }
    });

    liveCoachSocket = new WebSocket(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`
    );

    liveCoachSocket.onopen = () => {
      liveCoachStarted = true;
      addCoachEvent('Connected to Gemini Live.');
      sendNativeLiveSetup();
    };

    liveCoachSocket.onmessage = async event => {
      try {
        const message = await parseNativeLiveMessage(event.data);
        handleNativeLiveMessage(message);
      } catch (error) {
        showCoachError(`Could not read Gemini Live message: ${error.message}`);
      }
    };

    liveCoachSocket.onerror = () => {
      showCoachError('Gemini Live WebSocket error. Check your API key and Live API access.');
      stopNativeLiveCoach();
    };

    liveCoachSocket.onclose = event => {
      const closeDetail = event.reason || `code ${event.code}`;
      addCoachEvent(`Live session closed: ${closeDetail}`);
      stopNativeLiveCoach(false);
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

function startNativeLiveMicrophone() {
  liveCoachSource = liveCoachAudioContext.createMediaStreamSource(liveCoachStream);
  liveCoachProcessor = liveCoachAudioContext.createScriptProcessor(4096, 1, 1);
  resetLiveCoachVoiceGate();

  liveCoachProcessor.onaudioprocess = event => {
    if (!liveCoachStarted || liveCoachSocket?.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);

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
  };

  liveCoachSource.connect(liveCoachProcessor);
  liveCoachProcessor.connect(liveCoachAudioContext.destination);
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
    liveCoachPlaybackTime = liveCoachAudioContext.currentTime;
    addCoachEvent('You interrupted Gemini.');
  }

  const parts = serverContent.modelTurn?.parts || serverContent.model_turn?.parts || [];
  parts.forEach(part => {
    const inlineData = part.inlineData || part.inline_data;
    const audioData = inlineData?.data;
    if (audioData) playNativeLiveAudio(audioData);
  });
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
  const startAt = Math.max(liveCoachPlaybackTime, liveCoachAudioContext.currentTime);
  source.start(startAt);
  liveCoachPlaybackTime = startAt + audioBuffer.duration;
  liveCoachAiSpeakingUntil = Math.max(liveCoachAiSpeakingUntil, liveCoachPlaybackTime + LIVE_COACH_AI_DUCK_SECONDS);
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
  if (icon) icon.textContent = 'â–¶';
  document.getElementById('music-toggle')?.classList.remove('playing');
}

function resumeMusicAfterLiveCoach() {
  const audio = document.getElementById('bg-audio');
  if (!audio || !liveCoachPausedMusic) return;

  liveCoachPausedMusic = false;
  audio.play().then(() => {
    const icon = document.getElementById('music-icon');
    if (icon) icon.textContent = 'â¸';
    document.getElementById('music-toggle')?.classList.add('playing');
  }).catch(() => { });
}

function stopNativeLiveCoach(closeSocket = true) {
  liveCoachStarted = false;
  liveCoachSetupComplete = false;
  resetLiveCoachVoiceGate();
  resumeMusicAfterLiveCoach();
  setNativeLiveButtons(false);
  setCoachStatus('Ready');

  if (liveCoachProcessor) {
    liveCoachProcessor.disconnect();
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
    span.textContent = item.word;

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

  const body = document.createElement('div');
  body.className = 'story-json-body';
  contentEl.appendChild(body);
  renderStoryWithHighlights(storyData?.story || '', selectedWords, body);

  const definitions = Array.isArray(storyData?.simpleDefinitions)
    ? storyData.simpleDefinitions
    : (Array.isArray(storyData?.targetWords) ? storyData.targetWords : []);

  if (definitions.length > 0) {
    const wordsBlock = document.createElement('div');
    wordsBlock.className = 'story-json-section';
    wordsBlock.innerHTML = '<h5>Simple Definitions</h5>';
    definitions.forEach(item => {
      const row = document.createElement('div');
      row.className = 'story-json-row';
      if (typeof item === 'string') {
        row.textContent = item;
      } else {
        row.textContent = `${item.word || ''}: ${item.meaning || item.simpleMeaning || ''}${item.exampleSentence ? ' Example: ' + item.exampleSentence : ''}`;
      }
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
    questionBlock.innerHTML = '<h5>Questions</h5>';
    questions.slice(0, 3).forEach(item => {
      const row = document.createElement('div');
      row.className = 'story-json-row';
      row.textContent = `${item.question || ''} Answer: ${item.answer || ''}`;
      questionBlock.appendChild(row);
    });
    contentEl.appendChild(questionBlock);
  }
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
  fullVocabList = fullVocabList.filter(w => !ids.has(String(w.id)));
  chrome.storage.local.set({ vocabList: fullVocabList }, () => { loadData(); });
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
