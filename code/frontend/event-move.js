/* Explicit relocation, scoped previews, and durable uncertain-result recovery. */
let moveContext = null, movePreview = null, moveBusy = false, moveGeneration = 0;
let moveIntent = JSON.parse(sessionStorage.getItem('todo.pendingEventMove') || 'null');
const moveDrawer = document.createElement('dialog');
moveDrawer.id = 'moveDrawer';
moveDrawer.setAttribute('aria-labelledby', 'moveTitle');
moveDrawer.innerHTML = `<div class="drawerHead"><h2 id="moveTitle">迁移事件</h2><button id="closeMove">取消</button></div>
  <h3 id="moveName"></h3><p id="moveFrom" class="muted"></p>
  <label for="moveGoal">目标</label><select id="moveGoal"></select>
  <label for="moveModule">模块</label><select id="moveModule"></select>
  <label for="moveThing">事情</label><select id="moveThing"></select>
  <p id="moveImpact" class="sourceHint" aria-live="polite"></p>
  <p id="moveError" class="error" role="alert"></p>
  <div class="actions"><button id="refreshMove">刷新影响范围</button><button id="checkMove" hidden>核对迁移结果</button><button id="retryMove" hidden>手动重试原迁移</button><button id="submitMove" class="primary" disabled>确认迁移</button></div>`;
document.body.append(moveDrawer);

const moveRecovery = document.createElement('button');
moveRecovery.textContent = '核对待确认迁移';
moveRecovery.hidden = !moveIntent;
moveRecovery.onclick = () => openEventMove(moveIntent?.id);
// The work page is hidden after reload; recovery must also be reachable on the homepage.
$('.workspaceBar').insertBefore(moveRecovery, $('#workspaceDate'));
const moveEntry = document.createElement('button');
moveEntry.id = 'moveEntry';
moveEntry.type = 'button';
moveEntry.textContent = '迁移事件';
moveEntry.hidden = true;
moveEntry.onclick = () => openEventMove(editing?.id);
$('#editor .actions').prepend(moveEntry);
const moveBaseForm = openForm;
openForm = function(type, id) {
  moveBaseForm(type, id);
  moveEntry.hidden = !id || type !== 'event';
};
const moveBaseEvent = openEvent;
openEvent = async function(id, mode = 'detail') {
  await moveBaseEvent(id, mode);
  if (mode !== 'detail' || !eventDialog.open || eventContext !== id || eventPending || !$('#eventContent .actions')) return;
  if ($('#eventMoveEntry')) return;
  const entry = document.createElement('button');
  entry.id = 'eventMoveEntry';
  entry.textContent = '迁移事件';
  entry.onclick = () => openEventMove(id);
  $('#eventContent .actions').append(entry);
};

function persistMove(value) {
  // Store before sending so a reload can recover the same operation key.
  if (value) sessionStorage.setItem('todo.pendingEventMove', JSON.stringify(value));
  else sessionStorage.removeItem('todo.pendingEventMove');
  moveIntent = value;
  moveRecovery.hidden = !value;
}
function moveControls() {
  for (const id of ['moveGoal', 'moveModule', 'moveThing', 'refreshMove']) $( '#' + id).disabled = moveBusy || !!moveIntent;
  $('#closeMove').disabled = moveBusy;
  $('#submitMove').disabled = moveBusy || !!moveIntent || !movePreview;
  $('#checkMove').hidden = $('#retryMove').hidden = !moveIntent;
  $('#checkMove').disabled = $('#retryMove').disabled = moveBusy;
}
function closeMove() {
  if (moveBusy) return;
  moveGeneration++;
  moveDrawer.close();
}
$('#closeMove').onclick = closeMove;
moveDrawer.addEventListener('cancel', e => { if (moveBusy) e.preventDefault(); else moveGeneration++; });
function moveOptions(rows, label) {
  return `<option value="">请选择${label}</option>` + rows.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
}
function resetMovePreview() {
  moveGeneration++;
  movePreview = null;
  $('#moveError').textContent = '';
  $('#moveImpact').textContent = '请选择目标事情，核对迁移范围后确认。';
  moveControls();
}
function moveModules() {
  resetMovePreview();
  $('#moveModule').innerHTML = moveOptions(db.items.filter(x => x.type === 'module' && x.parent === $('#moveGoal').value), '模块');
  moveThings();
}
function moveThings() {
  resetMovePreview();
  const rows = db.items.filter(x => x.type === 'thing' && x.parent === $('#moveModule').value && x.id !== get(moveContext)?.parent && pending(x));
  $('#moveThing').innerHTML = moveOptions(rows, '事情');
  if (!rows.length) $('#moveImpact').textContent = '此模块没有可接收的其他事情，请选择其他模块，或先新建、重开事情。';
}
$('#moveGoal').onchange = moveModules;
$('#moveModule').onchange = moveThings;
$('#moveThing').onchange = loadMovePreview;
$('#refreshMove').onclick = loadMovePreview;

