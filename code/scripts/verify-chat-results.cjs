// TEST-015 / TEST-025: all HTTP and WebSocket traffic intercepted; no live services.
// Set NODE_PATH=code/frontend-react/node_modules for Playwright if needed.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const react = true;
const base = 'http://todo-test.local';
const frontend = path.resolve(__dirname, '../frontend-react/public');
const bundle = '/dist/workbench-react.js';
const output = path.resolve(__dirname, '../../runtime', `chat-results-ui${react ? '-react' : ''}`);
const widths = [1440,1024,768,375];
const shellHosts = ['.topbar','.workspaceBar'];
const recoveryLabels = ['核对待确认删除','核对待确认迁移','核对记忆保存','核对拆解操作'];

const splitRecoveryOperation = 'fixture-split-operation';

function rememberShellHosts(selectors) {
  const hosts = window.__testOriginalShellHosts = [];
  const capture = () => {
    selectors.forEach((selector,index) => { hosts[index] ||= document.querySelector(selector); });
    if (selectors.every((_,index) => hosts[index])) observer.disconnect();
  };
  const observer = new MutationObserver(capture);
  observer.observe(document,{childList:true,subtree:true});
  capture();
}

async function assertShellOwnership(page) {
  if (react) await page.waitForFunction(selectors => selectors.every(selector => {
    const host = document.querySelector(selector);
    return host && Object.keys(host).some(key => key.startsWith('__reactContainer$'));
  }), shellHosts);
  const actual = await page.evaluate(selectors => selectors.map((selector,index) => {
    const host = document.querySelector(selector);
    const fiber = (node,prefix) => Object.keys(node).filter(key => key.startsWith(prefix)).map(key => node[key]);
    const nodeFiber = node => fiber(node,'__reactFiber$').find(value => value?.stateNode === node);
    const container = fiber(host,'__reactContainer$');
    const root = container.find(value => value?.stateNode?.containerInfo === host)?.stateNode;
    const rootOf = node => {
      let current = nodeFiber(node);
      while (current?.return) current = current.return;
      return current?.stateNode;
    };
    const label = node => node.id || `${node.localName}.${node.getAttribute('class') || ''}`;
    const nodes = [...host.querySelectorAll('*')];
    return {
      sameHost:host === window.__testOriginalShellHosts[index],
      containers:container.length, root:Boolean(root), hostFiber:Boolean(nodeFiber(host)),
      owned:nodes.filter(nodeFiber).map(label),
      unowned:nodes.filter(node => !node.matches('.iconTip[role="tooltip"]') && (!root || rootOf(node) !== root)).map(label),
      inline:[host,...nodes].flatMap(node => node.getAttributeNames().filter(name => /^on/i.test(name))
        .map(name => `${label(node)}.${name}`)),
    };
  }), shellHosts);
  for (const [index,selector] of shellHosts.entries()) {
    const shell = actual[index];
    assert.equal(shell.sameHost,true,`${selector} must retain its original element`);
    assert.equal(shell.hostFiber,false,`${selector} must be a host, not React-rendered content`);
    assert.equal(shell.containers,react?1:0,`${selector} React root count`);
    assert.equal(shell.root,react,`${selector} real React root`);
    if (react) {
      assert.notEqual(shell.owned.length,0,`${selector} must render React descendants`);
      assert.deepEqual(shell.unowned,[],`${selector} descendants must have DOM Fibers belonging to that root`);
      assert.deepEqual(shell.inline,[],`${selector} must not use inline event attributes`);
    } else {
      assert.deepEqual(shell.owned,[],`${selector} native descendants must not have React Fibers`);
    }
  }
}

async function assertShellLayout(page,width) {
  const layout = await page.evaluate(selectors => selectors.map(selector => {
    const host = document.querySelector(selector);
    const bounds = node => {
      const {left,top,width,height} = node.getBoundingClientRect();
      return {left,top,width,height};
    };
    return {host:bounds(host),scrollWidth:host.scrollWidth,clientWidth:host.clientWidth,
      controls:[...host.querySelectorAll('button,#workspaceDate')].filter(node => node.getClientRects().length)
        .map(node => ({name:node.getAttribute('aria-label') || node.textContent.trim(),...bounds(node)}))};
  }), shellHosts);
  for (const [index,{host,scrollWidth,clientWidth,controls}] of layout.entries()) {
    assert.ok(scrollWidth <= clientWidth,`${shellHosts[index]} overflows at ${width}px`);
    for (const rect of [host,...controls]) {
      assert.ok(rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.left+rect.width <= width+1,
        `${rect.name || shellHosts[index]} must fit at ${width}px: ${JSON.stringify(rect)}`);
    }
    for (const [i,a] of controls.entries()) for (const b of controls.slice(i+1)) {
      assert.ok(a.left+a.width <= b.left+1 || b.left+b.width <= a.left+1 ||
        a.top+a.height <= b.top+1 || b.top+b.height <= a.top+1,`${a.name} overlaps ${b.name} at ${width}px`);
    }
  }
  return layout;
}

