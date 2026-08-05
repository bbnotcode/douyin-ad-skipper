const DEFAULTS = { enabled: true, showToast: true, debug: false, skippedCount: 0, localSegments: {} };
const settingKeys = ['enabled', 'showToast', 'debug'];

chrome.storage.local.get(DEFAULTS, (settings) => {
  for (const key of settingKeys) document.getElementById(key).checked = Boolean(settings[key]);
  document.getElementById('count').textContent = Number(settings.skippedCount || 0).toLocaleString('zh-CN');
  document.getElementById('segmentCount').textContent = Object.values(settings.localSegments || {}).reduce((sum, segments) => sum + segments.length, 0).toLocaleString('zh-CN');
});

document.getElementById('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('openSegments').addEventListener('click', () => {
  chrome.tabs.create({ url: `${chrome.runtime.getURL('options.html')}#segments` });
});

for (const key of settingKeys) {
  document.getElementById(key).addEventListener('change', (event) => {
    chrome.storage.local.set({ [key]: event.target.checked });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.skippedCount) {
    document.getElementById('count').textContent = Number(changes.skippedCount.newValue || 0).toLocaleString('zh-CN');
  }
  if (area === 'local' && changes.localSegments) {
    document.getElementById('segmentCount').textContent = Object.values(changes.localSegments.newValue || {}).reduce((sum, segments) => sum + segments.length, 0).toLocaleString('zh-CN');
  }
});
