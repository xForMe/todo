// TEST-025: Playwright Chrome regression against local files and in-memory responses only.
// From the repo root: node code/frontend-react/test/work-editor.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const frontend = path.resolve(__dirname, '../public');
const output = path.resolve(__dirname, '../../../runtime/react-editor');
const widths = [1440, 1024, 768, 375];
const bundle = '/dist/workbench-react.js';
const origin = 'http://127.0.0.1:18887'; // Virtual origin, never a running server.
const today = '2026-11-19';
const actionIds = ['workingMemoryEntry', 'moduleMemoryEntry', 'moveEntry', 'deleteEntry'];
const editorActionsByTitle = {
  编辑目标: { deleteEntry: '删除目标' },
  编辑模块: { moduleMemoryEntry: '模块记忆', deleteEntry: '删除模块' },
  编辑事情: { workingMemoryEntry: '当前工作摘要', deleteEntry: '删除事情' },
  编辑事件: { moveEntry: '迁移事件', deleteEntry: '删除事件' },
};
const memoryPath = '/api/memory/modules/m1';
const summaryPath = '/api/memory/working/t1/refresh';
const movePreviewPath = '/api/events/e1/move?target_id=t2';
const deletionPath = '/api/items/e1/deletion';
const initialValues = {
  name: '核对样稿 <版本 & 资料>', description: '合成说明 <不落库>\n第二行',
  owner: '原负责人', planStart: '2026-11-18', planEnd: '2026-11-20', status: 'working',
};
const revisedValues = {
  name: '  核对新版 <复核>  ', description: '  更新后的说明 & 验收\n保留换行  ',
  owner: '  新负责人  ', planStart: '2026-11-19', planEnd: '2026-11-24', status: 'notStarted',
  editorPlanReason: '等待跨组复核 <第二轮>',
};
const newValues = {
  name: '新建事情 <隔离>', description: '创建说明 & 资料',
  owner: '新增负责人', planStart: '2026-11-23', planEnd: '2026-11-26', status: 'working',
};
const item = (id, type, parent, name, extra = {}) => ({
  id, type, parent, name, description: '', owner: '', planStart: '', planEnd: '',
  status: 'notStarted', version: 1, ...extra,
});
const draftPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRbsAAAAASUVORK5CYII=', 'base64');

