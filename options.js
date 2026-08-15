const DEFAULT_COMMUNITY_API='https://douyin-ad-skipper-api.douyin-skip-community.workers.dev';
const CATEGORY_LABELS={sponsor:'赞助/广告',selfpromo:'自我推广',interaction:'互动提醒'};
const DEFAULTS = { enabled:true, skipLocalSegments:true, showToast:true, debug:false, shortcutsEnabled:true, shortcutCreate:'Alt+KeyZ', shortcutCancel:'Alt+KeyX', shortcutSubmit:'Alt+Enter', skippedCount:0, localSegments:{}, communityEnabled:false, communityConsentGranted:false, communityConsentPrompted:false, communityApiBase:DEFAULT_COMMUNITY_API, categoryModeSponsor:'auto', categoryModeSelfpromo:'manual', categoryModeInteraction:'manual', communityClientId:'' };
let state = { ...DEFAULTS };
let capturingShortcut='';
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
    return `<article class="video-group"><header class="video-head"><div><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(info.title||`抖音作品 ${videoId}`)}</strong></a><span>${escapeHtml(info.author||'未记录作者')} · ID ${videoId}</span></div><em>${segments.length} 段</em></header>${segments.map((item)=>{const [statusClass,statusText]=segmentStatus(item);const category=item.category||'sponsor';return `<div class="segment-row"><div><span class="time-range">${formatTime(item.start)} → ${formatTime(item.end)}</span>${item.storageSource==='community'?'':`<div class="nudge-controls"><button data-adjust="start" data-delta="-0.1" data-video-id="${videoId}" data-index="${item.index}">起点 −</button><button data-adjust="start" data-delta="0.1" data-video-id="${videoId}" data-index="${item.index}">起点 +</button><button data-adjust="end" data-delta="-0.1" data-video-id="${videoId}" data-index="${item.index}">终点 −</button><button data-adjust="end" data-delta="0.1" data-video-id="${videoId}" data-index="${item.index}">终点 +</button></div>`}</div><div class="segment-copy"><strong>${CATEGORY_LABELS[category]||'片段'} <i class="segment-status ${statusClass}">${statusText}</i></strong><span>${item.storageSource==='community'?'已保存在社区':item.previewed?'✓ 已预览':'修改或创建后需预览'} · ${item.createdAt?new Date(item.createdAt).toLocaleString('zh-CN'):'旧版片段'}</span></div><div class="segment-actions">${item.storageSource==='community'?'<button class="upload-button" disabled>云端片段</button>':`<select class="category-select" data-video-id="${videoId}" data-index="${item.index}"><option value="sponsor" ${category==='sponsor'?'selected':''}>赞助/广告</option><option value="selfpromo" ${category==='selfpromo'?'selected':''}>自我推广</option><option value="interaction" ${category==='interaction'?'selected':''}>互动提醒</option></select><button class="edit-button" data-video-id="${videoId}" data-index="${item.index}">编辑时间</button><button class="upload-button" data-video-id="${videoId}" data-index="${item.index}" ${isUploadReady(item)?'':'disabled'}>${isUploadReady(item)?'上传社区':'等待预览'}</button><button class="delete-button" data-video-id="${videoId}" data-index="${item.index}">删除草稿</button>`}</div></div>`}).join('')}</article>`;
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
  if(!state.communityConsentGranted||!state.communityEnabled||!state.communityApiBase||!state.communityClientId)return;
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
  }catch(error){console.error('[抖音社区片段助手] 获取我的社区片段失败',error)}
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

async function updateLocalSegment(videoId,index,changes,message) {
  const localSegments={...state.localSegments};const segments=[...(localSegments[videoId]||[])];const current=segments[index];if(!current)return;
  const next={...current,...changes,previewed:false};
  if(next.start<0||next.end<=next.start+0.2||next.end-next.start>600)return toast('调整后的时间范围无效');
  segments[index]=next;segments.sort((a,b)=>a.start-b.start);localSegments[videoId]=segments;state.localSegments=localSegments;
  await chrome.storage.local.set({localSegments});renderOverview();renderSegments();toast(message);
}

async function adjustSegment(videoId,index,field,delta) {
  const current=state.localSegments?.[videoId]?.[index];if(!current)return;
  const value=Math.round((Number(current[field])+delta)*10)/10;
  await updateLocalSegment(videoId,index,{[field]:value},'已调整 0.1 秒，请重新预览');
}

