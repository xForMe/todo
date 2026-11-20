/* REQ-O-005: account-wide chat results, sharing the existing confirmation flow. */
let chatResultState = 'pending', chatResultPage = 0;
let chatReviewOrigin = false, unmatchedMessages = [], recoveryError = '', retryBusy = false;
let recognitionReact = null, recognitionRendered = false;
function mountRecognitionDrawer(mount) { recognitionReact = mount(recognitionDrawer); }
const recognitionTabs = [['pending','待确认'],['linked','已关联进展'],['unmatched','未找到建议'],['dsh','DSH 草稿']];
let dshCaptureRefresh = 0;
const recognitionEntryId = 'eventRecognitionTrigger';
const recognitionDrawer = document.createElement('dialog');
recognitionDrawer.id = 'eventRecognitionDrawer';
recognitionDrawer.setAttribute('aria-labelledby', 'eventRecognitionTitle');
const paintRecognitionEntry=todoWorkspaceShell.addEntry({id:recognitionEntryId,kind:'recognition',
  status:'读取中…',expanded:false,count:'0',pending:false,error:false,onClick:()=>openChatResults()});
document.body.append(recognitionDrawer);
recognitionDrawer.addEventListener('close', () => {
  if (recognitionDrawer.open) return;
  paintRecognitionEntry({expanded:false});
  // Programmatic close and Escape return to the same visible entry.
  if (!chatReviewOrigin) todoWorkspaceShell.focus(recognitionEntryId);
});
document.getElementById('suggestionDrawer').addEventListener('close', () => {
  if (!chatReviewOrigin) return;
  chatReviewOrigin = false;
  openChatResults(false);
});
function openChatResults(refresh = true) {
  if (!recognitionReact) return;
  recognitionRendered = true;
  if (refresh && chatResultState === 'dsh') dshCaptureRefresh++;
  renderChatResults();
  if (!recognitionDrawer.open) recognitionDrawer.showModal();
  paintRecognitionEntry({expanded:true});
  if (refresh) refreshSuggestions();
}
function renderChatResults() {
  const rows = aiSuggestions.filter(isChatSuggestion);
  const list = rows.filter(s => s.state === chatResultState);
  const last = Math.max(0, Math.ceil(list.length / 10) - 1);
  chatResultPage = Math.min(chatResultPage, last);
  const count = rows.filter(s => s.state === 'pending').length + unmatchedMessages.length;
  const status = aiError ? '读取失败' : !aiLoaded ? '读取中…' : count ? `${count} 待确认` : '暂无待确认';
  paintRecognitionEntry({status,count:count>99?'99+':String(count),pending:aiLoaded&&!aiError&&count>0,error:Boolean(aiError)});
  if (!recognitionReact || !recognitionRendered) return;
  recognitionReact({model:{state:chatResultState,last,page:chatResultPage,paged:list.length>10,
    loading:!aiLoaded,error:aiError,recoveryError,retryBusy,
    tabs:recognitionTabs.map(([state,label])=>({state,label,count:state==='unmatched'
      ?unmatchedMessages.length:state==='dsh'?null:rows.filter(row=>row.state===state).length})),
     dshRefresh:dshCaptureRefresh,
    unmatched:unmatchedMessages,
    suggestions:list.slice(chatResultPage*10,(chatResultPage+1)*10).map(row=>{
      const body=JSON.parse(row.body),path=wbPath(wbGet(row.thing_id));
      return {id:row.id,name:body.name,thingId:row.thing_id,path:path?.text||'',evidence:body.evidence,state:row.state};
    })},actions:{close:()=>recognitionDrawer.close(),refresh:()=>{if(chatResultState==='dsh'){dshCaptureRefresh++;renderChatResults()}else refreshSuggestions()},dshApi:api,dshSaved:async id=>{if(!await loadWorkbench() || !wbGet(id))throw Error('行动清单尚未读回')},
      tab:state=>{chatResultState=state;chatResultPage=0;renderChatResults()},
      page:delta=>{chatResultPage=Math.max(0,Math.min(last,chatResultPage+delta));renderChatResults()},
      review:reviewChatResult,locate:locateChatResult,manual:manualUnmatched,retry:retryUnmatched,discard:discardUnmatched,showTip,hideTip,
    }});
}
let unmatchedReadVersion = 0;
async function loadUnmatched() {
  const version=++unmatchedReadVersion;
  try {
    const rows=await api('/sources/unmatched');
    if(version!==unmatchedReadVersion)return;
    unmatchedMessages=rows;recoveryError='';
  } catch (e) {
    if(version!==unmatchedReadVersion)return;
    recoveryError='消息核对暂不可用：'+e.message;unmatchedMessages=[];
  }
  renderChatResults();
}
async function manualUnmatched(index) {
  const m = unmatchedMessages[index];
  if (!m || retryBusy || suggestionBusy) return;
  retryBusy = true; renderChatResults();
  try {
    const result = await api('/sources/manual-message','POST',{source_id:m.source_id,message_id:m.message_id,expected_version:m.version});
    await refreshSuggestions();
    const draft = aiSuggestions.find(s => s.id === result.suggestion_id);
    if (!draft) throw Error('草稿已提交，请刷新待确认列表核对');
    chatReviewOrigin = recognitionDrawer.open;
    recognitionDrawer.close();
    openSuggestion(draft);
    setSuggestionRecommendation('手动整理：请编辑事件名称并选择归属，确认后才保存为正式事件。');
  } catch (e) { recoveryError = e.message+'；未自动重试，可从待确认列表核对草稿。'; }
  finally { retryBusy = false; renderChatResults(); }
}
async function discardUnmatched(index) {
  const m = unmatchedMessages[index];
  if (!m || retryBusy) return;
  if (!confirm('废弃并删除这条消息的本地原文？以后不再识别或提醒此条消息。')) return;
  retryBusy = true; renderChatResults();
  try {
    const result = await api('/sources/discard-message','POST',{source_id:m.source_id,message_id:m.message_id,expected_version:m.version});
    await refreshSuggestions();
    notify(result.status);
  } catch (e) { recoveryError = e.message+'；请刷新核对，未自动重试。'; }
  finally { retryBusy = false; renderChatResults(); }
}
async function retryUnmatched(index) {
  const m = unmatchedMessages[index];
  if (!m?.can_retry || retryBusy) return;
  if (!confirm('将这条消息再次提交已授权的模型识别？生成建议后仍需你确认。')) return;
  retryBusy = true; renderChatResults();
  try {
    const result = await api('/sources/retry-message','POST',{source_id:m.source_id,message_id:m.message_id,expected_version:m.version});
    notify(result.status);
    await refreshSuggestions();
  } catch (e) { recoveryError = e.message+'；未自动重试，请刷新核对。'; }
  finally { retryBusy = false; renderChatResults(); }
}
function reviewChatResult(id) {
  const suggestion = aiSuggestions.find(s => s.id === id && s.state === 'pending');
  if (aiError || !suggestion) { notify('结果已变化，请刷新后核对'); return; }
  if (suggestionBusy) return;
  chatReviewOrigin = recognitionDrawer.open;
  recognitionDrawer.close();
  openSuggestion(suggestion);
}
async function locateChatResult(id) {
  if (aiError) { notify('读取失败，请刷新后核对'); return; }
  recognitionDrawer.close();
  await locateWorkbench(id);
}
