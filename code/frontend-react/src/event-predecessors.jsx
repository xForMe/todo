import React from 'react';

function Button({ kind, label, paths, icon, children, ...props }) {
  return <button {...props} type="button" className="iconButton" data-dependency={kind}
    title={label} aria-label={label}>
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[icon]} /></svg>
    {children}
  </button>;
}

export function EventPredecessors({ model }) {
  const { active, editing, saved, candidates, selected, recommendation, error, paths, actions } = model;
  return <section className="dependencyPanel">
    <div className="dependencyHeading">
      <h3>前置事件</h3>
      <Button kind="edit" label={editing ? '收起前置设置' : '设置前置'} paths={paths} icon="link"
        hidden={!active && !saved.length} aria-expanded={editing} aria-controls="dependencyOptions"
        onClick={actions.toggle} />
    </div>
    <div data-dependency-list="">
      {saved.length ? saved.map(row => <div className="dependencyLine" key={row.id}>
        <div>
          {row.available ? <button type="button" className="dependencyName" data-dependency="open"
            value={row.id} onClick={() => actions.open(row.id)}>{row.name}</button> : <strong>{row.name}</strong>}
          <small>{row.status}</small>
        </div>
        {editing && <Button kind="remove" label={`移除：${row.name}`} paths={paths} icon="unlink"
          value={row.id} onClick={() => actions.remove(row.id)} />}
      </div>) : <p className="muted">暂无前置事件</p>}
    </div>
    <div className="dependencyOptions" id="dependencyOptions" hidden={!editing || !active}>
      <div className="dependencyAI">
        <div className="dependencyHeading"><strong>AI 推荐</strong>
          <Button kind="recommend" label="AI 识别前置" paths={paths} icon="ai"
            disabled={recommendation.loading} onClick={actions.recommend} />
        </div>
        <p className="muted" role="status" data-recommendation-status="">{recommendation.message}</p>
        <div data-recommendation-list="">
          {recommendation.rows.map(row => <div className="dependencyLine" key={row.id}>
            <div><strong>{row.name}</strong><small>{row.reason}</small></div>
            <Button kind="suggested" label={`添加推荐：${row.name}`} paths={paths} icon="add"
              value={row.id} onClick={() => actions.add(row.id)} />
          </div>)}
        </div>
      </div>
      <div className="dependencyManual">
        <label htmlFor="predecessorPicker">等待所选事件完成</label>
        <div className="dependencyHeading">
          <select id="predecessorPicker" value={selected} onChange={event => actions.select(event.currentTarget.value)}>
            <option value="">选择同一事情下的事件</option>
            {candidates.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
          </select>
          <Button kind="add" label="添加前置" paths={paths} icon="add" disabled={!selected}
            onClick={() => actions.add(selected)} />
        </div>
      </div>
    </div>
    <p className="error" role="alert" data-dependency-error="">{error}</p>
  </section>;
}
