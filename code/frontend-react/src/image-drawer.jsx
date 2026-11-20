import React, { useRef } from 'react';

const iconPaths = {
  refresh: 'M21 11a9 9 0 1 0-2 7M21 3v8h-8',
  close: 'm6 6 12 12M18 6 6 18',
  image: 'M3 3h18v18H3ZM3 20l12-12 6 6M7 7h.01',
};

const imageStates = new Map([
  ['pending', '待上传'],
  ['failed', '上传未完成'],
  ['unknown', '结果待核对'],
  ['absent', '云端未找到，可主动重试'],
  ['mismatch', '内容不符，需检查'],
  ['blocked', '事件已变化，图片未关联'],
  ['ready', '已保存'],
]);

function ImageIcon({ name }) {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={iconPaths[name]} /></svg>;
}

function ImageIconButton({ id, label, icon, disabled, onClick }) {
  return <button type="button" id={id} className="imageIcon" title={label} aria-label={label}
    disabled={disabled} onClick={onClick}><ImageIcon name={icon} /></button>;
}

function ImageAction({ kind, id, children, controls, actions, className, label }) {
  const availableWhileRemoving = ['recover-remove', 'retry-remove', 'preview'].includes(kind);
  return <button type="button" className={className} aria-label={label} data-action={kind} data-id={id}
    disabled={controls.busy || (Boolean(controls.removePending) && !availableWhileRemoving)}
    onClick={() => actions.action(kind, id)}>{children}</button>;
}