async function openEventMove(id) {
  if (moveBusy || eventBusy || busy || pendingWrite || eventPending) { notify('请先完成或核对当前操作'); return; }
  moveContext = moveIntent?.id || id;
  if (!moveContext) return;
  movePreview = null;
  const run = ++moveGeneration;
  $('#moveError').textContent = '';
  $('#moveName').textContent = get(moveContext)?.name || '事件迁移';
  $('#moveFrom').textContent = '';
  for (const key of ['moveGoal', 'moveModule', 'moveThing']) $('#' + key).innerHTML = '';
  $('#moveImpact').textContent = '正在读取可选位置…';
  moveControls();
  if (!moveDrawer.open) moveDrawer.showModal();
  try {
    const rows = await api('/items');
    if (run !== moveGeneration || !moveDrawer.open) return;
    db.items = rows;
    const current = get(moveContext), thing = get(current?.parent), module = get(thing?.parent);
    if (!current) throw Error('事件不存在或不可操作');
    $('#moveName').textContent = current.name;
    $('#moveFrom').textContent = '当前位置：' + itemPath(thing) + ($('#editor').open ? '。迁移不保存编辑中的字段。' : '');
    $('#moveGoal').innerHTML = moveOptions(children('goal'), '目标');
    $('#moveGoal').value = module?.parent || '';
    moveModules();
    $('#moveModule').value = module?.id || '';
    moveThings();
    if (moveIntent) {
      $('#moveImpact').textContent = '上次迁移结果待核对，目标：' + itemPath(get(moveIntent.body.target_id)) + '。请先查询结果；不会自动重试。';
    }
    moveControls();
    $('#moveGoal').focus();
  } catch (e) { if (run === moveGeneration && moveDrawer.open) $('#moveError').textContent = e.message; }
}
async function loadMovePreview() {
  if (moveBusy || moveIntent) return;
  resetMovePreview();
  const target = $('#moveThing').value, id = moveContext, run = moveGeneration;
  if (!target) return;
  $('#moveImpact').textContent = '正在核对迁移影响…';
  try {
    const result = await api('/events/' + id + '/move?target_id=' + encodeURIComponent(target));
    if (run !== moveGeneration || !moveDrawer.open) return;
    movePreview = result;
    $('#moveImpact').textContent = `将 ${result.moved_ids.length} 个事件迁至 ${result.target_path.join(' / ')}。` +
      (result.detached_parent ? '当前事件会脱离原父事件，作为目标事情下的独立事件。' : '') +
      `保留内容、状态和内部关系；暂停 ${result.documents} 个文档来源、${result.reminders} 条催办，作废 ${result.discarded_suggestions} 条待确认建议。`;
  } catch (e) {
    if (run === moveGeneration && moveDrawer.open) { $('#moveImpact').textContent = '未完成核对，暂不能迁移。'; $('#moveError').textContent = e.message; }
  } finally { if (run === moveGeneration) moveControls(); }
}
$('#submitMove').onclick = async () => {
  if (moveBusy || moveIntent || !movePreview) return;
  try {
    persistMove({ id: moveContext, body: { target_id: $('#moveThing').value, snapshot: movePreview.snapshot, operation_id: crypto.randomUUID() } });
    await sendMove();
  } catch (e) { $('#moveError').textContent = e.message; }
};
async function moveSaved(result) {
  if (result.action !== 'move' || result.event_id !== moveIntent.id || result.target_id !== moveIntent.body.target_id) throw Error('回执与迁移不一致，请保留操作继续核对');
  db.items = await api('/items');
  const targetId = result.target_id;
  persistMove(null);
  moveGeneration++;
  moveDrawer.close();
  eventDialog.close();
  $('#editor').close();
  editing = null;
  await locateWorkbench(targetId);
  notify(selection.thing === targetId ? '事件已迁移，相关来源与催办已暂停' : '事件已迁移，页面定位未完成，请刷新后核对目标事情');
}
async function sendMove() {
  if (moveBusy || !moveIntent) return;
  moveBusy = true; moveControls(); $('#moveError').textContent = '';
  let committed = false;
  try {
    const result = await api('/events/' + moveIntent.id + '/move', 'POST', moveIntent.body);
    committed = true;
    await moveSaved(result);
  } catch (e) {
    if (!committed && e.status >= 400 && e.status < 500 && ![401, 403].includes(e.status)) { persistMove(null); movePreview = null; }
    $('#moveError').textContent = e.message;
  } finally { moveBusy = false; moveControls(); }
}
$('#retryMove').onclick = sendMove;
$('#checkMove').onclick = async () => {
  if (moveBusy || !moveIntent) return;
  moveBusy = true; moveControls();
  try { await moveSaved(await api('/event-operations/' + moveIntent.body.operation_id)); }
  catch (e) { $('#moveError').textContent = e.message; }
  finally { moveBusy = false; moveControls(); }
};
