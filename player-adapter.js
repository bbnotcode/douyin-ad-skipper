(() => {
  'use strict';

  const CONTROL_HOST_SELECTORS = [
    'xg-right-grid',
    '.xgplayer-controls-right',
    '[class*="right-grid"]',
    '[class*="controls-right"]',
  ];

  function idFromLocation(pathname = '', search = '') {
    const pathId = String(pathname).match(/\/video\/(\d{10,24})/);
    if (pathId) return pathId[1];
    const modalId = new URLSearchParams(String(search)).get('modal_id');
    return /^\d{10,24}$/.test(modalId || '') ? modalId : null;
  }

  function idFromNode(video) {
    let node = video;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      const direct = node.getAttribute?.('data-aweme-id') || node.getAttribute?.('data-item-id');
      if (/^\d{10,24}$/.test(direct || '')) return direct;
      const classId = String(node.className || '').match(/(?:^|\s)video_(\d{10,24})(?:\s|$)/);
      if (classId) return classId[1];
    }
    return null;
  }

  function findControlsHost(video) {
    let player = video?.parentElement || null;
    for (let depth = 0; player && depth < 14; depth += 1, player = player.parentElement) {
      for (const selector of CONTROL_HOST_SELECTORS) {
        const host = player.querySelector?.(selector);
        if (host) return { player, host, strategy: selector };
      }
    }
    return null;
  }

  globalThis.DouyinSegmentAdapter = Object.freeze({ CONTROL_HOST_SELECTORS, idFromLocation, idFromNode, findControlsHost });
})();
