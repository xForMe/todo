/* Sources are persistent server records; no simulated content or external writes. */
let sourceContext = null, sourceRecords = [], sourcePending = null, sourceBusy = false;
let sourceLoadVersion = 0, sourceSession = 0, sourceError = '';
let sourceReact = null, sourceAcknowledged = null;
const sourceDrawer = $('#sourceDrawer');

function mountSourceDrawer(mount) { sourceReact = mount(sourceDrawer); }
sourceDrawer.addEventListener('close', () => {
  if (!sourceDrawer.open && !sourceBusy) sourceLoadVersion++;
});

async function openSources(id) {
  if (!sourceReact) return;
  if (sourcePending) {
    if ((id || null) !== sourceContext) { notify('请先核对上次来源操作'); return; }
    renderSources();
    if (!sourceDrawer.open) sourceDrawer.showModal();
    await loadSources();
    return;
  }
  const item = id ? get(id) : null;
  if (id && !item) return;
  sourceContext=id||null;
  sourceSession++;
  sourceError = '';
  renderSources();
  if (!sourceDrawer.open) sourceDrawer.showModal();
  await loadSources();
}

function sourceMatches(row, intended) {
  return !!row && (row.context || null) === (intended.context || null) &&
    ['kind', 'address', 'enabled', 'removed', 'interval', 'ai_consent'].every(key => row[key] === intended[key]);
}

async function loadSources({ fromWrite = false } = {}) {
  if (sourceBusy && !fromWrite) return false;
  const version = ++sourceLoadVersion;
  const pendingAtStart = sourcePending;
  try {
    const records = await api('/sources');
    if (version !== sourceLoadVersion) return false;
    sourceRecords = records;
    if (sourcePending && sourcePending === pendingAtStart) {
      const found = records.find(row => row.id === sourcePending.id);
      const matched = sourceAcknowledged?.removed
        ? !found
        : sourceMatches(found, sourceAcknowledged || sourcePending)
          || (Number.isInteger(sourceAcknowledged?.version) && found?.version > sourceAcknowledged.version);
      if (matched) {
        sourcePending = null;
        sourceAcknowledged = null;
        sourceError = fromWrite ? '' : '上次操作已读回确认';
      } else {
        sourceError = sourceAcknowledged ? '来源已提交，但列表未读回对应结果；请刷新核对，不会自动重试'
          : '上次操作仍需核对；原操作标识保留，可手动再次提交';
      }
    }
    renderSources();
    return !sourcePending;
  } catch (error) {
    if (version === sourceLoadVersion) { sourceError = error.message; renderSources(); }
    return false;
  }
}

function renderSources() {
  const rows = sourceRecords.filter(row => sourceContext
    ? row.kind === 'document' && row.context === sourceContext : row.kind === 'chat');
  const stamp = row => row.last_run ? '上次读取：' + new Date(row.last_run * 1000).toLocaleString('zh-CN') : '尚未读取';
  const item = get(sourceContext);
  sourceReact({ model: {
    chat: !sourceContext, context: item ? '所属' + names[item.type] + '：' + item.name : '',
    session: sourceSession, interval: '900', records: rows.map(row => ({ ...row, stamp: stamp(row) })),
    error: sourceError, busy: sourceBusy, saveDisabled: sourceBusy || !!sourceAcknowledged,
  }, actions: {
    close: () => sourceDrawer.close(), submit: submitSource, refresh: () => loadSources(),
    change: (id, enabled, removed) => {
      const row = rows.find(row => row.id === id);
      if (row) return changeSource(row, enabled, removed);
    }, showTip, hideTip,
  } });
}

async function sourceWrite(body) {
  if (sourceBusy) return;
  if (sourceAcknowledged) { notify('请刷新来源列表核对已提交的操作'); return; }
  if (sourcePending && sourcePending !== body) { notify('请先核对上一次来源操作'); return; }
  sourceBusy = true;
  sourcePending = body;
  sourceLoadVersion++;
  renderSources();
  try {
    const response = await api('/sources', 'POST', body);
    sourceAcknowledged = { ...body, ...response };
    if (await loadSources({ fromWrite: true })) notify('来源设置已保存并读回');
    else sourceError = '来源已提交，列表读回失败；请刷新来源列表核对，不会自动重试';
  } catch (error) {
    if (error.status >= 400 && error.status < 500) sourcePending = null;
    sourceError = error.message + '；操作结果待核对，请刷新来源列表，不会自动重试';
  } finally {
    sourceBusy = false;
    if (sourceDrawer.open) renderSources();
  }
}

async function changeSource(row, enabled, removed) {
  await sourceWrite({ id: row.id, context: row.kind === 'chat' ? null : row.context, kind: row.kind,
    address: row.address, interval: row.interval, enabled, removed, consent: enabled,
    ai_consent: row.ai_consent, expected_version: row.version });
}
async function submitSource() {
  if (sourcePending) { await sourceWrite(sourcePending); return; }
  await sourceWrite({ id: crypto.randomUUID(), context: sourceContext, kind: sourceContext ? 'document' : 'chat',
    address: $('#sourceAddress').value.trim(), interval: Number($('#sourceInterval').value), enabled: true,
    removed: false, consent: $('#sourceConsent').checked, ai_consent: $('#aiConsent').checked });
}
setInterval(() => { if (sourceDrawer.open && !sourceBusy) loadSources(); }, 10000);
