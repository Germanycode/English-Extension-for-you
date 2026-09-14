document.addEventListener('DOMContentLoaded', () => {
  restoreOptions();
  restorePersonalization();
  applyPersonalization();
  populateTtsVoices();

  // Listen for setting changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.appName || changes.customIconDataUrl)) {
      applyPersonalization();
    }
  });
});
document.getElementById('saveBtn').addEventListener('click', saveOptions);
document.getElementById('savePersonalize').addEventListener('click', savePersonalization);
document.getElementById('iconUpload').addEventListener('change', previewIcon);

// ── Personalization ──

function previewIcon(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    document.getElementById('iconPreview').src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

function savePersonalization() {
  const appName = document.getElementById('appName').value.trim();
  const previewSrc = document.getElementById('iconPreview').src;
  const hasCustomIcon = previewSrc.startsWith('data:');

  const toSave = { appName: appName || 'GermanyVocab' };
  if (hasCustomIcon) toSave.customIconDataUrl = previewSrc;

  chrome.storage.local.set(toSave, () => {
    if (hasCustomIcon) {
      chrome.runtime.sendMessage({ action: 'applyCustomIcon', dataUrl: previewSrc });
    }
    const status = document.getElementById('personalizeStatus');
    status.textContent = '✓ Saved! Reopen the popup to see your changes.';
    status.classList.add('show');
    setTimeout(() => { status.textContent = ''; status.classList.remove('show'); }, 4000);
  });
}

function restorePersonalization() {
  chrome.storage.local.get({ appName: '', customIconDataUrl: '' }, items => {
    if (items.appName) document.getElementById('appName').value = items.appName;
    if (items.customIconDataUrl) document.getElementById('iconPreview').src = items.customIconDataUrl;
  });
}

function saveOptions() {
  const googleApiKey = document.getElementById('googleApiKey').value;
  const geminiApiKey = document.getElementById('geminiApiKey').value;
  const unsplashAccessKey = document.getElementById('unsplashAccessKey').value;
  const pixabayApiKey = document.getElementById('pixabayApiKey')?.value || '';
  const voiceSelect = document.getElementById('preferredTtsVoice');
  const selectedVoice = voiceSelect?.selectedOptions?.[0];

  chrome.storage.local.set({
    googleApiKey: googleApiKey,
    geminiApiKey: geminiApiKey,
    unsplashAccessKey: unsplashAccessKey,
    pixabayApiKey: pixabayApiKey.trim(),
    preferredTtsVoice: voiceSelect?.value || '',
    preferredTtsVoiceLang: selectedVoice?.dataset.lang || ''
  }, function() {
    const status = document.getElementById('status');
    status.textContent = 'Options saved successfully!';
    status.classList.add('show');
    setTimeout(function() {
      status.textContent = '';
      status.classList.remove('show');
    }, 3000);
  });
}

function restoreOptions() {
  chrome.storage.local.get({
    googleApiKey: '',
    geminiApiKey: '',
    unsplashAccessKey: '',
    pixabayApiKey: ''
  }, function(items) {
    document.getElementById('googleApiKey').value = items.googleApiKey;
    document.getElementById('geminiApiKey').value = items.geminiApiKey;
    if (document.getElementById('unsplashAccessKey')) {
      document.getElementById('unsplashAccessKey').value = items.unsplashAccessKey;
    }
    if (document.getElementById('pixabayApiKey')) {
      document.getElementById('pixabayApiKey').value = items.pixabayApiKey || '';
    }
  });
}

async function populateTtsVoices() {
  const select = document.getElementById('preferredTtsVoice');
  const help = document.getElementById('ttsVoiceHelp');
  if (!select || !chrome.tts?.getVoices) return;

  try {
    const [voices, saved] = await Promise.all([
      chrome.tts.getVoices(),
      chrome.storage.local.get({ preferredTtsVoice: '' })
    ]);
    const englishVoices = voices
      .filter(voice => /^en(?:-|$)/i.test(voice.lang || '') && voice.voiceName)
      .sort((left, right) => scoreVoice(right) - scoreVoice(left) || left.voiceName.localeCompare(right.voiceName));

    select.textContent = '';
    const automatic = document.createElement('option');
    automatic.value = '';
    automatic.textContent = 'Automatic (Chrome default)';
    select.appendChild(automatic);

    for (const voice of englishVoices) {
      const option = document.createElement('option');
      option.value = voice.voiceName;
      option.dataset.lang = voice.lang;
      const recommendation = scoreVoice(voice) > 0 ? 'Recommended · ' : '';
      option.textContent = `${recommendation}${voice.voiceName} (${voice.lang})`;
      select.appendChild(option);
    }

    select.value = saved.preferredTtsVoice || '';
    if (select.value !== (saved.preferredTtsVoice || '')) select.value = '';
    select.disabled = false;
    if (englishVoices.length === 0 && help) {
      help.textContent = 'No English system voices were found. Install an English voice in Windows, then reopen this page.';
    }
  } catch (error) {
    select.textContent = '';
    const option = document.createElement('option');
    option.textContent = 'Could not load voices';
    option.value = '';
    select.appendChild(option);
    if (help) help.textContent = 'Chrome could not list system voices. Automatic playback remains available.';
  }
}

function scoreVoice(voice) {
  const descriptor = `${voice.voiceName || ''} ${voice.lang || ''}`.toLowerCase();
  return /natural|online|neural|enhanced|premium|google|microsoft/.test(descriptor) ? 1 : 0;
}

function applyPersonalization() {
  chrome.storage.local.get({ appName: 'GermanyVocab', customIconDataUrl: '' }, (items) => {
    const name = items.appName || 'GermanyVocab';
    document.title = `${name} Settings`;
    const h1 = document.querySelector('h1');
    if (h1) h1.textContent = `${name} Settings`;
    
    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.getElementsByTagName('head')[0].appendChild(link);
    }
    link.href = items.customIconDataUrl || '../assets/icons/icon48.png';
  });
}
