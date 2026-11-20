import React from 'react';

const labels = { notStarted: '未开始', working: '进行中', completed: '已完成', cancelled: '已取消' };

function Summary({ summary, onLocate }) {
  return <>
    <p className="workingMemoryPath">{summary.path}</p>
    <div className="workingMemoryCounts">
      {Object.entries(labels).map(([status, label]) => <span key={status}>{label} {summary.counts[status] || 0}</span>)}
    </div>
    <h3>未结束行动</h3>
    {!summary.actions.length && <p>当前没有未结束行动。</p>}
    <ul className="workingMemoryActions">
      {summary.actions.map(action => <li key={action.id}>
        <strong>{action.name}</strong>
        <p className="workingMemoryMeta">{labels[action.status] || action.status} · {action.owner || '未指定负责人'} · {action.plan_end || '日期未定'}</p>
        <button type="button" aria-label={`查看事件：${action.name}`} onClick={() => onLocate(action.id)}>查看事件</button>
      </li>)}
    </ul>
    {summary.omitted ? <p className="sourceHint">部分行动：另有 {summary.omitted} 项未列出，请在事件列表查看。</p>
      : summary.partial && <p className="sourceHint">当前仅展示部分工作，完整内容请查看事件列表。</p>}
    <p className="workingMemoryMeta">摘要只读。修改内容请编辑对应事情或事件。</p>
  </>;
}

export function WorkingMemory({ model, actions }) {
  return <>
    <div className="drawerHead"><h2 id="workingMemoryTitle">当前工作摘要</h2>
      <button type="button" id="workingMemoryClose" onClick={actions.close}>关闭</button></div>
    <p id="workingMemoryState" role="status">{model.status}</p>
    <div id="workingMemoryBody" aria-busy={model.busy}>
      {model.summary && <Summary summary={model.summary} onLocate={actions.locate} />}
    </div>
    <p id="workingMemoryError" role="alert">{model.error}</p>
    <div className="actions"><button type="button" id="workingMemoryRefresh" disabled={model.busy}
      onClick={actions.refresh}>刷新摘要</button></div>
  </>;
}
