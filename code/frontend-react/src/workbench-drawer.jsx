import React from 'react';
import { WorkbenchIcon as Icon } from './workbench-icons.jsx';

export function WorkbenchDrawer({ model, actions }) {
  if (!model) return null;
  const { mode, busy, error, canRetry, detail } = model;
  return <>
    <div className="drawerHead">
      <h2 id="wbDetailTitle">{mode === 'recovery' ? '核对关注结果' : detail.name}</h2>
      <button type="button" data-wb-drawer="close" onClick={actions.close}>关闭</button>
    </div>
    {mode === 'recovery' ? <>
      <p className="error" role="alert">{error}；结果尚未确认，未自动重试。</p>
      <button type="button" data-wb-drawer="recover" onClick={actions.recover} disabled={busy}>查询保存结果</button>
      <div id="wbRecovery">{canRetry && <>
        <p>尚未查到提交记录。可明确使用原操作标识重试。</p>
        <button type="button" data-wb-drawer="retry" onClick={actions.retry} disabled={busy}>使用原操作标识重试</button>
      </>}</div>
    </> : <>
      <p>{detail.path}</p>
      {detail.description && <p>{detail.description}</p>}
      <div className="meta">
        <span className={`status ${detail.status}`}>{detail.statusLabel}</span>
        <span>责任人 · {detail.owner}</span>
        <span>计划开始 · {detail.start}</span>
        <span>计划结束 · {detail.end}</span>
      </div>
      <p>{detail.progress}</p><p>事情优先级：{detail.priority}</p>
      <div className="actions">
        <button type="button" data-wb-drawer="watch" className={`wbWatch ${detail.watched ? 'isWatched' : ''}`}
          title={detail.watchLabel} aria-label={`${detail.watchLabel}：${detail.matterName}`} aria-pressed={detail.watched}
          disabled={detail.watchDisabled} onClick={() => actions.watch(detail.matterId, !detail.watched)}><Icon name="watch" /></button>
        <button type="button" data-wb-drawer="locate" onClick={() => actions.locate(detail.id)} disabled={busy}>定位到工作页</button>
      </div>
      <p id="wbWriteError" className="error" role="alert">{error}</p>
      <button type="button" data-wb-drawer="recover" onClick={actions.recover} disabled={busy}>核对关注结果</button>
    </>}
  </>;
}
