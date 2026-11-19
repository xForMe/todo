let followRules=[],followEventId=null,followBusy=false,followPeopleSeq=0,followReadyEvent=null,followOpenSeq=0,followDraftText=null;
async function refreshFollow(){try{followRules=await api('/sources/follow');document.querySelectorAll('.followBell').forEach(b=>{const r=followRules.find(x=>x.event_id===b.dataset.event);b.title='自动催办：'+(r?.status||'未开启')})}catch(e){/* Opening the drawer displays read errors. */}}
function makeFollowDraft(event, items, branches){
  const matter=items.find(x=>x.id===event.parent&&x.type==='thing');
  if(!matter)throw new Error('所属事情读取不完整，请重新打开');
  const ancestors=[],seen=new Set([event.id]);
  let current=event;
  while(true){
    const parents=branches.filter(x=>x.child_id===current.id);
    if(!parents.length)break;
    const parent=items.find(x=>x.id===parents[0].parent_id&&x.type==='event'&&x.parent===event.parent);
    if(parents.length!==1||!parent||seen.has(parent.id))throw new Error('上级事件关系异常，请核对后重新打开');
    seen.add(parent.id);ancestors.unshift(parent);current=parent;
  }
  const brief=(value,limit)=>{const text=String(value||'').trim();return text.length>limit?text.slice(0,limit)+'…':text;};
  const lines=[event.owner?brief(event.owner,80)+'，你好。':'你好。','关于事情「'+brief(matter.name,120)+'」。'];
  if(matter.description)lines.push('事情背景：'+brief(matter.description,300));
  if(ancestors.length)lines.push('上级事件：'+brief(ancestors.map(x=>x.name).join(' → '),350));
  const direct=ancestors.at(-1);
  if(direct?.description)lines.push('上级工作要求：'+brief(direct.description,200));
  lines.push('请同步「'+brief(event.name,120)+'」的当前进展。');
  if(event.description)lines.push('本次工作：'+brief(event.description,400));
  lines.push('计划结束日期：'+(event.planEnd||'未设置')+'。','如有阻塞或需调整计划，请说明原因及预计完成时间，谢谢。');
  return lines.join('\n');
}
function regenerateFollowContent(){
  if(followDraftText===null){$('#followError').textContent='上下文尚未读取完成，请重新打开后整理';return;}
  $('#followContent').value=followDraftText;
}
async function openFollowRule(id){
  if(!get(id))return;
  followEventId=id;const opening=++followOpenSeq;++followPeopleSeq;
  followReadyEvent=null;followDraftText=null;resetFollowPeople();
  $('#followPersonQuery').disabled=true;$('#followSearch').disabled=true;
  $('#followPersonQuery').value='';$('#followContent').value='';$('#followContext').textContent='正在读取事件与上级上下文…';
  $('#followDrawer').showModal();$('#followError').textContent='';$('#followLogs').replaceChildren();
  const active=()=>opening===followOpenSeq&&followEventId===id&&$('#followDrawer').open;
  try{followRules=await api('/sources/follow')}catch(err){if(active()){$('#followError').textContent=err.message;$('#followPersonQuery').disabled=false;$('#followSearch').disabled=false;}return;}
  if(!active())return;
  followReadyEvent=id;const r=followRules.find(x=>x.event_id===id);
  $('#followAt').value=r?.at||'09:00';$('#followCap').value=r?.cap||3;$('#followContent').value=r?.content||'';
  for(const log of r?.logs||[]){const p=document.createElement('p');p.textContent=new Date(log.created*1000).toLocaleString('zh-CN')+' · '+({confirmed:'已发送并读回确认',pending:'发送结果待核对',unknown:'结果未知，已暂停'}[log.state]||log.state)+' · '+log.content;$('#followLogs').append(p)}
  if(!r?.logs?.length)$('#followLogs').textContent='尚无发送记录';
  try{
    const [items,view]=await Promise.all([api('/items'),api('/events/'+id+'/structure')]);
    if(!active())return;
    const event=view.events.find(x=>x.id===id);
    if(!event)throw new Error('事件已失效，请刷新后重新打开');
    followDraftText=makeFollowDraft(event,[...items.filter(x=>x.type!=='event'),...view.events],view.branches);
    const index=db.items.findIndex(x=>x.id===id);if(index>=0)db.items[index]=event;
    $('#followContext').textContent=event.name+' · 责任人：'+(event.owner||'未指定')+' · 截止：'+(event.planEnd||'未设置')+' · '+(r?.status||'未开启');
    if(!r?.content&&!$('#followContent').value)$('#followContent').value=followDraftText;
    $('#followPersonQuery').value=event.owner||'';
    $('#followPersonQuery').disabled=false;$('#followSearch').disabled=false;
    if(r?.recipient)await searchFollowPeople(true);
    else if(event.owner?.trim())await searchFollowPeople(false,true);
    else $('#followPeopleHint').textContent='事件尚未指定负责人，请先完善事件负责人。';
  }catch(err){if(active()){$('#followContext').textContent='上下文读取失败';$('#followError').textContent=err.message+'；请重新打开，已有规则仍可暂停';$('#followPersonQuery').disabled=false;$('#followSearch').disabled=false;}}
}
async function saveFollowRule(enabled){if(followBusy)return;if(followReadyEvent!==followEventId){$('#followError').textContent='请重新打开并读回规则后再保存';return}const e=get(followEventId),r=followRules.find(x=>x.event_id===followEventId);if(enabled&&followDraftText===null){$('#followError').textContent='请重新打开并读取完整上下文后再开启';return}if(enabled&&!$('#followRecipient').value){$('#followError').textContent='请选择事件负责人后保存';return}followBusy=true;try{await api('/sources/follow/'+e.id,'POST',{recipient:enabled?$('#followRecipient').value:(r?.recipient||$('#followRecipient').value),content:$('#followContent').value,at:$('#followAt').value,cap:Number($('#followCap').value),enabled,expected_version:r?.version||0,event_version:e.version});await openFollowRule(e.id);await refreshFollow();notify('规则已保存并读回')}catch(err){$('#followError').textContent=err.message+'；请重新打开核对结果，不会自动重试'}finally{followBusy=false}}
const priorRender=render;render=function(){priorRender();refreshFollow()};setInterval(refreshFollow,10000);

