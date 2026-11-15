/* REQ-O-005: account-wide chat results, sharing the existing confirmation flow. */
let chatResultState = 'pending', chatResultPage = 0;
let chatReviewOrigin = false, unmatchedMessages = [], recoveryError = '', retryBusy = false;
function recognitionIcon(label, path, action, disabled = false, danger = false) {
  return `<button type="button" class="recognitionIcon${danger ? ' danger' : ''}" aria-label="${label}" ${disabled ? 'disabled' : ''} onclick="${action}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg><span class="recognitionActionHint" role="tooltip">${label}</span></button>`;
}
const recognitionRefreshPath = 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2';
const recognitionEntry = document.createElement('button');
recognitionEntry.id = 'eventRecognitionTrigger';
recognitionEntry.className = 'eventRecognitionTrigger';
recognitionEntry.type = 'button';
recognitionEntry.setAttribute('aria-haspopup', 'dialog');
recognitionEntry.setAttribute('aria-controls', 'eventRecognitionDrawer');
recognitionEntry.setAttribute('aria-expanded', 'false');
recognitionEntry.innerHTML = '<span class="recognitionLabel"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h5m-4 4 2 2 5-5"/></svg>事件识别</span><span id="eventRecognitionStatus" class="recognitionStatus">读取中…</span>';
const recognitionDrawer = document.createElement('dialog');
recognitionDrawer.id = 'eventRecognitionDrawer';
recognitionDrawer.setAttribute('aria-labelledby', 'eventRecognitionTitle');
recognitionDrawer.innerHTML = `<div class="drawerHead"><h2 id="eventRecognitionTitle">事件识别</h2><div class="recognitionHeaderActions">${recognitionIcon('刷新结果', recognitionRefreshPath, 'refreshSuggestions()')}${recognitionIcon('关闭', 'M6 6l12 12M18 6 6 18', 'recognitionDrawer.close()')}</div></div><div id="chatResults"></div>`;
recognitionDrawer.querySelector('button[aria-label="关闭"]').autofocus = true;
document.querySelector('.workspaceBar').append(recognitionEntry);
document.body.append(recognitionDrawer);
recognitionEntry.querySelector('svg').innerHTML = '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>';
recognitionEntry.onclick = () => openChatResults();
recognitionDrawer.addEventListener('close', () => {
  recognitionEntry.setAttribute('aria-expanded', 'false');
  // Programmatic close and Escape return to the same visible entry.
  if (!chatReviewOrigin) recognitionEntry.focus({preventScroll:true});
});
document.getElementById('suggestionDrawer').addEventListener('close', () => {
  if (!chatReviewOrigin) return;
  chatReviewOrigin = false;
  openChatResults(false);
});
function openChatResults(refresh = true) {
  renderChatResults();
  if (!recognitionDrawer.open) recognitionDrawer.showModal();
  recognitionEntry.setAttribute('aria-expanded', 'true');
  if (refresh) refreshSuggestions();
}
function renderChatResults() {
  const root = document.getElementById('chatResults');
  if (!root) return;
  const rows = aiSuggestions.filter(isChatSuggestion);
  const list = rows.filter(s => s.state === chatResultState);
  const last = Math.max(0, Math.ceil(list.length / 10) - 1);
  chatResultPage = Math.min(chatResultPage, last);
  const count = rows.filter(s => s.state === 'pending').length + unmatchedMessages.length;
  const status = aiError ? '读取失败' : !aiLoaded ? '读取中…' : count ? `${count} 待确认` : '暂无待确认';
  const badge = document.getElementById('eventRecognitionStatus');
  if (badge.textContent !== status) badge.textContent = status;
  recognitionEntry.setAttribute('aria-label', `事件识别，${status}`);
  recognitionEntry.title = `事件识别通知 · ${status}`;
  recognitionEntry.dataset.count = count > 99 ? '99+' : String(count);
  recognitionEntry.classList.toggle('hasPending', aiLoaded && !aiError && count > 0);
  recognitionEntry.classList.toggle('hasError', Boolean(aiError));
  let html = '';
  if (recoveryError) html += `<p class="error" role="alert">${esc(recoveryError)}</p>`;
  if (retryBusy) html += '<p role="status">正在重新识别，请稍候…</p>';
  if (aiError) {
    html += `<p class="chatScope error" role="alert">识别结果读取失败：${esc(aiError)}。请刷新重试。</p>`;
  } else if (!aiLoaded) {
    html += '<p class="chatScope" role="status">正在读取识别结果…</p>';
  } else {
    html += `<div class="wbTabs" aria-label="事件识别状态">${[['pending','待确认'],['linked','已关联进展'],['unmatched','未找到建议']].map(([state,label]) => `<button aria-pressed="${state === chatResultState}" class="${state === chatResultState ? 'active' : ''}" onclick="chatResultState='${state}';chatResultPage=0;renderChatResults()">${label} <span>${state === 'unmatched' ? unmatchedMessages.length : rows.filter(s => s.state === state).length}</span></button>`).join('')}</div>`;
    if (chatResultState === 'unmatched') {
      html += unmatchedMessages.map((m,i) => `<article class="wbRow chatResult"><div class="chatResultHead"><strong>${esc(m.content)}</strong><div class="chatActions">${recognitionIcon('重新识别此条', recognitionRefreshPath, `retryUnmatched(${i})`, !m.can_retry||retryBusy)}${recognitionIcon('废弃', 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', `discardUnmatched(${i})`, retryBusy, true)}</div></div><p>${m.processed?'已处理，但未找到对应建议':'等待处理'}${!m.can_retry?' · 重新识别需来源启用、AI授权且已完成首次处理':''}</p></article>`).join('') || '<p>当前页没有未匹配消息</p>';
    } else html += list.slice(chatResultPage * 10, (chatResultPage + 1) * 10).map(s => {
      const p = JSON.parse(s.body), path = wbPath(wbGet(s.thing_id));
      return `<article class="wbRow chatResult"><div><strong>${esc(p.name)}</strong><p class="wbPath">${esc(path ? path.text : '归属待确认')}</p><details><summary>原文依据</summary><p>${esc(p.evidence || '暂无依据')}</p></details></div><div class="chatActions">${s.state === 'pending' ? `<button class="primary" onclick="reviewChatResult('${s.id}')">核对建议</button>` : ''}${path ? `<button onclick="locateChatResult('${s.thing_id}')">定位事情</button>` : ''}</div></article>`;
    }).join('') || `<p class="chatScope">${chatResultState === 'pending' ? '暂无待确认事件建议' : '暂无已关联进展'}</p>`;
    if (list.length > 10) html += `<div class="wbPager"><span>第 ${chatResultPage + 1}/${last + 1} 页</span><button ${chatResultPage === 0 ? 'disabled' : ''} onclick="chatResultPage--;renderChatResults()">上一页</button><button ${chatResultPage === last ? 'disabled' : ''} onclick="chatResultPage++;renderChatResults()">下一页</button></div>`;
  }
  // Polling an unchanged result must not steal keyboard focus or collapse evidence.
  if (root.dataset.content !== html) { root.innerHTML = html; root.dataset.content = html; }
}
async function loadUnmatched() {
  try { unmatchedMessages = await api('/sources/unmatched'); recoveryError = ''; }
  catch (e) { recoveryError = '消息核对暂不可用：'+e.message; unmatchedMessages = []; }
  renderChatResults();
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
