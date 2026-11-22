import React, { useRef } from 'react';

export function InlineImages({ model, actions }) {
  const input = useRef(null);
  const paste = useRef(null);
  return <section className="inlineImageEntry">
    <div className="imageTools imageWrap">
      <button type="button" className="imageIcon inlineImagePaste" aria-label="附加图片" title="附加图片 / Ctrl+V"
        ref={paste} disabled={model.disabled} onClick={() => actions.clipboard(paste.current)} onPaste={actions.paste}>
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h18v18H3ZM3 20l12-12 6 6M7 7h.01" /></svg>
        <span>附加图片</span>
      </button>
      <button type="button" className={`inlineImageChoose${model.follow ? '' : ' iconButton'}`}
        aria-label="选文件" title={model.follow ? undefined : '选文件'} data-tip={model.follow ? undefined : '选文件'}
        disabled={model.disabled} onClick={() => { input.current.click(); if (!model.follow) actions.hideTip(); }}
        onMouseEnter={event => { if (!model.follow) actions.showTip(event.currentTarget); }}
        onFocus={event => { if (!model.follow) actions.showTip(event.currentTarget); }}
        onMouseLeave={model.follow ? undefined : actions.hideTip} onBlur={model.follow ? undefined : actions.hideTip}>
        {model.follow ? '选文件' : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>}
      </button>
      {model.follow && <button type="button" className="inlineAnalyze" hidden={!model.files.length}
        disabled={model.disabled} onClick={actions.analyze}>分析图片</button>}
    </div>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden disabled={model.disabled}
      onChange={event => { actions.add([...event.currentTarget.files]); event.currentTarget.value = ''; }} />
    <div className="inlineImagePreview">
      {model.files.map(file => <span key={file.id}>
        <img src={file.url} alt={file.name} />
        <button type="button" className="imageIcon" data-drop={file.id} aria-label={`移除${file.name}`}
          disabled={model.disabled || file.checking} onClick={() => actions.remove(file.id)}>
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
        {file.check && <button type="button" data-check={file.id} disabled={model.disabled || file.checking}
          onClick={() => actions.reconcile(file.id)}>核对</button>}
      </span>)}
    </div>
    <p className="imageHelp" role="status">{model.message}</p>
  </section>;
}