async function intercept(context, page, holdBundle) {
  const items = [
    item('g1', 'goal', null, '合成目标'), item('m1', 'module', 'g1', '主模块'),
    item('m2', 'module', 'g1', '备用模块'), item('t1', 'thing', 'm1', '合成事情'),
    item('t2', 'thing', 'm2', '备用事情'), item('e1', 'event', 't1', initialValues.name, { ...initialValues, version: 7 }),
  ];
  const writes = [];
  const httpWrites = [];
  const receiptReads = [];
  const workspaceReads = [];
  const actionRequests = [];
  const receipts = new Map();
  const receiptErrors = new Map();
  const problems = [];
  let nextResponse;
  let nextItemsError;
  const priorities = { week: '2026-11-16', items: [] };
  const find = id => items.find(row => row.id === id);
  const snapshot = () => ({ items, priorities, today, attention: [], branches: [], links: [], dependencies: [] });
  const editPath = '/api/items/e1';
  const createPath = '/api/items';
  page.on('pageerror', error => problems.push(error.message));
  await context.routeWebSocket('**/*', socket => {
    problems.push(`Unexpected WebSocket: ${socket.url()}`);
    return socket.close();
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const { origin: requestOrigin, pathname, search } = new URL(request.url());
    const method = request.method();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) httpWrites.push(`${method} ${request.url()}`);
    const reject = () => {
      problems.push(`Unexpected request: ${method} ${request.url()}`);
      return route.abort();
    };
    // No route ever continues or fetches, including off-origin requests and unplanned writes.
    if (requestOrigin !== origin) return reject();
    if (method === 'POST' && pathname === summaryPath && !search && request.postData() === null) {
      actionRequests.push(`POST ${summaryPath}`);
      return route.fulfill({ json: { state: 'cached', summary: {
        thing_id: 't1', path: '合成目标 / 主模块 / 合成事情', counts: { working: 1 },
        actions: [{ id: 'e1', name: initialValues.name, status: 'working', owner: initialValues.owner }],
      } } });
    }
    if ((method === 'PUT' && pathname === editPath) || (method === 'POST' && pathname === createPath)) {
      const body = request.postDataJSON();
      writes.push({ method, pathname, body });
      const response = nextResponse;
      nextResponse = null;
      if (!response) return reject();
      const { status, detail } = await response;
      if (status >= 400) return route.fulfill({ status, json: { detail } });
      if (status === 'lost-before-commit') return route.abort('connectionreset');
      const current = method === 'PUT' ? find('e1') : null;
      const { operation_id, expected_version, plan_change_reason, ...fields } = body;
      const saved = { ...fields, id: current?.id ?? 'created-thing', version: (current?.version ?? 0) + 1 };
      if (current) items[items.indexOf(current)] = saved;
      else items.push(saved);
      receipts.set(operation_id, saved);
      if (status === 'lost') return route.abort('connectionreset');
      if (status === 'misplaced') return route.fulfill({ status: 200, json: { ...saved, id: 'wrong-event' } });
      return route.fulfill({ json: saved });
    }
    if (method !== 'GET') return reject();
    if (pathname.startsWith('/api/')) {
      const operation = /^\/api\/operations\/([^/]+)$/.exec(pathname)?.[1];
      if (operation) {
        receiptReads.push(operation);
        const error = receiptErrors.get(operation);
        if (error) {
          receiptErrors.delete(operation);
          return route.fulfill({ status: error.status, json: { detail: error.detail } });
        }
        if (!receipts.has(operation)) return reject();
        return route.fulfill({ json: receipts.get(operation) });
      }
      if (pathname === '/api/session' || pathname === '/api/items') workspaceReads.push(pathname);
      if (pathname === '/api/items' && nextItemsError) {
        const detail = nextItemsError;
        nextItemsError = null;
        return route.fulfill({ status: 503, json: { detail } });
      }
      const responses = {
        '/api/session': {}, '/api/items': items, '/api/workbench': snapshot(), '/api/priorities': priorities,
        '/api/sources': [], '/api/sources/suggestions': [], '/api/sources/unmatched': [], '/api/sources/follow': [],
        '/api/plan-history-counts': {},
        '/api/events/e1/structure': { ...snapshot(), events: [find('e1')], snapshot: '0'.repeat(64) },
        '/api/items/e1/plan-history': {
          item: find('e1'), baseline: { scheduled: true, start: initialValues.planStart, end: initialValues.planEnd },
          records: [{ old_start: '2026-11-17', old_end: '2026-11-19', new_start: initialValues.planStart,
            new_end: initialValues.planEnd, reason: '合成变更历史', changed_at: '2026-11-18T02:00:00Z', account: '测试账号' }],
        },
      };
      const resource = pathname + search;
      const previews = {
        [memoryPath]: { card: { module_id: 'm1', path: '合成目标 / 主模块', version: 1,
          description: '已确认的模块职责 <隔离>', aliases: ['主模块简称'], status: '已确认', enabled: true, usable: true },
          index_state: 'not_indexed', embedding_configured: false, enabled: true },
        [movePreviewPath]: { moved_ids: ['e1'], target_path: ['合成目标', '备用模块', '备用事情'],
          snapshot: '1'.repeat(64), documents: 0, reminders: 0, discarded_suggestions: 0 },
        [deletionPath]: { item: find('e1'), requires_target: false, children: 0, descendants: 0,
          documents: 0, suggestions: 0, reminders: 0, relations: [] },
      };
      if (Object.hasOwn(previews, resource)) {
        actionRequests.push(`GET ${resource}`);
        return route.fulfill({ json: previews[resource] });
      }
      if (Object.hasOwn(responses, pathname)) return route.fulfill({ json: responses[pathname] });
      return reject();
    }
    if (pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (pathname === bundle && holdBundle) await holdBundle;
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (pathname !== bundle && !/^[-\w]+\.(?:js|css)$/.test(file) && pathname !== '/') return reject();
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    try {
      return await route.fulfill({ body: await fs.readFile(path.join(frontend, file)),
        contentType: `${mime[path.extname(file)]}; charset=utf-8` });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return reject();
    }
  });
  return {
    writes, httpWrites, receiptReads, workspaceReads, actionRequests, problems, find,
    respondWith(status, detail) { nextResponse = Promise.resolve({ status, detail }); },
    pauseResponse() { nextResponse = new Promise(resolve => { this.release = resolve; }); },
    failReceiptOnce(operation, status, detail) { receiptErrors.set(operation, { status, detail }); },
    failItemsOnce(detail) { nextItemsError = detail; },
  };
}