async function assertNavigation(topbar,pageName) {
  const nav = topbar.getByRole('navigation',{name:'主导航',exact:true});
  const home = pageName === '工作台';
  for (const [name,current] of [['工作台',home],['目标与事情',!home]]) {
    const button = nav.getByRole('button',{name,exact:true});
    assert.equal(await button.getAttribute('aria-current'),current?'page':null);
    assert.equal(await button.evaluate(node => node.classList.contains('active')),current);
  }
  const page = topbar.page();
  assert.equal(await page.locator('#globalWorkbench').isVisible(),home);
  assert.equal(await page.locator('#workPage').isVisible(),!home);
}

async function assertShellEntrypoints(page) {
  const topbar = page.locator('.topbar'), workspace = page.locator('.workspaceBar');
  const nav = topbar.getByRole('navigation',{name:'主导航',exact:true});
  const work = nav.getByRole('button',{name:'目标与事情',exact:true});
  const home = nav.getByRole('button',{name:'工作台',exact:true});
  const settings = topbar.getByRole('navigation',{name:'系统导航',exact:true}).getByRole('button',{name:'设置',exact:true});
  const settingsDrawer = page.locator('#matterPlanningDrawer'), sourceDrawer = page.locator('#sourceDrawer');
  const candidate = workspace.getByRole('button',{name:'记忆候选',exact:true});
  const candidateDrawer = page.getByRole('dialog',{name:'记忆候选',exact:true});
  const read = endpoint => page.waitForResponse(r => r.url() === `${base}/api${endpoint}` && r.request().method() === 'GET' && r.ok());
  const focused = locator => locator.evaluate(node => node === document.activeElement);

  assert.equal(await topbar.locator('.brand strong').innerText(),'行间');
  assert.match(await workspace.textContent(),/个人工作空间.*目标与行动/);
  for (const name of recoveryLabels) assert.equal(await workspace.getByRole('button',{name,exact:true}).count(),0);
  await assertNavigation(topbar,'工作台');
  await work.press('Enter');
  await page.locator('#workPage').waitFor();
  await assertNavigation(topbar,'目标与事情');
  assert.equal(await focused(work),true);
  await page.locator('#workPage #goalSelect').waitFor();
  for (const width of widths) {
    await page.setViewportSize({width,height:960});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),`work page overflows at ${width}px`);
    await assertShellLayout(page,width);
    await page.screenshot({path:path.join(output,`shell-work-${width}.png`),fullPage:true});
  }
  await home.press('Space');
  await page.locator('#globalWorkbench').waitFor();
  await assertNavigation(topbar,'工作台');
  assert.equal(await focused(home),true);
  await page.setViewportSize({width:widths[0],height:960});

  await Promise.all([read('/decomposition/types'),settings.press('Enter')]);
  await settingsDrawer.getByRole('heading',{name:'设置',exact:true}).waitFor();
  assert.equal(await settingsDrawer.getByRole('tab',{name:'数据渠道',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('dialog:modal').count(),1);
  const channels = settingsDrawer.getByRole('tabpanel',{name:'数据渠道',exact:true});
  await channels.getByText('飞书聊天',{exact:true}).waitFor();
  await Promise.all([read('/sources'),channels.getByRole('button',{name:'管理',exact:true}).click()]);
  await sourceDrawer.getByRole('heading',{name:'设置 · 聊天来源',exact:true}).waitFor();
  await sourceDrawer.getByText('当前上下文尚未关联来源',{exact:true}).waitFor();
  assert.equal(await settingsDrawer.isVisible(),false);
  assert.equal(await page.locator('dialog:modal').count(),1);
  await sourceDrawer.getByRole('button',{name:'关闭',exact:true}).click();
  await sourceDrawer.waitFor({state:'hidden'});
  await page.waitForFunction(() => document.activeElement === document.querySelector('.topbar nav[aria-label="系统导航"] button'));
  assert.equal(await focused(settings),true);

  await Promise.all([read('/memory/candidates'),candidate.press('Enter')]);
  await candidateDrawer.getByText('暂无待确认记忆候选。',{exact:false}).waitFor();
  assert.equal(await page.locator('dialog:modal').count(),1);
  await page.keyboard.press('Escape');
  await candidateDrawer.waitFor({state:'hidden'});
  await page.waitForFunction(() => document.activeElement?.id === 'memoryCandidatesEntry');
  assert.equal(await focused(candidate),true);
  await assertShellOwnership(page);
}

async function assertShellRecovery(context) {
  // Seed only a new tab's sessionStorage, never a write endpoint or the main test page.
  const intents = {
    'todo.pendingDeletion':{id:'t',name:'合同签约',body:{operation_id:'fixture-delete-operation'}},
    'todo.pendingEventMove':{id:'e',body:{target_id:'t',operation_id:'fixture-move-operation'}},
    'todo.memoryWrite':{module_id:'m',operation_id:'fixture-memory-operation'},
    'todo.matterPlanningWrite':{kind:'events',target:'t',acknowledged:true,body:{operation_id:splitRecoveryOperation}},
    'todo.memoryCandidateWrite':{module_id:'m',candidate_id:'c',operation_id:'fixture-candidate-operation'},
  };
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.addInitScript(({origin,values}) => {
      if (location.origin !== origin) return;
      for (const [key,value] of Object.entries(values)) sessionStorage.setItem(key,JSON.stringify(value));
    },{origin:base,values:intents});
    await page.setViewportSize({width:1440,height:960});
    await page.goto(`${base}/`);
    await page.waitForFunction(() => document.getElementById('workspaceDate')?.textContent);
    await assertShellOwnership(page);
    await assertNavigation(page.locator('.topbar'),'工作台');
    const workspace = page.locator('.workspaceBar');
    const button = name => workspace.getByRole('button',{name,exact:true});
    const open = async (name,id,expected) => {
      const dialog = page.locator(id);
      await button(name).click();
      await dialog.getByText(expected,{exact:false}).waitFor();
      assert.equal(await dialog.evaluate(node => node.matches(':modal')),true);
      assert.equal(await page.locator('dialog:modal').count(),1);
      return dialog;
    };
    const close = async dialog => {
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'hidden'});
    };
    const recoveryButtons = [...recoveryLabels,'记忆保存待核对'];
    const geometry = [];
    for (const width of widths) {
      await page.setViewportSize({width,height:960});
      for (const name of recoveryButtons) await button(name).waitFor();
      const [,layout] = await assertShellLayout(page,width);
      const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(pageWidth <= width,`recovery entries overflow the page at ${width}px`);
      geometry.push({width,pageWidth,...layout});
      await page.screenshot({path:path.join(output,`shell-recovery-${width}.png`),fullPage:true});
    }
    await page.setViewportSize({width:widths[0],height:960});
    // Pending migration blocks the deletion recovery action rather than starting a second operation.
    await button('核对待确认删除').press('Enter');
    await page.locator('#notice').getByText('请先核对其他尚未完成的操作',{exact:true}).waitFor();
    assert.equal(await page.locator('dialog[open]').count(),0);
    await close(await open('核对待确认迁移','#moveDrawer','上次迁移结果待核对'));
    await close(await open('核对记忆保存','#memoryDrawer','年度目标 / 交付模块'));
    const split = await open('核对拆解操作','#matterPlanningDrawer','模拟未找到原操作回执');
    assert.equal(await split.locator('#mpRetry').isVisible(),false);
    await close(split);
    const candidate = await open('记忆保存待核对','#memoryCandidatesDrawer','暂无待确认记忆候选。');
    assert.equal(await candidate.getByRole('button',{name:'核对保存结果',exact:true}).isVisible(),true);
    await close(candidate);
    await page.waitForFunction(() => document.activeElement?.id === 'memoryCandidatesEntry');
    await assertShellOwnership(page);
    assert.deepEqual(await page.evaluate(keys => Object.fromEntries(keys.map(key => [key,JSON.parse(sessionStorage.getItem(key))])),Object.keys(intents)),intents);
    assert.deepEqual(errors,[]);
    return geometry;
  } finally { await page.close(); }
}

