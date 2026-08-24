(() => {
  'use strict';

  const DEFAULT_COMMUNITY_API = 'https://douyin-ad-skipper-api.douyin-skip-community.workers.dev';
  const adapter = globalThis.DouyinSegmentAdapter;
  const DEFAULTS = {
    enabled: true,
    skipLocalSegments: true,
    communityEnabled: false,
    communityConsentGranted: false,
    communityConsentPrompted: false,
    communityApiBase: DEFAULT_COMMUNITY_API,
    categoryModeSponsor: 'auto',
    categoryModeSelfpromo: 'manual',
    categoryModeInteraction: 'manual',
    communityClientId: '',
    showToast: true,
    debug: false,
    shortcutsEnabled: true,
    shortcutCreate: 'Alt+KeyZ',
    shortcutCancel: 'Alt+KeyX',
    shortcutSubmit: 'Alt+Enter',
    skippedCount: 0,
    localSegments: {},
  };
  let settings = { ...DEFAULTS };
  let draftStart = null;
  let draftVideoId = null;
  let lastSegmentSkipKey = '';
  let mountScheduled = false;
  let manualNoticeKey = '';
  let diagnosticFingerprint = '';
  let diagnosticWrittenAt = 0;
  const skipSuppressedUntil = new Map();
  const communityCache = new Map();
  const COMMUNITY_CACHE_MS = 10 * 60 * 1000;
  const COMMUNITY_RETRY_MS = [5000, 15000, 60000, 5 * 60 * 1000];
  const CATEGORY_LABELS = { sponsor:'赞助/广告', selfpromo:'自我推广', interaction:'互动提醒' };
  const CATEGORY_SETTING_KEYS = { sponsor:'categoryModeSponsor', selfpromo:'categoryModeSelfpromo', interaction:'categoryModeInteraction' };

  const log = (...args) => settings.debug && console.debug('[抖音社区片段助手]', ...args);

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
    const locationId = adapter?.idFromLocation(location.pathname, location.search);
    if (locationId) return locationId;
    const nodeId = adapter?.idFromNode(video);
    if (nodeId) return nodeId;

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

  function writeAdapterDiagnostic(reason, video = null, strategy = '') {
    const route = location.pathname.startsWith('/video/') ? '/video/:id'
      : location.pathname.startsWith('/user/') ? '/user/:redacted'
      : /^\/(recommend|discover|follow|hot|channel)(?:\/|$)/.test(location.pathname) ? `/${location.pathname.split('/')[1]}`
      : '/other';
    const snapshot = {
      recordedAt: new Date().toISOString(),
      extensionVersion: chrome.runtime.getManifest().version,
      reason,
      strategy: strategy || 'none',
      pathShape: route,
      modalRoute: new URLSearchParams(location.search).has('modal_id'),
      visibleVideoCount: [...document.querySelectorAll('video')].filter(isVisible).length,
      videoIdDetected: Boolean(video && extractVideoId(video)),
      controlsMounted: Boolean(document.querySelector('.das-player-controls')),
      viewport: `${innerWidth}x${innerHeight}`,
    };
    const fingerprint = JSON.stringify({ ...snapshot, recordedAt: '' });
    if (fingerprint === diagnosticFingerprint && Date.now() - diagnosticWrittenAt < 30000) return;
    diagnosticFingerprint = fingerprint;
    diagnosticWrittenAt = Date.now();
    void chrome.storage.local.set({ lastAdapterDiagnostic: snapshot });
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

  function mergeOverlappingDrafts(segments) {
    const sorted = [...segments].sort((a, b) => a.start - b.start);
    const merged = [];
    for (const segment of sorted) {
      const previous = merged[merged.length - 1];
      if (!previous || segment.start > previous.end + 0.25) {
        merged.push(segment);
        continue;
      }
      merged[merged.length - 1] = {
        ...previous,
        ...segment,
        start: Math.min(previous.start, segment.start),
        end: Math.max(previous.end, segment.end),
        createdAt: Date.now(),
        previewed: false,
      };
    }
    return merged;
  }

  function setCommunityCache(videoId, value) {
    communityCache.delete(videoId);
    communityCache.set(videoId, value);
    while (communityCache.size > 100) communityCache.delete(communityCache.keys().next().value);
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

  function communityRetryDelay(failureCount) {
    return COMMUNITY_RETRY_MS[Math.min(Math.max(1, Number(failureCount) || 1) - 1, COMMUNITY_RETRY_MS.length - 1)];
  }

  async function sha256Hex(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function loadCommunitySegments(video) {
    if (!settings.communityConsentGranted || !settings.communityEnabled) return;
    const videoId = extractVideoId(video);
    const apiBase = normalizedApiBase();
    if (!videoId || !apiBase) return;
    const cached = communityCache.get(videoId);
    const now = Date.now();
    if (cached?.loading || Number(cached?.retryAt || 0) > now) return;
    if (cached?.loadedAt && now - cached.loadedAt < COMMUNITY_CACHE_MS) return;
    setCommunityCache(videoId, { ...cached, segments: cached?.segments || [], loading: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const videoHash = await sha256Hex(videoId);
      const response = await fetch(`${apiBase}/v1/videos/by-hash/${videoHash}/segments`, {
        headers: { Accept: 'application/json', 'X-Client-ID': settings.communityClientId },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const segments = Array.isArray(payload.segments) ? payload.segments
        .filter((item) => CATEGORY_LABELS[item.category] && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
        .map((item) => ({ start: item.start, end: item.end, category:item.category, source: 'community', id: item.id, status: item.status, ownedByMe: item.ownedByMe === true, clusterSize:Math.max(1,Number(item.clusterSize||1)) })) : [];
      setCommunityCache(videoId, { loadedAt: Date.now(), retryAt: 0, failureCount: 0, segments });
      renderPreviewBar();
      log('已加载社区片段', videoId, segments.length);
    } catch (error) {
      const failureCount = Number(cached?.failureCount || 0) + 1;
      const retryDelay = communityRetryDelay(failureCount);
      setCommunityCache(videoId, {
        loadedAt: cached?.loadedAt || 0,
        retryAt: Date.now() + retryDelay,
        failureCount,
        segments: cached?.segments || [],
      });
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

  function displayToast(message, actions = [], required = false, persistent = false) {
    if (!required && !settings.showToast && actions.length === 0) return;
    let toast = document.getElementById('das-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'das-toast';
      document.documentElement.appendChild(toast);
    }
    toast.setAttribute('role', actions.length ? 'alertdialog' : 'status');
    toast.setAttribute('aria-live', required ? 'assertive' : 'polite');
    toast.replaceChildren();
    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);
    if (actions.length) {
      const controls = document.createElement('span');
      controls.className = 'das-toast-actions';
      for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = action.label;
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          controls.querySelectorAll('button').forEach((item) => { item.disabled = true; });
          action.run();
        });
        controls.appendChild(button);
      }
      toast.appendChild(controls);
    }
    toast.classList.remove('das-visible');
    requestAnimationFrame(() => toast.classList.add('das-visible'));
    clearTimeout(displayToast.timer);
    if (!persistent) displayToast.timer = setTimeout(() => toast.classList.remove('das-visible'), actions.length ? 8000 : 2200);
  }

  function showToast(message, actions = []) {
    displayToast(message, actions, false);
  }

  function showRequiredToast(message, actions = [], persistent = false) {
    displayToast(message, actions, true, persistent);
  }

  async function responseErrorCode(response) {
    try {
      const payload = await response.clone().json();
      return typeof payload?.error === 'string' ? payload.error : '';
    } catch {
      return '';
    }
  }

  function communityErrorMessage(code, fallback) {
    return ({
      cannot_vote_own_segment: '这是你提交的片段，无需给自己的片段投票',
      cannot_report_own_segment: '这是你提交的片段，不能举报自己的投稿',
      rate_limited: '操作太频繁，请稍后再试',
      segment_not_found: '该社区片段已不存在或已停止共享',
      writes_not_configured: '社区服务暂时只读，请稍后再试',
      invalid_client_id: '匿名贡献身份无效，请重新打开扩展',
    })[code] || fallback;
  }

  async function chooseCommunityMode(enabled) {
    const update = {
      communityConsentPrompted: true,
      communityConsentGranted: enabled === true,
      communityEnabled: enabled === true,
      communityApiBase: DEFAULT_COMMUNITY_API,
    };
    Object.assign(settings, update);
    await chrome.storage.local.set(update);
    if (enabled) {
      if (!settings.communityClientId) settings.communityClientId = await getContributorId();
      const video = getActiveVideo();
      if (video) void loadCommunitySegments(video);
      showRequiredToast('社区共享已启用');
    } else {
      communityCache.clear();
      renderPreviewBar();
      showRequiredToast('已选择仅本地使用，可随时在设置中启用社区');
    }
  }

  function showCommunityConsent() {
    if (settings.communityConsentPrompted) return;
    showRequiredToast('启用社区会发送作品 ID 哈希和匿名贡献 ID 来查询片段；只有主动提交才上传作品 ID 与片段时间', [
      { label: '启用社区', run: () => { void chooseCommunityMode(true); } },
      { label: '仅本地', run: () => { void chooseCommunityMode(false); } },
    ], true);
  }

  async function recordSkip(change = 1) {
    settings.skippedCount = Math.max(0, Number(settings.skippedCount || 0) + change);
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
    if (!video) {
      writeAdapterDiagnostic('no-visible-video');
      return null;
    }
    loadCommunitySegments(video);
    if (draftStart !== null && draftVideoId !== extractVideoId(video)) cancelDraft();
    const resolved = adapter?.findControlsHost(video);
    const player = resolved?.player;
    const rightGrid = resolved?.host;
    if (!player || !rightGrid) {
      writeAdapterDiagnostic('controls-host-missing', video);
      return null;
    }

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
      const clarity = rightGrid.querySelector('.xgplayer-playclarity-setting,[class*="playclarity"],[class*="clarity-setting"]');
      // 抖音右侧控制栏使用 row-reverse；放在清晰度节点之后，视觉上才位于其左侧。
      if (clarity) rightGrid.insertBefore(controls, clarity.nextSibling);
      else rightGrid.appendChild(controls);
      renderPlayerControls();
      log('标记按钮已嵌入播放器控制栏');
    }
    writeAdapterDiagnostic('mounted', video, resolved.strategy);
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

  function handleShortcut(event) {
    if (!settings.shortcutsEnabled || event.repeat) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
    let action='';
    const signature=shortcutSignature(event);
    if(signature===settings.shortcutCreate)action=draftStart===null?'start':'end';
    if(signature===settings.shortcutCancel&&draftStart!==null)action='cancel';
    if(signature===settings.shortcutSubmit&&draftStart===null)action='submit';
    if(!action)return;
    const controls=ensurePlayerControls();const button=controls?.querySelector(`[data-action="${action}"]`);
    if(!button)return;
    event.preventDefault();event.stopPropagation();button.click();
  }

  function shortcutSignature(event) {
    return [event.ctrlKey?'Ctrl':'',event.altKey?'Alt':'',event.shiftKey?'Shift':'',event.metaKey?'Meta':'',event.code].filter(Boolean).join('+');
  }

  async function handlePlayerControl(event) {
    event.preventDefault();
    event.stopPropagation();
    const action = event.target.closest('button')?.dataset.action;
    if (!action) return;
    const video = getActiveVideo();
    const videoId = video && extractVideoId(video);
    if (!video || !videoId) {
      showRequiredToast('暂时无法取得当前作品 ID');
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
        showRequiredToast('当前视频已变化，请重新开始标记');
        return;
      }
      if (end <= draftStart + 0.2) {
        showRequiredToast('结束时间必须晚于开始时间');
        return;
      }
      if (end - draftStart < 1 && !confirm('这个片段不足 1 秒，时间点可能不准确。仍然保存吗？')) return;
      const savedStart = draftStart;
      const metadata = getVideoMetadata(video, videoId);
      const segments = mergeOverlappingDrafts([...currentSegments(video), { start: savedStart, end, category:'sponsor', createdAt: Date.now(), submissionStatus: 'pending', previewed:false, ...metadata }]);
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

  function openSubmissionMenu(video, videoId, expandedSegmentId = null) {
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
    const allPreviewed = pending.every((item) => item.previewed === true);
    menu.innerHTML = `<header><div><strong>提交社区片段</strong><small>${pending.length} 个待提交片段</small></div><button type="button" data-menu-action="close" aria-label="关闭">×</button></header>
      <p>先微调时间并完整预览，确认片段边界准确后再提交。</p>
      <ol>${pending.map((item,index) => `<li>
        <div class="das-segment-summary"><span>${formatTime(item.start)} – ${formatTime(item.end)}</span><small>${item.previewed?'✓ 已预览':'尚未预览'}</small></div>
        <div class="das-segment-category"><select data-menu-action="category" data-preview-index="${index}" aria-label="片段分类"><option value="sponsor" ${(item.category||'sponsor')==='sponsor'?'selected':''}>赞助/广告</option><option value="selfpromo" ${item.category==='selfpromo'?'selected':''}>自我推广</option><option value="interaction" ${item.category==='interaction'?'selected':''}>互动提醒</option></select></div>
        <div class="das-segment-primary-actions">
          <button type="button" data-menu-action="preview" data-preview-index="${index}"><b>▶</b><span>${item.previewed?'重新预览':'预览片段'}</span></button>
          <button type="button" data-menu-action="seek-boundary" data-field="start" data-preview-index="${index}"><b>↤</b><span>片段开头</span></button>
          <button type="button" data-menu-action="seek-boundary" data-field="end" data-preview-index="${index}"><b>↦</b><span>片段结尾</span></button>
        </div>
        <div class="das-segment-secondary-actions">
          <button type="button" class="${expandedSegmentId===item.createdAt?'das-active':''}" data-menu-action="toggle-editor" data-preview-index="${index}" aria-expanded="${expandedSegmentId===item.createdAt?'true':'false'}"><span>精确编辑</span><b>⌄</b></button>
          <button type="button" data-menu-action="delete-segment" data-preview-index="${index}">删除此片段</button>
        </div>
        <div class="das-segment-editor" data-editor-index="${index}" aria-label="片段时间微调" ${expandedSegmentId===item.createdAt?'':'hidden'}>
          <span>起点</span><button type="button" data-menu-action="adjust" data-field="start" data-delta="-0.1" data-preview-index="${index}" aria-label="起点提前 0.1 秒">−</button><button type="button" data-menu-action="seek-boundary" data-field="start" data-preview-index="${index}" title="跳到起点">${formatTime(item.start)}</button><button type="button" data-menu-action="adjust" data-field="start" data-delta="0.1" data-preview-index="${index}" aria-label="起点延后 0.1 秒">＋</button>
          <span>终点</span><button type="button" data-menu-action="adjust" data-field="end" data-delta="-0.1" data-preview-index="${index}" aria-label="终点提前 0.1 秒">−</button><button type="button" data-menu-action="seek-boundary" data-field="end" data-preview-index="${index}" title="跳到终点">${formatTime(item.end)}</button><button type="button" data-menu-action="adjust" data-field="end" data-delta="0.1" data-preview-index="${index}" aria-label="终点延后 0.1 秒">＋</button>
          <div class="das-frame-controls"><button type="button" data-menu-action="frame-step" data-delta="-1"><b>‹</b><span>上一帧</span><kbd>,</kbd></button><button type="button" data-menu-action="frame-step" data-delta="1"><span>下一帧</span><kbd>.</kbd><b>›</b></button></div>
        </div>
      </li>`).join('')}</ol>
      <div class="das-submission-actions"><button type="button" data-menu-action="submit" ${allPreviewed?'':'disabled'}>${allPreviewed?'提交到社区':'请先预览全部'}</button><button type="button" data-menu-action="keep">暂时保留本地</button></div>`;
    menu.addEventListener('pointerdown', (event) => event.stopPropagation());
    menu.addEventListener('click', async (event) => {
      event.stopPropagation();
      const action = event.target.closest('button')?.dataset.menuAction;
      if (action === 'close' || action === 'keep') closeSubmissionMenu();
      if (action === 'preview') await previewPendingSegment(video, videoId, pending[Number(event.target.closest('button').dataset.previewIndex)]);
      if (action === 'toggle-editor') {
        const button = event.target.closest('button');
        const editor = menu.querySelector(`[data-editor-index="${button.dataset.previewIndex}"]`);
        if (editor) {
          editor.hidden = !editor.hidden;
          button.setAttribute('aria-expanded', String(!editor.hidden));
          button.classList.toggle('das-active', !editor.hidden);
        }
      }
      if (action === 'seek-boundary') {
        const button = event.target.closest('button');
        const target = pending[Number(button.dataset.previewIndex)];
        if (target) await inspectSegmentBoundary(video, videoId, target, button.dataset.field);
      }
      if (action === 'adjust') {
        const button = event.target.closest('button');
        await adjustPendingSegment(video, videoId, pending[Number(button.dataset.previewIndex)], button.dataset.field, Number(button.dataset.delta));
      }
      if (action === 'frame-step') {
        const button = event.target.closest('button');
        stepVideoFrame(video, Number(button.dataset.delta));
      }
      if (action === 'delete-segment') {
        const button = event.target.closest('button');
        await deletePendingSegment(video, videoId, pending[Number(button.dataset.previewIndex)]);
      }
      if (action === 'submit') await submitPendingSegments(video, videoId, menu);
    });
    menu.addEventListener('change', async (event) => {
      const select=event.target.closest('select[data-menu-action="category"]');if(!select)return;
      const target=pending[Number(select.dataset.previewIndex)];if(!target||!CATEGORY_LABELS[select.value])return;
      const segments=[...(settings.localSegments?.[videoId]||[])];const stored=segments.find((item)=>item.createdAt===target.createdAt);
      if(stored)stored.category=select.value;target.category=select.value;
      settings.localSegments={...(settings.localSegments||{}),[videoId]:segments};await chrome.storage.local.set({localSegments:settings.localSegments});renderPreviewBar();
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key !== ',' && event.key !== '.') return;
      event.preventDefault();
      stepVideoFrame(video, event.key === ',' ? -1 : 1);
    });
    menu.tabIndex = -1;
    player.appendChild(menu);
    menu.focus({ preventScroll: true });
  }

  function stepVideoFrame(video, direction) {
    if (!video || !Number.isFinite(direction) || !direction) return;
    video.pause();
    video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + Math.sign(direction) / 30));
  }

  async function inspectSegmentBoundary(video, videoId, segment, field) {
    if (!segment || !['start', 'end'].includes(field)) return;
    const key = `${videoId}:${segment.start}:${segment.end}`;
    lastSegmentSkipKey = '';
    if (field === 'start') {
      // 校准起点时允许用户连续观看整段，不触发本地或社区自动跳过。
      const inspectMs = Math.max(5000, (segment.end - segment.start + 3) * 1000);
      skipSuppressedUntil.set(key, Date.now() + inspectMs);
      video.currentTime = Math.max(0, segment.start);
      try { await video.play(); } catch {}
      showToast(`从片段开头播放 · ${formatTime(segment.start)}`);
      return;
    }
    skipSuppressedUntil.set(key, Date.now() + 5000);
    video.pause();
    video.currentTime = Math.min(segment.end, video.duration || segment.end);
    showToast(`已定位片段结尾 · ${formatTime(segment.end)}`);
  }

  async function deletePendingSegment(video, videoId, segment) {
    if (!segment) return;
    const segments = [...(settings.localSegments?.[videoId] || [])];
    const index = segments.findIndex((item) => item.createdAt === segment.createdAt);
    if (index < 0) return;
    const [removed] = segments.splice(index, 1);
    const localSegments = { ...(settings.localSegments || {}) };
    if (segments.length) localSegments[videoId] = segments;
    else delete localSegments[videoId];
    settings.localSegments = localSegments;
    await chrome.storage.local.set({ localSegments });
    closeSubmissionMenu();
    if (segments.some((item) => (item.submissionStatus || 'pending') === 'pending')) openSubmissionMenu(video, videoId);
    renderPlayerControls();
    renderPreviewBar();
    showToast(`已删除片段 · ${formatTime(removed.start)}–${formatTime(removed.end)}`);
  }

  async function adjustPendingSegment(video, videoId, segment, field, delta) {
    if (!segment || !['start', 'end'].includes(field) || !Number.isFinite(delta)) return;
    const segments = [...(settings.localSegments?.[videoId] || [])];
    const target = segments.find((item) => item.createdAt === segment.createdAt);
    if (!target) return;
    const nextValue = Math.round((Number(target[field]) + delta) * 10) / 10;
    const nextStart = field === 'start' ? nextValue : Number(target.start);
    const nextEnd = field === 'end' ? nextValue : Number(target.end);
    if (nextStart < 0 || nextEnd <= nextStart + 0.2 || nextEnd > (video.duration || Infinity)) {
      showRequiredToast('调整后的片段范围无效');
      return;
    }
    target[field] = nextValue;
    target.previewed = false;
    settings.localSegments = { ...(settings.localSegments || {}), [videoId]: segments };
    await chrome.storage.local.set({ localSegments: settings.localSegments });
    const menu = getVideoPlayer(video)?.querySelector('.das-submission-menu');
    const pending = currentSegments(video).filter((item) => (item.submissionStatus || 'pending') === 'pending');
    const pendingIndex = pending.findIndex((item) => item.createdAt === target.createdAt);
    if (menu && pendingIndex >= 0) {
      const editor = menu.querySelector(`[data-editor-index="${pendingIndex}"]`);
      const summary = editor?.closest('li')?.querySelector('.das-segment-summary');
      const times = editor?.querySelectorAll('[data-menu-action="seek-boundary"]');
      if (summary) summary.innerHTML = `<span>${formatTime(target.start)} – ${formatTime(target.end)}</span><small>尚未预览</small>`;
      if (times?.[0]) times[0].textContent = formatTime(target.start);
      if (times?.[1]) times[1].textContent = formatTime(target.end);
      const submitButton = menu.querySelector('[data-menu-action="submit"]');
      if (submitButton) { submitButton.disabled = true; submitButton.textContent = '请先预览全部'; }
    }
    video.currentTime = nextValue;
    renderPreviewBar();
    showToast(`${field === 'start' ? '起点' : '终点'}已调整 0.1 秒，请重新预览`);
  }

  async function previewPendingSegment(video, videoId, segment) {
    if (!segment) return;
    video.currentTime = Math.max(0, segment.start - 2);
    try { await video.play(); } catch {}
    showToast(`正在预览 ${formatTime(segment.start)}–${formatTime(segment.end)}`);
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (extractVideoId(video) !== videoId || Date.now() - startedAt > 15000) {
        clearInterval(timer);
        if (Date.now() - startedAt > 15000) showRequiredToast('未完成预览，请重新点击预览并保持播放器处于播放状态');
        return;
      }
      if (video.currentTime < segment.end - 0.15) return;
      clearInterval(timer);
      const segments = [...(settings.localSegments?.[videoId] || [])];
      const target = segments.find((item) => item.createdAt === segment.createdAt && item.start === segment.start && item.end === segment.end);
      if (target) target.previewed = true;
      settings.localSegments = { ...(settings.localSegments || {}), [videoId]: segments };
      await chrome.storage.local.set({ localSegments: settings.localSegments });
      closeSubmissionMenu();
      openSubmissionMenu(video, videoId);
      showToast('片段预览完成');
    }, 150);
  }

  async function submitPendingSegments(video, videoId, menu) {
    const apiBase = normalizedApiBase();
    if (!settings.communityConsentGranted || !settings.communityEnabled || !apiBase) {
      showRequiredToast('请先同意并启用社区共享');
      chrome.runtime.openOptionsPage?.();
      return;
    }
    const button = menu.querySelector('[data-menu-action="submit"]');
    const pending = currentSegments(video).filter((segment) => (segment.submissionStatus || 'pending') === 'pending');
    if (!pending.length || pending.some((segment) => segment.previewed !== true)) {
      showRequiredToast('请先预览全部待提交片段');
      return;
    }
    button.disabled = true;
    button.textContent = '提交中…';
    const segments = [...currentSegments(video)];
    const submittedSegments = new Set();
    const confirmedCommunitySegments = [];
    let submitted = 0;
    let submissionError = '';
    for (const segment of segments) {
      if ((segment.submissionStatus || 'pending') !== 'pending') continue;
      try {
        const response = await fetch(`${apiBase}/v1/segments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Client-ID': settings.communityClientId },
          body: JSON.stringify({ videoId, start: segment.start, end: segment.end, duration: video.duration, category: segment.category || 'sponsor', clientRequestId: crypto.randomUUID() }),
        });
        if (!response.ok) throw new Error(communityErrorMessage(await responseErrorCode(response), '社区提交失败'));
        const payload = await response.json();
        const confirmed = payload.segment;
        if (confirmed && Number.isFinite(confirmed.start) && Number.isFinite(confirmed.end)) {
          confirmedCommunitySegments.push({
            start: confirmed.start,
            end: confirmed.end,
            source: 'community',
            id: confirmed.id,
            status: confirmed.status || 'trusted',
            category: confirmed.category || segment.category || 'sponsor',
            ownedByMe: confirmed.ownedByMe === true,
          });
        }
        submittedSegments.add(segment);
        submitted += 1;
      } catch (error) {
        log('社区片段提交失败', error);
        submissionError = error instanceof Error ? error.message : '社区提交失败';
      }
    }
    const localSegments = { ...(settings.localSegments || {}) };
    const remaining = segments.filter((segment) => !submittedSegments.has(segment));
    if (remaining.length) localSegments[videoId] = remaining;
    else delete localSegments[videoId];
    settings.localSegments = localSegments;
    if (confirmedCommunitySegments.length) {
      const cached = communityCache.get(videoId);
      const byId = new Map([...(cached?.segments || []), ...confirmedCommunitySegments].map((item) => [item.id || `${item.start}:${item.end}`, item]));
      setCommunityCache(videoId, { loadedAt: Date.now(), segments: [...byId.values()] });
    }
    await chrome.storage.local.set({ localSegments });
    closeSubmissionMenu();
    renderPlayerControls();
    renderPreviewBar();
    if (submitted) showToast(`已提交 ${submitted} 个片段`);
    else showRequiredToast(`${submissionError || '提交失败'}，片段仍保留在本地`);
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
      const category=item.category||'sponsor';
      segment.className = `das-preview-segment das-${item.previewState} das-category-${category}`;
      const stateName = item.previewState === 'pending' ? '待提交' : item.previewState === 'candidate' ? '待确认' : '社区';
      segment.title = `${stateName}${CATEGORY_LABELS[category]||'片段'} ${formatTime(item.start)}–${formatTime(item.end)}`;
      segment.setAttribute('aria-label', segment.title);
      segment.style.left = `${Math.max(0, item.start / video.duration * 100)}%`;
      segment.style.width = `${Math.max(0.08, (Math.min(video.duration, item.end) - Math.max(0, item.start)) / video.duration * 100)}%`;
      return segment;
    }));
  }

  async function checkLocalSegments() {
    if (!settings.enabled || document.hidden) return;
    const video = getActiveVideo();
    if (!video || video.paused || video.seeking) return;
    const videoId = extractVideoId(video);
    if (!videoId) return;
    loadCommunitySegments(video);
    const now = video.currentTime;
    const localAvailable = settings.skipLocalSegments ? currentSegments(video) : [];
    const trustedCommunity = communitySegments(video).filter((segment) => segment.status === 'trusted');
    const modeFor=(segment)=>settings[CATEGORY_SETTING_KEYS[segment.category||'sponsor']]||'manual';
    const manualSegment = trustedCommunity.filter((segment)=>modeFor(segment)==='manual').find(({start,end}) => now >= start - 0.12 && now < end - 0.05);
    if (manualSegment) {
      const noticeKey=`${videoId}:${manualSegment.id}:${manualSegment.start}`;
      if(manualNoticeKey!==noticeKey){
        manualNoticeKey=noticeKey;
        showToast(`发现${CATEGORY_LABELS[manualSegment.category||'sponsor']} ${formatTime(manualSegment.start)}–${formatTime(manualSegment.end)}`, [
          {label:'立即跳过',run:()=>skipKnownSegment(video,videoId,manualSegment)},
          {label:'本次忽略',run:()=>skipSuppressedUntil.set(`${videoId}:${manualSegment.start}:${manualSegment.end}`,Date.now()+Math.max(1000,(manualSegment.end-video.currentTime+1)*1000))},
        ]);
      }
    } else manualNoticeKey='';
    const available = [...localAvailable, ...trustedCommunity.filter((segment)=>modeFor(segment)==='auto')];
    const segment = available.find(({ start, end }) => now >= start - 0.12 && now < end - 0.05);
    if (!segment) return;
    const key = `${videoId}:${segment.start}:${segment.end}`;
    if (Number(skipSuppressedUntil.get(key) || 0) > Date.now()) return;
    if (lastSegmentSkipKey === key && Math.abs(now - segment.start) > 0.5) return;
    await skipKnownSegment(video,videoId,segment,key);
  }

  async function skipKnownSegment(video, videoId, segment, knownKey) {
    const key=knownKey||`${videoId}:${segment.start}:${segment.end}`;
    if (Number(skipSuppressedUntil.get(key) || 0) > Date.now()) return;
    lastSegmentSkipKey = key;
    video.currentTime = Math.min(segment.end, video.duration || segment.end);
    await recordSkip();
    const impactTimer = segment.source === 'community' && segment.id
      ? setTimeout(() => { void recordCommunitySkip(segment); }, 3000)
      : null;
    const undo = async () => {
      if (impactTimer) clearTimeout(impactTimer);
      skipSuppressedUntil.set(key, Date.now() + 12000);
      video.currentTime = Math.max(0, segment.start);
      await recordSkip(-1);
      showToast('已撤销跳过，12 秒内不会再次自动跳过', [{
        label:'重新跳过',
        run:()=>{skipSuppressedUntil.delete(key);lastSegmentSkipKey='';void skipKnownSegment(video,videoId,segment,key)},
      }]);
    };
    const actions = [{ label:'撤销', run:undo }];
    if (segment.source === 'community' && segment.id && !segment.ownedByMe) {
      actions.push(
        { label:'赞成', run:()=>voteOnSegment(segment,1) },
        { label:'反对', run:()=>voteOnSegment(segment,-1) },
        { label:'举报', run:()=>showReportChoices(segment) },
      );
    }
    const ownership = segment.ownedByMe ? ' · 你的投稿' : segment.clusterSize > 1 ? ` · ${segment.clusterSize} 人相近投稿` : '';
    showToast(`已跳过片段 ${formatTime(segment.start)}–${formatTime(segment.end)}${ownership}`, actions);
    log(segment.source === 'community' ? '跳过社区可信片段' : '跳过本地标记片段', videoId, segment);
  }

  async function recordCommunitySkip(segment) {
    const apiBase = normalizedApiBase();
    if (!apiBase || !settings.communityClientId) return;
    try {
      const response = await fetch(`${apiBase}/v1/segments/${segment.id}/skips`, {
        method:'POST', headers:{'X-Client-ID':settings.communityClientId},
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      log('已记录社区片段贡献', segment.id);
    } catch (error) {
      log('记录社区片段贡献失败', error);
    }
  }

  async function voteOnSegment(segment, vote) {
    const apiBase = normalizedApiBase();
    if (!apiBase || !settings.communityClientId) return;
    if (segment.ownedByMe) {
      showRequiredToast('这是你提交的片段，无需给自己的片段投票');
      return;
    }
    try {
      const response = await fetch(`${apiBase}/v1/segments/${segment.id}/votes`, {
        method:'POST', headers:{'Content-Type':'application/json','X-Client-ID':settings.communityClientId}, body:JSON.stringify({vote}),
      });
      if (!response.ok) throw new Error(communityErrorMessage(await responseErrorCode(response), '反馈失败，请稍后重试'));
      const result = await response.json();
      segment.status = result.status || segment.status;
      showToast(vote === 1 ? '感谢确认这个片段' : '已反馈：这个片段有问题');
    } catch (error) {
      log('片段投票失败', error);
      showRequiredToast(error instanceof Error ? error.message : '反馈失败，请稍后重试');
    }
  }

  function showReportChoices(segment) {
    showToast('请选择问题类型', [
      { label:'时间错误', run:()=>reportSegment(segment,'wrong_time') },
      { label:'分类错误', run:()=>reportSegment(segment,'not_ad') },
      { label:'视频不符', run:()=>reportSegment(segment,'wrong_video') },
      { label:'滥用', run:()=>reportSegment(segment,'abuse') },
    ]);
  }

  async function reportSegment(segment, reason) {
    const apiBase = normalizedApiBase();
    if (!apiBase || !settings.communityClientId) return;
    if (segment.ownedByMe) {
      showRequiredToast('这是你提交的片段，不能举报自己的投稿');
      return;
    }
    try {
      const response = await fetch(`${apiBase}/v1/segments/${segment.id}/reports`, {
        method:'POST', headers:{'Content-Type':'application/json','X-Client-ID':settings.communityClientId}, body:JSON.stringify({reason}),
      });
      if (!response.ok) throw new Error(communityErrorMessage(await responseErrorCode(response), '举报失败，请稍后重试'));
      await response.json();
      showToast('举报已提交，感谢帮助维护社区质量');
    } catch (error) {
      log('片段举报失败', error);
      showRequiredToast(error instanceof Error ? error.message : '举报失败，请稍后重试');
    }
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
    const stored = await chrome.storage.local.get(null);
    settings = { ...DEFAULTS, ...stored };
    if (!Object.hasOwn(stored, 'categoryModeSponsor')) {
      const legacyMode = ['auto', 'manual', 'disabled'].includes(stored.communitySkipMode) ? stored.communitySkipMode : 'auto';
      const categoryModes = { categoryModeSponsor: legacyMode, categoryModeSelfpromo: legacyMode, categoryModeInteraction: legacyMode };
      settings = { ...settings, ...categoryModes };
      await chrome.storage.local.set(categoryModes);
    }
    const migration = { communityApiBase: DEFAULT_COMMUNITY_API };
    if (!Object.hasOwn(stored, 'communityConsentPrompted')) {
      Object.assign(migration, {
        communityConsentPrompted: false,
        communityConsentGranted: false,
        communityEnabled: false,
      });
    } else if (!settings.communityConsentGranted && settings.communityEnabled) {
      migration.communityEnabled = false;
    }
    Object.assign(settings, migration);
    await chrome.storage.local.set(migration);
    await chrome.storage.local.remove(['communitySkipMode', 'communityAutoSkipTrusted', 'skipLabeledAds']);
    if (settings.communityConsentGranted) settings.communityClientId = await getContributorId();
    log('扩展已启动', settings);
    ensurePlayerControls();
    showCommunityConsent();
  })();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
    if (changes.communityConsentPrompted?.newValue === true) {
      clearTimeout(displayToast.timer);
      document.getElementById('das-toast')?.classList.remove('das-visible');
    }
    if (changes.communityConsentGranted?.newValue === true && !settings.communityClientId) {
      void getContributorId().then((id) => {
        settings.communityClientId = id;
        const video = getActiveVideo();
        if (video && settings.communityEnabled) void loadCommunitySegments(video);
      });
    }
    if (changes.communityConsentGranted?.newValue === false || changes.communityEnabled?.newValue === false) {
      communityCache.clear();
    }
    renderPlayerControls();
    renderPreviewBar();
  });

  const observer = new MutationObserver(() => {
    schedulePlayerControls();
    clearTimeout(observer.timer);
    observer.timer = setTimeout(() => {
      ensurePlayerControls();
    }, 180);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('play', schedulePlayerControls, true);
  document.addEventListener('loadedmetadata', schedulePlayerControls, true);
  document.addEventListener('pointermove', schedulePlayerControls, { passive: true });
  document.addEventListener('keydown', handleShortcut, true);
  setInterval(checkLocalSegments, 250);
  setInterval(schedulePlayerControls, 300);
  setInterval(renderPreviewBar, 300);
})();
