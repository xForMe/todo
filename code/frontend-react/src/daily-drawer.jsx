import React from 'react';

function FollowRecords({ view, onImages }) {
  return <>
    <h3 id="dailyRecordsTitle">{view ? `当日记录 ${view.records.length} · ${view.day}` : '当日记录'}</h3>
    <div id="dailyRecords">{view && (view.records.length ? view.records.map(record =>
      <article className="dailyEntry" key={record.id}>
        <time>{record.created_at.slice(11, 16)}</time>
        <p>{record.content}</p>
        {record.new_end !== record.old_end && <small>截止时间 {record.old_end} → {record.new_end} · 已加入延期记录</small>}
        {record.note && <small>{record.note}</small>}
        {!!record.image_ids?.length && <button type="button" data-follow-images={record.id}
          onClick={() => onImages(record.id)}>图片 {record.image_ids.length} 张</button>}
      </article>) : <p className="muted">{view.legacy_at ? '旧梳理标记，无跟进正文' : '今天还没有跟进记录'}</p>)}</div>
  </>;
}

export function DailyDrawer({ model, actions }) {
  const { content, busy, canWrite, view, path, result, reload, plain, verify, retry } = model;
  return <>
    <div className="dailyHead"><h2 id="dailyFollowTitle">当日跟进</h2><div className="dailyHeadActions">
      <button type="button" id="dailySave" className="primary" title="保存跟进" aria-label="保存跟进"
        disabled={busy || !canWrite} onClick={actions.save}>
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8M7 3v5h9" /></svg>
      </button>
      <button type="button" id="dailyClose" title="关闭当日跟进" aria-label="关闭当日跟进"
        disabled={busy} onClick={actions.close}>
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </div></div>
    <div className="dailyBody">
      <div id="dailyContext">{view && <><strong>{view.item.name}</strong><p>{path}</p>
        <p>当前截止：{view.item.planEnd || '未排期'}</p></>}</div>
      <label htmlFor="dailyContent">本次跟进</label>
      <textarea id="dailyContent" maxLength={4000} rows={3} placeholder="记录这次跟进情况…"
        disabled={busy || !canWrite} value={content} onChange={event => actions.input(event.currentTarget.value)} />
      <div id="dailyImageSlot" style={{ display: 'contents' }} />
      <small>明确说明当前任务已完成，保存后标记为已完成；明确延期时同步截止日期及延期记录。</small>
      <p id="dailyResult" role="status" className={result?.error ? 'error' : undefined} hidden={!result}>{result?.text}</p>
      <div className="dailyRecovery">
        <button type="button" id="dailyReload" hidden={!reload} disabled={busy} onClick={actions.reload}>重新读取</button>
        <button type="button" id="dailyPlain" hidden={!plain} disabled={busy || !canWrite} onClick={actions.plain}>仅保存跟进</button>
        <button type="button" id="dailyVerify" hidden={!verify} onClick={actions.verify}>核对保存结果</button>
        <button type="button" id="dailyRetry" hidden={!retry} onClick={actions.retry}>使用原操作标识重试</button>
      </div>
      <FollowRecords view={view} onImages={actions.images} />
    </div>
  </>;
}