async function assertEmptyDrawer(drawer, original, mounted) {
  const actual = await drawer.evaluate((node, original) => ({
    sameHost: node === original,
    native: node instanceof HTMLDialogElement,
    open: node.open,
    modal: node.matches(':modal'),
    children: node.childNodes.length,
    reactRoot: Object.keys(node).some(key => key.startsWith('__reactContainer$') && node[key]?.stateNode?.containerInfo === node),
  }), original);
  assert.deepEqual(actual, {sameHost:true,native:true,open:false,modal:false,children:0,reactRoot:mounted},
    `${drawer}: must retain its closed, empty native host ${mounted ? 'after React mounts' : 'before the bundle loads'}`);
}

async function assertDrawerOwnership(drawer, selectors) {
  const actual = await drawer.evaluate((dialog, selectors) => {
    // A marker on the dialog or a Fiber on its React root container is not content ownership.
    const hasFiber = node => node && Object.keys(node).some(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node);
    const label = node => node.id || node.localName;
    const nodes = [...dialog.querySelectorAll('*')];
    const basis = dialog.querySelector('#suggestionMemoryBasis');
    const rootOf = node => {
      const key = node && Object.keys(node).find(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node);
      let fiber = key && node[key];
      while (fiber?.return) fiber = fiber.return;
      return fiber?.stateNode || null;
    };
    const reviewRoot = rootOf(dialog.querySelector('#suggestionRecommendation'));
    const isPublicTip = node => node.parentElement === dialog && node.matches('.iconTip[role="tooltip"]');
    return {
      modal: dialog instanceof HTMLDialogElement && dialog.open && dialog.matches(':modal'),
      ownedShell: hasFiber(dialog),
      marked: dialog.hasAttribute('data-react-owned'),
      legacySlot: Boolean(dialog.querySelector('#suggestionMemorySlot')),
      separateBasis: basis && [basis, ...basis.querySelectorAll('*')].some(node => !reviewRoot || rootOf(node) !== reviewRoot),
      missing: selectors.filter(selector => !hasFiber(dialog.querySelector(selector))),
      owned: nodes.filter(hasFiber).map(label),
      unowned: nodes.filter(node => !hasFiber(node) && !isPublicTip(node)).map(label),
      inline: [dialog, ...nodes].flatMap(node => node.getAttributeNames()
        .filter(name => /^on/i.test(name)).map(name => `${label(node)}.${name}`)),
    };
  }, selectors);
  assert.equal(actual.modal,true,'drawer must use native showModal()');
  assert.equal(actual.ownedShell,false,'React must not replace the native dialog');
  assert.equal(actual.marked,react);
  assert.equal(actual.legacySlot,false,'the legacy suggestion memory slot must not exist');
  if (!react) {
    assert.deepEqual(actual.owned,[],'native mode must not mount React content');
    return;
  }
  assert.deepEqual(actual.missing,[],'visible content and required controls must have real DOM Fibers');
  assert.deepEqual(actual.unowned,[],'only the public iconTip may lack a Fiber');
  assert.ok(!actual.separateBasis,'memory citations must belong to the same React root as the review form');
  assert.deepEqual(actual.inline,[],'React dialogs must not use inline event attributes');
}