async function ensureCommunityReady() {
  if (!state.communityConsentGranted || !state.communityEnabled) {
    toast('请先在“社区共享”中同意并启用社区');
    return false;
  }
  return state.communityApiBase === DEFAULT_COMMUNITY_API;
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
      body:JSON.stringify({videoId,start:Number(segment.start),end:Number(segment.end),category:segment.category||'sponsor',clientRequestId:crypto.randomUUID()}),
    });
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.json();
    const localSegments={...state.localSegments};const segments=[...(localSegments[videoId]||[])];segments.splice(index,1);
    if(segments.length)localSegments[videoId]=segments;else delete localSegments[videoId];
    state.localSegments=localSegments;await chrome.storage.local.set({localSegments});
    await fetchMyContributions();
    return true;
  } catch(error) {
    console.error('[抖音社区片段助手] 上传社区失败',error);
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
  const payload = {format:'douyin-ad-skipper-backup',version:5,exportedAt:new Date().toISOString(),settings:{enabled:state.enabled,skipLocalSegments:state.skipLocalSegments,showToast:state.showToast,debug:state.debug,shortcutsEnabled:state.shortcutsEnabled,shortcutCreate:state.shortcutCreate,shortcutCancel:state.shortcutCancel,shortcutSubmit:state.shortcutSubmit,categoryModeSponsor:state.categoryModeSponsor,categoryModeSelfpromo:state.categoryModeSelfpromo,categoryModeInteraction:state.categoryModeInteraction},localSegments:state.localSegments};
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})); const a=document.createElement('a'); a.href=url; a.download=`douyin-ad-skipper-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); toast('备份已导出');
}

async function importData(file) {
  try {
    if(file.size>2*1024*1024)throw new Error('too_large');
    const payload=JSON.parse(await file.text());
    if(payload.format!=='douyin-ad-skipper-backup'||!payload.localSegments||typeof payload.localSegments!=='object'||Array.isArray(payload.localSegments))throw new Error('invalid');
    const entries=Object.entries(payload.localSegments);if(entries.length>1000)throw new Error('too_many');
    const merged={...state.localSegments};let total=0;
    for(const [id,segments] of entries){
      if(!/^\d{10,24}$/.test(id)||!Array.isArray(segments))throw new Error('invalid_segment');
      const valid=segments.map((item)=>normalizeImportedSegment(item,id));total+=valid.length;if(total>10000)throw new Error('too_many');
      merged[id]=[...(merged[id]||[]),...valid].sort((a,b)=>a.start-b.start);
    }
    const allowedSettings=['enabled','skipLocalSegments','showToast','debug','shortcutsEnabled','shortcutCreate','shortcutCancel','shortcutSubmit','categoryModeSponsor','categoryModeSelfpromo','categoryModeInteraction'];
    const importedSettings=Object.fromEntries(Object.entries(payload.settings||{}).filter(([key])=>allowedSettings.includes(key)));
    for(const key of ['enabled','skipLocalSegments','showToast','debug','shortcutsEnabled'])if(key in importedSettings)importedSettings[key]=importedSettings[key]===true;
    for(const key of ['categoryModeSponsor','categoryModeSelfpromo','categoryModeInteraction'])if(key in importedSettings&&!['auto','manual','disabled'].includes(importedSettings[key]))delete importedSettings[key];
    for(const key of ['shortcutCreate','shortcutCancel','shortcutSubmit'])if(key in importedSettings&&!/^(?:(?:Ctrl|Alt|Shift|Meta)\+)+(?:Key[A-Z]|Digit\d|Enter|Space|Arrow(?:Up|Down|Left|Right))$/.test(String(importedSettings[key])))delete importedSettings[key];
    const update={...importedSettings,localSegments:merged};await chrome.storage.local.set(update);state={...state,...update};syncSettings();renderOverview();renderSegments();toast('备份已导入');
  } catch { toast('无法导入：文件格式不正确或数据过大'); }
}

function normalizeImportedSegment(item,videoId){
  if(!item||typeof item!=='object')throw new Error('invalid_segment');
  const start=Number(item.start),end=Number(item.end),category=item.category||'sponsor';
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end-start>600||!CATEGORY_LABELS[category])throw new Error('invalid_segment');
  return {start,end,category,createdAt:Number.isFinite(Number(item.createdAt))?Number(item.createdAt):Date.now(),submissionStatus:item.submissionStatus==='submitted'?'submitted':'pending',previewed:item.previewed===true,title:String(item.title||`抖音作品 ${videoId}`).slice(0,300),author:String(item.author||'').slice(0,100),url:`https://www.douyin.com/video/${videoId}`};
}

function syncSettings() {
  ['enabled','skipLocalSegments','showToast','debug','shortcutsEnabled','communityEnabled'].forEach((key)=>{ $(`#${key}`).checked=Boolean(state[key]); });
  document.querySelectorAll('.category-mode').forEach((select)=>{select.value=state[select.dataset.setting]||DEFAULTS[select.dataset.setting]});
  document.querySelectorAll('.shortcut-capture').forEach((button)=>{button.textContent=formatShortcut(state[button.dataset.setting]||DEFAULTS[button.dataset.setting])});
  renderCommunityStatus();
}

