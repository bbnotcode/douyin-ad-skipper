const DEFAULTS = { enabled:true, skipLabeledAds:true, skipLocalSegments:true, showToast:true, debug:false, skippedCount:0, localSegments:{}, communityEnabled:false, communityApiBase:'', communityAutoSkipTrusted:true, communityClientId:'' };
let state = { ...DEFAULTS };

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value='') => String(value).replace(/[&<>'"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const formatTime = (seconds=0) => `${Math.floor(seconds/60)}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;
const allSegments = () => Object.entries(state.localSegments || {}).flatMap(([videoId,segments]) => segments.map((segment,index) => ({...segment,videoId,index})));

function showPage(name) {
  document.querySelectorAll('[data-page]').forEach((element) => element.classList.toggle('active', element.dataset.page === name));
  history.replaceState(null,'',`#${name}`);
  if (name === 'segments') renderSegments();
}

function toast(message) {
  const element = $('#optionsToast'); element.textContent = message; element.classList.add('visible');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('visible'),1800);
}

function segmentTitle(segment) { return segment.title || `抖音作品 ${segment.videoId}`; }
function segmentAuthor(segment) { return segment.author || '未记录作者'; }
function isPending(segment) { return (segment.submissionStatus || 'pending') === 'pending'; }
function segmentStatus(segment) { return isPending(segment) ? ['pending','待提交'] : ['submitted','已提交']; }

function renderOverview() {
  const segments = allSegments();
  const duration = segments.reduce((sum,item) => sum + Math.max(0,Number(item.end)-Number(item.start)),0);
  $('#metricSegments').textContent = segments.length;
  $('#metricVideos').textContent = Object.keys(state.localSegments || {}).filter((id) => state.localSegments[id]?.length).length;
  $('#metricSkips').textContent = Number(state.skippedCount || 0).toLocaleString('zh-CN');
  $('#metricDuration').textContent = formatTime(duration);
  $('#navSegmentCount').textContent = segments.length;
  const recent = [...segments].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,5);
  $('#recentSegments').innerHTML = recent.length ? recent.map((item) => `<div class="recent-item"><div><strong>${escapeHtml(segmentTitle(item))}</strong><span>${escapeHtml(segmentAuthor(item))} · ${formatTime(item.start)}–${formatTime(item.end)}</span></div><span>${item.createdAt ? new Date(item.createdAt).toLocaleDateString('zh-CN') : '旧版片段'}</span></div>`).join('') : '<div class="empty">还没有创建片段。请在抖音播放器控制栏点击标记图标。</div>';
}

function renderSegments() {
  const query = ($('#segmentSearch').value || '').trim().toLowerCase();
  const groups = Object.entries(state.localSegments || {}).map(([videoId,segments]) => ({videoId,segments})).filter(({videoId,segments}) => {
    const haystack = `${videoId} ${segments[0]?.title||''} ${segments[0]?.author||''}`.toLowerCase();
    return segments.length && (!query || haystack.includes(query));
  });
  const count = groups.reduce((sum,group)=>sum+group.segments.length,0);
  const pendingCount = groups.reduce((sum,group)=>sum+group.segments.filter(isPending).length,0);
  $('#segmentSummary').textContent = `${groups.length} 个视频 · ${count} 个片段`;
  $('#uploadAllSegments').disabled = pendingCount === 0;
  $('#uploadAllSegments').textContent = pendingCount ? `上传全部待提交（${pendingCount}）` : '没有待提交片段';
  $('#segmentList').innerHTML = groups.length ? groups.map(({videoId,segments}) => {
    const info = segments.find((item)=>item.title||item.author||item.url) || {};
    const url = info.url || `https://www.douyin.com/video/${videoId}`;
    return `<article class="video-group"><header class="video-head"><div><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(info.title||`抖音作品 ${videoId}`)}</strong></a><span>${escapeHtml(info.author||'未记录作者')} · ID ${videoId}</span></div><em>${segments.length} 段</em></header>${segments.map((item,index)=>{const [statusClass,statusText]=segmentStatus(item);return `<div class="segment-row"><span class="time-range">${formatTime(item.start)} → ${formatTime(item.end)}</span><div class="segment-copy"><strong>广告片段 <i class="segment-status ${statusClass}">${statusText}</i></strong><span>${item.createdAt?new Date(item.createdAt).toLocaleString('zh-CN'):'从旧版本保存'}</span></div><div class="segment-actions"><button class="upload-button" data-video-id="${videoId}" data-index="${index}" ${isPending(item)?'':'disabled'}>${isPending(item)?'上传社区':'已上传'}</button><button class="delete-button" data-video-id="${videoId}" data-index="${index}">删除</button></div></div>`}).join('')}</article>`;
  }).join('') : '<div class="panel empty">没有找到本地片段。</div>';
}