async function ownership(editor, hasAttachment = false) {
  await editor.locator('#form[data-react-owned]').waitFor();
  if (hasAttachment) await editor.locator('.inlineImageEntry').waitFor();
  const actual = await editor.evaluate((dialog, ids) => {
    const form = dialog.querySelector(':scope > #form');
    const own = (node, kind) => node && Object.getOwnPropertyNames(node)
      .find(key => key.startsWith(`__react${kind}$`));
    const fiber = node => {
      const value = node?.[own(node, 'Fiber')];
      return value?.stateNode === node ? value : undefined;
    };
    const fiberRoot = node => {
      let value = fiber(node);
      while (value?.return) value = value.return;
      return value?.stateNode?.containerInfo;
    };
    const slot = form.querySelector('#editorImageSlot');
    const attachment = form.querySelector('.inlineImageEntry');
    const nodes = [...form.querySelectorAll('*')];
    const fields = nodes.filter(node => !slot?.contains(node) || node === slot);
    const entries = [...document.querySelectorAll(ids.map(id => `#${id}`).join(', '))];
    const label = node => node.id || node.tagName;
    return {
      modal: dialog instanceof HTMLDialogElement && dialog.open && dialog.matches(':modal'),
      dialogOwned: !!(fiber(dialog) || own(dialog, 'Container')),
      formMarker: form.hasAttribute('data-react-owned'),
      formContainer: !!own(form, 'Container'),
      legacySlot: !!dialog.querySelector('#editorLegacyActions'),
      slots: form.querySelectorAll('#editorImageSlot').length,
      rendered: nodes.filter(fiber).map(label),
      wrongRoot: fields.filter(node => fiberRoot(node) !== form).map(label),
      inline: [form, ...nodes].flatMap(node =>
        node.getAttributeNames().filter(name => /^on/i.test(name)).map(name => `${label(node)}.${name}`)),
      entries: entries.map(node => ({ id: node.id, button: node instanceof HTMLButtonElement && node.type === 'button',
        inActions: node.closest('.actions')?.parentElement === form, inFormRoot: fiberRoot(node) === form })),
      attachmentCount: form.querySelectorAll('.inlineImageEntry').length,
      attachmentInSlot: !!slot && attachment?.parentElement === slot,
      attachmentInSlotRoot: !!slot && !!attachment && [...slot.querySelectorAll('*')].every(node => fiberRoot(node) === slot),
    };
  }, actionIds);
  assert.equal(actual.modal, true, '#editor stays a native, modal <dialog>');
  assert.equal(actual.dialogOwned, false, '#editor stays outside React');
  assert.equal(actual.formMarker, true);
  assert.equal(actual.formContainer, true, '#form is the React root container');
  assert.equal(actual.legacySlot, false, 'The old editor action slot must not exist');
  assert.equal(actual.slots, 1, 'Only React creates the attachment slot');
  assert.deepEqual(actual.entries, actionIds.map(id => ({ id, button: true, inActions: true, inFormRoot: true })),
    'All four unique entries stay in action order as non-submit buttons, inside the React form root');
  assert.equal(actual.attachmentCount, Number(hasAttachment), 'Only a new thing or event shows the attachment entry');
  if (hasAttachment) {
    assert.equal(actual.attachmentInSlot, true, 'The attachment entry stays in #editorImageSlot');
    assert.equal(actual.attachmentInSlotRoot, true, 'The independent root owns every attachment element');
  }
  for (const id of ['formTitle', 'name', 'description', 'planStart', 'planEnd', 'owner', 'status', 'save', 'formError']) {
    assert.ok(actual.rendered.includes(id), `#${id} needs a native host fiber, not just an ownership marker`);
  }
  assert.deepEqual(actual.wrongRoot, [], 'All editor descendants except attachment content belong to the form root');
  assert.deepEqual(actual.inline, [], 'React fields, actions, and attachments must not contain inline event attributes');
}

