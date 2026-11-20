import React from 'react';

export function ModuleMemory({ model, actions }) {
  const { path, status, error, draft, processing, pending, editable, canDisable, canIndex } = model;
  return <>
    <div className="drawerHead"><h2 id="memoryTitle">模块记忆</h2>
      <button type="button" id="memoryClose" aria-label="关闭模块记忆" onClick={actions.close}>关闭</button>
    </div>
    <p id="memoryPath">{path}</p><p id="memoryState" role="status">{status}</p>
    <form id="memoryForm" onSubmit={event => { event.preventDefault(); actions.save(true); }}>
      <label htmlFor="memoryDescription">模块职责</label>
      <textarea id="memoryDescription" maxLength={2000} rows={5} disabled={!editable} value={draft.description}
        onChange={event => actions.change('description', event.currentTarget.value)} />
      <label htmlFor="memoryAliases">简称（每行一个，最多20个）</label>
      <textarea id="memoryAliases" rows={3} maxLength={1620} disabled={!editable} value={draft.aliases}
        onChange={event => actions.change('aliases', event.currentTarget.value)} />
      <p className="sourceHint">确认后用于辅助判断工作归属。事件不会自动加入长期记忆。</p>
      <div className="actions">
        <button className="primary" type="submit" id="memorySave" disabled={!editable}>确认保存</button>
        <button type="button" id="memoryDisable" disabled={!canDisable} onClick={() => actions.save(false)}>停用</button>
      </div>
    </form>
    <div className="actions">
      <button type="button" id="memoryIndex" disabled={!canIndex} onClick={actions.index}>生成向量索引</button>
      <button type="button" id="memoryRefresh" disabled={processing} onClick={actions.refresh}>刷新</button>
      <button type="button" id="memoryRecover" hidden={!pending} disabled={processing} onClick={actions.recover}>核对保存结果</button>
    </div>
    <p id="memoryError" role="alert">{error}</p>
  </>;
}