(async () => {
  if (react) fs.accessSync(path.join(frontend,bundle.slice(1)),fs.constants.R_OK);
  fs.mkdirSync(output, {recursive:true});
  const browser = await chromium.launch({channel:'chrome',headless:true,
    args:['--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});
  let releaseBundle;
  const bundleGate = new Promise(resolve => { releaseBundle = resolve; });
  try {
    const context = await browser.newContext({serviceWorkers:'block'});
    await context.addInitScript(rememberShellHosts,shellHosts);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const blockedRequests = [];
    let bundleRequests = 0;
    await context.routeWebSocket('**/*', socket => {
      blockedRequests.push(`Unexpected WebSocket: ${socket.url()}`);
      return socket.close();
    });
    const items = [['g','goal',null,'年度目标'],['m','module','g','交付模块'],['t','thing','m','合同签约']].map(([id,type,parent,name])=>({id,type,parent,name,description:'',owner:'',planStart:'',planEnd:'',status:'notStarted',version:1}));
    const proposal = {name:'培训宣传册制定',owner:'',plan_end:'',status:'notStarted',evidence:'请准备培训宣传册',thing_id:'t'};
    let suggestions = [{id:'s',source_id:'src',source_kind:'chat',thing_id:'t',state:'pending',action:'new',body:JSON.stringify(proposal)}];
    let failure = false, unmatched = [], sources = [], sourceReads = 0;
    const writes = [];
    let splitRecoveryReads = 0;
    const priorities = {week:'2026-11-09',items:[]};
    const workbench = {items,priorities,attention:[],branches:[],links:[],dependencies:[],today:'2026-11-15'};
    const reference = {path:'年度目标 / 交付模块',revision:1,status:'有效引用',description:'整理培训交付资料',aliases:['培训简称']};
    let basisValid = true;
    const memoryBasis = () => ({note:'仅展示测试夹具中的可核对引用。',items:[{
      ...reference,valid:basisValid,status:basisValid ? reference.status : '引用版本或授权已失效，正文不再展示',
    }]});
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), method = req.method();
      const abort = () => {
        blockedRequests.push(`Unexpected HTTP request: ${method} ${req.url()}`);
        return route.abort();
      };
      if (url.origin !== base) return abort();
      if (url.pathname.startsWith('/api/')) {
        const endpoint = url.pathname.slice(4);
        if (method === 'POST' && ['/sources/manual-message','/sources/discard-message','/sources/suggestions/s','/sources/suggestions/manual'].includes(endpoint)) {
          const body = req.postDataJSON();
          writes.push({endpoint,body});
          if (endpoint === '/sources/manual-message') {
            suggestions=[{id:'manual',source_kind:'chat',source_id:'src',thing_id:'',state:'pending',action:'new',body:JSON.stringify({...proposal,name:'手动原文',thing_id:''})}];
            unmatched=[];
            return route.fulfill({json:{suggestion_id:'manual'}});
          }
          if (endpoint === '/sources/discard-message') {
            unmatched=[];
            return route.fulfill({json:{status:'已废弃，本地原文已删除，此消息不会再次识别'}});
          }
          const event={id:endpoint.endsWith('/s')?'e':'manual-event',type:'event',parent:body.edited.thing_id,name:body.edited.name,description:'',owner:body.edited.owner,planStart:'',planEnd:body.edited.plan_end,status:body.edited.status,version:1};
          items.push(event); suggestions=[];
          return route.fulfill({json:{saved:event}});
        }
        if (method !== 'GET') return abort();
        if (endpoint === '/sources') sourceReads++;
        if (endpoint === `/event-operations/${splitRecoveryOperation}`) {
          splitRecoveryReads++;
          return route.fulfill({status:404,json:{detail:'模拟未找到原操作回执'}});
        }
        if (endpoint === '/sources/suggestions' && failure) return route.fulfill({status:503,json:{detail:'模拟读取失败'}});
        const data={'/session':{},'/items':items,'/sources/suggestions':suggestions,'/sources':sources,
          '/sources/unmatched':unmatched,'/priorities':priorities,'/workbench':workbench,'/plan-history-counts':{},'/sources/follow':[],
          '/decomposition/types':[], '/memory/candidates':{items:[]}, '/memory/modules/m':{
            card:{module_id:'m',version:1,path:reference.path,status:reference.status,description:reference.description,aliases:reference.aliases},
            embedding_configured:false,
          },
          '/events/e/structure':{...workbench,events:items.filter(item=>item.type==='event')},
          '/memory/suggestions/s/basis':memoryBasis(),'/memory/suggestions/manual/basis':memoryBasis()};
        return Object.hasOwn(data,endpoint) ? route.fulfill({json:data[endpoint]}) : abort();
      }
      if (method !== 'GET') return abort();
      if (url.pathname === '/favicon.ico') return route.fulfill({status:204});
      let filename;
      if (url.pathname === bundle) {
        if (!react) return abort();
        bundleRequests++;
        await bundleGate;
        filename = bundle.slice(1);
      } else if (url.pathname === '/') filename = 'index.html';
      else if (/^\/[\w-]+\.(js|css)$/.test(url.pathname)) filename = url.pathname.slice(1);
      else return abort();
      const file = path.join(frontend,filename);
      if (!fs.existsSync(file)) return abort();
      return route.fulfill({body:fs.readFileSync(file),contentType:filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html'});
    });
    await Promise.all([
      page.waitForRequest(`${base}${bundle}`),
      page.goto(`${base}/`,{waitUntil:'domcontentloaded'}),
    ]);
    const entry = page.locator('#eventRecognitionTrigger');
    const drawer = page.locator('#eventRecognitionDrawer');
    const review = page.locator('#suggestionDrawer');
    await page.locator('body[data-ui-startup]').waitFor({state:'attached'});
    const originalDrawer = await drawer.elementHandle();
    const originalReview = await review.elementHandle();
    await assertEmptyDrawer(drawer,originalDrawer,false);
    await assertEmptyDrawer(review,originalReview,false);
    releaseBundle();
    await page.locator('body:not([data-ui-startup])').waitFor({state:'attached'});
    await assertEmptyDrawer(drawer,originalDrawer,true);
    await assertEmptyDrawer(review,originalReview,true);
    const save = review.getByRole('button',{name:'确认保存',exact:true});
    const settle = () => page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
    const settleAtTop = async dialog => {
      await settle();
      await dialog.evaluate(async node => {
        node.scrollTop = 0;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      assert.equal(await dialog.evaluate(node => node.scrollTop),0);
    };
    const recognitionSelectors = ['#eventRecognitionTitle','.drawerHead button[aria-label="刷新结果"]','#chatResults .wbTabs',
      '#chatResults .chatResult','#chatResults summary','#chatResults .chatActions button.primary'];
    const reviewSelectors = ['.drawerHead h2','#suggestionBasis','#suggestionRecommendation','#suggestionName','#suggestionOwner',
      '#suggestionDate','#suggestionStatus','#suggestionGoal','#suggestionModule','#suggestionThing','#suggestionNewModule',
      '#suggestionNewThing','#suggestionSaveScope','#suggestionError','#suggestionMemoryBasis','#suggestionMemoryBasis details summary','button.primary'];
    await page.waitForFunction(today => aiLoaded && document.getElementById('eventRecognitionStatus')?.textContent === '1 待确认' &&
      document.getElementById('workspaceDate')?.textContent === today,workbench.today);
    assert.equal(bundleRequests,react?1:0);
    await assertShellOwnership(page);
    await assertShellEntrypoints(page);
    assert.equal(writes.length,0,'navigation, settings and candidate opening must not write');
    assert.equal(await drawer.isVisible(), false);
    assert.equal(await page.locator('#globalWorkbench #chatResults').count(),0);
    assert.equal(await entry.count(),1);
    assert.equal(await page.locator('.workspaceBar #eventRecognitionTrigger').count(),1);
    assert.equal(await entry.textContent(),'事件识别1 待确认');
    assert.equal(await entry.getAttribute('aria-label'),'事件识别，1 待确认');
    assert.equal(await entry.getAttribute('aria-haspopup'),'dialog');
    assert.equal(await entry.getAttribute('aria-controls'),'eventRecognitionDrawer');
    assert.equal(await entry.getAttribute('aria-expanded'),'false');
    await assertEmptyDrawer(drawer,originalDrawer,true);
    await entry.focus(); await page.keyboard.press('Enter');
    await drawer.waitFor(); await settle();
    assert.equal(await drawer.evaluate((node,original) => node === original,originalDrawer),true,
      'first opening recognition must reuse its native host');
    await originalDrawer.dispose();
    assert.equal(await entry.getAttribute('aria-expanded'),'true');
    assert.equal(await page.locator('dialog[open]').count(),1);
    assert.match(await page.locator('#chatResults').innerText(),/年度目标.*交付模块.*合同签约/);
    await assertDrawerOwnership(drawer,recognitionSelectors);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('eventRecognitionDrawer').open &&
      document.getElementById('eventRecognitionTrigger')?.getAttribute('aria-expanded') === 'false');
    assert.equal(await entry.evaluate(e => e === document.activeElement),true);
    assert.equal(await entry.getAttribute('aria-expanded'),'false');
    for(const width of widths) {
      await page.setViewportSize({width,height:960});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await assertShellLayout(page,width);
      const edge = await entry.boundingBox();
      assert.ok(edge.x >= 0 && edge.x + edge.width <= width);
      assert.ok(edge.width <= 120);
      await page.screenshot({path:path.join(output,`entry-${width}.png`),fullPage:true});
      await entry.click(); await settleAtTop(drawer);
      const bounds = await drawer.boundingBox();
      assert.ok(Math.abs(bounds.x + bounds.width - width) <= 1);
      assert.ok(bounds.width <= width);
      assert.ok(await drawer.evaluate(e => e.scrollWidth <= e.clientWidth));
      await page.screenshot({path:path.join(output,`drawer-${width}.png`),fullPage:true});
      await drawer.getByRole('button',{name:'关闭',exact:true}).click();
      await page.waitForFunction(() => !document.getElementById('eventRecognitionDrawer').open &&
      document.getElementById('eventRecognitionTrigger')?.getAttribute('aria-expanded') === 'false');
    }
    await page.emulateMedia({reducedMotion:'reduce'});
    await entry.click();
    assert.equal(await drawer.evaluate(e=>getComputedStyle(e).animationName),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await settle();
    await assertEmptyDrawer(review,originalReview,true);
    await page.getByRole('button',{name:'核对建议',exact:true}).click();
    await review.waitFor();
    assert.equal(await review.evaluate((node,original) => node === original,originalReview),true,
      'first opening review must reuse its native host');
    await originalReview.dispose();
    assert.equal(await drawer.isVisible(),false);
    assert.equal(await page.locator('dialog[open]').count(),1);
    const basis = review.locator('#suggestionMemoryBasis');
    await basis.getByText('年度目标 / 交付模块 · 第1版',{exact:true}).waitFor();
    assert.ok((await basis.textContent()).includes(reference.description));
    assert.ok((await basis.textContent()).includes(reference.aliases[0]));
    if (react) {
      await settle();
      await save.evaluate(node => node.focus({preventScroll:true}));
      await review.locator(':scope > .iconTip[role="tooltip"]').waitFor();
    }
    await assertDrawerOwnership(review,reviewSelectors);
    await page.keyboard.press('Escape');
    await review.waitFor({state:'hidden'});
    await drawer.waitFor(); await settle();
    assert.equal(await drawer.evaluate(node => node.matches(':modal')),true,'review close must restore the native recognition modal');
    assert.equal(await page.locator('dialog[open]').count(),1);
    // A workbench refresh must not destroy the open recognition drawer or its evidence.
    await page.locator('#chatResults summary').click();
    await page.evaluate(()=>loadWorkbench());
    assert.equal(await drawer.isVisible(),true);
    assert.equal(await page.locator('#chatResults details').getAttribute('open'),'');
    assert.equal(await page.locator('#chatResults').count(),1);
    basisValid = false;
    await page.getByRole('button',{name:'核对建议',exact:true}).click();
    await basis.getByText('已失效引用 · 第1版',{exact:true}).waitFor();
    // Even if a stale server row still carries old content, it must not reach the DOM.
    const redacted = await basis.textContent();
    assert.match(redacted,/引用版本或授权已失效/);
    for (const value of [reference.path,reference.description,...reference.aliases]) assert.ok(!redacted.includes(value));
    await assertDrawerOwnership(review,reviewSelectors);
    assert.equal(await page.locator('#suggestionName').inputValue(),proposal.name);
    assert.equal(await page.locator('#suggestionThing').inputValue(),'t');
    for (const width of widths) {
      await page.setViewportSize({width,height:960});
      await settleAtTop(review);
      const bounds = await review.boundingBox();
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1);
      assert.ok(await review.evaluate(e => e.scrollWidth <= e.clientWidth));
      await page.screenshot({path:path.join(output,`review-${width}.png`)});
    }
    await page.screenshot({path:path.join(output,'review-mobile.png')});
    // Source polling may replace the suggestion snapshot, but not the in-progress review form.
    const edited = {name:'培训宣传册定稿',owner:'陈一',plan_end:'2026-11-22',status:'working',thing_id:'t'};
    const name = review.locator('#suggestionName');
    await name.fill(edited.name);
    await review.locator('#suggestionOwner').fill(edited.owner);
    await review.locator('#suggestionDate').fill(edited.plan_end);
    await review.locator('#suggestionStatus').selectOption(edited.status);
    await name.focus();
    sources = [{id:'src',kind:'chat',version:2}];
    suggestions=[{...suggestions[0],body:JSON.stringify({...proposal,name:'已刷新来源中的候选'})}];
    const readsBeforeRefresh = sourceReads;
    await page.evaluate(()=>refreshSuggestions());
    assert.ok(sourceReads > readsBeforeRefresh);
    assert.match(await drawer.locator('#chatResults').textContent(),/已刷新来源中的候选/);
    assert.equal(await review.isVisible(),true);
    assert.equal(await name.evaluate(e=>e===document.activeElement),true);
    assert.equal(await name.inputValue(),edited.name);
    assert.equal(await review.locator('#suggestionOwner').inputValue(),edited.owner);
    assert.equal(await review.locator('#suggestionDate').inputValue(),edited.plan_end);
    assert.equal(await review.locator('#suggestionStatus').inputValue(),edited.status);
    assert.equal(await review.locator('#suggestionThing').inputValue(),edited.thing_id);
    assert.equal(writes.length,0);
    await save.click();
    await page.waitForFunction(()=>!document.querySelector('#suggestionDrawer').open);
    await drawer.waitFor(); await settle();
    await page.waitForFunction(()=>!suggestionBusy && wbSnapshot.items.some(x=>x.id==='e'));
    assert.equal(writes.length,1);
    assert.deepEqual(writes[0],{endpoint:'/sources/suggestions/s',body:{accept:true,edited:{...proposal,...edited},
      placement:{goal_id:'g',module_id:'m',new_module_name:'',new_thing_name:''}}});
    assert.equal(await entry.textContent(),'事件识别暂无待确认');
    assert.match(await page.locator('#chatResults').innerText(),/暂无待确认/);
    assert.equal(await page.evaluate(()=>wbSnapshot.items.find(x=>x.id==='e')?.name),edited.name);
    suggestions=[{id:'s2',source_kind:'chat',thing_id:'t',state:'pending',action:'new',body:JSON.stringify(proposal)}];
    await page.evaluate(()=>refreshSuggestions());
    await page.getByRole('button',{name:'定位事情',exact:true}).click();
    await page.waitForFunction(()=>wbView==='work');
    assert.equal(await page.evaluate(()=>selection.thing),'t');
    assert.equal(await drawer.isVisible(),false);
    assert.equal(await entry.isVisible(),true);
    await entry.click(); await settle();
    assert.equal(await drawer.isVisible(),true);
    await drawer.getByRole('button',{name:'关闭',exact:true}).click();
    await page.evaluate(()=>showWorkbench('home'));
    suggestions=[...Array(12)].map((_,i)=>({id:'u'+i,source_kind:'chat',thing_id:'',state:'pending',action:'new',body:JSON.stringify({...proposal,name:'长标题'.repeat(40)})}));
    await page.evaluate(()=>refreshSuggestions());
    assert.equal(await entry.textContent(),'事件识别12 待确认');
    await entry.click(); await settle();
    assert.equal(await page.locator('#chatResults .chatResult').count(),10);
    assert.equal(await page.locator('#chatResults').getByRole('button',{name:'定位事情'}).count(),0);
    await page.locator('#chatResults').getByRole('button',{name:'下一页'}).click();
    assert.equal(await page.locator('#chatResults .chatResult').count(),2);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.ok(await drawer.evaluate(e => e.scrollWidth <= e.clientWidth));
    await page.screenshot({path:path.join(output,'long-mobile.png'),fullPage:true});
    const button=page.locator('#chatResults').getByRole('button',{name:'核对建议'}).first();
    await button.focus(); await page.evaluate(()=>refreshSuggestions());
    assert.equal(await button.evaluate(e=>e===document.activeElement),true);
    failure=true; await page.evaluate(()=>refreshSuggestions());
    assert.match(await page.locator('#chatResults').innerText(),/读取失败/);
    assert.equal(await entry.textContent(),'事件识别读取失败');
    assert.equal(await page.locator('#chatResults .chatResult').count(),0);
    failure=false; suggestions=[]; await page.evaluate(()=>refreshSuggestions());
    assert.match(await page.locator('#chatResults').innerText(),/暂无待确认/);
    await page.screenshot({path:path.join(output,'empty-mobile.png'),fullPage:true});
    suggestions=[{id:'linked',source_kind:'chat',thing_id:'t',state:'linked',body:JSON.stringify(proposal)}];
    await page.evaluate(()=>refreshSuggestions());
    await page.getByRole('button',{name:'已关联进展 1'}).click();
    assert.equal(await page.locator('#chatResults .chatResult').count(),1);
    assert.equal(await page.locator('#chatResults').getByRole('button',{name:'核对建议'}).count(),0);
    unmatched = [{source_id:'src',message_id:'missing',version:1,content:'下周四去青岛进行售电结项汇报',processed:true,can_retry:true}];
    await page.evaluate(()=>refreshSuggestions());
    await page.getByRole('button',{name:'未找到建议 1'}).click();
    assert.match(await page.locator('#chatResults').innerText(),/青岛/);
    assert.equal(await page.locator('#chatResults .wbTabs').getByRole('button',{name:'未找到建议 1'}).getAttribute('class'),'active');
    await page.setViewportSize({width:1440,height:960});
    assert.equal(await drawer.locator('.recognitionScope').count(),0);
    assert.equal(await drawer.locator('.drawerHead').getByRole('button',{name:'刷新结果',exact:true}).count(),1);
    for (const width of [1440,1024,887,768,375]) {
      await page.setViewportSize({width,height:960});
      const title=await page.locator('.chatResultHead strong').boundingBox();
      const icons=await page.locator('.chatResultHead .chatActions').boundingBox();
      assert.ok(title.x+title.width<=icons.x);
      assert.ok(await drawer.evaluate(e=>e.scrollWidth<=e.clientWidth));
      await page.screenshot({path:path.join(output,`icons-${width}.png`)});
    }
    const retryIcon=page.getByRole('button',{name:'重新识别此条',exact:true});
    assert.equal(await retryIcon.locator('svg').count(),1);
    await page.keyboard.press('Tab'); await retryIcon.focus();
    assert.equal(await retryIcon.getByRole('tooltip').isVisible(),true);
    await page.setViewportSize({width:1440,height:960});
    await page.screenshot({path:path.join(output,'unmatched-desktop.png')});
    await page.setViewportSize({width:375,height:960});
    page.once('dialog', dialog=>dialog.dismiss());
    await page.getByRole('button',{name:'重新识别此条'}).click();
    assert.equal(writes.length,1);
    await page.screenshot({path:path.join(output,'unmatched-mobile.png')});
    page.once('dialog', dialog=>dialog.dismiss());
    await page.getByRole('button',{name:'废弃',exact:true}).click();
    assert.equal(writes.length,1);
    page.once('dialog', dialog=>dialog.accept());
    await page.getByRole('button',{name:'废弃',exact:true}).click();
    await page.waitForFunction(()=>!retryBusy && unmatchedMessages.length===0);
    assert.equal(writes.length,2);
    assert.equal(writes[1].endpoint,'/sources/discard-message');
    assert.equal(writes[1].body.message_id,'missing');
    assert.match(await page.locator('#chatResults').innerText(),/没有未匹配消息/);
    unmatched=[{source_id:'src',message_id:'manual',version:2,content:'继续推进项目数据收集，协调相关责任人，确认后续交付资料',processed:true,can_retry:false,retry_block_reason:'模型输出不符合约定，来源已暂停'}];
    await page.evaluate(()=>refreshSuggestions());
    await page.getByRole('button',{name:'未找到建议 1'}).click();
    assert.equal(await page.getByRole('button',{name:'重新识别此条',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'手动整理',exact:true}).isEnabled(),true);
    for (const width of [1440,1024,887,768,375]) {
      await page.setViewportSize({width,height:960});
      assert.ok(await drawer.evaluate(e=>e.scrollWidth<=e.clientWidth));
      await page.screenshot({path:path.join(output,`manual-${width}.png`)});
    }
    await page.getByRole('button',{name:'手动整理',exact:true}).click();
    await review.waitFor();
    assert.equal(await review.locator('#suggestionName').inputValue(),'手动原文');
    await review.locator('#suggestionGoal').selectOption('g');
    await review.locator('#suggestionModule').selectOption('m');
    await review.locator('#suggestionThing').selectOption('t');
    await review.locator('#suggestionName').fill('手动核对后的行动');
    await save.click();
    await drawer.waitFor();
    await page.waitForFunction(()=>!suggestionBusy && !retryBusy);
    assert.equal(writes.length,4);
    assert.deepEqual(writes[2],{endpoint:'/sources/manual-message',body:{source_id:'src',message_id:'manual',expected_version:2}});
    assert.equal(writes[3].endpoint,'/sources/suggestions/manual');
    assert.equal(writes[3].body.edited.name,'手动核对后的行动');
    assert.equal(writes[3].body.edited.thing_id,'t');
    await drawer.getByRole('button',{name:'关闭',exact:true}).click();
    await page.waitForFunction(() => document.activeElement?.id === 'eventRecognitionTrigger' && document.activeElement.getAttribute('aria-expanded') === 'false');
    assert.equal(await entry.getAttribute('aria-expanded'),'false');
    const recoveryGeometry = await assertShellRecovery(context);
    assert.equal(bundleRequests,react?2:0);
    assert.equal(splitRecoveryReads,1,'the split recovery entry must only read its original receipt');
    assert.equal(writes.length,4,'synthetic recovery must not add any mocked writes');
    assert.deepEqual(blockedRequests,[]);
    assert.deepEqual(errors,[]);
    const checks = ['edge entry with badge','closed by default','original native recognition and review hosts stay empty until first use, including after React mounts',
      'right drawer','keyboard open and Escape focus return','reduced motion',
      'review and return with one native modal','path','mock confirmation and snapshot refresh','locate and drawer close',
      'entry available on work page','unassigned','pagination','long text','keyboard focus','drawer persists through snapshot refresh',
      'draft and focus persist through source refresh','failure recovery','empty','linked','unmatched and tooltips',
      'retry and discard cancellation','mock discard and manual review','recognition and review screenshots',
      'valid memory citation and invalid citation redaction, with no legacy slot',
      'original shell hosts and keyboard navigation with active state',
      'settings to Feishu chat source and close focus return; read-only memory candidate entry',
      'workbench and work-page shell screenshots and bounds at four widths',
      'synthetic sessionStorage recovery entries at four widths, deletion guard, retained operation IDs and no repeat writes'];
    if (react) checks.push('React Fiber ownership including memory citations in the parent review root and all shell descendants in their original roots, with no inline handlers');
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({mode:react?'react':'native',passed:true,widths,checks,bundleRequests,
      recoveryGeometry,splitRecoveryReads,mockedWrites:writes.length,realWrites:0,realModelCalls:0,blockedRequests,errors},null,2));
    console.log(`Chat results browser checks passed (${react?'react':'native'})`);
  } finally { releaseBundle(); await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
