(() => {
  'use strict';

  const DEFAULT_COMMUNITY_API = 'https://douyin-ad-skipper-api.douyin-skip-community.workers.dev';
  const DEFAULTS = {
    enabled: true,
    skipLabeledAds: true,
    skipLocalSegments: true,
    communityEnabled: true,
    communityApiBase: DEFAULT_COMMUNITY_API,
    communityAutoSkipTrusted: true,
    communityClientId: '',
    showToast: true,
    debug: false,
    skippedCount: 0,
    localSegments: {},
  };
  const AD_LABELS = new Set(['广告', '商业推广', '广告推广', '推广']);
  const CHECK_INTERVAL_MS = 900;
  const SKIP_COOLDOWN_MS = 3500;

  let settings = { ...DEFAULTS };
  let lastSkipAt = 0;
  let lastVideo = null;
  let draftStart = null;
  let draftVideoId = null;
  let lastSegmentSkipKey = '';
  let mountScheduled = false;
  const communityCache = new Map();
  const COMMUNITY_CACHE_MS = 10 * 60 * 1000;

  const log = (...args) => settings.debug && console.debug('[抖音广告跳过]', ...args);

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 &&
      rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth;
  }

  function visibleArea(element) {
    const rect = element.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    return width * height;
  }

  function getActiveVideo() {
    const active = [...document.querySelectorAll('[data-e2e="feed-active-video"] video, [data-e2e="modal-video-container"] video')]
      .filter(isVisible)
      .sort((a, b) => visibleArea(b) - visibleArea(a))[0];
    if (active) return active;
    return [...document.querySelectorAll('video')]
      .filter(isVisible)
      .sort((a, b) => visibleArea(b) - visibleArea(a))[0] || null;
  }

  function getVideoContainer(video) {
    let node = video;
    let best = video.parentElement;
    for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= innerWidth * 0.35 && rect.height >= innerHeight * 0.45) best = node;
      if (rect.width >= innerWidth * 0.7 && rect.height >= innerHeight * 0.7) break;
    }
    return best || video.parentElement;
  }

  function extractVideoId(video) {
    const urlMatches = location.pathname.match(/\/video\/(\d+)/);
    if (urlMatches) return urlMatches[1];

    // 精选、推荐等页面会以弹层打开视频，ID 位于查询参数中。
    const queryId = new URLSearchParams(location.search).get('modal_id');
    if (/^\d{10,}$/.test(queryId || '')) return queryId;

    // 播放器节点常见形式：data-e2e="feed-active-video" class="video_123..."。
    let node = video;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      const awemeId = node.getAttribute?.('data-aweme-id') || node.getAttribute?.('data-item-id');
      if (/^\d{10,}$/.test(awemeId || '')) return awemeId;
      const classId = String(node.className || '').match(/(?:^|\s)video_(\d{10,})(?:\s|$)/);
      if (classId) return classId[1];
    }

    const container = getVideoContainer(video);
    // 抖音有些“卡片链接”是带 href 的 div，并非真正的 a 元素。
    const links = container ? [...container.querySelectorAll('[href*="/video/"]')] : [];
    for (const link of links) {
      const match = link.href.match(/\/video\/(\d+)/);
      if (match) return match[1];
    }

    // 推荐流有时把作品链接放在视频卡片的父级之外。
    let ancestor = container;
    for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
      const ownId = ancestor.getAttribute?.('data-aweme-id') || ancestor.getAttribute?.('data-item-id');
      if (/^\d{10,}$/.test(ownId || '')) return ownId;
      const link = ancestor.querySelector?.('[href*="/video/"]');
      const match = link?.href.match(/\/video\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '--:--.-';
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
  }

  function currentSegments(video) {
    const id = extractVideoId(video);
    return id ? (settings.localSegments?.[id] || []) : [];
  }

  function communitySegments(video) {
    const id = extractVideoId(video);
    const cached = id && communityCache.get(id);
    return cached?.segments || [];
  }

  function normalizedApiBase() {
    try {
      const url = new URL(settings.communityApiBase || '');
      return url.protocol === 'https:' ? url.origin : '';
    } catch {
      return '';
    }
  }

  async function loadCommunitySegments(video) {
    if (!settings.communityEnabled) return;
    const videoId = extractVideoId(video);
    const apiBase = normalizedApiBase();
    if (!videoId || !apiBase) return;
    const cached = communityCache.get(videoId);
    if (cached && Date.now() - cached.loadedAt < COMMUNITY_CACHE_MS) return;
    communityCache.set(videoId, { loadedAt: Date.now(), segments: cached?.segments || [], loading: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`${apiBase}/v1/videos/${videoId}/segments`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const segments = Array.isArray(payload.segments) ? payload.segments
        .filter((item) => item.category === 'sponsor' && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
        .map((item) => ({ start: item.start, end: item.end, source: 'community', id: item.id, status: item.status })) : [];
      communityCache.set(videoId, { loadedAt: Date.now(), segments });
      renderPreviewBar();
      log('已加载社区片段', videoId, segments.length);
    } catch (error) {
      communityCache.set(videoId, { loadedAt: Date.now(), segments: cached?.segments || [] });
      log('社区片段查询失败，继续使用本地数据', error);
    } finally {
      clearTimeout(timer);
    }
  }

  function getVideoMetadata(video, videoId) {
    let container = video;
    for (let depth = 0; container && depth < 14; depth += 1, container = container.parentElement) {
      if (container.matches?.('[data-e2e="feed-active-video"], [data-e2e="feed-item"]')) break;
    }
    const scope = container || document;
    const title = scope.querySelector?.('[data-e2e="video-desc"]')?.textContent?.trim() || document.title.replace(/\s*[-–]\s*抖音.*$/, '').trim();
    const author = scope.querySelector?.('[data-e2e="feed-video-nickname"]')?.textContent?.trim() || '';
    return {
      title: title || `抖音作品 ${videoId}`,
      author,
      url: `https://www.douyin.com/video/${videoId}`,
    };
  }

  function normalizedLeafText(element) {
    if (element.children.length > 0) return '';
    return (element.textContent || '').replace(/\s+/g, '').trim();
  }

  function findAdSignal(container) {
    if (!container) return null;
    const elements = [container, ...container.querySelectorAll('span, div, p, a, button')];
    for (const element of elements) {
      if (!isVisible(element)) continue;
      const text = normalizedLeafText(element);
      if (AD_LABELS.has(text)) return { type: 'label', text, element };

      const aria = (element.getAttribute('aria-label') || '').replace(/\s+/g, '');
      if (AD_LABELS.has(aria)) return { type: 'aria-label', text: aria, element };
    }
    return null;
  }

  function findNextButton() {
    const selectors = [
      '[data-e2e="arrow-right"]',
      '[data-e2e="feed-next"]',
      'button[aria-label="下一个视频"]',
      'button[aria-label="下一条"]',
      '[role="button"][aria-label="下一条"]',
    ];
    for (const selector of selectors) {
      const match = [...document.querySelectorAll(selector)].find(isVisible);
      if (match) return match;
    }
    return null;
  }

  function showToast(message) {
    if (!settings.showToast) return;
    let toast = document.getElementById('das-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'das-toast';
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.remove('das-visible');
    requestAnimationFrame(() => toast.classList.add('das-visible'));
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('das-visible'), 1800);
  }

  async function recordSkip() {
    settings.skippedCount = Number(settings.skippedCount || 0) + 1;
    await chrome.storage.local.set({ skippedCount: settings.skippedCount, lastSkippedAt: Date.now() });
  }

  const CONTROL_ICONS = {
    start: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.8A1.8 1.8 0 0 1 7.7 3.2l10.7 7.1a2 2 0 0 1 0 3.4L7.7 20.8A1.8 1.8 0 0 1 5 19.2V4.8Z"/><path class="das-accent" d="M5 8h3M5 16h3"/></svg>',
    end: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.8A1.8 1.8 0 0 1 7.7 3.2l10.7 7.1a2 2 0 0 1 0 3.4L7.7 20.8A1.8 1.8 0 0 1 5 19.2V4.8Z"/><path class="das-accent" d="M18.5 5v14"/></svg>',
    cancel: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 20 6v5.7c0 5-3.3 8.2-8 9.8-4.7-1.6-8-4.8-8-9.8V6l8-3.5Z"/><path class="das-cut" d="m8.5 8.5 7 7m0-7-7 7"/></svg>',
    submit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 20 6v5.7c0 5-3.3 8.2-8 9.8-4.7-1.6-8-4.8-8-9.8V6l8-3.5Z"/><path class="das-cut das-light-cut" d="M12 16V8m-3 3 3-3 3 3"/></svg>',
    delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 20 6v5.7c0 5-3.3 8.2-8 9.8-4.7-1.6-8-4.8-8-9.8V6l8-3.5Z"/><path class="das-cut" d="m8.5 8.5 7 7m0-7-7 7"/></svg>',
  };

  function controlButton(action, label) {
    return `<button type="button" class="das-control-button" data-action="${action}" data-tooltip="${label}" aria-label="${label}">${CONTROL_ICONS[action]}</button>`;
  }

  function renderPlayerControls() {
    document.querySelectorAll('.das-player-controls').forEach((controls) => {
      controls.classList.toggle('das-is-creating', draftStart !== null);
      const video = getActiveVideo();
      const hasPending = video && currentSegments(video).some((segment) => (segment.submissionStatus || 'pending') === 'pending');
      controls.innerHTML = draftStart === null
        ? `${hasPending ? controlButton('submit', '打开提交菜单') + controlButton('delete', '删除最后一个未提交片段') : ''}${controlButton('start', '片段从当前开始')}`
        : `${controlButton('cancel', '取消创建片段')}${controlButton('end', '片段现在结束')}`;
    });
  }

  function ensurePlayerControls() {
    const video = getActiveVideo();
    if (!video) return null;
    loadCommunitySegments(video);
    if (draftStart !== null && draftVideoId !== extractVideoId(video)) cancelDraft();
    let player = video.parentElement;
    while (player && !player.querySelector?.('xg-right-grid')) player = player.parentElement;
    const rightGrid = player?.querySelector('xg-right-grid');
    if (!rightGrid) return null;

    // 抖音会预加载前后多个播放器，只在当前活动播放器保留一组按钮。
    document.querySelectorAll('.das-player-controls').forEach((element) => {
      if (!rightGrid.contains(element)) element.remove();
    });
    let controls = rightGrid.querySelector('.das-player-controls');
    if (!controls) {
      controls = document.createElement('xg-icon');
      controls.className = 'das-player-controls';
      controls.addEventListener('pointerdown', (event) => event.stopPropagation());
      controls.addEventListener('click', handlePlayerControl);
      const clarity = rightGrid.querySelector('.xgplayer-playclarity-setting');
      // 抖音右侧控制栏使用 row-reverse；放在清晰度节点之后，视觉上才位于其左侧。
      if (clarity) rightGrid.insertBefore(controls, clarity.nextSibling);
      else rightGrid.appendChild(controls);
      renderPlayerControls();
      log('标记按钮已嵌入播放器控制栏');
    }
    ensurePreviewBar(video, player);
    return controls;
  }

  function schedulePlayerControls() {
    if (mountScheduled) return;
    mountScheduled = true;
    requestAnimationFrame(() => {
      mountScheduled = false;
      ensurePlayerControls();
    });
  }

  async function handlePlayerControl(event) {
    event.preventDefault();
    event.stopPropagation();
    const action = event.target.closest('button')?.dataset.action;
    if (!action) return;
    const video = getActiveVideo();
    const videoId = video && extractVideoId(video);
    if (!video || !videoId) {
      showToast('暂时无法取得当前作品 ID');
      return;
    }

    if (action === 'start') {
      draftStart = video.currentTime;
      draftVideoId = videoId;
      renderPlayerControls();
      showToast(`片段从当前开始 · ${formatTime(draftStart)}`);
    } else if (action === 'end') {
      const end = video.currentTime;
      if (draftStart === null || draftVideoId !== videoId) {
        cancelDraft();
        showToast('当前视频已变化，请重新开始标记');
        return;
      }
      if (end <= draftStart + 0.2) {
        showToast('结束时间必须晚于开始时间');
        return;
      }
      const savedStart = draftStart;
      const metadata = getVideoMetadata(video, videoId);
      const segments = [...currentSegments(video), { start: savedStart, end, createdAt: Date.now(), submissionStatus: 'pending', ...metadata }]
        .sort((a, b) => a.start - b.start);
      const localSegments = { ...(settings.localSegments || {}), [videoId]: segments };
      settings.localSegments = localSegments;
      await chrome.storage.local.set({ localSegments });
      cancelDraft();
      renderPlayerControls();
      renderPreviewBar();
      showToast(`片段已保存，点击上传图标提交 · ${formatTime(savedStart)}–${formatTime(end)}`);
    } else if (action === 'cancel') {
      cancelDraft();
      showToast('已取消创建片段');
    } else if (action === 'delete') {
      await deleteLastPendingSegment(video, videoId);
    } else if (action === 'submit') {
      openSubmissionMenu(video, videoId);
    }
  }

  function cancelDraft() {
    draftStart = null;
    draftVideoId = null;
    renderPlayerControls();
    renderPreviewBar();
  }

  async function deleteLastPendingSegment(video, videoId) {
    const segments = [...currentSegments(video)];
    const index = segments.map((item) => item.submissionStatus || 'pending').lastIndexOf('pending');
    if (index < 0) return;
    const [removed] = segments.splice(index, 1);
    const localSegments = { ...(settings.localSegments || {}), [videoId]: segments };
    settings.localSegments = localSegments;
    await chrome.storage.local.set({ localSegments });
    closeSubmissionMenu();
    renderPlayerControls();
    renderPreviewBar();
    showToast(`已删除未提交片段 · ${formatTime(removed.start)}–${formatTime(removed.end)}`);
  }

  function closeSubmissionMenu() {
    document.querySelectorAll('.das-submission-menu').forEach((menu) => menu.remove());
  }

  function openSubmissionMenu(video, videoId) {
    const player = getVideoPlayer(video);
    if (!player) return;
    const existing = player.querySelector('.das-submission-menu');
    if (existing) {
      existing.remove();
      return;
    }
    closeSubmissionMenu();
    const pending = currentSegments(video).filter((segment) => (segment.submissionStatus || 'pending') === 'pending');
    if (!pending.length) return;
    const menu = document.createElement('section');
    menu.className = 'das-submission-menu';
    menu.innerHTML = `<header><strong>提交广告片段</strong><button type="button" data-menu-action="close" aria-label="关闭">×</button></header>
      <p>以下片段会作为“赞助/广告”提交；审核通过后，其他用户也能自动跳过。</p>
      <ol>${pending.map((item) => `<li><span>${formatTime(item.start)} – ${formatTime(item.end)}</span><em>${(item.end - item.start).toFixed(1)} 秒</em></li>`).join('')}</ol>
      <div class="das-submission-actions"><button type="button" data-menu-action="submit">提交到社区</button><button type="button" data-menu-action="keep">暂时保留本地</button></div>`;
    menu.addEventListener('pointerdown', (event) => event.stopPropagation());
    menu.addEventListener('click', async (event) => {
      event.stopPropagation();
      const action = event.target.closest('button')?.dataset.menuAction;
      if (action === 'close' || action === 'keep') closeSubmissionMenu();
      if (action === 'submit') await submitPendingSegments(video, videoId, menu);
    });
    player.appendChild(menu);
  }

  async function submitPendingSegments(video, videoId, menu) {
    const apiBase = normalizedApiBase();
    if (!settings.communityEnabled || !apiBase) {
      showToast('请先在扩展选项中启用并配置社区服务');
      chrome.runtime.openOptionsPage?.();
      return;
    }
    const button = menu.querySelector('[data-menu-action="submit"]');
    button.disabled = true;
    button.textContent = '提交中…';
    const segments = [...currentSegments(video)];
    const submittedSegments = new Set();
    let submitted = 0;
    for (const segment of segments) {
      if ((segment.submissionStatus || 'pending') !== 'pending') continue;
      try {
        const response = await fetch(`${apiBase}/v1/segments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-ID': settings.communityClientId },
          body: JSON.stringify({ videoId, start: segment.start, end: segment.end, duration: video.duration, category: 'sponsor', clientRequestId: crypto.randomUUID() }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await response.json();
        submittedSegments.add(segment);
        submitted += 1;
      } catch (error) {
        log('社区片段提交失败', error);
      }
    }
    const localSegments = { ...(settings.localSegments || {}) };
    const remaining = segments.filter((segment) => !submittedSegments.has(segment));
    if (remaining.length) localSegments[videoId] = remaining;
    else delete localSegments[videoId];
    settings.localSegments = localSegments;
    await chrome.storage.local.set({ localSegments });
    if (submitted) communityCache.delete(videoId);
    closeSubmissionMenu();
    renderPlayerControls();
    renderPreviewBar();
    showToast(submitted ? `已提交 ${submitted} 个片段` : '提交失败，片段仍保留在本地');
  }

  function getVideoPlayer(video) {
    let player = video?.parentElement;
    while (player && !player.querySelector?.('xg-right-grid')) player = player.parentElement;
    return player;
  }

  function getProgressHost(player) {
    const selectors = ['xg-progress', '.xgplayer-progress', 'xg-progress-outer', '.xgplayer-progress-outer'];
    for (const selector of selectors) {
      const host = player?.querySelector(selector);
      if (host) return host;
    }
    return null;
  }

  function ensurePreviewBar(video, player = getVideoPlayer(video)) {
    const host = getProgressHost(player);
    if (!host) return null;
    let bar = host.querySelector(':scope > .das-preview-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'das-preview-bar';
      host.appendChild(bar);
    }
    renderPreviewBar(video, bar);
    return bar;
  }

  function renderPreviewBar(video = getActiveVideo(), bar) {
    if (!video) return;
    const player = getVideoPlayer(video);
    bar ||= player?.querySelector('.das-preview-bar');
    if (!bar || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const items = [
      ...communitySegments(video).map((item) => ({ ...item, previewState: item.status === 'trusted' ? 'submitted' : 'candidate' })),
      ...currentSegments(video).map((item) => ({ ...item, previewState: item.submissionStatus || 'pending' })),
    ];
    if (draftStart !== null && draftVideoId === extractVideoId(video)) {
      items.push({ start: Math.min(draftStart, video.currentTime), end: Math.max(draftStart, video.currentTime), previewState: 'pending' });
    }
    items.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    bar.replaceChildren(...items.map((item) => {
      const segment = document.createElement('span');
      segment.className = `das-preview-segment das-${item.previewState}`;
      segment.style.left = `${Math.max(0, item.start / video.duration * 100)}%`;
      segment.style.width = `${Math.max(0.08, (Math.min(video.duration, item.end) - Math.max(0, item.start)) / video.duration * 100)}%`;
      return segment;
    }));
  }

  async function checkLocalSegments() {
    if (!settings.enabled || !settings.skipLocalSegments || document.hidden) return;
    const video = getActiveVideo();
    if (!video || video.paused || video.seeking) return;
    const videoId = extractVideoId(video);
    if (!videoId) return;
    loadCommunitySegments(video);
    const now = video.currentTime;
    const available = [
      ...currentSegments(video),
      ...(settings.communityAutoSkipTrusted ? communitySegments(video).filter((segment) => segment.status === 'trusted') : []),
    ];
    const segment = available.find(({ start, end }) => now >= start - 0.12 && now < end - 0.05);
    if (!segment) return;
    const key = `${videoId}:${segment.start}:${segment.end}`;
    if (lastSegmentSkipKey === key && Math.abs(now - segment.start) > 0.5) return;
    lastSegmentSkipKey = key;
    video.currentTime = Math.min(segment.end, video.duration || segment.end);
    await recordSkip();
    showToast(`已跳过片段 ${formatTime(segment.start)}–${formatTime(segment.end)}`);
    log(segment.source === 'community' ? '跳过社区可信片段' : '跳过本地标记片段', videoId, segment);
  }

  function moveToNextVideo() {
    const button = findNextButton();
    if (button) {
      button.click();
      log('通过下一条按钮跳过');
      return '按钮';
    }

    const target = document.activeElement || document.body;
    const eventOptions = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true };
    target.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
    target.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.max(innerHeight * 0.85, 600), bubbles: true }));
    log('通过方向键/滚轮跳过');
    return '翻页';
  }

  async function checkCurrentVideo() {
    if (!settings.enabled || !settings.skipLabeledAds || document.hidden || Date.now() - lastSkipAt < SKIP_COOLDOWN_MS) return;
    const video = getActiveVideo();
    if (!video) return;
    if (video !== lastVideo) {
      lastVideo = video;
      log('检测到当前视频', video.currentSrc || video.src || '(无地址)');
    }

    const signal = findAdSignal(getVideoContainer(video));
    if (!signal) return;

    lastSkipAt = Date.now();
    const method = moveToNextVideo();
    await recordSkip();
    showToast(`已跳过广告 · ${method}`);
    log('命中广告标识', signal.type, signal.text, signal.element);
  }

  async function getContributorId() {
    const synced = await chrome.storage.sync.get({ communityContributorId: '' });
    if (/^[0-9a-f-]{16,64}$/i.test(synced.communityContributorId)) return synced.communityContributorId;
    const legacy = await chrome.storage.local.get({ communityClientId: '' });
    const id = /^[0-9a-f-]{16,64}$/i.test(legacy.communityClientId) ? legacy.communityClientId : crypto.randomUUID();
    await chrome.storage.sync.set({ communityContributorId: id });
    await chrome.storage.local.remove('communityClientId');
    return id;
  }

  (async () => {
    const stored = await chrome.storage.local.get(DEFAULTS);
    settings = { ...DEFAULTS, ...stored };
    if (!settings.communityApiBase || /^https:\/\/douyin-ad-skipper-api\.\d+\.workers\.dev\/?$/.test(settings.communityApiBase)) {
      settings.communityApiBase = DEFAULT_COMMUNITY_API;
      settings.communityEnabled = true;
      await chrome.storage.local.set({ communityApiBase: DEFAULT_COMMUNITY_API, communityEnabled: true });
    }
    settings.communityClientId = await getContributorId();
    log('扩展已启动', settings);
    checkCurrentVideo();
    ensurePlayerControls();
  })();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
    renderPlayerControls();
    renderPreviewBar();
  });

  const observer = new MutationObserver(() => {
    schedulePlayerControls();
    clearTimeout(observer.timer);
    observer.timer = setTimeout(() => {
      checkCurrentVideo();
      ensurePlayerControls();
    }, 180);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('play', schedulePlayerControls, true);
  document.addEventListener('loadedmetadata', schedulePlayerControls, true);
  document.addEventListener('pointermove', schedulePlayerControls, { passive: true });
  setInterval(checkCurrentVideo, CHECK_INTERVAL_MS);
  setInterval(checkLocalSegments, 250);
  setInterval(schedulePlayerControls, 300);
  setInterval(renderPreviewBar, 300);
})();
