import React from 'react';

export function MatterPlanningTools({ types, draft, locked, actions }) {
  return <>
    <select id="mpType" aria-label="事情类型" disabled={locked || !draft} value={draft?.type || ''}
      onChange={event => actions.type(event.currentTarget.value)}>
      <option value="">自动判断</option>
      {types.map(type => <option key={type.id} value={type.id} disabled={!type.enabled}>
        {type.name}{!type.enabled && '（停用）'}
      </option>)}
    </select>
    <button id="mpGenerate" type="button" disabled={locked || !draft} onClick={actions.generate}>重新生成</button>
  </>;
}

function Candidate({ item, index, editing, locked, actions }) {
  const fields = (name) => ({ 'data-field': name, value: item[name] ?? '', disabled: locked,
    onChange: event => actions.field(index, name, event.currentTarget.value) });
  const edit = () => actions.edit(index);
  return <article className="mpCandidate" data-index={index}>
    <div className="mpRow">
      <input type="checkbox" data-field="selected" aria-label={`选择第${index + 1}个事件`} checked={item.selected} disabled={locked}
        onChange={event => actions.field(index, 'selected', event.currentTarget.checked)} />
      <div className="mpCopy"><strong>{item.name || '未命名事件'}</strong><p>{item.description || '尚未填写预期结果'}</p>
        {item.duplicate && <small className="error">已有同名事件，请修改名称区分本轮行动</small>}
      </div>
      <button type="button" data-edit={index} title="编辑事件" aria-label={`编辑第${index + 1}个事件`}
        className="quiet mpIcon" aria-expanded={editing} disabled={locked} onClick={edit}>
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5-11 11-6 1 1-6L15 4Zm-2 2 5 5" /></svg>
      </button>
      <button type="button" data-remove={index} title="舍弃建议" aria-label={`舍弃第${index + 1}个事件`}
        className="quiet mpIcon" disabled={locked} onClick={() => actions.remove(index)}>
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </div>
    {editing && <div className="mpEdit">
      <label>事件名称<input maxLength={120} {...fields('name')} /></label>
      <label>预期结果<textarea rows={2} maxLength={2000} {...fields('description')} /></label>
      <div className="mpDates"><label>责任人<input maxLength={80} {...fields('owner')} /></label>
        <label>开始日期<input type="date" {...fields('planStart')} /></label>
        <label>结束日期<input type="date" {...fields('planEnd')} /></label>
      </div>
      <small>{item.reason}</small><button type="button" data-edit={index} disabled={locked} onClick={edit}>收起</button>
    </div>}
  </article>;
}

export function MatterPlanningSplit({ draft, locked, rowStatus, actions }) {
  return <>
    <div className="mpToolbar"><details><summary>补充要求</summary>
      <textarea id="mpInstructions" maxLength={2000} rows={2} aria-label="补充要求" placeholder="例如：只拆关键节点"
        disabled={locked || !draft} value={draft?.instructions ?? ''} onChange={event => actions.instructions(event.currentTarget.value)} />
    </details><button id="mpAdd" type="button" disabled={locked || !draft} onClick={actions.add}>补充事件</button></div>
    <div id="mpRows" aria-busy={Boolean(rowStatus)}>
      {rowStatus || (draft && <>
        <div className="mpCaption">建议事件 · {draft.items.length} 项</div>
        {draft.items.map((item, index) => <Candidate key={item.key} item={item} index={index}
          editing={draft.editing === index} locked={locked} actions={actions} />)}
      </>)}
    </div>
  </>;
}

export function MatterPlanningFooter({ draft, mode, locked, pending, canRetry, processing, actions }) {
  const split = mode === 'split';
  const count = draft?.items.filter(item => item.selected).length ?? 0;
  return <>
    <span id="mpCount">{split && draft ? `已选 ${count} / ${draft.items.length} 项` : ''}</span>
    <button id="mpRecover" type="button" hidden={!pending} disabled={processing} onClick={actions.recover}>核对结果</button>
    <button id="mpRetry" type="button" hidden={!canRetry} disabled={processing} onClick={actions.retry}>重试原操作</button>
    <button id="mpAccept" type="button" className="primary" hidden={!split}
      disabled={locked || !draft || draft.changed || !count} onClick={actions.accept}>确认创建</button>
  </>;
}
