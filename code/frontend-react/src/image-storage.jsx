import React from 'react';

function ConfigButton({ id, title, save = false, disabled, onClick }) {
  return <button type="button" id={id} className={`imageIcon${save ? ' primary' : ''}`}
    title={title} aria-label={title} disabled={disabled} onClick={onClick}>
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={save
      ? 'M19 21H5V3h12l4 4v14ZM7 3v5h9M7 21v-8h10v8'
      : 'M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-6 6v4'} /></svg>
  </button>;
}

export function ImageStorage({ model, actions }) {
  const { saveDisabled, checkDisabled, disabled, pending, retry, credentials, connection, error, session, region, bucket, placeholder } = model;
  return <>
    <div className="imageSettingsHead"><h3>腾讯云 COS</h3><div className="imageTools">
      <ConfigButton id="imageConfigCheck" title="检查连接" disabled={checkDisabled} onClick={actions.check} />
      <ConfigButton id="imageConfigSave" title="保存配置" save disabled={saveDisabled} onClick={actions.save} />
    </div></div>
    <form id="imageConfigForm" autoComplete="off" onInput={actions.dirty}
      onSubmit={event => { event.preventDefault(); actions.save(); }}>
      <div className="imageConfigFields" key={session}>
        <label>地域<input id="imageRegion" defaultValue={region} maxLength={50} required spellCheck={false} disabled={disabled} /></label>
        <label>存储桶<input id="imageBucket" defaultValue={bucket} maxLength={100} required spellCheck={false} disabled={disabled} /></label>
        <label>SecretId<input id="imageSecretId" type="password" autoComplete="new-password"
          maxLength={256} placeholder={placeholder} disabled={disabled} /></label>
        <label>SecretKey<input id="imageSecretKey" type="password" autoComplete="new-password"
          maxLength={256} placeholder={placeholder} disabled={disabled} /></label>
      </div>
      <p className="imageHelp">已有密钥留空保留，替换时填写一组新密钥。</p>
      <div className="imageConfigStatus"><p><span>密钥状态</span><span id="imageCredentialStatus">{credentials}</span></p>
        <p><span>连接状态</span><span id="imageConnectionStatus">{connection}</span></p></div>
      <p id="imageConfigError" className="imageError" role="status">{error}</p>
      <button id="imageConfigRecover" type="button" hidden={!pending} onClick={actions.recover}>核对保存结果</button>
      <button id="imageConfigRetry" type="button" hidden={!retry} onClick={actions.retry}>使用原操作重试保存</button>
    </form>
  </>;
}