function shortcutSignature(event){return [event.ctrlKey?'Ctrl':'',event.altKey?'Alt':'',event.shiftKey?'Shift':'',event.metaKey?'Meta':'',event.code].filter(Boolean).join('+')}
function formatShortcut(value){return String(value||'').replace(/Key([A-Z])/,'$1').replace(/Digit(\d)/,'$1').split('+').join(' + ')}

function renderCommunityStatus() {
  const status=$('#communityStatus');
  const granted=state.communityConsentGranted===true;
  const enabled=granted&&state.communityEnabled===true;
  status.textContent=enabled?'已启用':granted?'已暂停':state.communityConsentPrompted?'仅本地':'等待选择';
  $('#overviewStatus').textContent=enabled?'社区已启用':granted?'社区已暂停':'仅本地';
  $('#sidebarPrivacy').innerHTML=enabled?'社区查询已启用<br>草稿需手动提交':'本地草稿只保存在此浏览器';
  $('#communityApiDisplay').textContent=DEFAULT_COMMUNITY_API;
  $('#communityEnabled').disabled=!granted;
  $('#grantCommunityConsent').hidden=granted;
  $('#useLocalOnly').hidden=granted;
  $('#revokeCommunityConsent').hidden=!granted;
  $('#consentTitle').textContent=granted?'社区共享已授权':state.communityConsentPrompted?'当前为仅本地模式':'选择社区模式';
  $('#consentDescription').textContent=granted
    ? '扩展只在社区查询启用时发送当前作品 ID 的哈希；片段内容仍只会在你主动提交时上传。'
    : '启用后，扩展会发送当前作品 ID 的哈希来查询共享片段；不会上传完整观看历史，本地草稿只有在你主动提交时才会上传。';
}

async function setCommunityConsent(granted) {
  const update={communityConsentPrompted:true,communityConsentGranted:granted===true,communityEnabled:granted===true,communityApiBase:DEFAULT_COMMUNITY_API};
  Object.assign(state,update);
  if(granted&&!state.communityClientId)state.communityClientId=await getContributorId();
  if(!granted){communitySegments=[];communityStats={submittedCount:0,contributedSeconds:0,skipCount:0,helpedPeople:0,secondsSaved:0}}
  await chrome.storage.local.set(update);
  syncSettings();renderOverview();renderSegments();
  if(granted)await fetchMyContributions();
  toast(granted?'社区共享已启用':'已切换为仅本地使用');
}

