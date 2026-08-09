const DEFAULT_COMMUNITY_API='https://douyin-ad-skipper-api.douyin-skip-community.workers.dev';
const DEFAULTS = { enabled:true, skipLabeledAds:true, skipLocalSegments:true, showToast:true, debug:false, shortcutsEnabled:true, skippedCount:0, localSegments:{}, communityEnabled:true, communityApiBase:DEFAULT_COMMUNITY_API, communityAutoSkipTrusted:true, communitySkipMode:'auto', communityClientId:'' };
let state = { ...DEFAULTS };
let communitySegments = [];
let communityStats = { submittedCount:0, contributedSeconds:0, skipCount:0, helpedPeople:0, secondsSaved:0 };

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value='') => String(value).replace(/[&<>'"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const formatTime = (seconds=0) => `${Math.floor(seconds/60)}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;
const formatContribution = (seconds=0) => {
  const rounded=Math.max(0,Math.round(seconds));
  if(rounded<60)return `${rounded} 秒`;
  const hours=Math.floor(rounded/3600),minutes=Math.round((rounded%3600)/60);
  return hours ? `${hours} 小时${minutes?` ${minutes} 分钟`:''}` : `${minutes} 分钟`;
};
const localSegmentItems = () => Object.entries(state.localSegments || {}).flatMap(([videoId,segments]) => segments.map((segment,index) => ({...segment,videoId,index,storageSource:'local'})));
const allSegments = () => [...localSegmentItems(), ...communitySegments];

function showPage(name) {
  document.querySelectorAll('[data-page]').forEach((element) => element.classList.toggle('active', element.dataset.page === name));
  history.replaceState(null,'',`#${name}`);
  if (name === 'segments') { renderSegments(); fetchMyContributions(); }
}

function toast(message) {
  const element = $('#optionsToast'); element.textContent = message; element.classList.add('visible');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('visible'),1800);
}

function segmentTitle(segment) { return segment.title || `抖音作品 ${segment.videoId}`; }
function segmentAuthor(segment) { return segment.author || '未记录作者'; }
function isPending(segment) { return segment.storageSource !== 'community' && (segment.submissionStatus || 'pending') === 'pending'; }
function isUploadReady(segment) { return isPending(segment) && segment.previewed === true; }
function segmentStatus(segment) { return isPending(segment) ? ['pending','待提交'] : ['submitted','社区保存']; }

function renderOverview() {
  const segments = allSegments();
  const duration = segments.reduce((sum,item) => sum + Math.max(0,Number(item.end)-Number(item.start)),0);
  $('#metricSegments').textContent = segments.length;
  $('#metricVideos').textContent = new Set(segments.map((item)=>item.videoId)).size;
  $('#metricSkips').textContent = Number(state.skippedCount || 0).toLocaleString('zh-CN');
  $('#metricDuration').textContent = formatTime(duration);
  $('#metricContributionDuration').textContent = formatContribution(communityStats.secondsSaved);
  $('#metricContributionCount').textContent = `帮助 ${communityStats.helpedPeople} 人跳过 ${communityStats.skipCount} 次 · 已提交 ${communityStats.submittedCount} 个片段`;
  $('#navSegmentCount').textContent = segments.length;
  const recent = [...segments].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,5);
  $('#recentSegments').innerHTML = recent.length ? recent.map((item) => `<div class="recent-item"><div><strong>${escapeHtml(segmentTitle(item))}</strong><span>${escapeHtml(segmentAuthor(item))} · ${formatTime(item.start)}–${formatTime(item.end)}</span></div><span>${item.createdAt ? new Date(item.createdAt).toLocaleDateString('zh-CN') : '旧版片段'}</span></div>`).join('') : '<div class="empty">还没有创建片段。请在抖音播放器控制栏点击标记图标。</div>';
}

