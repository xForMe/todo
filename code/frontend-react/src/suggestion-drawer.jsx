import React from 'react';
import { SuggestionMemoryBasis } from './memory-candidates.jsx';

function ReviewButton({ label, actions, close = false, disabled }) {
  const show = event => actions.showTip(event.currentTarget);
  return <button type="button" className={close ? 'iconButton' : 'primary iconButton'}
    title={label} aria-label={label} data-tip={label} data-iconified="true" disabled={disabled}
    onMouseEnter={show} onFocus={show} onMouseLeave={actions.hideTip} onBlur={actions.hideTip}
    onClick={() => { (close ? actions.close : actions.confirm)(); actions.hideTip(); }}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={close ? 'M6 6l12 12M18 6 6 18' : 'm5 12 4 4L19 6'} /></svg>
  </button>;
}

function PlacementSelect({ id, label, kind, list, value, disabled, newLabel, onChange }) {
  return <>
    <label htmlFor={id}>{label}</label>
    <select id={id} value={value} disabled={disabled} onChange={event => onChange(event.currentTarget.value)}>
      <option value="">请选择{kind}</option>
      {list.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
      {newLabel && <option value="__new__">新建{kind}…</option>}
    </select>
  </>;
}

export function SuggestionDrawer({ model, actions }) {
  const { basis, recommendation, fields, goals, modules, things, editable, saveScope, error, states, busy } = model;
  const change = (field, event) => actions.input(field, event.currentTarget.value);
  return <>
    <div className="drawerHead"><h2 id="suggestionTitle">核对事件建议</h2>
      <ReviewButton label="关闭" close actions={actions} disabled={busy} />
    </div>
    <p id="suggestionBasis">{basis}</p>
    <label htmlFor="suggestionName">名称</label><input id="suggestionName" value={fields.name} onChange={event => change('name', event)} />
    <label htmlFor="suggestionOwner">责任人</label><input id="suggestionOwner" value={fields.owner} onChange={event => change('owner', event)} />
    <label htmlFor="suggestionDate">结束日期</label><input id="suggestionDate" type="date" value={fields.date} onChange={event => change('date', event)} />
    <p id="suggestionRecommendation" className="sourceHint">{recommendation}</p>
    <SuggestionMemoryBasis basis={model.memoryBasis} />
    <PlacementSelect id="suggestionGoal" label="所属目标" kind="目标" list={goals} value={fields.goal}
      disabled={!editable} onChange={actions.goal} />
    <PlacementSelect id="suggestionModule" label="所属模块" kind="模块" list={modules} value={fields.module}
      disabled={!editable || !fields.goal} newLabel={editable && !!fields.goal} onChange={actions.module} />
    <div id="suggestionNewModuleGroup" hidden={fields.module !== '__new__'}>
      <label htmlFor="suggestionNewModule">新模块名称</label><input id="suggestionNewModule" maxLength={120}
        value={fields.newModule} onChange={event => change('newModule', event)} />
    </div>
    <PlacementSelect id="suggestionThing" label="所属事情" kind="事情" list={things} value={fields.thing}
      disabled={!editable || !fields.module} newLabel={editable && !!fields.module} onChange={actions.thing} />
    <div id="suggestionNewThingGroup" hidden={fields.thing !== '__new__'}>
      <label htmlFor="suggestionNewThing">新事情名称</label><input id="suggestionNewThing" maxLength={120}
        value={fields.newThing} onChange={event => change('newThing', event)} />
    </div>
    <p id="suggestionSaveScope" className="sourceHint">{saveScope}</p>
    <label htmlFor="suggestionStatus">建议状态</label>
    <select id="suggestionStatus" value={fields.status} onChange={event => change('status', event)}>
      {Object.entries(states).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
    </select>
    <p id="suggestionError" className="error" role="alert">{error}</p>
    <div className="actions"><ReviewButton label="确认保存" actions={actions} disabled={busy} /></div>
  </>;
}
