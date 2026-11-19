/* Global read snapshot and explicit attention writes. No external adapter calls. */
let wbSnapshot=null,wbGeneration=0,wbView='home',wbFilter='all',wbScope='',wbEnded=false,wbOnly=false;
let wbPages={events:0,attention:0,reviews:0},wbPending=null,wbBusy=false,wbLoading=false,wbError='',wbDetail=null;
const wbSize=20,wbMain=document.querySelector('main'),wbWork=document.createElement('section');
wbWork.id='workPage';while(wbMain.firstChild)wbWork.append(wbMain.firstChild);wbMain.append(wbWork);
const wbHome=document.createElement('section');wbHome.id='globalWorkbench';wbMain.prepend(wbHome);
const wbNav=[...document.querySelector('.navGroup').children];
wbNav[0].disabled=false;wbNav[0].title='查看全部目标的行动与关注';wbNav[0].onclick=()=>showWorkbench('home');
wbNav[1].onclick=()=>showWorkbench('work');
const wbDrawer=document.createElement('dialog');wbDrawer.id='workbenchDrawer';wbDrawer.setAttribute('aria-labelledby','wbDetailTitle');document.body.append(wbDrawer);
const wbStar='<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg>';
function wbItems(){return wbSnapshot?.items||[]}
function wbGet(id){return wbItems().find(x=>x.id===id)}
function wbMatter(item){return item?.type==='event'?wbGet(item.parent):item?.type==='thing'?item:null}
function wbPath(item){const m=wbMatter(item),mod=m&&wbGet(m.parent),goal=mod&&wbGet(mod.parent);return m&&mod?.type==='module'&&goal?.type==='goal'?{m,mod,goal,text:[goal.name,mod.name,m.name].join(' / ')}:null}
function wbWatched(id){return !!wbSnapshot?.attention.find(x=>x.item_id===id)?.enabled}
function wbPriority(id){return wbSnapshot?.priorities.items.find(x=>x.id===id)}
function wbProgress(m){const parents=new Set(wbSnapshot.branches.map(x=>x.parent_id)),leaves=wbItems().filter(x=>x.type==='event'&&x.parent===m.id&&!parents.has(x.id)),valid=leaves.filter(x=>x.status!=='cancelled'),done=valid.filter(x=>x.status==='completed').length;return valid.length?`事件完成率 ${Math.round(done/valid.length*100)}% · ${done}/${valid.length}`:'暂无进度'}
function wbAttentionButton(m){const on=wbWatched(m.id),label=on?'取消持续关注':'持续关注';return `<button class="wbWatch ${on?'isWatched':''}" title="${label}" aria-label="${label}：${esc(m.name)}" aria-pressed="${on}" ${wbBusy||wbPending||wbError||wbLoading?'disabled':''} onclick="setAttention('${m.id}',${!on})">${wbStar}</button>`}
let wbLatestRead=Promise.resolve(false);
function loadWorkbench(){const request=wbReadWorkbench(++wbGeneration);wbLatestRead=request;return request}
async function wbReadWorkbench(run){wbLoading=true;drawWorkbench();try{const result=await api('/workbench');if(run!==wbGeneration)return wbLatestRead;wbSnapshot=result;wbError='';db.items=result.items;priorityData=result.priorities;wbBaseRender();paintAttention();return true}catch(e){if(run!==wbGeneration)return wbLatestRead;wbError=e.message;return false}finally{if(run===wbGeneration){wbLoading=false;drawWorkbench();paintAttention()}}}
function wbPagination(key,rows,renderRow){
 const size=key==='events'?10:wbSize,total=rows.length,last=Math.max(0,Math.ceil(total/size)-1);wbPages[key]=Math.max(0,Math.min(wbPages[key],last));const page=wbPages[key];
 const content=total?rows.slice(page*size,(page+1)*size).map(renderRow).join(''):wbEmptyState(key);
 if(key==='events')return content+`<nav class="wbPager" aria-label="行动清单分页"><span role="status">共 ${total} 条 · 第 ${total?page*size+1:0}–${Math.min((page+1)*size,total)} 条 · 第 ${page+1}/${last+1} 页</span><button data-direction="-1" ${!page?'disabled':''} onclick="wbChangeActionPage(-1)">上一页</button><button data-direction="1" ${page===last?'disabled':''} onclick="wbChangeActionPage(1)">下一页</button></nav>`;
 return content+(total>size?`<div class="wbPager"><span>共 ${total} 条 · 第 ${page+1}/${last+1} 页</span><button ${!page?'disabled':''} onclick="wbPages.${key}--;drawWorkbench()">上一页</button><button ${page===last?'disabled':''} onclick="wbPages.${key}++;drawWorkbench()">下一页</button></div>`:total?`<div class="wbPager"><span>共 ${total} 条</span></div>`:'');
}
function wbChangeActionPage(direction){
 wbPages.events+=direction;drawWorkbench();
 const pager=wbHome.querySelector('nav.wbPager');
 const target=pager?.querySelector(`[data-direction="${direction}"]:not(:disabled)`)||pager?.querySelector('button:not(:disabled)');
 target?.focus({preventScroll:true});
}
function wbEventRow(e,hasPredecessors){const path=wbPath(e),parent=wbSnapshot.branches.some(x=>x.parent_id===e.id);return `<article class="wbRow wbActionRow"><div class="planTitleWrap"><button class="wbTitle" onclick="openWorkbenchEditor('${e.id}')">${esc(e.name)}</button>${hasPredecessors?todoDependencies.detailShortcut(e.id):''}</div><div class="wbMeta">${pill(e)}<span class="${e.planEnd&&e.planEnd<wbSnapshot.today?'wbOverdue':''}">${e.planEnd?esc(e.planEnd)+' 截止':'未排期'}</span>${planChangeButton(e)}${parent?'<span>父事件</span>':''}${wbSnapshot.links.some(x=>x.kind==='followup'&&x.source===e.id)?'<span>后续跟进</span>':''}</div><p class="wbPath" title="${esc(path?.text)}">${esc(path?.text)}</p>${dailyAction(e)}</article>`}
function wbMatterRow(m,review=false){return `<article class="wbRow"><div><button class="wbTitle" onclick="openWorkbenchDetail('${m.id}')">${esc(m.name)}</button><p class="wbPath">${esc(wbPath(m)?.text)}</p><div class="wbMeta"><span>${esc(priorityLabels[wbPriority(m.id)?.priority||0])}</span><span>${review?'本周待评估':states[m.status]}</span><span>${wbProgress(m)}</span></div></div>${review?`<button class="wbLocate" onclick="locateWorkbench('${m.id}',true)">去评估 ${wbIcon('arrow')}</button>`:wbAttentionButton(m)}</article>`}
const wbActionCategories={all:'所有分类',overdue:'已逾期',today:'今日到期',working:'进行中',follow:'待跟进',undated:'未排期'};
function wbSetActionFilter(value){
 wbFilter=value;
 wbPages.events=0;drawWorkbench();
 wbHome.querySelector('button[data-action-category="'+value+'"]')?.focus({preventScroll:true});
}
function wbActionTabs(events,rules){
 const tabs=Object.entries(wbActionCategories).map(([key,label])=>
  `<button type="button" data-action-category="${key}" class="${wbFilter===key?'active':''}" aria-pressed="${wbFilter===key}" onclick="wbSetActionFilter('${key}')">${label} <span>${events.filter(rules[key]).length}</span></button>`
 ).join('');
 return `<div class="wbTabs" role="group" aria-label="行动分类">${tabs}</div>`;
}
function drawWorkbench(){todoDependencies.closeWaiting();if(typeof refreshPlanMarks==='function')setTimeout(refreshPlanMarks,0);const goals=wbItems().filter(x=>x.type==='goal');wbHome.innerHTML=wbRenderHeading(goals);renderChatResults();
 wbHome.innerHTML+=dailyWarning();if(wbPending)wbHome.innerHTML+='<div class="wbWarning" role="alert">关注保存结果待核对，未自动重试。<button onclick="recoverAttention()">核对关注结果</button></div>';
 if(wbError){wbHome.innerHTML+=`<div class="wbWarning" role="alert">工作台读取失败：${esc(wbError)}。统计暂不可用，请手动刷新。</div>`;return}
 if(!wbSnapshot){wbHome.innerHTML+='<div class="empty">正在读取工作台…</div>';return}
 if(wbScope&&!goals.some(g=>g.id===wbScope)){wbHome.innerHTML+='<div class="empty">所选目标已不可用，请切换到全部目标。</div>';return}
 const allMatters=wbItems().filter(x=>x.type==='thing'&&wbPath(x));
 const matters=allMatters.filter(x=>!wbScope||wbPath(x).goal.id===wbScope);
 const events=wbItems().filter(x=>x.type==='event'&&pending(x)&&matters.some(m=>m.id===x.parent));const follows=new Set(wbSnapshot.links.filter(x=>x.kind==='followup').map(x=>x.source));
 const rules={all:()=>true,overdue:x=>x.planEnd&&x.planEnd<wbSnapshot.today,today:x=>x.planEnd===wbSnapshot.today,working:x=>x.status==='working',follow:x=>follows.has(x.id),undated:x=>!x.planEnd};
 const dependencies=todoDependencies.index(wbSnapshot,wbItems());
 const ready=events.filter(event=>!todoDependencies.reasons(event,dependencies).length);
 const filtered=ready.filter(rules[wbFilter]).sort((a,b)=>(a.planEnd||'9999').localeCompare(b.planEnd||'9999')||a.name.localeCompare(b.name,'zh-CN')||a.id.localeCompare(b.id));const watched=matters.filter(x=>wbWatched(x.id)&&(wbEnded||pending(x))),reviews=matters.filter(x=>wbPriority(x.id)?.due);
 wbHome.innerHTML+=wbRenderOverview(goals,allMatters)+`<div class="wbLayout"><section class="wbPanel"><div class="wbPanelHead"><h2>行动清单 <span class="wbCount">${filtered.length}</span></h2></div><div class="dailyToolbar">${wbActionTabs(ready,rules)}${dailyToolbar(filtered)}</div>${wbPagination('events',filtered.filter(x=>dailyReviewed(x.id)===(dailyFilter==='done')),event=>wbEventRow(event,dependencies.edges.has(event.id)))}</section><div class="wbStack"><section class="wbPanel"><div class="wbPanelHead"><h2>持续关注 <span class="wbCount">${watched.length}</span></h2><label><input type="checkbox" ${wbEnded?'checked':''} onchange="wbEnded=this.checked;wbPages.attention=0;drawWorkbench()"> 含已结束</label></div>${wbPagination('attention',watched,m=>wbMatterRow(m))}</section><section class="wbPanel"><div class="wbPanelHead"><h2>本周待评估 <span class="wbCount">${reviews.length}</span></h2><small>${esc(wbSnapshot.priorities.week)} 起</small></div>${wbPagination('reviews',reviews,m=>wbMatterRow(m,true))}</section></div></div>`;

}
function paintAttention(){document.querySelectorAll('.wbWatchSlot').forEach(x=>x.remove());const cards=[...document.querySelectorAll('#things > .thing')],rows=children('thing',selection.module);cards.forEach((card,i)=>{const m=rows[i];if(!m)return;const tags=card.previousElementSibling;if(tags?.classList.contains('priorityTags')){const slot=document.createElement('span');slot.className='wbWatchSlot';slot.innerHTML=wbAttentionButton(m);tags.append(slot)}const hide=(priorityDueOnly&&!priorityData?.items.find(x=>x.id===m.id)?.due)||(wbOnly&&!wbWatched(m.id));card.hidden=hide;if(tags?.classList.contains('priorityTags'))tags.hidden=hide});let label=$('#wbOnlyLabel');if(!label&&$('#priorityNotice')){label=document.createElement('label');label.id='wbOnlyLabel';$('#priorityNotice').append(label)}if(label){label.innerHTML=`<input type="checkbox" ${wbOnly?'checked':''} onchange="wbOnly=this.checked;paintAttention()"> 仅关注${wbError?'（关注读取失败）':''}`}const title=$('#events .detailTitle');if(title){const slot=document.createElement('span');slot.className='wbWatchSlot';const m=get(selection.thing);if(m)slot.innerHTML=wbAttentionButton(m);title.append(slot)}}
const wbPriorityPaint=paintPriorities;paintPriorities=function(){wbPriorityPaint();paintAttention()};
const wbBaseRender=render;let wbTimer;render=function(){wbBaseRender();paintAttention();clearTimeout(wbTimer);wbTimer=setTimeout(loadWorkbench,100)};
function setWorkbenchView(view){
 wbView=view;
 wbHome.hidden=view!=='home';
 wbWork.hidden=view!=='work';
 for(const [index,name] of ['home','work'].entries()){
  const current=view===name,nav=wbNav[index];
  nav.classList.toggle('active',current);
  if(current)nav.setAttribute('aria-current','page');
  else nav.removeAttribute('aria-current');
 }
}
async function showWorkbench(view){setWorkbenchView(view);await loadWorkbench()}
async function locateWorkbench(id,review=false){
 if(!await loadWorkbench()){notify('读取失败，未切换位置');return}
 const item=wbGet(id),path=wbPath(item);
 if(item?.type!=='goal'&&!path){notify('对象已删除或归属变化，请刷新后核对');return}
 if(path)selection={goal:path.goal.id,module:path.mod.id,thing:path.m.id};
 else selection.goal=item.id;
 priorityDueOnly=false;
 wbOnly=false;
 setWorkbenchView('work');
 wbBaseRender();
 paintAttention();
 if(wbDrawer.open)wbDrawer.close();
 if(review&&path)openPriority(path.m.id);
 else if(item.type==='event')await openEvent(item.id);
 else if(item.type==='goal')$('#goalSelect').focus();
 notify('已定位：'+(path?.text??item.name));
}
async function openWorkbenchEditor(id){
 if(dailyBusy||busy||wbBusy||wbLoading||eventBusy||priorityBusy||moveBusy||deletionBusy)return;
 if(dailyPending||pendingWrite||wbPending||eventPending||priorityPending||moveIntent||deletionIntent){notify('请先核对尚未完成的保存操作');return}
 if($('#editor').open)return;
 if(!await loadWorkbench()){notify('编辑读取失败，请刷新后重试');return}
 const item=wbGet(id),path=wbPath(item);
 if(item?.type!=='event'||!path||path.m.type!=='thing'){notify('事件已不可用或归属变化，请刷新后核对');return}
 openForm('event',id);
}
async function openWorkbenchDetail(id){if(!await loadWorkbench()){notify('详情读取失败');return}const item=wbGet(id),p=wbPath(item);if(!p){notify('对象已不可用，请刷新');return}wbDetail=id;wbDrawer.innerHTML=`<div class="drawerHead"><h2 id="wbDetailTitle">${esc(item.name)}</h2><button onclick="wbDrawer.close()">关闭</button></div><p>${esc(p.text)}</p>${item.description?`<p>${esc(item.description)}</p>`:''}${metadata(item)}<p>${wbProgress(p.m)}</p><p>事情优先级：${esc(priorityLabels[wbPriority(p.m.id)?.priority||0])}</p><div class="actions">${wbAttentionButton(p.m)}<button onclick="locateWorkbench('${id}')">定位到工作页</button></div><p id="wbWriteError" class="error" role="alert"></p><button onclick="recoverAttention()">核对关注结果</button>`;if(!wbDrawer.open)wbDrawer.showModal()}
async function setAttention(id,enabled){if(wbBusy||wbPending||wbLoading)return;if(pendingWrite||priorityPending||eventPending){notify('请先核对尚未完成的保存操作');return}const item=wbGet(id);if(!item){notify('事情不可用，请刷新');return}wbPending={id,body:{operation_id:crypto.randomUUID(),expected_version:item.version,enabled}};await sendAttention()}
async function sendAttention(){if(wbBusy||!wbPending)return;wbBusy=true;paintAttention();drawWorkbench();try{await api('/items/'+wbPending.id+'/attention','POST',wbPending.body);if(!await loadWorkbench())throw Error('已提交，关注读回失败，请核对结果');wbPending=null;notify('关注状态已保存并读回');if(wbDrawer.open)await openWorkbenchDetail(wbDetail)}catch(e){if(e.status>=400&&e.status<500)wbPending=null;notify(e.message+'；未自动重试');if($('#wbWriteError'))$('#wbWriteError').textContent=e.message;if(wbPending)showAttentionRecovery(e.message)}finally{wbBusy=false;drawWorkbench();paintAttention();if(wbDrawer.open)wbDrawer.querySelectorAll('.wbWatch').forEach(x=>x.disabled=!!wbPending)}}
function showAttentionRecovery(message){wbDrawer.innerHTML=`<div class="drawerHead"><h2 id="wbDetailTitle">核对关注结果</h2><button onclick="wbDrawer.close()">关闭</button></div><p class="error" role="alert">${esc(message)}；结果尚未确认，未自动重试。</p><button onclick="recoverAttention()">查询保存结果</button><div id="wbRecovery"></div>`;if(!wbDrawer.open)wbDrawer.showModal()}
async function recoverAttention(){if(wbBusy)return;if(!wbPending){notify('没有待核对的关注操作');return}wbBusy=true;try{await api('/operations/'+wbPending.body.operation_id);if(!await loadWorkbench())throw Error('回执存在，但关注状态读取失败');wbPending=null;if(wbDrawer.open)wbDrawer.close();notify('已核对关注保存结果')}catch(e){showAttentionRecovery(e.message);if(e.status===404)$('#wbRecovery').innerHTML='<p>尚未查到提交记录。可明确使用原操作标识重试。</p><button onclick="sendAttention()">使用原操作标识重试</button>'}finally{wbBusy=false;drawWorkbench();paintAttention()}}
const wbPriorityLoad=loadPriorities;loadPriorities=async function(){await wbPriorityLoad();if(wbSnapshot&&priorityData){wbSnapshot.priorities=priorityData;drawWorkbench()}};
window.addEventListener('focus',()=>{if(wbView==='home'&&!wbBusy)loadWorkbench()});
(async()=>{await api('/session');await showWorkbench('home');await refreshSuggestions()})().catch(e=>{wbError=e.message;drawWorkbench()});

