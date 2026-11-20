const actionIconPaths={move:'M4 5h8M4 5v14h8M10 12h11m-5-5 5 5-5 5',trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',edit:'m16 3 5 5-12 12-6 1 1-6L16 3Zm-3 3 5 5',pause:'M8 4v16M16 4v16',play:'m6 3 15 9-15 9V3',add:'M12 5v14M5 12h14',split:'M12 3v6M5 17v-4h14v4M12 9v4M2 17h6v4H2zM16 17h6v4h-6z',detail:'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5',document:'M5 3h9l5 5v13H5zM14 3v5h5M8 12h8M8 16h8',close:'M6 6l12 12M18 6 6 18',check:'m5 12 4 4L19 6',link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',unlink:'M3 3l18 18M9 15l-3 3M15 9l3-3M3 14l-1 1a5 5 0 0 0 7 7l1-1M14 3l1-1a5 5 0 0 1 7 7l-1 1',reset:'M3 11a9 9 0 1 1 2 7M3 4v7h7',ai:'m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3z',follow:'M4 5v9h14m-5-5 5 5-5 5'};
let iconHint = null, iconHintReact = null;
function enableReactIconHint(mount) {
 hideTip();
 const host = document.createElement('div');
 host.id = 'iconHintLayer';
 document.body.append(host);
 iconHintReact = mount(host);
}
function positionIconHint(hint, anchor) {
 const r = anchor.getBoundingClientRect();
 const left = Math.max(8, Math.min(innerWidth - hint.offsetWidth - 8, r.left));
 const top = r.bottom + hint.offsetHeight + 12 < innerHeight ? r.bottom + 6 : r.top - hint.offsetHeight - 6;
 hint.style.left = left + 'px';
 hint.style.top = Math.max(8, top) + 'px';
}
function hideTip() {
 if (!iconHint) return;
 iconHint = null;
 iconHintReact(null);
}
function showTip(anchor) {
 const label = anchor.dataset.tip;
 if (!iconHintReact || !label || !anchor.isConnected) return;
 const target = anchor.closest('dialog') || document.querySelector('dialog[open]') || document.body;
 if (target instanceof HTMLDialogElement && !target.open) return;
 if (iconHint?.anchor === anchor && iconHint.label === label && iconHint.target === target) return;
 if (iconHint) hideTip();
 iconHint = { anchor, label, target, position: positionIconHint };
 iconHintReact(iconHint);
}
new MutationObserver(()=>{
 if(iconHint && (!iconHint.anchor.isConnected || iconHint.anchor.closest('[hidden]'))) hideTip();
}).observe(document.body,{childList:true,subtree:true});
document.addEventListener('keydown',e=>{if(e.key==='Escape')hideTip()});
document.addEventListener('scroll',hideTip,true);
document.addEventListener('close',event=>{if(iconHint?.target===event.target && !event.target.open)hideTip()},true);
window.addEventListener('resize',hideTip);
