'use strict';

const DEFAULTS = {
  enabled: true,
  autoTranslate: true,
  outgoingTarget: 'en',
  minConfidence: 0.45
};

const elements = {
  enabled: document.querySelector('#enabled'),
  autoTranslate: document.querySelector('#autoTranslate'),
  outgoingTarget: document.querySelector('#outgoingTarget'),
  confidence: document.querySelector('#confidence'),
  confidenceValue: document.querySelector('#confidenceValue'),
  saved: document.querySelector('#saved')
};

let saveTimer = null;

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  elements.enabled.checked = Boolean(settings.enabled);
  elements.autoTranslate.checked = Boolean(settings.autoTranslate);
  elements.outgoingTarget.value = settings.outgoingTarget;
  elements.confidence.value = String(settings.minConfidence);
  updateConfidenceLabel();
}

function updateConfidenceLabel() {
  elements.confidenceValue.textContent = `${Math.round(Number(elements.confidence.value) * 100)}%`;
}

function scheduleSave() {
  updateConfidenceLabel();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 150);
}

async function saveSettings() {
  await chrome.storage.sync.set({
    enabled: elements.enabled.checked,
    autoTranslate: elements.autoTranslate.checked,
    outgoingTarget: elements.outgoingTarget.value,
    minConfidence: Number(elements.confidence.value)
  });

  elements.saved.textContent = '设置已保存';
  setTimeout(() => {
    elements.saved.textContent = '';
  }, 1200);
}

for (const element of [
  elements.enabled,
  elements.autoTranslate,
  elements.outgoingTarget,
  elements.confidence
]) {
  element.addEventListener('change', scheduleSave);
  element.addEventListener('input', scheduleSave);
}

loadSettings().catch((error) => {
  elements.saved.textContent = `读取设置失败：${error.message}`;
});