function ImageCard({ row, local, picked, controls, actions }) {
  const { id, state, name, url, created_at } = row;
  const kind = local && ['pending', 'failed'].includes(state) ? 'cancel'
    : ['ready', 'absent', 'blocked'].includes(state) ? 'remove' : 'reconcile';
  const label = { cancel: '取消', remove: '移除', reconcile: '核对结果' }[kind];
  return <article className="imageCard">
    {url && <ImageAction kind="preview" id={id} className="imageThumb" label={`预览：${name}`}
      controls={controls} actions={actions}>
      <img src={url} alt={name} onError={event => actions.readError(event.currentTarget.src.startsWith('blob:')
        ? '无法预览该文件，请重新选择图片。' : '图片暂不可访问或链接已过期，请刷新图片。')} />
    </ImageAction>}
    <div className="imageCaption">
      <label className="imagePick">
        <input type="checkbox" data-action="pick" data-id={id} checked={picked}
          disabled={controls.busy || Boolean(controls.removePending)}
          onChange={event => actions.action('pick', id, event.currentTarget.checked)} />
        {name}
      </label>
      <p>{imageStates.get(state) ?? '待核对'}</p>
      {!local && created_at && <p className="muted">{new Date(created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>}
      <ImageAction kind={kind} id={id} controls={controls} actions={actions}>{label}</ImageAction>
    </div>
  </article>;
}

function ImageCandidate({ candidate, index, duplicate, controls, actions }) {
  const edit = (key, value) => actions.editCandidate(index, key, value);
  return <article className="imageCandidate" data-index={index}>
    <div className="imageCandidateTitle">
      <input type="checkbox" aria-label={`选中候选 ${index + 1}`} data-field="selected" checked={Boolean(candidate.selected)}
        onChange={event => edit('selected', event.currentTarget.checked)} />
      <input aria-label="事件名称" data-field="name" maxLength={120} value={candidate.name ?? ''}
        onChange={event => edit('name', event.currentTarget.value)} />
    </div>
    {duplicate && <small className="muted">已有同名事件，请先核对</small>}
    <details><summary>详情与图片依据</summary>
      <label>说明<textarea data-field="description" maxLength={2000} value={candidate.description ?? ''}
        onChange={event => edit('description', event.currentTarget.value)} /></label>
      <div className="fieldGrid">
        <label>责任人<input data-field="owner" maxLength={80} value={candidate.owner ?? ''}
          onChange={event => edit('owner', event.currentTarget.value)} /></label>
        <label>计划结束<input type="date" data-field="planEnd" value={candidate.planEnd ?? ''}
          onChange={event => edit('planEnd', event.currentTarget.value)} /></label>
      </div>
      <p>{candidate.evidence}</p>
      <ImageAction kind="preview" id={candidate.image_id} controls={controls} actions={actions}>对照来源图片</ImageAction>
    </details>
  </article>;
}

function ImageAnalysis({ batch, pendingConfirm, controls, actions }) {
  return <section id="imageAnalysis" hidden={!batch && !pendingConfirm}>
    <h3>下一步事件</h3>
    <p id="imageSummary" role="status">{pendingConfirm ? '创建结果待核对。' : batch?.summary || ''}</p>
    <div id="imageCandidates">
      {batch?.candidates.map((candidate, index) => <ImageCandidate key={`${batch.id}:${index}`} candidate={candidate}
        index={index} duplicate={batch.duplicates?.includes(candidate.name)} controls={controls} actions={actions} />)}
    </div>
    <div className="imageTools imageWrap">
      <button id="imageConfirm" type="button" className="primary" hidden={!batch?.candidates.length || pendingConfirm}
        disabled={controls.confirmDisabled} title={controls.confirmTitle} onClick={() => actions.confirm()}>确认创建所选</button>
      <button id="imageConfirmCheck" type="button" hidden={!pendingConfirm} disabled={controls.checkDisabled}
        onClick={() => actions.checkConfirm()}>核对创建结果</button>
      <button type="button" hidden={controls.retryConfirmHidden} disabled={controls.busy}
        onClick={() => actions.retryConfirm()}>重试原确认</button>
    </div>
  </section>;
}

export function ImageDrawer({ model, actions }) {
  const { title, context, source, error, queue, rows, picks, controls, batch, pendingConfirm } = model;
  const fileInput = useRef(null);
  function addFiles(event) {
    const input = event.currentTarget;
    const files = [...input.files];
    input.value = '';
    actions.addFiles(files);
  }

  return <>
    <div className="drawerHead">
      <h2 id="imageTitle">{title}</h2>
      <div className="imageTools">
        <ImageIconButton id="imageReload" label="刷新图片与访问链接" icon="refresh"
          disabled={controls.reloadDisabled} onClick={() => actions.reload()} />
        <ImageIconButton id="imageClose" label="关闭图片" icon="close" onClick={() => actions.close()} />
      </div>
    </div>
    <div className="imageBody">
      <div id="imageContext" className="imageContext">{context}</div>
      <div id="imageSource" hidden={!source}>
        {source && <details><summary>来源图片 · {source.name}</summary>
          <p>{source.evidence}</p>
          {source.url ? <a href={source.url} target="_blank" rel="noreferrer">查看原图</a>
            : <p className="muted">原图暂不可查看</p>}
        </details>}
      </div>
      <div className="imageTools imageWrap">
        <button id="imagePaste" type="button" disabled={controls.chooseDisabled}
          onClick={() => actions.paste()} onPaste={event => actions.clipboardPaste(event)}>
          <ImageIcon name="image" /> 粘贴图片 <kbd>Ctrl+V</kbd>
        </button>
        <button id="imageChoose" type="button" disabled={controls.chooseDisabled}
          onClick={() => fileInput.current.click()}>选择图片</button>
        <button id="imageUpload" type="button" className="primary" disabled={controls.uploadDisabled}
          onClick={() => actions.upload()}>上传图片</button>
        <button id="imageAnalyze" type="button" className="primary" hidden={controls.analyzeHidden}
          disabled={controls.analyzeDisabled} onClick={() => actions.analyze()}>分析图片</button>
      </div>
      <input id="imageFiles" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden ref={fileInput} onChange={addFiles} />
      <p className="imageHelp">JPEG、PNG、WebP · 单张≤10MiB · 每个对象≤20张</p>
      <p id="imageError" className="imageError" role="status">{error}</p>
      <div>
        {controls.removePending && <>
          <ImageAction kind="recover-remove" controls={controls} actions={actions}>核对移除结果</ImageAction>
          {controls.removeCanRetry &&
            <ImageAction kind="retry-remove" controls={controls} actions={actions}>使用原操作重试移除</ImageAction>}
        </>}
      </div>
      <div id="imageQueue" className="imageGrid">
        {queue.map(row => <ImageCard key={row.id} row={row} local picked={picks.includes(row.id)} controls={controls} actions={actions} />)}
      </div>
      <h3>已保存图片</h3>
      <div id="imageSaved" className="imageGrid">
        {rows.length ? rows.map(row => <ImageCard key={row.id} row={row} picked={picks.includes(row.id)}
          controls={controls} actions={actions} />) : <p className="muted">暂无图片</p>}
      </div>
      <ImageAnalysis batch={batch} pendingConfirm={pendingConfirm} controls={controls} actions={actions} />
      <p className="imageHelp">移除仅解除关联，云端原文件暂保留。</p>
    </div>
  </>;
}

export function ImageViewer({ model, actions }) {
  const { name, url, error } = model;
  return <>
    <div className="drawerHead">
      <h2 id="imageViewerName">{name}</h2>
      <ImageIconButton id="imageViewerClose" label="关闭预览" icon="close" onClick={() => actions.close()} />
    </div>
    <img id="imageLarge" src={url || undefined} alt={name || ''} onError={() => actions.error()} />
    <p className="imageHelp" role="status">{error}</p>
  </>;
}
