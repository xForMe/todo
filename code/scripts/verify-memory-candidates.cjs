// TEST-016 / TEST-025: local frontend assets and synthetic fixtures; HTTP and WebSockets never reach a service.
// Set NODE_PATH=code/frontend-react/node_modules for Playwright if needed.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const react = true;
const mode = react ? 'react' : 'native';
const origin = 'https://todo-test.local';
const frontend = path.resolve(__dirname, '../frontend-react/public');
const bundle = '/dist/workbench-react.js';
const output = path.resolve(__dirname, '../../runtime', `memory-candidates-ui${react ? '-react' : ''}`);
const widths = [1440, 1024, 768, 375];
const candidatesPath = '/api/memory/candidates';
const modulePath = '/api/memory/modules/m';
const operationsPath = '/api/memory/operations/';
const successMessage = '模块记忆已更新；向量索引需另行生成';
const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

async function assertDrawer(drawer, original) {
  const actual = await drawer.evaluate((dialog, original) => {
    const nodes = [...dialog.querySelectorAll('*')];
    const hasFiber = node => Object.getOwnPropertyNames(node)
      .some(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node);
    const label = node => node.id || node.localName;
    return {
      original: dialog === original,
      modal: dialog instanceof HTMLDialogElement && dialog.open && dialog.matches(':modal'),
      marked: dialog.hasAttribute('data-react-owned'),
      shellFiber: hasFiber(dialog),
      labelled: dialog.getAttribute('aria-labelledby') === 'memoryCandidatesTitle',
      missing: ['#memoryCandidatesTitle', '#memoryCandidatesClose', '#memoryCandidatesStatus[role="status"]',
        '#memoryCandidatesList', '#memoryCandidatesError[role="alert"]', '#memoryCandidatesRefresh', '#memoryCandidatesRecover']
        .filter(selector => !dialog.querySelector(selector)),
      owned: nodes.filter(hasFiber).map(label),
      unowned: nodes.filter(node => !hasFiber(node)).map(label),
      inline: [dialog, ...nodes].flatMap(node => node.getAttributeNames().filter(name => /^on/i.test(name))
        .map(name => `${label(node)}.${name}`)),
    };
  }, original);
  const {owned, unowned, ...shell} = actual;
  assert.deepEqual(shell, {original:true, modal:true, marked:react, shellFiber:false, labelled:true, missing:[], inline:[]});
  assert.deepEqual(react ? unowned : owned, [], 'every candidate node must match the expected renderer');
  assert.equal(await drawer.page().locator('dialog:modal').count(), 1);
  assert.equal(await drawer.page().locator('dialog[open]').count(), 1);
}