function renderSegments() {
  const query = ($('#segmentSearch').value || '').trim().toLowerCase();
  const grouped=new Map();
  for(const segment of allSegments()){if(!grouped.has(segment.videoId))grouped.set(segment.videoId,[]);grouped.get(segment.videoId).push(segment)}
  const groups = [...grouped.entries()].map(([videoId,segments]) => ({videoId,segments})).filter(({videoId,segments}) => {
    const haystack = `${videoId} ${segments[0]?.title||''} ${segments[0]?.author||''}`.toLowerCase();
    return segments.length && (!query || haystack.includes(query));
  });
  const count = groups.reduce((sum,group)=>sum+group.segments.length,0);
  const pendingCount = localSegmentItems().filter(isPending).length;
  const readyCount = localSegmentItems().filter(isUploadReady).length;
  $('#segmentSummary').textContent = `${groups.length} 个视频 · ${count} 个片段`;
  $('#uploadAllSegments').disabled = readyCount === 0;
  $('#uploadAllSegments').textContent = readyCount ? `上传全部已预览（${readyCount}）` : pendingCount ? '请先在播放器预览' : '没有待提交片段';
  $('#segmentList').innerHTML = groups.length ? groups.map(({videoId,segments}) => {
    const info = segments.find((item)=>item.title||item.author||item.url) || {};
    const url = info.url || `https://www.douyin.com/video/${videoId}`;
    return `<article class="video-group"><header class="video-head"><div><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(info.title||`抖音作品 ${videoId}`)}</strong></a><span>${escapeHtml(info.author||'未记录作者')} · ID ${videoId}</span></div><em>${segments.length} 段</em></header>${segments.map((item)=>{const [statusClass,statusText]=segmentStatus(item);return `<div class="segment-row"><span class="time-range">${formatTime(item.start)} → ${formatTime(item.end)}</span><div class="segment-copy"><strong>广告片段 <i class="segment-status ${statusClass}">${statusText}</i></strong><span>${item.storageSource==='community'?'已保存在社区':item.previewed?'✓ 已预览':'修改或创建后需预览'} · ${item.createdAt?new Date(item.createdAt).toLocaleString('zh-CN'):'旧版片段'}</span></div><div class="segment-actions">${item.storageSource==='community'?'<button class="upload-button" disabled>云端片段</button>':`<button class="edit-button" data-video-id="${videoId}" data-index="${item.index}">编辑时间</button><button class="upload-button" data-video-id="${videoId}" data-index="${item.index}" ${isUploadReady(item)?'':'disabled'}>${isUploadReady(item)?'上传社区':'等待预览'}</button><button class="delete-button" data-video-id="${videoId}" data-index="${item.index}">删除草稿</button>`}</div></div>`}).join('')}</article>`;
  }).join('') : '<div class="panel empty">没有找到片段。</div>';
}

async function getContributorId() {
  const synced=await chrome.storage.sync.get({communityContributorId:''});
  if(/^[0-9a-f-]{16,64}$/i.test(synced.communityContributorId))return synced.communityContributorId;
  const legacy=await chrome.storage.local.get({communityClientId:''});
  const id=/^[0-9a-f-]{16,64}$/i.test(legacy.communityClientId)?legacy.communityClientId:crypto.randomUUID();
  await chrome.storage.sync.set({communityContributorId:id});
  await chrome.storage.local.remove('communityClientId');
  return id;
}

async function fetchMyContributions() {
  if(!state.communityEnabled||!state.communityApiBase||!state.communityClientId)return;
  try{
    const response=await fetch(`${new URL(state.communityApiBase).origin}/v1/me/segments?apiVersion=2`,{headers:{Accept:'application/json','X-Client-ID':state.communityClientId}});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const payload=await response.json();
    communitySegments=Array.isArray(payload.segments)?payload.segments.map((segment)=>({...segment,storageSource:'community',submissionStatus:'submitted'})):[];
    communityStats={submittedCount:Number(payload.stats?.submittedCount||0),contributedSeconds:Number(payload.stats?.contributedSeconds||0),skipCount:Number(payload.stats?.skipCount||0),helpedPeople:Number(payload.stats?.helpedPeople||0),secondsSaved:Number(payload.stats?.secondsSaved||0)};
    const remoteIds=new Set(communitySegments.map((item)=>item.id));
    const remoteTimes=new Set(communitySegments.map((item)=>`${item.videoId}:${Number(item.start).toFixed(3)}:${Number(item.end).toFixed(3)}`));
    let changed=false;const localSegments={};
    for(const [videoId,segments] of Object.entries(state.localSegments||{})){
      const kept=segments.filter((item)=>{
        const uploaded=(item.submissionStatus==='submitted')&&(remoteIds.has(item.communityId)||remoteTimes.has(`${videoId}:${Number(item.start).toFixed(3)}:${Number(item.end).toFixed(3)}`));
        if(uploaded)changed=true;return !uploaded;
      });
      if(kept.length)localSegments[videoId]=kept;
    }
    if(changed){state.localSegments=localSegments;await chrome.storage.local.set({localSegments})}
    renderOverview();renderSegments();
  }catch(error){console.error('[抖音广告跳过] 获取我的社区片段失败',error)}
}

