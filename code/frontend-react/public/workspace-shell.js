/* Feature controllers register view data and actions; React owns both hosts. */
const todoWorkspaceShell = (() => {
  const navHost = $('.topbar'), barHost = $('.workspaceBar');
  const entries = new Map();
  let date = '', view = 'home', reactNav = null, reactBar = null;

  function renderBar() {
    reactBar?.({date, entries:[...entries.values()], showTip, hideTip});
  }
  function renderNav() {
    reactNav?.({view, navigate:showWorkbench, settings:todoMatterPlanning.settings});
  }
  function addEntry(model) {
    entries.set(model.id,model);
    return patch => {
      const changed=Object.keys(patch).some(key=>model[key]!==patch[key]);
      Object.assign(model,patch);
      if(changed)renderBar();
    };
  }
  return {
    mount(nav,bar){
      reactNav=nav(navHost);reactBar=bar(barHost);
      renderNav();renderBar();
    },
    setView(value){view=value;renderNav()},
    setDate(value){if(date!==value){date=value;renderBar()}},
    addEntry,
    focus(id){document.getElementById(id)?.focus({preventScroll:true})},
  };
})();
