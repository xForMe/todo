(() => {
  const drawer = document.querySelector('#matterPlanningDrawer');
  const tab = document.createElement('button');
  tab.id = 'mpModelTab';
  tab.type = 'button';
  tab.role = 'tab';
  tab.textContent = '大模型';
  tab.setAttribute('aria-controls', 'mpModelPanel');
  tab.setAttribute('aria-selected', 'false');
  tab.tabIndex = -1;
  drawer.querySelector('#mpSettingsTabs').append(tab);

  const icon = (path) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  const panel = document.createElement('section');
  panel.id = 'mpModelPanel';
  panel.role = 'tabpanel';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', tab.id);
  panel.innerHTML = `
    <div class="imageSettingsHead">
      <h3>模型列表</h3>
      <div class="imageTools">
        <button id="modelAdd" type="button" class="imageIcon" title="新增模型" aria-label="新增模型">
          ${icon('M12 5v14M5 12h14')}
        </button>
        <button id="modelSave" type="button" class="imageIcon primary" title="保存模型配置" aria-label="保存模型配置">
          ${icon('M19 21H5V3h12l4 4v14ZM7 3v5h9M7 21v-8h10v8')}
        </button>
      </div>
    </div>
    <div id="modelList"></div>
    <form id="modelEditor" autocomplete="off" hidden>
      <div class="imageConfigFields">
        <label>显示名称<input id="modelName" maxlength="80" placeholder="例如：日常文本" required></label>
        <label>模型 ID<input id="modelId" maxlength="200" spellcheck="false" required></label>
        <label>模型地址<input id="modelAddress" type="url" maxlength="500" placeholder="https://example.com/v1" spellcheck="false" required></label>
        <label>API Key<input id="modelKey" type="password" autocomplete="new-password" maxlength="512"></label>
      </div>
      <p class="imageHelp" id="modelKeyHelp">填写 OpenAI 兼容的 Base URL 或 Chat Completions 地址。</p>
      <div class="modelFlags">
        <label><input id="modelVision" type="checkbox"> 支持图片输入</label>
        <label id="modelClearLabel" hidden><input id="modelClear" type="checkbox"> 清除已有密钥</label>
      </div>
      <div class="modelEditorActions">
        <button id="modelRemove" type="button" hidden>移除模型</button>
        <div class="imageTools"><button id="modelCancel" type="button">取消</button><button type="submit">确定</button></div>
      </div>
    </form>
    <section id="modelAssignments" aria-labelledby="modelAssignmentsTitle">
      <h3 id="modelAssignmentsTitle">场景分配</h3>
      <div id="modelScenes"></div>
      <p id="modelSourceNotice" class="imageHelp" hidden>飞书资料识别会将已授权的资料提交给所选服务。</p>
    </section>
    <p id="modelStatus" class="imageError" role="status"></p>
    <button id="modelRecover" type="button" hidden>核对保存结果</button>
    <button id="modelReload" type="button" hidden>重新加载</button>`;
  drawer.querySelector('#mpSettings').append(panel);

  const field = id => panel.querySelector('#' + id);
  const editor = field('modelEditor');
  const status = field('modelStatus');
  const recover = field('modelRecover');
  const reload = field('modelReload');
  const profileKey = field('modelKey');
  let saved = null;
  let profiles = [];
  let assignments = {};
  let editing = null;
  let dirty = false;
  let stale = false;
  let busy = false;
  let pendingId = '';

  function controls() {
    const locked = busy || stale || Boolean(pendingId) || !saved;
    field('modelAdd').disabled = locked || Boolean(editing);
    field('modelSave').disabled = locked || Boolean(editing) || !dirty;
    for (const button of field('modelList').querySelectorAll('button')) {
      button.disabled = locked || Boolean(editing) || (button.dataset.check === 'true' && dirty);
    }
    for (const select of field('modelScenes').querySelectorAll('select')) {
      select.disabled = locked || Boolean(editing);
    }
    recover.hidden = !pendingId;
    recover.disabled = reload.disabled = busy;
    reload.hidden = Boolean(pendingId) || (!stale && Boolean(saved));
  }

  function rowButton(name, path, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'imageIcon';
    button.title = name;
    button.setAttribute('aria-label', name);
    button.innerHTML = icon(path);
    button.onclick = onClick;
    return button;
  }

  function render() {
    const list = field('modelList');
    list.replaceChildren();
    if (saved && !profiles.length) {
      const empty = document.createElement('p');
      empty.className = 'imageHelp';
      empty.textContent = '暂无自定义模型。点击右上角的＋添加。';
      list.append(empty);
    }
    for (const profile of profiles) {
      const row = document.createElement('div');
      row.className = 'modelProfileRow';
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = profile.name;
      const details = document.createElement('small');
      details.textContent = profile.model + (profile.vision ? ' · 支持图片' : '');
      info.append(name, details);
      const actions = document.createElement('div');
      actions.className = 'imageTools';
      const check = rowButton('检查模型 ' + profile.name, 'M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-6 6v4', () => checkModel(profile.id));
      check.dataset.check = 'true';
      actions.append(check, rowButton('编辑模型 ' + profile.name, actionIconPaths.edit, () => openEditor(profile)));
      row.append(info, actions);
      list.append(row);
    }

    const scenes = field('modelScenes');
    scenes.replaceChildren();
    for (const [scene, name] of Object.entries(saved?.scenes || {})) {
      const label = document.createElement('label');
      label.className = 'modelScene';
      label.textContent = name;
      const select = document.createElement('select');
      select.append(new Option('沿用现有配置', ''));
      for (const profile of profiles) {
        if (scene !== 'image_analysis' || profile.vision) {
          select.append(new Option(profile.name, profile.id));
        }
      }
      select.value = assignments[scene] || '';
      select.onchange = () => {
        if (select.value) assignments[scene] = select.value;
        else delete assignments[scene];
        markDirty();
      };
      label.append(select);
      scenes.append(label);
    }
    field('modelAssignments').hidden = !saved;
    field('modelSourceNotice').hidden = !assignments.source_recognition;
    controls();
  }

  function setSaved(value) {
    saved = value;
    profiles = value.models.map(profile => ({...profile}));
    assignments = {...value.assignments};
    dirty = stale = false;
    closeEditor();
    render();
  }

  function markDirty() {
    dirty = true;
    status.textContent = '有未保存的修改';
    field('modelSourceNotice').hidden = !assignments.source_recognition;
    controls();
  }

  function openEditor(profile) {
    editing = profile || {id: crypto.randomUUID()};
    field('modelName').value = editing.name || '';
    field('modelId').value = editing.model || '';
    field('modelAddress').value = editing.base_url || '';
    profileKey.value = editing.api_key || '';
    profileKey.placeholder = editing.has_key ? '留空保留已有密钥' : '可选';
    field('modelVision').checked = Boolean(editing.vision);
    field('modelClear').checked = Boolean(editing.clear_key);
    field('modelClearLabel').hidden = !editing.has_key;
    field('modelRemove').hidden = !profile;
    editor.hidden = false;
    controls();
    field('modelName').focus();
  }

  function closeEditor() {
    editing = null;
    profileKey.value = '';
    editor.hidden = true;
    controls();
  }

  editor.onsubmit = event => {
    event.preventDefault();
    if (!editing) return;
    const name = field('modelName').value.trim();
    const model = field('modelId').value.trim();
    const baseUrl = field('modelAddress').value.trim();
    const vision = field('modelVision').checked;
    const clearKey = field('modelClear').checked;
    const apiKey = profileKey.value.trim();
    if (!name || !model || /\s/.test(model)) {
      status.textContent = '请填写显示名称和有效的模型 ID。';
      return;
    }
    if (profiles.some(profile => profile.id !== editing.id && profile.name.toLowerCase() === name.toLowerCase())) {
      status.textContent = '此显示名称已存在。';
      return;
    }
    if ((!vision && assignments.image_analysis === editing.id) || (clearKey && apiKey)) {
      status.textContent = !vision && assignments.image_analysis === editing.id
        ? '请先调整图片分析的模型分配。'
        : '请在替换密钥和清除密钥中选择一项。';
      return;
    }
    const profile = {
      id: editing.id, name, model, base_url: baseUrl, vision,
      has_key: Boolean(editing.has_key),
      ...(apiKey ? {api_key: apiKey} : {}),
      ...(clearKey ? {clear_key: true} : {})
    };
    const index = profiles.findIndex(item => item.id === editing.id);
    const original = saved.models.find(item => item.id === editing.id);
    if (original?.has_key && baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') !== original.base_url
        && !clearKey && !apiKey) {
      status.textContent = '地址已变更，请重新填写 API Key 或清除已有密钥。';
      return;
    }
    if (index < 0) profiles.push(profile);
    else profiles[index] = profile;
    closeEditor();
    markDirty();
    render();
  };

  field('modelAdd').onclick = () => openEditor();
  field('modelCancel').onclick = closeEditor;
  field('modelRemove').onclick = () => {
    if (!editing) return;
    if (Object.values(assignments).includes(editing.id)) {
      status.textContent = '请先调整使用此模型的场景。';
      return;
    }
    profiles = profiles.filter(item => item.id !== editing.id);
    closeEditor();
    markDirty();
    render();
  };

  async function load() {
    if (busy || pendingId) return;
    busy = true;
    controls();
    status.textContent = '正在加载配置…';
    try {
      setSaved(await api('/model-catalog'));
      status.textContent = '';
    } catch (error) {
      stale = true;
      status.textContent = error.message;
    } finally {
      busy = false;
      controls();
    }
  }

  field('modelSave').onclick = async () => {
    if (field('modelSave').disabled) return;
    pendingId = crypto.randomUUID();
    busy = true;
    controls();
    status.textContent = '正在保存配置…';
    const body = {
      operation_id: pendingId,
      expected_revision: saved.revision,
      models: profiles.map(({has_key, ...profile}) => profile),
      assignments
    };
    try {
      setSaved(await api('/model-catalog', 'PUT', body));
      pendingId = '';
      status.textContent = '已保存，下次调用将使用此配置。';
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        pendingId = '';
        stale = error.status === 409;
      }
      status.textContent = pendingId ? '保存结果待核对，请点击「核对保存结果」。' : error.message;
    } finally {
      busy = false;
      controls();
    }
  };

  reload.onclick = load;
  recover.onclick = async () => {
    if (!pendingId || busy) return;
    busy = true;
    controls();
    try {
      setSaved(await api('/model-catalog/operations/' + pendingId));
      pendingId = '';
      status.textContent = '已核对，模型配置已保存。';
    } catch (error) {
      if (error.status === 404) {
        pendingId = '';
        stale = true;
        status.textContent = '尚未查到保存记录，请重新加载确认当前配置。';
      } else {
        status.textContent = '暂时无法核对，请稍后再查。';
      }
    } finally {
      busy = false;
      controls();
    }
  };

  async function checkModel(id) {
    busy = true;
    controls();
    status.textContent = '正在检查模型目录…';
    try {
      status.textContent = (await api('/model-catalog/' + id + '/check', 'POST')).message;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      controls();
    }
  }

  drawer.addEventListener('model-settings-open', () => {
    if (!dirty && !stale && !editing) void load();
  });
  drawer.addEventListener('close', () => {
    if (profileKey.value || profiles.some(profile => profile.api_key)) {
      for (const profile of profiles) delete profile.api_key;
      status.textContent = pendingId ? '保存结果待核对。' : '未保存的 API Key 已清除。';
    }
    closeEditor();
  });
  render();
})();