async function deleteSegment(videoId,index) {
  const localSegments = {...state.localSegments}; const segments = [...(localSegments[videoId]||[])]; segments.splice(index,1);
  if (segments.length) localSegments[videoId]=segments; else delete localSegments[videoId];
  state.localSegments=localSegments; await chrome.storage.local.set({localSegments}); renderOverview(); renderSegments(); toast('片段已删除');
}

function parseTimeInput(value) {
  const text=String(value||'').trim();
  if(/^\d+(?:\.\d+)?$/.test(text))return Number(text);
  const match=text.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  return match?Number(match[1])*60+Number(match[2]):NaN;
}

async function editSegment(videoId,index) {
  const current=state.localSegments?.[videoId]?.[index];if(!current)return;
  const startInput=prompt('开始时间（秒或 分:秒）',formatTime(current.start));if(startInput===null)return;
  const start=parseTimeInput(startInput);if(!Number.isFinite(start))return toast('开始时间格式不正确');
  const endInput=prompt('结束时间（秒或 分:秒）',formatTime(current.end));if(endInput===null)return;
  const end=parseTimeInput(endInput);if(!Number.isFinite(end))return toast('结束时间格式不正确');
  if(start<0||end<=start+0.2||end-start>600)return toast('时间范围无效，片段最长 10 分钟');
  const localSegments={...state.localSegments};const segments=[...(localSegments[videoId]||[])];
  segments[index]={...current,start,end,previewed:false,createdAt:Date.now()};segments.sort((a,b)=>a.start-b.start);localSegments[videoId]=segments;
  state.localSegments=localSegments;await chrome.storage.local.set({localSegments});renderOverview();renderSegments();toast('时间已修改，请回到播放器重新预览');
}

async function ensureCommunityReady() {
  if (!state.communityEnabled || !state.communityApiBase) {
    toast('请先在“社区共享”中授权并连接 API');
    return false;
  }
  try {
    const pattern=`${new URL(state.communityApiBase).origin}/*`;
    if (!await chrome.permissions.contains({origins:[pattern]})) {
      toast('社区 API 域名权限缺失，请重新授权连接');
      return false;
    }
    return true;
  } catch {
    toast('社区 API 地址无效');
    return false;
  }
}

async function uploadSegment(videoId,index) {
  if (!await ensureCommunityReady()) return false;
  const segment=state.localSegments?.[videoId]?.[index];
  if (!segment || !isPending(segment)) return true;
  if (!isUploadReady(segment)){toast('请先在播放器完成片段预览');return false}
  try {
    const response=await fetch(`${new URL(state.communityApiBase).origin}/v1/segments`,{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Client-ID':state.communityClientId},
      body:JSON.stringify({videoId,start:Number(segment.start),end:Number(segment.end),category:'sponsor',clientRequestId:crypto.randomUUID()}),
    });
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.json();
    const localSegments={...state.localSegments};const segments=[...(localSegments[videoId]||[])];segments.splice(index,1);
    if(segments.length)localSegments[videoId]=segments;else delete localSegments[videoId];
    state.localSegments=localSegments;await chrome.storage.local.set({localSegments});
    await fetchMyContributions();
    return true;
  } catch(error) {
    console.error('[抖音广告跳过] 上传社区失败',error);
    return false;
  }
}

