const todoModelSettings = (() => {
  const drawer = document.querySelector('#matterPlanningDrawer');
  const panel = document.createElement('section');
  panel.id = 'mpModelPanel';
  panel.role = 'tabpanel';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'mpModelTab');
  drawer.querySelector('#mpSettings').append(panel);

  const field = id => panel.querySelector('#' + id);
  let saved = null;
  let profiles = [];
  let assignments = {};
  let editing = null;
  let dirty = false;
  let stale = false;
  let busy = false;
  let pendingId = '';
  let modelReact = null, session = 0, message = '';
  function enableReact(mount) { modelReact = mount(panel); controls(); }
  function feedback(text) {
    message = text;
    controls();
  }
  function safeMessage(error) {
    let result = String(error.message || '模型配置操作失败');
    const keys = [...profiles.map(profile => profile.api_key), field('modelKey')?.value];
    for (const key of keys.filter(Boolean).sort((a,b) => b.length-a.length)) result = result.replaceAll(key,'[已隐藏]');
    return result;
  }
  function changeAssignment(scene,id) {
    if (id) assignments[scene] = id;
    else delete assignments[scene];
    markDirty();
  }

  const isLocked = () => busy || stale || Boolean(pendingId) || !saved;
  function controls() {
    const publicProfile = ({id, name, model, base_url, vision, clear_key, has_key}) => ({id, name, model, base_url, vision, clear_key, has_key});
    modelReact?.({model:{saved:!!saved,profiles:profiles.map(publicProfile),scenes:saved?.scenes||{},assignments,
      editing:editing?publicProfile(editing):null,editingExisting:!!editing&&profiles.some(row=>row.id===editing.id),session,status:message,
      locked:isLocked(),busy,dirty,pending:!!pendingId,reload:!pendingId&&(stale||!saved)},actions:{
      add:()=>openEditor(),save:saveModels,edit:id=>{const profile=profiles.find(row=>row.id===id);if(profile)openEditor(profile)},
      check:checkModel,assign:changeAssignment,cancel:closeEditor,remove:removeModel,submit:updateProfile,recover:recoverModels,reload:load,
    }});
  }

  function setSaved(value) {
    saved = value;
    profiles = value.models.map(profile => ({...profile}));
    assignments = {...value.assignments};
    dirty = stale = false;
    closeEditor();
  }

  function markDirty() {
    dirty = true;
    feedback('有未保存的修改');
  }

  function openEditor(profile) {
    editing = profile || {id: crypto.randomUUID()};
    session++;
    controls();
    // Keep API keys out of the React model and input attributes.
    field('modelKey').value = editing.api_key || '';
    field('modelName').focus();
  }

  function closeEditor() {
    editing = null;
    const key = field('modelKey');
    if (key) key.value = '';
    controls();
  }

  function updateProfile() {
    if (!editing) return;
    const name = field('modelName').value.trim();
    const model = field('modelId').value.trim();
    const baseUrl = field('modelAddress').value.trim();
    const vision = field('modelVision').checked;
    const clearKey = field('modelClear').checked;
    const apiKey = field('modelKey').value.trim();
    if (!name || !model || /\s/.test(model)) {
      feedback('请填写显示名称和有效的模型 ID。');
      return;
    }
    if (profiles.some(profile => profile.id !== editing.id && profile.name.toLowerCase() === name.toLowerCase())) {
      feedback('此显示名称已存在。');
      return;
    }
    if ((!vision && assignments.image_analysis === editing.id) || (clearKey && apiKey)) {
      feedback(!vision && assignments.image_analysis === editing.id
        ? '请先调整图片分析的模型分配。'
        : '请在替换密钥和清除密钥中选择一项。');
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
      feedback('地址已变更，请重新填写 API Key 或清除已有密钥。');
      return;
    }
    if (index < 0) profiles.push(profile);
    else profiles[index] = profile;
    closeEditor();
    markDirty();
  }

  function removeModel() {
    if (!editing) return;
    if (Object.values(assignments).includes(editing.id)) {
      feedback('请先调整使用此模型的场景。');
      return;
    }
    profiles = profiles.filter(item => item.id !== editing.id);
    closeEditor();
    markDirty();
  }

  async function load() {
    if (!modelReact || busy || pendingId) return;
    busy = true;
    feedback('正在加载配置…');
    try {
      setSaved(await api('/model-catalog'));
      feedback('');
    } catch (error) {
      stale = true;
      feedback(safeMessage(error));
    } finally {
      busy = false;
      controls();
    }
  }

  async function saveModels() {
    if (isLocked() || editing || !dirty) return;
    pendingId = crypto.randomUUID();
    busy = true;
    feedback('正在保存配置…');
    const body = {
      operation_id: pendingId,
      expected_revision: saved.revision,
      models: profiles.map(({has_key, ...profile}) => profile),
      assignments
    };
    try {
      setSaved(await api('/model-catalog', 'PUT', body));
      pendingId = '';
      feedback('已保存，下次调用将使用此配置。');
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        pendingId = '';
        stale = error.status === 409;
      }
      feedback(pendingId ? '保存结果待核对，请点击「核对保存结果」。' : safeMessage(error));
    } finally {
      busy = false;
      controls();
    }
  }

  async function recoverModels() {
    if (!pendingId || busy) return;
    busy = true;
    controls();
    try {
      setSaved(await api('/model-catalog/operations/' + pendingId));
      pendingId = '';
      feedback('已核对，模型配置已保存。');
    } catch (error) {
      if (error.status === 404) {
        pendingId = '';
        stale = true;
        feedback('尚未查到保存记录，请重新加载确认当前配置。');
      } else {
        feedback('暂时无法核对，请稍后再查。');
      }
    } finally {
      busy = false;
      controls();
    }
  }

  async function checkModel(id) {
    if (isLocked() || editing || dirty) return;
    busy = true;
    feedback('正在检查模型目录…');
    try {
      feedback(safeMessage(await api('/model-catalog/' + encodeURIComponent(id) + '/check', 'POST')));
    } catch (error) {
      feedback(safeMessage(error));
    } finally {
      busy = false;
      controls();
    }
  }

  drawer.addEventListener('model-settings-open', () => {
    if (!dirty && !stale && !editing) void load();
  });
  drawer.addEventListener('close', () => {
    if (field('modelKey')?.value || profiles.some(profile => profile.api_key)) {
      for (const profile of profiles) delete profile.api_key;
      feedback(pendingId ? '保存结果待核对。' : '未保存的 API Key 已清除。');
    }
    closeEditor();
  });
  return { enableReact };
})();