async function deleteSegment(videoId,index) {
  const localSegments = {...state.localSegments}; const segments = [...(localSegments[videoId]||[])]; segments.splice(index,1);
  if (segments.length) localSegments[videoId]=segments; else delete localSegments[videoId];
  state.localSegments=localSegments; await chrome.storage.local.set({localSegments}); renderOverview(); renderSegments(); toast('片段已删除');
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
  try {
    const response=await fetch(`${new URL(state.communityApiBase).origin}/v1/segments`,{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Client-ID':state.communityClientId},
      body:JSON.stringify({videoId,start:Number(segment.start),end:Number(segment.end),category:'sponsor',clientRequestId:crypto.randomUUID()}),
    });
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload=await response.json();
    segment.submissionStatus='submitted';
    segment.communityId=payload.segment?.id||payload.id||'';
    await chrome.storage.local.set({localSegments:state.localSegments});
    return true;
  } catch(error) {
    console.error('[抖音广告跳过] 上传社区失败',error);
    return false;
  }
}

async function uploadAllPending() {
  if (!await ensureCommunityReady()) return;
  const button=$('#uploadAllSegments');
  const pending=allSegments().filter(isPending);
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
  const payload = {format:'douyin-ad-skipper-backup',version:1,exportedAt:new Date().toISOString(),settings:{enabled:state.enabled,skipLabeledAds:state.skipLabeledAds,skipLocalSegments:state.skipLocalSegments,showToast:state.showToast,debug:state.debug},localSegments:state.localSegments};
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
  ['enabled','skipLabeledAds','skipLocalSegments','showToast','debug','communityEnabled','communityAutoSkipTrusted'].forEach((key)=>{ $(`#${key}`).checked=Boolean(state[key]); });
  $('#communityApiBase').value = state.communityApiBase || '';
  renderCommunityStatus();
}

async function communityOriginPattern() {
  try { const url=new URL($('#communityApiBase').value.trim()); return url.protocol==='https:' ? `${url.origin}/*` : ''; } catch { return ''; }
}

async function renderCommunityStatus() {
  const status=$('#communityStatus');
  if(!state.communityApiBase){status.textContent='未连接';return}
  let pattern;
  try { pattern=`${new URL(state.communityApiBase).origin}/*`; } catch { status.textContent='地址无效'; return; }
  const granted=await chrome.permissions.contains({origins:[pattern]});
  status.textContent=granted&&state.communityEnabled?'已启用':granted?'已授权':'权限缺失';
}

document.querySelectorAll('nav button[data-page]').forEach((button)=>button.addEventListener('click',()=>showPage(button.dataset.page)));
document.querySelectorAll('[data-goto]').forEach((button)=>button.addEventListener('click',()=>showPage(button.dataset.goto)));
['enabled','skipLabeledAds','skipLocalSegments','showToast','debug','communityAutoSkipTrusted'].forEach((key)=>$(`#${key}`).addEventListener('change',(event)=>{state[key]=event.target.checked;chrome.storage.local.set({[key]:state[key]});toast('设置已保存')}));
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
$('#disconnectCommunity').addEventListener('click',async()=>{
  if(state.communityApiBase){const pattern=`${new URL(state.communityApiBase).origin}/*`;await chrome.permissions.remove({origins:[pattern]})}
  state.communityApiBase='';state.communityEnabled=false;await chrome.storage.local.set({communityApiBase:'',communityEnabled:false});syncSettings();toast('已断开社区 API');
});
$('#segmentSearch').addEventListener('input',renderSegments);
$('#segmentList').addEventListener('click',async(event)=>{
  const deleteButton=event.target.closest('.delete-button');if(deleteButton){deleteSegment(deleteButton.dataset.videoId,Number(deleteButton.dataset.index));return}
  const uploadButton=event.target.closest('.upload-button');if(uploadButton&&!uploadButton.disabled){uploadButton.disabled=true;uploadButton.textContent='上传中…';const ok=await uploadSegment(uploadButton.dataset.videoId,Number(uploadButton.dataset.index));renderOverview();renderSegments();toast(ok?'片段已上传社区':'上传失败，片段仍保留在本地')}
});
$('#uploadAllSegments').addEventListener('click',uploadAllPending);
$('#exportData').addEventListener('click',exportData);
$('#importData').addEventListener('click',()=>$('#importFile').click());
$('#importFile').addEventListener('change',(event)=>{if(event.target.files[0])importData(event.target.files[0]);event.target.value=''});
$('#clearSegments').addEventListener('click',async()=>{if(confirm('确定清空所有本地片段吗？此操作无法撤销。')){state.localSegments={};await chrome.storage.local.set({localSegments:{}});renderOverview();renderSegments();toast('本地片段已清空')}});

chrome.storage.local.get(DEFAULTS,(stored)=>{state={...DEFAULTS,...stored};if(!state.communityClientId){state.communityClientId=crypto.randomUUID();chrome.storage.local.set({communityClientId:state.communityClientId})}syncSettings();renderOverview();renderSegments();showPage(location.hash.slice(1)||'overview')});
chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local')return;for(const [key,change] of Object.entries(changes))state[key]=change.newValue;renderOverview()});
