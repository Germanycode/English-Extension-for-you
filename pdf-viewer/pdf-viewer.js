/* ═══════════════════════════════════════════════
   GermanyVocab — PDF Viewer Script (pdf-viewer.js)
   Renders PDFs via PDF.js with a selectable text
   layer so content.js can intercept word selections.
   ═══════════════════════════════════════════════ */

// ── PDF.js worker setup — use local bundled worker to satisfy MV3 CSP ──
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf-viewer/lib/pdf.worker.min.js');

// ── State ────────────────────────────────────────
let pdfDoc      = null;
let currentPage = 1;
let totalPages  = 0;
let scale       = 1.5;        // fallback default — overridden by auto fit-to-width on load
let renderTask  = null;       // tracks in-flight renders
let isRendering = false;
let currentPdfName = '';

// ── DOM refs (initialised inside DOMContentLoaded to guarantee elements exist) ──
let pdfScroll, emptyState, loadingScreen, loadingSub, hintPill;
let fileNameText, fileNameDisplay;
let btnPrev, btnNext, pageInput, totalLabel;
let btnZoomIn, btnZoomOut, btnZoomFit, zoomDisplay, zoomSelect;
let btnOpenFile, fileInput, btnMusic, bgMusic, musicSelect;
let errorBanner, errorTitle, errorBody, errorBannerClose;

// ── Init: check URL params ────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Assign all DOM refs now that the document is ready
  pdfScroll       = document.getElementById('pdf-scroll');
  emptyState      = document.getElementById('empty-state');
  loadingScreen   = document.getElementById('loading-screen');
  loadingSub      = document.getElementById('loading-sub');
  hintPill        = document.getElementById('hint-pill');
  fileNameText    = document.getElementById('file-name-text');
  fileNameDisplay = document.getElementById('file-name-display');
  btnPrev         = document.getElementById('btn-prev');
  btnNext         = document.getElementById('btn-next');
  pageInput       = document.getElementById('page-input');
  totalLabel      = document.getElementById('total-pages');
  btnZoomIn       = document.getElementById('btn-zoom-in');
  btnZoomOut      = document.getElementById('btn-zoom-out');
  btnZoomFit      = document.getElementById('btn-zoom-fit');
  zoomDisplay     = document.getElementById('zoom-display');
  zoomSelect      = document.getElementById('zoom-select');
  btnOpenFile     = document.getElementById('btn-open-file');
  fileInput       = document.getElementById('file-input');
  btnMusic        = document.getElementById('btn-music');
  bgMusic         = document.getElementById('bg-music');
  musicSelect     = document.getElementById('music-select');
  errorBanner     = document.getElementById('error-banner');
  errorTitle      = document.getElementById('error-title');
  errorBody       = document.getElementById('error-body');
  errorBannerClose = document.getElementById('error-banner-close');

  const params  = new URLSearchParams(window.location.search);
  const fileUrl = params.get('file');

  if (fileUrl) {
    loadPdf(fileUrl);
  } else {
    showEmptyState();
  }

  setupControls();
  applyPersonalization();

  // Listen for setting changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.appName || changes.customIconDataUrl)) {
      applyPersonalization();
    }
  });
});

// ── Personalization ──

