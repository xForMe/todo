import React from 'react';

const paths = {
  refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2',
  close: 'M6 6l12 12M18 6 6 18',
  manual: 'M16 3l5 5L9 20l-6 1 1-6L16 3M13 6l5 5',
  discard: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
};

// The native dialog uses this attribute each time showModal() runs.
function setAutofocus(button) {
  if (button) button.autofocus = true;
}

function RecognitionIcon({ label, icon, onClick, disabled, danger, focusOnOpen }) {
  return <button type="button" className={danger ? 'recognitionIcon danger' : 'recognitionIcon'}
    aria-label={label} disabled={disabled} onClick={onClick} ref={focusOnOpen ? setAutofocus : undefined}>
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[icon]} /></svg>
    <span className="recognitionActionHint" role="tooltip">{label}</span>
  </button>;
}

function UnmatchedRow({ message, index, busy, actions }) {
  return <article className="wbRow chatResult unmatchedRow">
    <div className="chatResultHead">
      <div className="unmatchedContent">
        <strong title={message.content}>{message.content}</strong>
        <p className="unmatchedState">
          {message.processed ? '未提取行动' : '等待识别'}
          {!message.can_retry && <> · <span title={`${message.retry_block_reason || '来源暂不可用'}；可手动整理`}>识别不可用</span></>}
        </p>
      </div>
      <div className="chatActions">
        <RecognitionIcon label="手动整理" icon="manual" disabled={busy} onClick={() => actions.manual(index)} />
        <RecognitionIcon label="重新识别此条" icon="refresh" disabled={!message.can_retry || busy} onClick={() => actions.retry(index)} />
        <RecognitionIcon label="废弃" icon="discard" disabled={busy} danger onClick={() => actions.discard(index)} />
      </div>
    </div>
  </article>;
}

function SuggestionRow({ suggestion, actions }) {
  const { id, name, thingId, path, evidence, state } = suggestion;
  return <article className="wbRow chatResult">
    <div>
      <strong>{name}</strong>
      <p className="wbPath">{path || '归属待确认'}</p>
      <details><summary>原文依据</summary><p>{evidence || '暂无依据'}</p></details>
    </div>
    <div className="chatActions">
      {state === 'pending' && <button type="button" className="primary" onClick={() => actions.review(id)}>核对建议</button>}
      {path && <button type="button" onClick={() => actions.locate(thingId)}>定位事情</button>}
    </div>
  </article>;
}

function RecognitionResults({ model, actions }) {
  const { state, last, page, paged, loading, error, tabs, unmatched, suggestions, retryBusy } = model;
  return <>
    <div className="wbTabs dshRecognitionTabs" aria-label="事件识别状态">
      {tabs.map(tab => <button type="button" key={tab.state} aria-pressed={tab.state === state}
        className={tab.state === state ? 'active' : ''} onClick={() => actions.tab(tab.state)}>
        {tab.label} <span>{tab.count}</span>
      </button>)}
    </div>
    {error ? <p className="chatScope error" role="alert">识别结果读取失败：{error}。请刷新重试。</p>
      : loading ? <p className="chatScope" role="status">正在读取识别结果…</p>
      : state === 'unmatched' ? (unmatched.length ? unmatched.map((message, index) =>
      <UnmatchedRow key={JSON.stringify([message.source_id, message.message_id])}
        message={message} index={index} busy={retryBusy} actions={actions} />) : <p>当前页没有未匹配消息</p>)
      : (suggestions.length ? suggestions.map(suggestion => <SuggestionRow key={suggestion.id} suggestion={suggestion} actions={actions} />)
        : <p className="chatScope">{state === 'pending' ? '暂无待确认事件建议' : '暂无已关联进展'}</p>)}
    {paged && <div className="wbPager">
      <span>第 {page + 1}/{last + 1} 页</span>
      <button type="button" disabled={page === 0} onClick={() => actions.page(-1)}>上一页</button>
      <button type="button" disabled={page === last} onClick={() => actions.page(1)}>下一页</button>
    </div>}
  </>;
}

export function RecognitionDrawer({ model, actions }) {
  return <>
    <div className="drawerHead">
      <h2 id="eventRecognitionTitle">事件识别</h2>
      <div className="recognitionHeaderActions">
        <RecognitionIcon label="刷新结果" icon="refresh" onClick={() => actions.refresh()} />
        <RecognitionIcon label="关闭" icon="close" focusOnOpen onClick={() => actions.close()} />
      </div>
    </div>
    <div id="chatResults">
      {model.recoveryError && <p className="error" role="alert">{model.recoveryError}</p>}
      {model.retryBusy && <p role="status">正在处理，请稍候…</p>}
      <RecognitionResults model={model} actions={actions} />
    </div>
  </>;
}
