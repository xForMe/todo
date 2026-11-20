import React from 'react';
import { createPortal } from 'react-dom';

export function SettingsTabs({ tabs, active, onSelect, chrome, model, actions }) {
  function keydown(event, index) {
    const key = event.key;
    const offset = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
    if (!offset && key !== 'Home' && key !== 'End') return;
    event.preventDefault();
    const next = key === 'Home' ? 0 : key === 'End' ? tabs.length - 1 : (index + offset + tabs.length) % tabs.length;
    onSelect(tabs[next].id, true);
  }
  return <>
    {tabs.map(({ id, panel, label }, index) => <button key={id} id={id} type="button" role="tab"
      aria-controls={panel} aria-selected={id === active} tabIndex={id === active ? 0 : -1}
      onClick={() => onSelect(id)} onKeyDown={event => keydown(event, index)}>{label}</button>)}
    {createPortal(<h2 id="mpTitle">{model.title}</h2>, chrome.title)}
    {createPortal(<button type="button" id="mpClose" aria-label="关闭" onClick={actions.close}>关闭</button>, chrome.close)}
    {createPortal(<p id="mpContext" hidden={model.settings}>{model.context}</p>, chrome.context)}
    {createPortal(<div id="mpError" role="alert" hidden={!model.error}>{model.error}</div>, chrome.feedback)}
  </>;
}

export function SettingsChannels({ openSources }) {
  return <div className="mpChannel">
    <div><strong>飞书聊天</strong><p>管理聊天来源与读取授权</p></div>
    <button type="button" id="mpSource" onClick={openSources}>管理</button>
  </div>;
}
