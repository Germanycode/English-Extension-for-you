document.addEventListener('DOMContentLoaded', () => {
  restoreOptions();
  restorePersonalization();
  applyPersonalization();

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

  chrome.storage.local.set({
    googleApiKey: googleApiKey,
    geminiApiKey: geminiApiKey
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
    geminiApiKey: ''
  }, function(items) {
    document.getElementById('googleApiKey').value = items.googleApiKey;
    document.getElementById('geminiApiKey').value = items.geminiApiKey;
  });
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
