import React from 'react';

const iconPaths = {
  add: 'M12 5v14M5 12h14',
  save: 'M19 21H5V3h12l4 4v14ZM7 3v5h9M7 21v-8h10v8',
  check: 'M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-6 6v4',
  edit: 'm16 3 5 5-12 12-6 1 1-6L16 3Zm-3 3 5 5',
};

function ModelIconButton({ id, kind, label, disabled, onClick }) {
  return <button id={id} type="button" className={kind === 'save' ? 'imageIcon primary' : 'imageIcon'}
    title={label} aria-label={label} data-check={kind === 'check' ? 'true' : undefined}
    disabled={disabled} onClick={onClick}>
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={iconPaths[kind]} /></svg>
  </button>;
}

function ModelEditor({ editing, existing, actions }) {
  return <form id="modelEditor" autoComplete="off" hidden={!editing}
    onSubmit={event => { event.preventDefault(); if (editing) actions.submit(); }}>
    <div className="imageConfigFields">
      <label>显示名称<input id="modelName" maxLength={80} placeholder="例如：日常文本" required
        defaultValue={editing?.name ?? ''} autoFocus={Boolean(editing)} /></label>
      <label>模型 ID<input id="modelId" maxLength={200} spellCheck={false} required defaultValue={editing?.model ?? ''} /></label>
      <label>模型地址<input id="modelAddress" type="url" maxLength={500} placeholder="https://example.com/v1"
        spellCheck={false} required defaultValue={editing?.base_url ?? ''} /></label>
      <label>API Key<input id="modelKey" type="password" autoComplete="new-password" maxLength={512}
        placeholder={editing ? (editing.has_key ? '留空保留已有密钥' : '可选') : undefined} /></label>
    </div>
    <p className="imageHelp" id="modelKeyHelp">填写 OpenAI 兼容的 Base URL 或 Chat Completions 地址。</p>
    <div className="modelFlags">
      <label><input id="modelVision" type="checkbox" defaultChecked={Boolean(editing?.vision)} /> 支持图片输入</label>
      <label id="modelClearLabel" hidden={!editing?.has_key}>
        <input id="modelClear" type="checkbox" defaultChecked={Boolean(editing?.clear_key)} /> 清除已有密钥
      </label>
    </div>
    <div className="modelEditorActions">
      <button id="modelRemove" type="button" hidden={!existing} onClick={actions.remove}>移除模型</button>
      <div className="imageTools">
        <button id="modelCancel" type="button" onClick={actions.cancel}>取消</button><button type="submit">确定</button>
      </div>
    </div>
  </form>;
}

export function ModelCatalog({ model, actions }) {
  const { saved, profiles, scenes, assignments, editing, editingExisting, session,
    status, locked, busy, dirty, pending, reload } = model;
  const disabled = locked || Boolean(editing);

  return <>
    <div className="imageSettingsHead">
      <h3>模型列表</h3>
      <div className="imageTools">
        <ModelIconButton id="modelAdd" kind="add" label="新增模型" disabled={disabled} onClick={actions.add} />
        <ModelIconButton id="modelSave" kind="save" label="保存模型配置" disabled={disabled || !dirty} onClick={actions.save} />
      </div>
    </div>
    <div id="modelList">
      {saved && !profiles.length && <p className="imageHelp">暂无自定义模型。点击右上角的＋添加。</p>}
      {profiles.map(profile => <div key={profile.id} className="modelProfileRow">
        <div><strong>{profile.name}</strong><small>{profile.model}{profile.vision ? ' · 支持图片' : ''}</small></div>
        <div className="imageTools">
          <ModelIconButton kind="check" label={`检查模型 ${profile.name}`} disabled={disabled || dirty}
            onClick={() => actions.check(profile.id)} />
          <ModelIconButton kind="edit" label={`编辑模型 ${profile.name}`} disabled={disabled}
            onClick={() => actions.edit(profile.id)} />
        </div>
      </div>)}
    </div>
    <ModelEditor key={editing ? `open:${session}` : 'closed'} editing={editing}
      existing={editingExisting} actions={actions} />
    <section id="modelAssignments" aria-labelledby="modelAssignmentsTitle" hidden={!saved}>
      <h3 id="modelAssignmentsTitle">场景分配</h3>
      <div id="modelScenes">
        {Object.entries(scenes).map(([scene, label]) => <label key={scene} className="modelScene">
          {label}<select value={assignments[scene] || ''} disabled={disabled}
            onChange={event => actions.assign(scene, event.currentTarget.value)}>
            <option value="">沿用现有配置</option>
            {profiles.filter(profile => scene !== 'image_analysis' || profile.vision).map(profile =>
              <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>)}
      </div>
      <p id="modelSourceNotice" className="imageHelp" hidden={!assignments.source_recognition}>
        飞书资料识别会将已授权的资料提交给所选服务。
      </p>
    </section>
    <p id="modelStatus" className="imageError" role="status">{status}</p>
    <button id="modelRecover" type="button" hidden={!pending} disabled={busy} onClick={actions.recover}>核对保存结果</button>
    <button id="modelReload" type="button" hidden={pending || !reload} disabled={busy} onClick={actions.reload}>重新加载</button>
  </>;
}