async function uploadAllPending() {
  if (!await ensureCommunityReady()) return;
  const button=$('#uploadAllSegments');
  const pending=localSegmentItems().filter(isUploadReady).sort((a,b)=>a.videoId===b.videoId?b.index-a.index:0);
  if(!pending.length)return;
  button.disabled=true;
  let success=0;
  for(let position=0;position<pending.length;position+=1){
    button.textContent=`正在上传 ${position+1}/${pending.length}`;
    if(await uploadSegment(pending[position].videoId,pending[position].index))success+=1;
  }
  renderOverview();renderSegments();
  toast(success===pending.length?`已上传 ${success} 个片段`:`已上传 ${success} 个，${pending.length-success} 个失败`);
}

function exportData() {
  const payload = {format:'douyin-ad-skipper-backup',version:2,exportedAt:new Date().toISOString(),settings:{enabled:state.enabled,skipLabeledAds:state.skipLabeledAds,skipLocalSegments:state.skipLocalSegments,showToast:state.showToast,debug:state.debug,shortcutsEnabled:state.shortcutsEnabled,communitySkipMode:state.communitySkipMode},localSegments:state.localSegments};
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})); const a=document.createElement('a'); a.href=url; a.download=`douyin-ad-skipper-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); toast('备份已导出');
}

async function importData(file) {
  try {
    const payload=JSON.parse(await file.text()); if(payload.format!=='douyin-ad-skipper-backup'||!payload.localSegments||typeof payload.localSegments!=='object') throw new Error('invalid');
    const merged={...state.localSegments}; for(const [id,segments] of Object.entries(payload.localSegments)){if(Array.isArray(segments)) merged[id]=[...(merged[id]||[]),...segments].sort((a,b)=>a.start-b.start)}
    const update={...payload.settings,localSegments:merged}; await chrome.storage.local.set(update); state={...state,...update}; syncSettings(); renderOverview(); renderSegments(); toast('备份已导入');
  } catch { toast('无法导入：文件格式不正确'); }
}

function syncSettings() {
  ['enabled','skipLabeledAds','skipLocalSegments','showToast','debug','shortcutsEnabled','communityEnabled'].forEach((key)=>{ $(`#${key}`).checked=Boolean(state[key]); });
  $('#communitySkipMode').value=state.communitySkipMode||'auto';
  $('#communityApiBase').value = state.communityApiBase || '';
  renderCommunityStatus();
}

async function communityOriginPattern() {
  try { const url=new URL($('#communityApiBase').value.trim()); return url.protocol==='https:' ? `${url.origin}/*` : ''; } catch { return ''; }
}

async function renderCommunityStatus() {
  const status=$('#communityStatus');
  const button=$('#connectCommunity');
  const reset=$('#disconnectCommunity');
  const typed=$('#communityApiBase').value.trim();
  let typedOrigin,configuredOrigin;
  try { typedOrigin=new URL(typed).origin;configuredOrigin=new URL(state.communityApiBase).origin; } catch { status.textContent='地址无效';button.textContent='授权并连接';button.disabled=false;return; }
  const pattern=`${typedOrigin}/*`;
  const granted=await chrome.permissions.contains({origins:[pattern]});
  const connected=granted&&typedOrigin===configuredOrigin;
  status.textContent=connected&&state.communityEnabled?'已启用':connected?'已停用':granted?'待连接':'待授权';
  button.textContent=connected?'已授权':'授权并连接';
  button.disabled=connected;
  reset.disabled=typedOrigin===DEFAULT_COMMUNITY_API;
}