function resetFollowPeople(){
  $('#followRecipient').replaceChildren(new Option('请先查询并选择人员',''));
  $('#followPeopleHint').textContent='';
}
function followPersonChanged(){$('#followError').textContent=''; }
async function searchFollowPeople(saved=false,automatic=false){
  const id=followEventId,seq=++followPeopleSeq,query=$('#followPersonQuery').value.trim();
  resetFollowPeople();
  if(!saved&&!query){$('#followPeopleHint').textContent='请输入姓名或企业邮箱';return;}
  $('#followPeopleHint').textContent='正在查询人员…';
  try{
    const data=await api('/sources/follow-people?'+new URLSearchParams({event_id:id,query,saved:String(saved)}));
    if(seq!==followPeopleSeq||id!==followEventId||!$('#followDrawer').open)return;
    for(const person of data.people){
      const label=[person.name,person.department,person.enterprise_email].filter(Boolean).join(' · ');
      $('#followRecipient').add(new Option(label,person.id));
    }
    if(saved&&data.people.length===1){
      $('#followRecipient').value=data.people[0].id;
      $('#followPersonQuery').value=data.people[0].name;
    }
    const matches=data.people.filter(p=>p.name===query||p.enterprise_email?.toLowerCase()===query.toLowerCase());
    const selected=automatic&&!data.has_more&&matches.length===1&&data.people.length===1;
    if(selected)$('#followRecipient').value=matches[0].id;
    $('#followPeopleHint').textContent=selected?'已按事件负责人自动匹配。':data.people.length
      ?(data.has_more?'仅显示部分人员，请用完整姓名或企业邮箱缩小范围。':'请选择人员；同名请结合部门或企业邮箱区分。')
      :(saved?'已保存人员暂无法识别，请重新查询；仍可暂停已有规则。':'未找到可识别的人员，请核对姓名或企业邮箱。');
  }catch(err){
    if(seq===followPeopleSeq&&id===followEventId)$('#followPeopleHint').textContent=err.message+'；请重新查询，已有规则仍可暂停';
  }
}
$('#followPersonQuery').addEventListener('input',()=>{++followPeopleSeq;resetFollowPeople()});
$('#followPersonQuery').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();searchFollowPeople()}});
$('#followDrawer').addEventListener('close',()=>{++followPeopleSeq;++followOpenSeq;followReadyEvent=null});
