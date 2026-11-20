import React from 'react';

export function MatterPrompts({ types, selected, draft, locked, showReload, reloadDisabled, actions }) {
  return <>
    <button id="mpLoadRetry" type="button" hidden={!showReload} disabled={reloadDisabled}
      onClick={actions.reload}>重新加载</button>
    <div className="mpConfig">
      <div className="mpTypeColumn">
        <div className="mpTypeLabel"><span>事情类型</span>
          <button id="mpNew" type="button" className="quiet" title="新增类型" aria-label="新增类型"
            disabled={locked} onClick={actions.add}>
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
        <nav id="mpTypes" aria-label="事情类型">
          {types.map(type => <button key={type.id} type="button" data-type={type.id}
            className={type.id === selected ? 'active' : ''} aria-pressed={type.id === selected}
            disabled={locked} onClick={() => actions.select(type.id)}>{type.name}{!type.enabled && ' · 停用'}</button>)}
        </nav>
      </div>
      <form id="mpConfigForm" onSubmit={event => { event.preventDefault(); actions.save(); }}>
        <label>类型名称<input id="mpName" maxLength={40} required disabled={locked} value={draft.name}
          onChange={event => actions.change('name', event.currentTarget.value)} /></label>
        <label>拆解提示词<textarea id="mpPrompt" maxLength={4000} rows={10} required disabled={locked} value={draft.prompt}
          onChange={event => actions.change('prompt', event.currentTarget.value)} /></label>
        <div className="mpConfigActions"><label className="mpEnabled">
          <input id="mpEnabled" type="checkbox" disabled={locked} checked={draft.enabled}
            onChange={event => actions.change('enabled', event.currentTarget.checked)} />启用</label>
          <button id="mpSave" type="submit" className="primary" disabled={locked || !selected}>保存配置</button>
        </div>
      </form>
    </div>
  </>;
}