document.querySelectorAll('nav button[data-page]').forEach((button)=>button.addEventListener('click',()=>showPage(button.dataset.page)));
document.querySelectorAll('[data-goto]').forEach((button)=>button.addEventListener('click',()=>showPage(button.dataset.goto)));
document.querySelectorAll('.shortcut-capture').forEach((button)=>button.addEventListener('click',()=>{
  document.querySelectorAll('.shortcut-capture').forEach((item)=>item.classList.remove('capturing'));
  capturingShortcut=button.dataset.setting;button.classList.add('capturing');button.textContent='请按组合键…';button.focus();
}));
document.addEventListener('keydown',async(event)=>{
  if(!capturingShortcut)return;
  event.preventDefault();event.stopPropagation();
  const button=document.querySelector(`.shortcut-capture[data-setting="${capturingShortcut}"]`);
  if(event.code==='Escape'){button?.classList.remove('capturing');capturingShortcut='';syncSettings();return}
  if(['ControlLeft','ControlRight','AltLeft','AltRight','ShiftLeft','ShiftRight','MetaLeft','MetaRight'].includes(event.code))return;
  if(!event.ctrlKey&&!event.altKey&&!event.shiftKey&&!event.metaKey){toast('快捷键必须包含至少一个修饰键');return}
  const signature=shortcutSignature(event);
  const conflict=['shortcutCreate','shortcutCancel','shortcutSubmit'].find((key)=>key!==capturingShortcut&&state[key]===signature);
  if(conflict){toast('这个组合键已经用于其他操作');return}
  const key=capturingShortcut;capturingShortcut='';state[key]=signature;await chrome.storage.local.set({[key]:signature});button?.classList.remove('capturing');syncSettings();toast('快捷键已保存');
},true);
['enabled','skipLocalSegments','showToast','debug','shortcutsEnabled'].forEach((key)=>$(`#${key}`).addEventListener('change',(event)=>{state[key]=event.target.checked;chrome.storage.local.set({[key]:state[key]});toast('设置已保存')}));
document.querySelectorAll('.category-mode').forEach((select)=>select.addEventListener('change',async(event)=>{const key=event.target.dataset.setting;state[key]=event.target.value;const update={[key]:state[key]};if(state[key]==='manual'){state.showToast=true;update.showToast=true;$('#showToast').checked=true}await chrome.storage.local.set(update);toast('分类处理方式已保存')}));
$('#communityEnabled').addEventListener('change',async(event)=>{
  if(event.target.checked&&!state.communityConsentGranted){event.target.checked=false;await setCommunityConsent(true);return}
  state.communityEnabled=event.target.checked;await chrome.storage.local.set({communityEnabled:state.communityEnabled});renderCommunityStatus();toast('社区查询设置已保存');
});
$('#grantCommunityConsent').addEventListener('click',()=>{void setCommunityConsent(true)});
$('#useLocalOnly').addEventListener('click',()=>{void setCommunityConsent(false)});
$('#revokeCommunityConsent').addEventListener('click',()=>{void setCommunityConsent(false)});
$('#segmentSearch').addEventListener('input',renderSegments);
$('#segmentList').addEventListener('click',async(event)=>{
  const adjustButton=event.target.closest('[data-adjust]');if(adjustButton){await adjustSegment(adjustButton.dataset.videoId,Number(adjustButton.dataset.index),adjustButton.dataset.adjust,Number(adjustButton.dataset.delta));return}
  const editButton=event.target.closest('.edit-button');if(editButton){await editSegment(editButton.dataset.videoId,Number(editButton.dataset.index));return}
  const deleteButton=event.target.closest('.delete-button');if(deleteButton){deleteSegment(deleteButton.dataset.videoId,Number(deleteButton.dataset.index));return}
  const uploadButton=event.target.closest('.upload-button');if(uploadButton&&!uploadButton.disabled){uploadButton.disabled=true;uploadButton.textContent='上传中…';const ok=await uploadSegment(uploadButton.dataset.videoId,Number(uploadButton.dataset.index));renderOverview();renderSegments();toast(ok?'片段已上传社区':'上传失败，片段仍保留在本地')}
});
$('#segmentList').addEventListener('change',async(event)=>{
  const select=event.target.closest('.category-select');if(!select||!CATEGORY_LABELS[select.value])return;
  const videoId=select.dataset.videoId;const index=Number(select.dataset.index);if(!state.localSegments?.[videoId]?.[index])return;
  await updateLocalSegment(videoId,index,{category:select.value},'片段分类已保存');
});
$('#uploadAllSegments').addEventListener('click',uploadAllPending);
$('#exportData').addEventListener('click',exportData);
$('#importData').addEventListener('click',()=>$('#importFile').click());
$('#importFile').addEventListener('change',(event)=>{if(event.target.files[0])importData(event.target.files[0]);event.target.value=''});
$('#clearSegments').addEventListener('click',async()=>{if(confirm('确定清空所有本地片段吗？此操作无法撤销。')){state.localSegments={};await chrome.storage.local.set({localSegments:{}});renderOverview();renderSegments();toast('本地片段已清空')}});

(async()=>{const stored=await chrome.storage.local.get(null);state={...DEFAULTS,...stored};if(!Object.hasOwn(stored,'categoryModeSponsor')){const legacyMode=['auto','manual','disabled'].includes(stored.communitySkipMode)?stored.communitySkipMode:'auto';const categoryModes={categoryModeSponsor:legacyMode,categoryModeSelfpromo:legacyMode,categoryModeInteraction:legacyMode};state={...state,...categoryModes};await chrome.storage.local.set(categoryModes)}const migration={communityApiBase:DEFAULT_COMMUNITY_API};if(!Object.hasOwn(stored,'communityConsentPrompted'))Object.assign(migration,{communityConsentPrompted:false,communityConsentGranted:false,communityEnabled:false});else if(!state.communityConsentGranted&&state.communityEnabled)migration.communityEnabled=false;Object.assign(state,migration);await chrome.storage.local.set(migration);await chrome.storage.local.remove(['communitySkipMode','communityAutoSkipTrusted','skipLabeledAds']);if(state.communityConsentGranted)state.communityClientId=await getContributorId();const version=chrome.runtime.getManifest().version;$('#extensionVersion').textContent=`版本 ${version}`;$('#sidebarVersion').textContent=`社区片段助手 · v${version}`;syncSettings();renderOverview();renderSegments();showPage(location.hash.slice(1)||'overview');if(state.communityConsentGranted&&state.communityEnabled)await fetchMyContributions()})();
chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local')return;for(const [key,change] of Object.entries(changes))state[key]=change.newValue;syncSettings();renderOverview()});