(async () => {
  const bundleBody = react ? fs.readFileSync(path.join(frontend, bundle.slice(1))) : null;
  fs.mkdirSync(output, {recursive:true});
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    const context = await browser.newContext({serviceWorkers:'block'});
    const errors = [], blockedRequests = [], calls = [], writes = [], rejects = [], receipts = new Map();
    let bundleRequests = 0, releaseBundle, holdList = null;
    const bundleReady = new Promise(resolve => { releaseBundle = resolve; });
    const items = [['g','goal',null,'年度目标'], ['m','module','g','客户交付'], ['t','thing','m','上线准备']]
      .map(([id,type,parent,name]) => ({id,type,parent,name,description:'',owner:'',planStart:'',planEnd:'',status:'notStarted',version:1}));
    const card = {module_id:'m',path:'年度目标 / 客户交付',scope_version:'a'.repeat(64),version:1,
      description:'负责客户实施和验收',aliases:[],enabled:true,usable:true,status:'已确认'};
    const candidate = id => ({id,module_id:'m',path:card.path,source_id:'s',usable:true,status:'待核对',current:{...card},
      description:card.description,aliases:['华东一期'],draft:{module_id:'m',kind:'alias',description:'',aliases:['华东一期'],
        reason:'原文明确说明稳定简称',evidence:'客户交付模块简称华东一期。<img src=x onerror=alert(1)> ' + 'LongUnbrokenText'.repeat(7)}});
    let list = [candidate('c1'), {...candidate('c2'),usable:false,draft:null,current:null,status:'来源已变化，原文不再展示',description:'',aliases:[]}];
    let writeMode = 'normal', readFailure = false, basisValid = true, capacityFull = true;
    const suggestion = {id:'sg',source_id:'s',source_kind:'chat',thing_id:'t',event_id:null,action:'new',state:'pending',
      body:JSON.stringify({name:'合成新行动',evidence:'明天核对接口',owner:'',plan_end:'',status:'notStarted',module_id:'m',goal_id:'g',placement_reason:'模块职责匹配'})};
    const priorities = {week:'2026-11-16',items:[]};
    const reads = {'/api/session':{},'/api/items':items,'/api/sources/suggestions':[suggestion],'/api/sources':[{id:'s',kind:'chat'}],
      '/api/sources/unmatched':[],'/api/sources/follow':[],'/api/priorities':priorities,'/api/plan-history-counts':{},
      '/api/workbench':{items,priorities,attention:[],branches:[],links:[],dependencies:[],today:'2026-11-16'}};

    await context.routeWebSocket('**/*', socket => {
      blockedRequests.push(`Unexpected WebSocket: ${socket.url()}`);
      return socket.close();
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname;
      const abort = () => {
        blockedRequests.push(`Unexpected HTTP request: ${method} ${request.url()}`);
        return route.abort();
      };
      if (url.origin !== origin) return abort();
      if (pathname.startsWith('/api/')) {
        if (url.search) return abort();
        if (method === 'GET' && pathname === candidatesPath) {
          const status = readFailure ? 503 : 200;
          calls.push(['GET candidates', status]);
          const gate = holdList;
          holdList = null;
          if (gate) { gate.started(); await gate.response; }
          return status === 503 ? route.fulfill({status,json:{detail:'候选存储暂不可用'}})
            : route.fulfill({json:{items:list,partial:false,capacity_full:capacityFull}});
        }
        if (method === 'PUT' && pathname === modulePath) {
          const body = request.postDataJSON();
          if (!list.some(item => item.id === body?.candidate_id && item.usable)) return abort();
          const status = writeMode === 'conflict' ? 409 : writeMode === 'unknown' ? 503 : 200;
          writes.push(body);
          calls.push(['PUT module', status]);
          if (status === 409) return route.fulfill({status,json:{detail:'模块或记忆已变化，请刷新核对'}});
          const receipt = {...card,description:body.description,aliases:body.aliases,version:body.expected_version+1};
          receipts.set(body.operation_id,receipt);
          list = list.filter(item => item.id !== body.candidate_id);
          capacityFull = false;
          return status === 503 ? route.fulfill({status,json:{detail:'保存结果待核对'}}) : route.fulfill({json:receipt});
        }
        if (method === 'GET' && pathname.startsWith(operationsPath)) {
          const id = pathname.slice(operationsPath.length);
          if (!receipts.has(id)) return abort();
          calls.push(['GET receipt', 200, id]);
          return route.fulfill({json:receipts.get(id)});
        }
        if (method === 'POST' && pathname === `${candidatesPath}/c2/reject`) {
          rejects.push(pathname);
          calls.push(['POST reject', 200]);
          list = list.filter(item => item.id !== 'c2');
          return route.fulfill({json:{state:'rejected'}});
        }
        if (method === 'GET' && pathname === '/api/memory/suggestions/sg/basis') {
          return route.fulfill({json:{items:[{module_id:'m',revision:1,valid:basisValid,path:card.path,description:card.description,
            aliases:['华东一期'],status:basisValid?'当前有效':'引用版本或授权已失效，正文不再展示'}],
            note:'模型明确报告且经服务端核对的引用，不代表完整内部推理'}});
        }
        return method === 'GET' && Object.hasOwn(reads,pathname) ? route.fulfill({json:reads[pathname]}) : abort();
      }
      if (method !== 'GET') return abort();
      if (pathname === '/favicon.ico') return route.fulfill({status:204});
      let filename;
      if (pathname === bundle) {
        if (!react) return abort();
        bundleRequests++;
        await bundleReady;
        filename = bundle.slice(1);
      } else if (pathname === '/') filename = 'index.html';
      else if (/^\/[\w-]+\.(?:js|css)$/.test(pathname)) filename = pathname.slice(1);
      else return abort();
      const file = path.join(frontend,filename);
      if (!fs.existsSync(file)) return abort();
      return route.fulfill({body:filename === bundle.slice(1) ? bundleBody : fs.readFileSync(file),
        contentType:filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html'});
    });

    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/`, {waitUntil:'commit'});
    const drawer = page.locator('#memoryCandidatesDrawer'), entry = page.locator('#memoryCandidatesEntry');
    const original = await drawer.elementHandle();
    assert.deepEqual(await original.evaluate(node => ({
      native: node instanceof HTMLDialogElement, open: node.open,
      mounted: node.hasAttribute('data-react-owned'), children: node.childNodes.length,
    })), { native: true, open: false, mounted: false, children: 0 }, 'Memory candidates have no legacy content before React mounts');
    releaseBundle();
    await page.waitForFunction(() => db.items.length === 3);
    if (react) await page.locator('#memoryCandidatesDrawer[data-react-owned] #memoryCandidatesClose').waitFor({state:'attached'});
    assert.equal(bundleRequests,react ? 1 : 0);
    assert.equal(await drawer.isVisible(),false);

    const close = drawer.locator('#memoryCandidatesClose'), refresh = drawer.locator('#memoryCandidatesRefresh');
    const recover = drawer.locator('#memoryCandidatesRecover');
    const results = drawer.locator('#memoryCandidatesList');
    const formFor = id => drawer.locator(`form[data-candidate-id="${id}"]`);
    const saveFor = id => formFor(id).getByRole('button',{name:'确认更新记忆',exact:true});
    const readIntent = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('todo.memoryCandidateWrite')));
    const waitForError = text => page.waitForFunction(text => document.querySelector('#memoryCandidatesError').textContent.includes(text),text);
    const waitForEmpty = () => results.getByText('暂无待确认记忆候选。',{exact:false}).waitFor();
    const closeWithEscape = async () => {
      await page.keyboard.press('Escape');
      await drawer.waitFor({state:'hidden'});
      await page.waitForFunction(() => document.activeElement?.id === 'memoryCandidatesEntry');
    };
    const assertWrite = (body, id, description, aliases) => {
      assert.match(body.operation_id, uuid);
      assert.deepEqual(body,{operation_id:body.operation_id,candidate_id:id,expected_version:card.version,
        scope_version:card.scope_version,description,aliases,enabled:true});
    };
    const holdNextList = () => {
      let started, release;
      const requested = new Promise(resolve => { started = resolve; });
      const response = new Promise(resolve => { release = resolve; });
      holdList = {started,response};
      const wait = async () => {
        let timeout;
        try {
          await Promise.race([requested,new Promise((_,reject) => {
            timeout = setTimeout(() => reject(Error('No candidate list readback request')),8000);
          })]);
        } finally { clearTimeout(timeout); }
      };
      return {wait,release};
    };

    await entry.focus();
    await page.keyboard.press('Enter');
    const form = formFor('c1'), description = form.locator('#candidateDescription-c1'), aliases = form.locator('#candidateAliases-c1');
    await description.waitFor();
    assert.equal(await close.evaluate(node => node === document.activeElement),true);
    await assertDrawer(drawer,original);
    assert.match(await drawer.locator('#memoryCandidatesStatus').textContent(),/候选容量已满/);
    assert.equal(await formFor('c2').locator('textarea').count(),0);
    assert.equal(await saveFor('c2').count(),0);
    assert.match(await formFor('c2').locator('..').textContent(),/来源已变化，原文不再展示/);
    const proof = drawer.getByText('来源原文',{exact:true});
    assert.equal(await proof.count(),1,'unusable candidate must not display source evidence');
    await proof.evaluate(node => { node.parentElement.open = true; });
    assert.match(await drawer.locator('blockquote').textContent(),/<img src=x onerror=alert\(1\)>/);
    assert.equal(await drawer.locator('img').count(),0);
    for (const width of widths) {
      await page.setViewportSize({width,height:960});
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
      const bounds = await drawer.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      assert.ok(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth));
      await drawer.evaluate(async node => {
        node.scrollTop = 0;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      assert.equal(await drawer.evaluate(node => node.scrollTop),0);
      await page.screenshot({path:path.join(output,`candidates-${width}.png`),fullPage:true});
    }

    const edited = '保留我核对后的职责';
    await description.fill(edited);
    await aliases.fill(' 华东一期 \n\n 华东一期新简称');
    writeMode = 'conflict';
    await saveFor('c1').click();
    await waitForError('输入已保留');
    assert.equal(await description.inputValue(),edited);
    assert.equal(await aliases.inputValue(),' 华东一期 \n\n 华东一期新简称');
    assert.equal(await readIntent(),null);
    assertWrite(writes[0],'c1',edited,['华东一期','华东一期新简称']);

    writeMode = 'unknown';
    await saveFor('c1').click();
    await waitForError('不要重复提交');
    assert.equal(await saveFor('c1').isDisabled(),true);
    assertWrite(writes[1],'c1',edited,['华东一期','华东一期新简称']);
    const unknownId = writes[1].operation_id;
    assert.notEqual(unknownId,writes[0].operation_id);
    const unknownIntent = {operation_id:unknownId,module_id:'m',candidate_id:'c1'};
    assert.deepEqual(await readIntent(),unknownIntent);
    await closeWithEscape();
    await page.reload();
    await page.waitForFunction(() => db.items.length === 3);
    if (react) await page.locator('#memoryCandidatesDrawer[data-react-owned] #memoryCandidatesClose').waitFor({state:'attached'});
    assert.match(await entry.textContent(),/待核对/);
    assert.deepEqual(await readIntent(),unknownIntent);
    await entry.click();
    await recover.click();
    await recover.waitFor({state:'hidden'});
    assert.deepEqual(calls.slice(-2),[['GET receipt',200,unknownId],['GET candidates',200]]);
    assert.equal(writes.length,2);
    assert.equal(await readIntent(),null);
    await formFor('c2').getByRole('button',{name:'拒绝候选',exact:true}).click();
    await waitForEmpty();
    assert.deepEqual(rejects,[`${candidatesPath}/c2/reject`]);
    assert.deepEqual(calls.slice(-2),[['POST reject',200],['GET candidates',200]]);
    readFailure = true;
    await refresh.click();
    await waitForError('候选存储暂不可用');
    assert.equal(await results.textContent(),'');

    // A 200 PUT is not success until the candidate list confirms this candidate retired.
    list = [candidate('c3')];
    writeMode = 'normal';
    readFailure = false;
    await refresh.click();
    await saveFor('c3').waitFor();
    // Let the previous operation's success notice clear before checking this one.
    await page.waitForFunction(message => document.querySelector('#notice').textContent !== message,successMessage);
    await page.evaluate(successMessage => {
      const notice = document.querySelector('#notice');
      window.testCandidateSuccesses = [];
      new MutationObserver(() => {
        if (notice.textContent === successMessage) {
          window.testCandidateSuccesses.push({retired:!document.querySelector('form[data-candidate-id="c3"]'),
            empty:document.querySelector('#memoryCandidatesList').textContent.includes('暂无待确认')});
        }
      }).observe(notice,{childList:true,characterData:true,subtree:true});
    },successMessage);
    const successNotices = () => page.evaluate(() => window.testCandidateSuccesses);
    readFailure = true;
    const failureGate = holdNextList();
    try {
      await saveFor('c3').click();
      await failureGate.wait();
      assert.deepEqual(calls.slice(-2),[['PUT module',200],['GET candidates',503]]);
      assert.equal(await saveFor('c3').isDisabled(),true);
      assert.deepEqual(await successNotices(),[]);
    } finally { failureGate.release(); }
    await waitForError('候选列表未能读回');
    await recover.waitFor();
    assert.equal(await results.textContent(),'');
    assert.deepEqual(await successNotices(),[]);
    assertWrite(writes[2],'c3',card.description,['华东一期']);
    const knownId = writes[2].operation_id;
    const knownIntent = {operation_id:knownId,module_id:'m',candidate_id:'c3'};
    assert.deepEqual(await readIntent(),knownIntent);

    readFailure = false;
    list = [candidate('c3')]; // A successful but stale list must not clear the original intent.
    await recover.click();
    await waitForError('候选仍在待确认列表');
    assert.deepEqual(calls.slice(-2),[['GET receipt',200,knownId],['GET candidates',200]]);
    assert.deepEqual(await readIntent(),knownIntent);
    assert.deepEqual(await successNotices(),[]);

    list = [];
    const successGate = holdNextList();
    try {
      await recover.click();
      await successGate.wait();
      assert.deepEqual(calls.slice(-2),[['GET receipt',200,knownId],['GET candidates',200]]);
      assert.equal(await recover.isDisabled(),true);
      assert.deepEqual(await readIntent(),knownIntent);
      assert.deepEqual(await successNotices(),[]);
    } finally { successGate.release(); }
    await waitForEmpty();
    await page.waitForFunction(() => window.testCandidateSuccesses.length > 0);
    assert.deepEqual(await successNotices(),[{retired:true,empty:true}]);
    assert.equal(await recover.isHidden(),true);
    assert.equal(await readIntent(),null);
    assert.equal(writes.length,3,'receipt recovery must never resend the PUT');
    assert.deepEqual(calls.filter(([label]) => label === 'GET receipt'),
      [['GET receipt',200,unknownId],['GET receipt',200,knownId],['GET receipt',200,knownId]]);
    await closeWithEscape();

    const review = page.locator('#suggestionDrawer'), basis = review.locator('#suggestionMemoryBasis');
    await page.waitForFunction(() => aiLoaded);
    await page.evaluate(value => openSuggestion(value),suggestion);
    await basis.getByText(`${card.path} · 第1版`,{exact:true}).waitFor();
    assert.match(await basis.textContent(),/当前有效/);
    assert.ok((await basis.textContent()).includes(card.description));
    assert.equal(await review.locator('#suggestionMemorySlot').count(),0);
    assert.equal(await basis.evaluate(node => Object.getOwnPropertyNames(node)
      .some(key => key.startsWith('__reactFiber$') && node[key]?.stateNode === node)),react);
    await page.keyboard.press('Escape');
    await review.waitFor({state:'hidden'});
    basisValid = false;
    await page.evaluate(value => openSuggestion(value),suggestion);
    await basis.getByText('已失效引用 · 第1版',{exact:true}).waitFor();
    const redacted = await basis.textContent();
    assert.match(redacted,/引用版本或授权已失效/);
    for (const value of [card.path,card.description,'华东一期']) assert.ok(!redacted.includes(value));

    assert.equal(bundleRequests,react ? 2 : 0);
    assert.deepEqual(blockedRequests,[]);
    assert.deepEqual(errors,[]);
    const checks = ['native modal and keyboard focus return','candidate review and capacity hint','unusable evidence hidden',
      'escaped evidence and four-width layout','conflict preserves input','uncertain confirmation survives reload',
      'rejection with list readback','empty and read failure','acknowledged save waits for list verification',
      'same-key recovery without resending; stale list rejected','valid citation and invalid citation redaction'];
    if (react) checks.push('actual DOM Fibers for candidate contents and memory citation, with no legacy slot');
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({mode,passed:true,widths,checks,bundleRequests,
      mockedSaveAttempts:writes.length,mockedRejects:rejects.length,receiptReads:calls.filter(([label]) => label === 'GET receipt').length,
      businessWrites:0,externalCalls:0,blockedRequests,errors},null,2));
    console.log(`Memory candidates browser checks passed (${mode})`);
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