document.querySelectorAll('nav button[data-page]').forEach((button)=>button.addEventListener('click',()=>showPage(button.dataset.page)));
document.querySelectorAll('[data-goto]').forEach((button)=>button.addEventListener('click',()=>showPage(button.dataset.goto)));
['enabled','skipLabeledAds','skipLocalSegments','showToast','debug','shortcutsEnabled'].forEach((key)=>$(`#${key}`).addEventListener('change',(event)=>{state[key]=event.target.checked;chrome.storage.local.set({[key]:state[key]});toast('设置已保存')}));
$('#communitySkipMode').addEventListener('change',async(event)=>{state.communitySkipMode=event.target.value;state.communityAutoSkipTrusted=state.communitySkipMode==='auto';const update={communitySkipMode:state.communitySkipMode,communityAutoSkipTrusted:state.communityAutoSkipTrusted};if(state.communitySkipMode==='manual'){state.showToast=true;update.showToast=true;$('#showToast').checked=true}await chrome.storage.local.set(update);toast('社区片段处理方式已保存')});
$('#communityEnabled').addEventListener('change',async(event)=>{
  if(event.target.checked&&!state.communityApiBase){event.target.checked=false;toast('请先授权并连接 API');return}
  state.communityEnabled=event.target.checked;await chrome.storage.local.set({communityEnabled:state.communityEnabled});renderCommunityStatus();toast('社区查询设置已保存');
});
$('#connectCommunity').addEventListener('click',async()=>{
  const pattern=await communityOriginPattern();if(!pattern){toast('请输入有效的 HTTPS API 地址');return}
  const granted=await chrome.permissions.request({origins:[pattern]});if(!granted){toast('未授予域名访问权限');return}
  const communityApiBase=new URL($('#communityApiBase').value.trim()).origin;state.communityApiBase=communityApiBase;state.communityEnabled=true;
  await chrome.storage.local.set({communityApiBase,communityEnabled:true});syncSettings();toast('社区 API 已连接');
});
$('#communityApiBase').addEventListener('input',renderCommunityStatus);
$('#disconnectCommunity').addEventListener('click',async()=>{
  let oldOrigin='';try{oldOrigin=new URL(state.communityApiBase).origin}catch{}
  if(oldOrigin&&oldOrigin!==DEFAULT_COMMUNITY_API)await chrome.permissions.remove({origins:[`${oldOrigin}/*`]});
  state.communityApiBase=DEFAULT_COMMUNITY_API;state.communityEnabled=true;
  await chrome.storage.local.set({communityApiBase:DEFAULT_COMMUNITY_API,communityEnabled:true});syncSettings();await fetchMyContributions();toast('已恢复默认公共 API');
});
$('#segmentSearch').addEventListener('input',renderSegments);
$('#segmentList').addEventListener('click',async(event)=>{
  const editButton=event.target.closest('.edit-button');if(editButton){await editSegment(editButton.dataset.videoId,Number(editButton.dataset.index));return}
  const deleteButton=event.target.closest('.delete-button');if(deleteButton){deleteSegment(deleteButton.dataset.videoId,Number(deleteButton.dataset.index));return}
  const uploadButton=event.target.closest('.upload-button');if(uploadButton&&!uploadButton.disabled){uploadButton.disabled=true;uploadButton.textContent='上传中…';const ok=await uploadSegment(uploadButton.dataset.videoId,Number(uploadButton.dataset.index));renderOverview();renderSegments();toast(ok?'片段已上传社区':'上传失败，片段仍保留在本地')}
});
$('#uploadAllSegments').addEventListener('click',uploadAllPending);
$('#exportData').addEventListener('click',exportData);
$('#importData').addEventListener('click',()=>$('#importFile').click());
$('#importFile').addEventListener('change',(event)=>{if(event.target.files[0])importData(event.target.files[0]);event.target.value=''});
$('#clearSegments').addEventListener('click',async()=>{if(confirm('确定清空所有本地片段吗？此操作无法撤销。')){state.localSegments={};await chrome.storage.local.set({localSegments:{}});renderOverview();renderSegments();toast('本地片段已清空')}});

(async()=>{const stored=await chrome.storage.local.get(DEFAULTS);state={...DEFAULTS,...stored};if(!stored.communitySkipMode)state.communitySkipMode=stored.communityAutoSkipTrusted===false?'manual':'auto';if(!state.communityApiBase||/^https:\/\/douyin-ad-skipper-api\.\d+\.workers\.dev\/?$/.test(state.communityApiBase)){state.communityApiBase=DEFAULT_COMMUNITY_API;state.communityEnabled=true;await chrome.storage.local.set({communityApiBase:DEFAULT_COMMUNITY_API,communityEnabled:true})}state.communityClientId=await getContributorId();syncSettings();renderOverview();renderSegments();showPage(location.hash.slice(1)||'overview');await fetchMyContributions()})();
chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local')return;for(const [key,change] of Object.entries(changes))state[key]=change.newValue;renderOverview()});