async function exercise(page, fixture) {
  const { writes, httpWrites, receiptReads, actionRequests } = fixture;
  const work = page.locator('#workPage');
  const editor = page.locator('#editor');
  const events = work.locator('#events');
  const save = editor.locator('#save');
  const error = editor.locator('#formError');
  const field = id => editor.locator(`#${id}`);
  const editEvent = name => events.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) })
    .getByRole('button', { name: '编辑事件', exact: true });
  const plain = (locator, text) => locator.getByText(text, { exact: true }).waitFor();
  const hide = locator => locator.waitFor({ state: 'hidden' });
  const cancel = async () => { await editor.getByRole('button', { name: '取消', exact: true }).click(); await hide(editor); };
  const values = async expected => {
    for (const [id, value] of Object.entries(expected)) assert.equal(await field(id).inputValue(), value, `#${id} value`);
  };
  const fill = async (fields, next) => {
    for (const [id, value] of Object.entries(next)) {
      if (id === 'status') await field(id).selectOption(value);
      else await field(id).fill(value);
    }
    Object.assign(fields, next);
    await values(fields);
  };
  const open = async (trigger, title, parent, workFields) => {
    await trigger.click();
    await editor.getByRole('heading', { name: title, exact: true }).waitFor();
    assert.equal(await field('formContext').innerText(), parent);
    assert.equal(await field('workFields').isVisible(), workFields);
    assert.equal(await error.textContent(), '');
    const expectedActions = editorActionsByTitle[title] ?? {};
    await ownership(editor, title === '新建事情' || title === '新建事件');
    for (const id of actionIds) {
      assert.equal(await field(id).isVisible(), Object.hasOwn(expectedActions, id), `${title}: #${id} visibility`);
      if (expectedActions[id]) {
        assert.equal(await field(id).and(editor.getByRole('button', { name: expectedActions[id], exact: true })).count(), 1,
          `${title}: #${id} has the original accessible name`);
      }
    }
  };
  const assertWrite = (index, method, pathname, expected) => {
    const { body, ...request } = writes[index];
    assert.deepEqual(request, { method, pathname });
    const { operation_id, ...fields } = body;
    assert.match(operation_id, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
    assert.deepEqual(fields, expected);
    return operation_id;
  };
  const readback = async (name, expected) => {
    await open(editEvent(name), '编辑事件', '所属事情：合成事情', true);
    await values({ ...expected, editorPlanReason: '' });
    await cancel();
  };
  // Wait for the startup gate and structured row before exercising the editor.
  await page.goto(`${origin}/`);
  await page.locator('body:not([data-ui-startup])').waitFor({ state: 'attached' });
  await page.locator('#editor > #form[data-react-owned]').waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '目标与事情', exact: true }).click();
  await editEvent(initialValues.name).waitFor();

  await open(work.locator('#editGoal'), '编辑目标', '', false);
  await cancel();
  await open(work.locator('#editModule'), '编辑模块', '所属目标：合成目标', false);
  await values({ name: '主模块', description: '' });
  await field('name').fill('不可随模块记忆提交的编辑稿');
  await field('moduleMemoryEntry').click();
  const memory = page.locator('#memoryDrawer');
  await plain(memory, '合成目标 / 主模块');
  await hide(editor);
  const memoryDescription = memory.locator('#memoryDescription');
  assert.equal(await memoryDescription.inputValue(), '已确认的模块职责 <隔离>');
  assert.deepEqual(actionRequests, [`GET ${memoryPath}`]);
  assert.deepEqual(httpWrites, [], 'Opening module memory only reads the original module');
  await memoryDescription.fill('未确认的记忆草稿');
  await memory.locator('#memoryClose').click();
  await hide(memory);
  await open(work.locator('#editModule'), '编辑模块', '所属目标：合成目标', false);
  await values({ name: '主模块', description: '' });
  await cancel();

  const editThing = events.getByRole('button', { name: '编辑事情', exact: true });
  await open(editThing, '编辑事情', '所属模块：主模块', true);
  await field('name').fill('不属于已提交摘要的编辑稿');
  await field('workingMemoryEntry').click();
  const summary = page.locator('#workingMemoryDrawer');
  await plain(summary, '合成目标 / 主模块 / 合成事情');
  await plain(summary, initialValues.name);
  await hide(editor);
  await summary.locator('#workingMemoryClose').click();
  await hide(summary);
  const summaryWrite = `POST ${origin}${summaryPath}`;
  assert.deepEqual(httpWrites, [summaryWrite], 'Only the existing derived-summary refresh may POST');
  await open(editThing, '编辑事情', '所属模块：主模块', true);
  await values({ name: '合成事情', description: '' });
  await cancel();

  await open(work.getByRole('button', { name: '＋ 新建目标', exact: true }), '新建目标', '', false);
  await cancel();
  await open(work.locator('#newModule'), '新建模块', '所属目标：合成目标', false);
  await cancel();
  await open(events.getByRole('button', { name: '＋ 新建事件', exact: true }), '新建事件', '所属事情：合成事情', true);
  await cancel();

  await open(editEvent(initialValues.name), '编辑事件', '所属事情：合成事情', true);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await editor.evaluate(dialog => {
      const { left, right, width, height } = dialog.getBoundingClientRect();
      return left >= -1 && right <= innerWidth + 1 && width > 0 && height > 0 && dialog.scrollWidth <= dialog.clientWidth + 1;
    }), `Editor does not overflow at ${width}px`);
    await page.screenshot({ path: path.join(output, `react-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = { ...initialValues, editorPlanReason: '' };
  await values(input);
  await fill(input, { description: '扩展打开后继续编辑', editorPlanReason: '尚未保存的调整原因' });
  await editor.getByRole('button', { name: '查看时间变更记录', exact: true }).click();
  const plan = page.locator('#planDrawer');
  await plain(plan, '调整原因：合成变更历史');
  await plan.getByRole('button', { name: '关闭', exact: true }).click();
  await hide(plan);
  await values(input);
  await field('moveEntry').click();
  const move = page.locator('#moveDrawer');
  await plain(move, '当前位置：合成目标 / 主模块 / 合成事情。迁移不保存编辑中的字段。');
  assert.equal(await move.locator('#submitMove').isDisabled(), true);
  await move.locator('#moveModule').selectOption('m2');
  await move.locator('#moveThing').selectOption('t2');
  await plain(move, '将 1 个事件迁至 合成目标 / 备用模块 / 备用事情。保留内容、状态和内部关系；暂停 0 个文档来源、0 条催办，作废 0 条待确认建议。');
  assert.equal(await move.locator('#submitMove').isEnabled(), true);
  await move.locator('#closeMove').click();
  await hide(move);
  await values(input);
  await field('deleteEntry').click();
  const deletion = page.locator('#deleteDrawer');
  await plain(deletion, `确定删除“${initialValues.name}”？`);
  await hide(editor);
  await page.keyboard.press('Escape');
  await hide(deletion);
  assert.deepEqual(actionRequests, [`GET ${memoryPath}`, `POST ${summaryPath}`, `GET ${movePreviewPath}`, `GET ${deletionPath}`],
    'Each action goes to its own original controller and record exactly once');
  assert.deepEqual(httpWrites, [summaryWrite], 'No item save, memory confirmation, migration, or deletion follows preview/cancel');
  assert.deepEqual(receiptReads, [], 'Previewing and cancelling do not create any pending write');
  assert.equal(writes.length, 0, 'Checking the editor actions must not save items');

  await open(editEvent(initialValues.name), '编辑事件', '所属事情：合成事情', true);
  Object.assign(input, initialValues, { editorPlanReason: '' });
  await values(input);
  await fill(input, { name: '   ' });
  await save.click();
  await plain(editor, '请输入名称');
  await values(input);
  assert.equal(writes.length, 0, 'Whitespace-only names never reach the API');
  await fill(input, { ...revisedValues, planEnd: '2026-11-17' });
  await save.click();
  await plain(editor, '计划结束不能早于开始');
  await values(input);
  assert.equal(writes.length, 0, 'Inverted dates never reach the API');
  await fill(input, revisedValues);

  const expectedEdit = {
    type: 'event', parent: 't1', expected_version: 7, name: revisedValues.name.trim(),
    description: revisedValues.description, owner: revisedValues.owner.trim(),
    planStart: revisedValues.planStart, planEnd: revisedValues.planEnd, status: revisedValues.status,
    plan_change_reason: revisedValues.editorPlanReason,
  };
  fixture.pauseResponse();
  try {
    await save.click();
    await editor.locator('#save:disabled').waitFor();
    await values(input);
    // Keyboard submit while the first operation is pending must not queue a second write.
    await field('name').press('Enter');
  } finally {
    fixture.release({ status: 403, detail: '模拟服务拒绝：没有编辑权限' });
  }
  await plain(editor, '模拟服务拒绝：没有编辑权限；输入已保留，请核对操作结果');
  await values(input);
  assert.equal(writes.length, 1);
  const denied = assertWrite(0, 'PUT', '/api/items/e1', expectedEdit);
  assert.deepEqual(receiptReads, []);
  assert.equal(fixture.find('e1').version, 7, 'A definite rejection did not mutate the item');

  fixture.respondWith(409, '模拟服务拒绝：内容已变化');
  await save.click();
  await plain(editor, '模拟服务拒绝：内容已变化；输入已保留，请核对操作结果');
  await values(input);
  assert.equal(writes.length, 2);
  const conflicted = assertWrite(1, 'PUT', '/api/items/e1', expectedEdit);
  assert.notEqual(conflicted, denied, 'Only explicit resubmission creates a fresh operation after a definite rejection');
  assert.deepEqual(receiptReads, []);
  await cancel();
  await readback(initialValues.name, initialValues);

  await open(editEvent(initialValues.name), '编辑事件', '所属事情：合成事情', true);
  await fill({}, revisedValues);
  fixture.respondWith('lost'); // Server commits in the fixture, but browser loses its response.
  await save.click();
  await error.filter({ hasText: '输入已保留，请核对操作结果' }).waitFor();
  await values(input);
  assert.equal(writes.length, 3);
  const lost = assertWrite(2, 'PUT', '/api/items/e1', expectedEdit);
  assert.notEqual(lost, conflicted);
  assert.deepEqual(receiptReads, [], 'Do not look up a receipt automatically');
  await save.click();
  await error.filter({ hasText: '请先核对上一次操作' }).waitFor();
  await values(input);
  assert.equal(writes.length, 3, 'Repeated submit after an unknown result must not resend');
  assert.deepEqual(receiptReads, [], 'Repeated submit does not substitute for the explicit receipt button');
  await cancel();
  await work.locator('#addThing').click();
  await plain(page.locator('#notice'), '请先核对上次保存结果');
  assert.equal(await editor.isVisible(), false, 'An unresolved write blocks opening an unrelated editor');
  await work.getByRole('button', { name: '核对待确认操作', exact: true }).click();
  await plain(page.locator('#notice'), '已核对保存结果');
  assert.deepEqual(receiptReads, [lost], 'Manual lookup uses the same operation ID');
  assert.equal(writes.length, 3, 'Receipt lookup must not write');
  assert.equal(fixture.find('e1').version, 8);
  await readback(expectedEdit.name, { name: expectedEdit.name, description: expectedEdit.description,
    owner: expectedEdit.owner, planStart: expectedEdit.planStart, planEnd: expectedEdit.planEnd, status: expectedEdit.status });

  await work.locator('#moduleChoices').getByText('备用模块', { exact: true }).click();
  assert.ok(await work.getByRole('radio', { name: '备用模块', exact: true }).isChecked());
  await open(work.locator('#addThing'), '新建事情', '所属模块：备用模块', true);
  const attachment = editor.locator('.inlineImageEntry');
  await attachment.getByRole('button', { name: '附加图片', exact: true }).waitFor();
  const fresh = { name: '', description: '', owner: '', planStart: '', planEnd: '', status: 'notStarted' };
  await values(fresh);
  assert.equal(await field('editorPlanReason').isVisible(), false);
  const beforeDraftWrites = httpWrites.slice();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'), attachment.getByRole('button', { name: '选文件', exact: true }).click(),
  ]);
  await chooser.setFiles({ name: '合成草稿.png', mimeType: 'image/png', buffer: draftPng });
  const preview = attachment.getByRole('img', { name: '合成草稿.png', exact: true });
  await preview.waitFor();
  await fill(fresh, { description: newValues.description });
  await save.click();
  await plain(editor, '请输入名称');
  await preview.waitFor();
  await ownership(editor, true);
  const remove = attachment.getByRole('button', { name: '移除合成草稿.png', exact: true });
  await remove.click();
  await preview.waitFor({ state: 'detached' });
  await remove.waitFor({ state: 'detached' });
  assert.equal(writes.length, 3, 'Handling a local draft never calls save');
  assert.deepEqual(httpWrites, beforeDraftWrites, 'Selecting or removing a local draft never issues any HTTP write');

  await fill(fresh, newValues);
  fixture.respondWith(200);
  await save.click();
  await hide(editor);
  await plain(page.locator('#notice'), '已保存');
  assert.equal(writes.length, 4);
  const created = assertWrite(3, 'POST', '/api/items', {
    type: 'thing', parent: 'm2', ...newValues, plan_change_reason: '',
  });
  assert.equal(new Set([denied, conflicted, lost, created]).size, 4);
  assert.deepEqual(receiptReads, [lost]);
  assert.equal(fixture.find('created-thing').version, 1);
  await open(events.getByRole('button', { name: '编辑事情', exact: true }), '编辑事情', '所属模块：备用模块', true);
  await values({ ...newValues, editorPlanReason: '' });
  await cancel();
}

async function exercisePendingDrawer(page, fixture, width) {
  const { writes, httpWrites, receiptReads, workspaceReads } = fixture;
  const work = page.locator('#workPage');
  const tools = work.locator('.connectionTools');
  const events = work.locator('#events');
  const editor = page.locator('#editor');
  const drawer = page.locator('#pendingDrawer');
  const save = editor.locator('#save');
  const addThing = work.locator('#addThing');
  const notice = page.locator('#notice');
  const button = (host, name) => host.getByRole('button', { name, exact: true });
  const check = button(tools, '核对待确认操作');
  const close = button(drawer, '关闭');
  const keep = button(drawer, '保留并继续核对');
  const abandon = button(drawer, '确认放弃并刷新');
  const drawerTitle = drawer.getByRole('heading', { name: '核对待确认操作', exact: true });
  const alert = drawer.getByRole('alert');
  const hidden = locator => locator.waitFor({ state: 'hidden' });
  const exact = (locator, text) => locator.getByText(text, { exact: true }).waitFor();
  const eventName = name => button(events, name);
  const editEvent = name => button(events.getByRole('row').filter({ has: button(page, name) }), '编辑事件');
  const readError = '模拟服务暂时无法查询回执';
  const missing = '模拟未查到操作回执';
  const savedFirst = '同键读回的事件 <隔离>';
  const savedAfterAck = '响应错位后同键读回 <隔离>';
  const savedLast = '放弃刷新后的新操作 <隔离>';
  const expectedReceipts = [];
  const expectedWrites = [];

  const assertRequests = message => {
    assert.deepEqual(receiptReads, expectedReceipts, `${message}: only an explicit check reads the original key`);
    assert.deepEqual(httpWrites, expectedWrites, `${message}: no write or silent retry`);
  };
  const startEdit = async (current, draft, response, draftError) => {
    await editEvent(current).click();
    await editor.locator('#name').fill(draft);
    fixture.respondWith(response);
    await save.click();
    await editor.locator('#formError').filter({ hasText: draftError }).waitFor();
    assert.equal(await editor.locator('#name').inputValue(), draft);
    assert.equal(await drawer.isVisible(), false, 'Saving never opens the separate verification drawer automatically');
    expectedWrites.push(`PUT ${origin}/api/items/e1`);
    assertRequests('before clicking the receipt button');
    const key = writes.at(-1).body.operation_id;
    assert.match(key, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
    await button(editor, '取消').click();
    await hidden(editor);
    return key;
  };
  const queryFailure = async (key, status, message, canAbandon) => {
    fixture.failReceiptOnce(key, status, message);
    await check.click();
    expectedReceipts.push(key);
    await drawerTitle.waitFor();
    await exact(drawer, '尚未查到成功结果。可以保留操作标识继续核对；只有确认放弃后才允许重新提交。');
    await alert.filter({ hasText: message }).waitFor();
    assert.equal(await alert.textContent(), message);
    assert.equal(await abandon.isDisabled(), !canAbandon);
    assertRequests(`receipt returned ${status}`);
  };
  const closeAndStayPending = async control => {
    const readsBefore = workspaceReads.slice();
    await control.click();
    await hidden(drawer);
    await addThing.click();
    await exact(notice, '请先核对上次保存结果');
    assert.equal(await editor.isVisible(), false, 'A new operation is blocked while the old one is unresolved');
    assert.deepEqual(workspaceReads, readsBefore, 'Closing or keeping an operation must not refresh');
    assertRequests('close/keep leaves the pending write untouched');
  };
  const recover = async (key, name) => {
    await check.click();
    expectedReceipts.push(key);
    await exact(notice, '已核对保存结果');
    await eventName(name).waitFor();
    await hidden(drawer);
    assertRequests('manual recovery succeeds by reading the same key');
  };

  await page.goto(`${origin}/`);
  await page.locator('body:not([data-ui-startup])').waitFor({ state: 'attached' });
  await drawer.and(page.locator('[data-react-owned]')).waitFor({ state: 'attached' });
  await tools.and(page.locator('[data-react-owned]')).waitFor({ state: 'attached' });
  await button(page, '目标与事情').click();
  await editEvent(initialValues.name).waitFor();
  await button(tools, '刷新数据').waitFor();
  await check.waitFor();
  assert.deepEqual(await tools.locator('button').evaluateAll(nodes => nodes.map(node =>
    node.getAttribute('aria-label') || node.textContent.trim())), ['刷新数据', '核对待确认操作']);

  const assertRoot = async host => {
    const ownership = await host.evaluate(node => {
      const own = (element, kind) => Object.keys(element).find(key => key.startsWith(`__react${kind}$`));
      const descendants = [...node.querySelectorAll('*')];
      const owned = descendants.filter(element => {
        let fiber = element[own(element, 'Fiber')];
        if (fiber?.stateNode !== element) return false;
        while (fiber.return) fiber = fiber.return;
        return fiber.stateNode?.containerInfo === node;
      });
      return { marker: node.hasAttribute('data-react-owned'), container: !!own(node, 'Container'),
        owned: owned.length, descendants: descendants.length,
        inline: descendants.flatMap(element => element.getAttributeNames().filter(name => /^on/i.test(name))) };
    });
    assert.ok(ownership.descendants > 0, 'There must be real rendered children');
    assert.equal(ownership.marker, true);
    assert.equal(ownership.container, true, 'The native host is a real React root');
    assert.equal(ownership.owned, ownership.descendants, 'All children must have a host Fiber in the intended root');
    assert.deepEqual(ownership.inline, []);
  };
  await assertRoot(tools);

  const lost = await startEdit(initialValues.name, savedFirst, 'lost', '输入已保留，请核对操作结果');
  const readsBeforeCheck = workspaceReads.slice();
  await queryFailure(lost, 503, readError, false);
  assert.ok(await drawer.evaluate(node => node instanceof HTMLDialogElement && node.open && node.matches(':modal')),
    'The pending drawer remains a native modal dialog');
  await assertRoot(drawer);
  assert.ok(await drawer.evaluate(node => {
    const box = node.getBoundingClientRect();
    return box.left >= -1 && box.right <= innerWidth + 1 && node.scrollWidth <= node.clientWidth + 1;
  }), `Pending drawer does not overflow at ${width}px`);
  await page.screenshot({ path: path.join(output, `pending-react-${width}.png`) });
  await closeAndStayPending(close);
  await queryFailure(lost, 404, missing, true);
  await closeAndStayPending(keep);
  assert.deepEqual(workspaceReads, readsBeforeCheck, 'Checking or keeping a receipt does not reload the workspace');
  await recover(lost, savedFirst);
  assert.equal(fixture.find('e1').version, 8);

  // A 200 with a different item acknowledges the write, but is not safe to render or discard.
  const acknowledged = await startEdit(savedFirst, savedAfterAck, 'misplaced', '保存回执与原操作不匹配，请继续核对');
  assert.notEqual(acknowledged, lost, 'Only a resolved write allows another operation key');
  await queryFailure(acknowledged, 404, missing, false);
  await closeAndStayPending(keep);
  await recover(acknowledged, savedAfterAck);
  assert.equal(fixture.find('e1').version, 9);

  const noCommit = await startEdit(savedAfterAck, '网络中断，服务端未保存', 'lost-before-commit', '输入已保留，请核对操作结果');
  assert.notEqual(noCommit, acknowledged);
  await queryFailure(noCommit, 404, missing, true);
  const readback = workspaceReads.slice();
  fixture.failItemsOnce('模拟工作空间读回失败');
  await abandon.click();
  await alert.filter({ hasText: '模拟工作空间读回失败；原操作仍保留，请继续核对' }).waitFor();
  assert.equal(await abandon.isDisabled(), true);
  readback.push('/api/session', '/api/items');
  assert.deepEqual(workspaceReads, readback);
  await closeAndStayPending(close);
  await queryFailure(noCommit, 404, missing, true);
  await abandon.click();
  await hidden(drawer);
  await exact(notice, '工作空间已更新');
  readback.push('/api/session', '/api/items');
  assert.deepEqual(workspaceReads, readback, 'Explicit discard only releases the operation after a successful refresh');
  assertRequests('explicit discard refreshes without writing');
  assert.equal(fixture.find('e1').version, 9, 'The missing operation did not change the item');

  await editEvent(savedAfterAck).click();
  assert.equal(await editor.locator('#name').inputValue(), savedAfterAck, 'A fresh edit starts from the refreshed item');
  await editor.locator('#name').fill(savedLast);
  fixture.respondWith(200);
  await save.click();
  await hidden(editor);
  await exact(notice, '已保存');
  await eventName(savedLast).waitFor();
  expectedWrites.push(`PUT ${origin}/api/items/e1`);
  assertRequests('a new explicit save is allowed after discard');
  assert.equal(writes.at(-1).body.expected_version, 9);
  assert.equal(new Set(writes.map(({ body }) => body.operation_id)).size, 4, 'Every explicit save uses a fresh operation key');
}

async function verifyPendingDrawers(browser) {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const fixture = await intercept(context, page);
      try {
        await exercisePendingDrawer(page, fixture, width);
        assert.deepEqual(fixture.problems, []);
      } catch (error) {
        error.message = `React pending drawer at ${width}px: ${error.message}`;
        if (fixture.problems.length) error.message += `\nFixture problems: ${fixture.problems.join('; ')}`;
        throw error;
      }
    } finally {
      await context.close();
    }
  }
}

async function verifyDelayedBundle(browser) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let releaseBundle;
  const blocked = new Promise(resolve => { releaseBundle = resolve; });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const fixture = await intercept(context, page, blocked);
    await Promise.all([
      page.waitForRequest(request => request.url() === `${origin}${bundle}`),
      page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' }),
    ]);
    const startup = page.locator('body[data-ui-startup] > #frontendStartup');
    const workTab = page.getByRole('button', { name: '目标与事情', exact: true });
    const work = page.locator('#workPage');
    const editor = page.locator('#editor');
    const form = editor.locator(':scope > #form');
    const pending = page.locator('#pendingDrawer');
    const tools = work.locator('.connectionTools');
    const notice = page.locator('#notice');
    await startup.waitFor();
    const originalForm = await form.elementHandle();
    const originalPending = await pending.elementHandle();
    const originalTools = await tools.elementHandle();
    await page.waitForFunction(() => noticeMessage === '工作空间已更新');
    assert.equal(await notice.evaluate(host => host.childNodes.length), 0, 'The startup read records a notice without writing to its host');
    assert.ok(await notice.isHidden(), 'The startup read can finish without showing the workspace notice');
    assert.equal(await workTab.count(), 0, 'Business navigation is not exposed during startup');
    assert.ok(await work.isHidden(), 'The workspace cannot be interacted with during startup');
    assert.equal(await editor.evaluate(node => node instanceof HTMLDialogElement && !node.open), true);
    assert.equal(await originalForm.evaluate(node => node instanceof HTMLFormElement && !node.hasAttribute('data-react-owned')), true);
    assert.equal(await originalPending.evaluate(node => node instanceof HTMLDialogElement && !node.open && !node.hasAttribute('data-react-owned')), true);
    assert.equal(await originalTools.getAttribute('data-react-owned'), null);
    for (const [host, label] of [[originalForm, '#form'], [originalPending, '#pendingDrawer'], [originalTools, '.connectionTools']]) {
      assert.equal(await host.evaluate(node => node.childNodes.length), 0, `${label} is empty before React loads`);
    }
    assert.ok(fixture.workspaceReads.includes('/api/session'), 'Startup still connects to the workspace');
    assert.equal(fixture.workspaceReads.filter(path => path === '/api/items').length, 1, 'Startup reads workspace items without a UI action');
    assert.deepEqual(fixture.httpWrites, []);
    assert.deepEqual(fixture.receiptReads, []);

    releaseBundle();
    await page.locator('body:not([data-ui-startup])').waitFor({ state: 'attached' });
    assert.ok(await startup.isHidden());
    assert.equal(await form.evaluate((node, original) => node === original && node.hasAttribute('data-react-owned'), originalForm), true,
      'React mounts into the original editor form before revealing the workspace');
    assert.equal(await pending.evaluate((node, original) => node === original && node.hasAttribute('data-react-owned') && !node.open, originalPending), true,
      'React mounts into the original pending drawer without opening it during startup');
    assert.equal(await tools.evaluate((node, original) => node === original && node.hasAttribute('data-react-owned'), originalTools), true,
      'React mounts into the original connection tools host');
    await workTab.click();
    await work.locator('#editModule').click();
    await ownership(editor);
    assert.equal(await form.locator('#name').inputValue(), '主模块', 'The editor uses data read during startup');
    assert.deepEqual(fixture.httpWrites, []);
    assert.deepEqual(fixture.receiptReads, []);
    assert.deepEqual(fixture.problems, []);
    await originalForm.dispose();
    await originalPending.dispose();
    await originalTools.dispose();
  } finally {
    releaseBundle();
    await context.close();
  }
}

async function verify() {
  await fs.access(path.join(frontend, bundle.slice(1)));
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const fixture = await intercept(context, page);
      try {
        await exercise(page, fixture);
        assert.deepEqual(fixture.problems, []);
      } catch (error) {
        if (fixture.problems.length) error.message += `\nFixture problems: ${fixture.problems.join('; ')}`;
        throw error;
      }
    } finally {
      await context.close();
    }
    await verifyDelayedBundle(browser);
    await verifyPendingDrawers(browser);
    console.log(`React editor passed: startup gating, form and action ownership, action previews without writes, attachment drafts, create/edit, validation, 403/409, manual receipts, and pending drawer recovery/discard at ${widths.join('/')}.`);
  } finally {
    await browser.close();
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
