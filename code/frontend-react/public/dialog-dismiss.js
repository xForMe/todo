// REQ-O-003 / SRC-UI-012: dismiss drawers only for a gesture on the backdrop.
(() => {
  let pressedDrawer = null;

  function backdropDrawer(event) {
    const drawer = event.target;
    if (!(drawer instanceof HTMLDialogElement) || drawer.id === 'deleteDrawer' || drawer.dataset.busy === 'true' ||
        !drawer.open || !drawer.matches(':modal')) return null;
    const rect = drawer.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX >= rect.right ||
      event.clientY < rect.top || event.clientY >= rect.bottom ? drawer : null;
  }

  document.addEventListener('pointerdown', event => {
    pressedDrawer = event.isPrimary && event.button === 0 ? backdropDrawer(event) : null;
  }, true);
  document.addEventListener('pointercancel', () => { pressedDrawer = null; }, true);
  document.addEventListener('close', () => { pressedDrawer = null; }, true);
  document.addEventListener('click', event => {
    const drawer = pressedDrawer;
    pressedDrawer = null;
    if (event.button !== 0 || !drawer || backdropDrawer(event) !== drawer) return;
    event.preventDefault();
    event.stopPropagation();
    drawer.close();
  }, true);
})();
