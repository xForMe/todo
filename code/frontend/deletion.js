/* Reviewed deletion, explicit destination, and durable uncertain-result recovery. */
let deletionView = null, deletionBusy = false, deletionRetryAllowed = false;
let deletionIntent = JSON.parse(sessionStorage.getItem('todo.pendingDeletion') || 'null');
const deleteEntry = document.createElement('button');
deleteEntry.id = 'deleteEntry';
deleteEntry.type = 'button';
deleteEntry.className = 'quiet danger';
deleteEntry.textContent = '删除';
deleteEntry.hidden = true;
$('#editor .actions').prepend(deleteEntry);
const originalOpenForm = openForm;
openForm = function(type, id) {
  originalOpenForm(type, id);
  deleteEntry.hidden = !id || type === 'event';
  deleteEntry.textContent = '删除' + names[type];
};
deleteEntry.onclick = () => openDeletion(editing?.id);
const recoveryButton = document.createElement('button');
recoveryButton.textContent = '核对待确认删除';
recoveryButton.hidden = !deletionIntent;
recoveryButton.onclick = () => openDeletion(deletionIntent?.id);
$('.connectionTools').append(recoveryButton);

function saveDeleteIntent(value) {
  deletionIntent = value;
  if (value) sessionStorage.setItem('todo.pendingDeletion', JSON.stringify(value));
  else sessionStorage.removeItem('todo.pendingDeletion');
  recoveryButton.hidden = !value;
}
function itemPath(item) {
  const parts = [];
  for (let i = 0; item && i < 4; i++, item = get(item.parent)) parts.unshift(item.name);
  return parts.join(' / ');
}
function updateDeleteControls() {
  const uncertain = Boolean(deletionIntent);
  $('#deleteTarget').disabled = deletionBusy || uncertain;
  $('#reloadDelete').disabled = deletionBusy || uncertain;
  $('#checkDelete').hidden = !uncertain;
  $('#checkDelete').disabled = deletionBusy;
  $('#closeDelete').disabled = deletionBusy;
  $('#submitDelete').disabled = deletionBusy || (uncertain ? !deletionRetryAllowed :
    !deletionView?.impact || (deletionView.impact.requires_target && !$('#deleteTarget').value));
  if (uncertain) $('#submitDelete').textContent = '再次提交原操作';
  $('#deleteDestination').textContent = itemPath(get($('#deleteTarget').value));
}
async function openDeletion(id) {
  if (deletionBusy) return;
  if (pendingWrite) { notify('请先核对待确认保存操作'); return; }
  $('#editor').close();
  $('#deleteDrawer').showModal();
  $('#deleteError').textContent = '';
  if (deletionIntent) {
    deletionView = {id: deletionIntent.id};
    $('#deleteName').textContent = deletionIntent.name;
    $('#deleteImpact').textContent = '上次删除结果待核对；保留原操作，不会自动重新提交。';
    $('#deleteTargetGroup').hidden = true;
    updateDeleteControls();
    return;
  }
  deletionView = {id};
  await loadDeletion();
}
async function loadDeletion() {
  if (!deletionView || deletionIntent || deletionBusy) return;
  const id = deletionView.id;
  deletionBusy = true;
  deletionView.impact = null;
  $('#deleteImpact').textContent = '正在核对下级内容和关联资料…';
  $('#deleteName').textContent = get(id)?.name || '';
  $('#deleteError').textContent = '';
  updateDeleteControls();
  try {
    db.items = await api('/items');
    const impact = await api('/items/' + id + '/deletion');
    deletionView.impact = impact;
    $('#deleteTitle').textContent = '删除' + names[impact.item.type];
    $('#deleteName').textContent = itemPath(impact.item);
    $('#deleteImpact').textContent = impact.requires_target
      ? `下级内容 ${impact.descendants} 项（直接下级 ${impact.children} 项） · 文档来源 ${impact.documents} 条 · AI 建议 ${impact.suggestions} 条 · 催办规则 ${impact.reminders} 条。`
      : '没有下级内容或关联资料，可以删除当前对象。';
    $('#deleteTargetGroup').hidden = !impact.requires_target;
    const target = $('#deleteTarget');
    target.replaceChildren(new Option('请选择接收位置', ''));
    for (const item of children(impact.item.type).filter(x => x.id !== id)) {
      target.add(new Option(itemPath(item), item.id));
    }
    $('#deleteHint').textContent = impact.requires_target && target.options.length === 1
      ? '暂无可用接收位置，请取消后先创建另一个' + names[impact.item.type] + '。'
      : '双方内容合在一起保留；目标换绑时同名模块自动融合，事情和事件不自动去重。受影响来源和催办暂停。';
    $('#submitDelete').textContent = impact.requires_target ? '换绑并删除' : '确认删除';
  } catch (e) {
    $('#deleteImpact').textContent = '尚未获取到有效影响范围。';
    $('#deleteError').textContent = e.message;
  } finally {
    deletionBusy = false;
    updateDeleteControls();
    if ($('#deleteDrawer').open) {
      (deletionView?.impact?.requires_target ? $('#deleteTarget') : $('#closeDelete')).focus();
    }
  }
}
async function finishDeletion(result) {
  db.items = await api('/items');
  saveDeleteIntent(null);
  const target = get(result.target_id);
  if (target) {
    for (let item = target; item; item = get(item.parent)) selection[item.type] = item.id;
  }
  deletionView = null;
  $('#deleteDrawer').close();
  editing = null;
  await refreshSuggestions();
  render();
  notify('已删除，原有下级内容已保留');
}
async function submitDeletion() {
  if (deletionBusy) return;
  if (deletionIntent) {
    if (!deletionRetryAllowed) return;
    deletionBusy = true;
    deletionRetryAllowed = false;
    updateDeleteControls();
    try { await finishDeletion(await api('/items/' + deletionIntent.id + '/deletion', 'POST', deletionIntent.body)); }
    catch (e) {
      if (e.status >= 400 && e.status < 500) { saveDeleteIntent(null); deletionView.impact = null; }
      $('#deleteError').textContent = e.message + '；请核对结果或刷新影响范围。';
    } finally { deletionBusy = false; updateDeleteControls(); }
    return;
  }
  if (!deletionView?.impact) return;
  const impact = deletionView.impact;
  if (impact.requires_target && !$('#deleteTarget').value) return;
  const intent = {id:deletionView.id, name:impact.item.name, body:{
    operation_id:crypto.randomUUID(), snapshot:impact.snapshot,
    target_id:impact.requires_target ? $('#deleteTarget').value : null
  }};
  saveDeleteIntent(intent);
  deletionBusy = true;
  updateDeleteControls();
  try { await finishDeletion(await api('/items/' + intent.id + '/deletion', 'POST', intent.body)); }
  catch (e) {
    if (e.status >= 400 && e.status < 500) {
      saveDeleteIntent(null);
      deletionView.impact = null;
      $('#deleteError').textContent = e.message + '；请刷新影响范围。';
    } else $('#deleteError').textContent = e.message + '；请点击核对删除结果。';
  } finally { deletionBusy = false; updateDeleteControls(); }
}
async function checkDeletion() {
  if (!deletionIntent || deletionBusy) return;
  deletionBusy = true;
  updateDeleteControls();
  try { await finishDeletion(await api('/deletions/' + deletionIntent.body.operation_id)); }
  catch (e) {
    $('#deleteError').textContent = e.message;
    if (e.status === 404) {
      deletionRetryAllowed = true;
      $('#deleteError').textContent += '；可手动再次提交原操作，相同标识不会重复执行。';
    }
  } finally { deletionBusy = false; updateDeleteControls(); }
}
$('#deleteTarget').onchange = updateDeleteControls;
$('#reloadDelete').onclick = loadDeletion;
$('#submitDelete').onclick = submitDeletion;
$('#checkDelete').onclick = checkDeletion;
$('#closeDelete').onclick = () => $('#deleteDrawer').close();
$('#deleteDrawer').addEventListener('cancel', e => { if (deletionBusy) e.preventDefault(); });