function applyPersonalization() {
  chrome.storage.local.get({ appName: 'GermanyVocab', customIconDataUrl: '' }, (items) => {
    const name = items.appName || 'GermanyVocab';
    
    // Update toolbar brand
    const brand = document.querySelector('.toolbar-brand');
    if (brand) brand.textContent = name;
    
    // Update toolbar icon
    const logoIcon = document.querySelector('.toolbar-logo-icon');
    if (logoIcon) {
      logoIcon.src = items.customIconDataUrl || '../assets/icons/icon48.png';
    }

    // Update tab title (considering loaded PDF)
    if (currentPdfName) {
      document.title = `${currentPdfName} — ${name} PDF Viewer`;
    } else {
      document.title = `PDF Viewer — ${name}`;
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

// ══════════════════════════════════════════════════
// CORE — Load & Render PDF
// ══════════════════════════════════════════════════

async function loadPdf(url, customFileName = null) {
  hideError();
  showLoading('Loading document…');

  // Update title bar
  let fileName = customFileName;
  if (!fileName) {
    fileName = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'document.pdf';
  }
  currentPdfName = fileName;
  chrome.storage.local.get({ appName: 'GermanyVocab' }, (items) => {
    const name = items.appName || 'GermanyVocab';
    document.title = `${fileName} — ${name} PDF Viewer`;
  });
  fileNameText.textContent = fileName;
  fileNameDisplay.title    = customFileName ? fileName : decodeURIComponent(url);

  try {
    loadingSub.textContent = 'Fetching PDF data…';

    const loadingTask = pdfjsLib.getDocument({
      url,
      withCredentials: false,
      disableStream:   false,
      disableRange:    false,
    });

    loadingTask.onProgress = ({ loaded, total }) => {
      if (total) {
        const pct = Math.round((loaded / total) * 100);
        loadingSub.textContent = `Downloading… ${pct}%`;
      }
    };

    pdfDoc     = await loadingTask.promise;
    totalPages = pdfDoc.numPages;
    currentPage = 1;

    // Update UI
    totalLabel.textContent = totalPages;
    pageInput.max          = totalPages;
    updateNavButtons();
    enableZoom(true);

    // ── Auto fit-to-width: calculate scale from page 1 so the PDF fills the viewer ──
    loadingSub.textContent = 'Calculating best zoom…';
    const firstPage      = await pdfDoc.getPage(1);
    const naturalVp      = firstPage.getViewport({ scale: 1 });
    const availableWidth = pdfScroll.clientWidth - 48; // subtract padding
    if (availableWidth > 0 && naturalVp.width > 0) {
      scale = Math.min(3.0, Math.max(0.5, availableWidth / naturalVp.width));
    }
    zoomDisplay.textContent = `${Math.round(scale * 100)}%`;

    loadingSub.textContent = `Rendering ${totalPages} page${totalPages > 1 ? 's' : ''}…`;

    // Render all pages
    emptyState.style.display  = 'none';
    pdfScroll.style.display   = 'flex';
    pdfScroll.innerHTML       = '';

    for (let p = 1; p <= totalPages; p++) {
      loadingSub.textContent = `Rendering page ${p} of ${totalPages}…`;
      await renderPage(p);
    }

    hideLoading();
    showHint();
    scrollToPage(currentPage);

    // Play music when PDF is successfully loaded
    if (bgMusic) {
      bgMusic.play().catch(err => console.log('Autoplay blocked:', err));
      if (btnMusic) {
        btnMusic.style.display = 'inline-block';
        btnMusic.textContent = '🔊';
        btnMusic.title = 'Mute background music';
      }
    }

  } catch (err) {
    console.error('[GV PDF Viewer] Load error:', err);
    hideLoading();
    showEmptyState();
    showError(err, url);
  }
}

async function renderPage(pageNum) {
  const page     = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  // ── Wrapper div ──
  const wrapper = document.createElement('div');
  wrapper.className          = 'pdf-page-wrapper';
  wrapper.id                 = `page-${pageNum}`;
  wrapper.dataset.page       = pageNum;
  wrapper.style.width        = `${viewport.width}px`;
  wrapper.style.height       = `${viewport.height}px`;

  // ── Page label ──
  const label = document.createElement('div');
  label.className   = 'page-label';
  label.textContent = `Page ${pageNum}`;
  wrapper.appendChild(label);

  // ── Canvas ──
  const canvas  = document.createElement('canvas');
  const ctx     = canvas.getContext('2d');
  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  wrapper.appendChild(canvas);

  // ── Render canvas ──
  await page.render({ canvasContext: ctx, viewport }).promise;

  // ── Text layer (enables selection for content.js!) ──
  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';
  textLayerDiv.style.width  = `${viewport.width}px`;
  textLayerDiv.style.height = `${viewport.height}px`;
  textLayerDiv.style.setProperty('--scale-factor', viewport.scale);
  wrapper.appendChild(textLayerDiv);

  const textContent = await page.getTextContent();

  // PDF.js 3.x: renderTextLayer is a class, not a free function
  const textLayerRender = new pdfjsLib.renderTextLayer({
    textContentSource: textContent,
    container:         textLayerDiv,
    viewport,
    textDivs:          [],
  });
  await textLayerRender.promise;

  pdfScroll.appendChild(wrapper);
}

// ══════════════════════════════════════════════════
// ZOOM
// ══════════════════════════════════════════════════

function setZoom(newScale) {
  scale = Math.min(3.0, Math.max(0.5, newScale));
  zoomDisplay.textContent = `${Math.round(scale * 100)}%`;
  reRenderAll();
}

function fitToWidth() {
  const containerWidth = pdfScroll.clientWidth - 48; // padding
  if (!pdfDoc) return;
  pdfDoc.getPage(1).then(page => {
    const vp = page.getViewport({ scale: 1 });
    setZoom(containerWidth / vp.width);
  });
}

async function reRenderAll() {
  if (!pdfDoc || isRendering) return;
  isRendering = true;
  pdfScroll.innerHTML = '';

  for (let p = 1; p <= totalPages; p++) {
    await renderPage(p);
  }
  isRendering = false;
  scrollToPage(currentPage);
}

// ══════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════

function scrollToPage(pageNum) {
  const el = document.getElementById(`page-${pageNum}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function goToPage(pageNum) {
  if (!pdfDoc) return;
  currentPage = Math.min(totalPages, Math.max(1, pageNum));
  pageInput.value = currentPage;
  updateNavButtons();
  scrollToPage(currentPage);
}

function updateNavButtons() {
  btnPrev.disabled = currentPage <= 1;
  btnNext.disabled = currentPage >= totalPages;
  pageInput.value  = currentPage;
}

// Track which page is most visible as user scrolls
function observePages() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const num = parseInt(entry.target.dataset.page, 10);
        if (num && num !== currentPage) {
          currentPage = num;
          updateNavButtons();
        }
      }
    });
  }, { root: pdfScroll, threshold: 0.3 });

  document.querySelectorAll('.pdf-page-wrapper').forEach(el => observer.observe(el));
}

// ══════════════════════════════════════════════════
// FILE SELECTION
// ══════════════════════════════════════════════════

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  const fileUrl = URL.createObjectURL(file);
  
  // Clear the input so selecting the same file again triggers 'change'
  event.target.value = '';

  loadPdf(fileUrl, file.name);
}

// ══════════════════════════════════════════════════
// CONTROLS — wire up all buttons
// ══════════════════════════════════════════════════

function setupControls() {
  // Open file
  btnOpenFile.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileSelect);
  initMusicControls();

  // Music toggle
  if (btnMusic && bgMusic) {
    btnMusic.addEventListener('click', () => {
      if (bgMusic.paused) {
        bgMusic.play();
        btnMusic.textContent = '🔊';
        btnMusic.title = 'Mute background music';
      } else {
        bgMusic.pause();
        btnMusic.textContent = '🔇';
        btnMusic.title = 'Play background music';
      }
    });
  }

  // Navigation
  btnPrev.addEventListener('click', () => goToPage(currentPage - 1));
  btnNext.addEventListener('click', () => goToPage(currentPage + 1));

  pageInput.addEventListener('change', () => {
    const num = parseInt(pageInput.value, 10);
    if (!isNaN(num)) goToPage(num);
  });

  pageInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const num = parseInt(pageInput.value, 10);
      if (!isNaN(num)) goToPage(num);
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.target === pageInput) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') goToPage(currentPage + 1);
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   goToPage(currentPage - 1);
    if (e.key === '+' || e.key === '=') setZoom(scale + 0.1);
    if (e.key === '-')                  setZoom(scale - 0.1);
    if (e.key === '0')                  setZoom(1.25);
    if (e.key === 'f' || e.key === 'F') fitToWidth();
    if (e.key === 'o' || e.key === 'O') fileInput.click();
  });

  // Zoom
  btnZoomIn.addEventListener('click',  () => setZoom(scale + 0.25));
  btnZoomOut.addEventListener('click', () => setZoom(scale - 0.25));
  btnZoomFit.addEventListener('click', fitToWidth);

  // Zoom preset select
  const zoomSelect = document.getElementById('zoom-select');
  if (zoomSelect) {
    zoomSelect.addEventListener('change', () => {
      const val = zoomSelect.value;
      if (val === 'fit') {
        fitToWidth();
      } else {
        setZoom(parseFloat(val));
      }
      zoomSelect.value = ''; // reset so same value can be re-selected
    });
  }

  // Scroll → update page indicator
  pdfScroll.addEventListener('scroll', () => {
    // lightweight approach: check which page top is nearest scroll top
    const scrollTop = pdfScroll.scrollTop;
    const pages = [...document.querySelectorAll('.pdf-page-wrapper')];
    for (let i = pages.length - 1; i >= 0; i--) {
      if (pages[i].offsetTop <= scrollTop + 80) {
        const num = parseInt(pages[i].dataset.page, 10);
        if (num && num !== currentPage) {
          currentPage = num;
          updateNavButtons();
        }
        break;
      }
    }
  });

  // Error banner close
  errorBannerClose.addEventListener('click', hideError);
}

// ══════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════

function initMusicControls() {
  if (!bgMusic) return;

  const tracks = window.GV_MUSIC_TRACKS || [];
  const defaultTrack = (typeof gvFindMusicTrack === 'function' ? gvFindMusicTrack('reading') : null) || tracks[0] || {
    id: 'reading',
    title: 'Reading Music',
    src: '../assets/musics/reading-music.mp3'
  };

  if (musicSelect) {
    musicSelect.innerHTML = '';
    tracks.forEach(track => {
      const option = document.createElement('option');
      option.value = track.id;
      option.textContent = track.title;
      musicSelect.appendChild(option);
    });
  }

  function applyTrack(trackId, shouldKeepPlaying = false) {
    const track = typeof gvFindMusicTrack === 'function' ? gvFindMusicTrack(trackId) : defaultTrack;
    const wasPlaying = shouldKeepPlaying && !bgMusic.paused;

    if (!bgMusic.src.endsWith(track.src.replace('../', ''))) {
      bgMusic.src = track.src;
      bgMusic.load();
    }

    if (musicSelect) musicSelect.value = track.id;

    if (wasPlaying) {
      bgMusic.play().catch(() => {});
    }
  }

  chrome.storage.local.get({
    backgroundMusicTrack: defaultTrack.id,
    backgroundMusicVolume: 0.5
  }, items => {
    applyTrack(items.backgroundMusicTrack);
    bgMusic.volume = Number(items.backgroundMusicVolume);
  });

  if (musicSelect) {
    musicSelect.addEventListener('change', () => {
      applyTrack(musicSelect.value, true);
      chrome.storage.local.set({ backgroundMusicTrack: musicSelect.value });
    });
  }
}

function showLoading(msg = 'Loading…') {
  loadingScreen.classList.remove('hidden');
  document.querySelector('.loading-text').textContent = msg;
}

function hideLoading() {
  loadingScreen.classList.add('hidden');
}

function showEmptyState() {
  emptyState.style.display = 'flex';
  pdfScroll.style.display  = 'none';
}

function enableZoom(enabled) {
  btnZoomIn.disabled  = !enabled;
  btnZoomOut.disabled = !enabled;
  btnZoomFit.disabled = !enabled;
  if (zoomSelect) zoomSelect.disabled = !enabled;
  btnPrev.disabled    = !enabled || currentPage <= 1;
  btnNext.disabled    = !enabled || currentPage >= totalPages;
}

function showHint() {
  hintPill.style.display = 'block';
  setTimeout(() => { hintPill.style.display = 'none'; }, 5000);
}

function showError(err, url) {
  let title = 'Could not load PDF';
  let body  = '';

  const msg = err?.message || String(err);

  if (msg.includes('Missing PDF') || msg.includes('404') || msg.includes('fetch')) {
    title = 'File not found';
    body  = `Could not fetch: <code>${escapeHtml(url)}</code><br><br>
             Make sure the file path is correct and the file exists.`;
  } else if (msg.includes('NetworkError') || msg.includes('Failed to fetch')) {
    title = 'Network error';
    body  = `Could not reach: <code>${escapeHtml(url)}</code><br><br>
             If this is a <strong>local file (file:///…)</strong>, enable
             <em>"Allow access to file URLs"</em> in
             <a id="go-to-edge-ext">edge://extensions</a> → GermanyVocab → Details.`;
  } else if (msg.includes('Invalid PDF')) {
    title = 'Invalid PDF';
    body  = 'The file does not appear to be a valid PDF document.';
  } else {
    title = 'Load error';
    body  = escapeHtml(msg);
  }

  errorTitle.textContent = title;
  errorBody.innerHTML    = body;
  errorBanner.classList.add('visible');

  // Wire up the edge://extensions link (can't be a real href from extension context)
  const goLink = document.getElementById('go-to-edge-ext');
  if (goLink) {
    goLink.style.cursor = 'pointer';
    goLink.addEventListener('click', () => {
      chrome.tabs.create({ url: 'edge://extensions' });
    });
  }
}

function hideError() {
  errorBanner.classList.remove('visible');
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
