const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { test } = require('node:test');
const { createServer } = require('node:http');
const { once } = require('node:events');
const readKey = 'r'.repeat(64), writeKey = 'w'.repeat(64);
const thing = '10000000-0000-4000-8000-000000000001', eventId = '10000000-0000-4000-8000-000000000002';

async function harness({ outcome = 'allowed-once', abort = false, fail = '', missing = false, noAgent = false } = {}) {
  const { createEventTool } = await import('./index.js');
  const ctl = new AbortController();
  const calls = [];
  let request;
  const ctx = {
    credentials: { resolve: async name => ({ value: name === 'TODO_DSH_CAPTURE_TOKEN' ? readKey : missing ? '' : writeKey }) },
    approval: { request: async req => { calls.push('approval'); request = req; if (abort) ctl.abort(); return outcome; } },
  };
  const tool = createEventTool(ctx, async (raw, signature, signal, url) => {
    assert.ok(!signal.aborted); calls.push('write');
    assert.equal(url, 'http://127.0.0.1:8000/api/dsh-direct/events');
    assert.equal(request.toolName, 'todo_create_event');
    const body = JSON.parse(raw);
    assert.equal(signature, createHmac('sha256', writeKey)
      .update('todo-direct-create-v1\n').update(raw, 'utf8').digest('hex'));
    assert.deepEqual(body.expected_path, ['目标', '模块', '已有事情']);
    assert.equal(body.expected_version, 7); assert.equal(body.thing_id, thing);
    assert.match(request.reason, /归属："目标" → "模块" → "已有事情"/);
    assert.match(request.reason, /标题："检查接口"/);
    assert.deepEqual([request.agent, request.callId], [agent, 'root']);
    if (fail === 'network') throw Error('simulated disconnection');
    return Response.json({ event: { id: eventId, type: 'event', parent: thing, name: body.title,
      status: 'notStarted', owner: body.owner, planEnd: body.planned_date, description: body.description } });
  });
  const agent = {};
  const run = async args => {
    const native = global.fetch;
    global.fetch = async (url, init) => {
      assert.equal(init.redirect, 'error');
      const body = JSON.parse(init.body);
      if (url === 'http://127.0.0.1:8000/mcp') {
        calls.push('lookup');
        assert.equal(init.headers.Authorization, `Bearer ${readKey}`);
        assert.deepEqual(body.params, { name: 'find_matters', arguments: { query: thing } });
        const matches = [{ thing_id: thing, path: ['目标', '模块', '已有事情'], version: 7 }];
        return Response.json({ result: { content: [{ text: JSON.stringify({ matters: fail === 'ambiguous' ? [...matches, ...matches] : matches, truncated: false }) }] } });
      }
      assert.fail(`Unexpected fetch ${url}`);
    };
    try { return await tool.execute({ thing_id: thing, title: '检查接口', ...args },
      { agent: noAgent ? undefined : agent, callId: 'nested', rootCallId: 'root', signal: ctl.signal }); }
    finally { global.fetch = native; }
  };
  return { run, calls };
}

test('verified path, one approval, signed exact write, committed result', async () => {
  const h = await harness();
  const result = JSON.parse(await h.run({ owner: '甲', planned_date: '2026-11-30' }));
  assert.deepEqual(h.calls, ['lookup', 'approval', 'write']);
  assert.equal(result.event_id, eventId); assert.equal(result.status, '已创建正式事件');
});

test('reject, unavailable and abort never dispatch a write', async () => {
  for (const cfg of [{ outcome: 'rejected' }, { outcome: 'unavailable' }, { abort: true }]) {
    const h = await harness(cfg); await assert.rejects(h.run({}));
    assert.deepEqual(h.calls, ['lookup', 'approval']);
  }
});

test('ambiguous path, invalid field and absent independent credential never dispatch', async () => {
  for (const [cfg, args, calls] of [[{ fail: 'ambiguous' }, {}, ['lookup']], [{}, { planned_date: '2026-02-30' }, []],
                                   [{}, { title: '改写\u202e' }, []], [{ missing: true }, {}, []], [{ noAgent: true }, {}, []]]) {
    const h = await harness(cfg); await assert.rejects(h.run(args)); assert.deepEqual(h.calls, calls);
  }
});

test('native transport sends exact bytes and no browser headers or redirects', async () => {
  const { postNative } = await import('./index.js');
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(307, { Location: '/unexpected' });
      res.end('{}');
    });
  }).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const data = '{"title":"实际字节"}';
    const result = await postNative(data, 'b'.repeat(64), AbortSignal.timeout(5000),
      `http://127.0.0.1:${server.address().port}/api/dsh-direct/events`);
    assert.equal(result.status, 307);
    assert.deepEqual(requests.map(row => row.url), ['/api/dsh-direct/events']);
    const [received] = requests;
    assert.equal(received.body, data);
    assert.equal(received.headers['x-todo-approval'], 'v1=' + 'b'.repeat(64));
    assert.equal(received.headers['content-length'], String(Buffer.byteLength(data)));
    assert.ok(!Object.keys(received.headers).some(name => name.startsWith('sec-fetch-') || ['authorization', 'origin'].includes(name)));
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('unknown write outcome returns original receipt lookup, no retries', async () => {
  const h = await harness({ fail: 'network' });
  await assert.rejects(h.run({}), /操作标识：[0-9a-f-]{36}。请调用 mcp__todo_capture__get_recorded_event/);
  assert.deepEqual(h.calls, ['lookup', 'approval', 'write']);
});

const candidate = { event_id: eventId, version: 7, title: '检查接口', path: ['目标', '模块', '已有事情'], status: 'working' };
const completionReceipt = { event: { id: eventId, type: 'event', name: candidate.title, status: 'completed', version: 8 } };

async function completeHarness({ preview = candidate, structured = false, mcpError = false,
  outcome = 'allowed-once', abort = false, credential = writeKey, reply, noAgent = false, rootCallId = 'root' } = {}) {
  const { completeEventTool } = await import('./index.js');
  const controller = new AbortController();
  const calls = [], credentials = [], requests = [];
  const agent = {};
  let approval, write;
  const ctx = {
    credentials: { resolve: async name => {
      credentials.push(name);
      return { value: name === 'TODO_DSH_CAPTURE_TOKEN' ? readKey : credential };
    } },
    approval: { request: async req => {
      calls.push('approval'); approval = req;
      if (abort) controller.abort();
      return outcome;
    } },
  };
  const tool = completeEventTool(ctx, async (raw, signature, signal, url) => {
    calls.push('write');
    write = { raw, signature, signal, url };
    return reply ? reply() : Response.json(completionReceipt);
  });
  return {
    calls, credentials, requests, agent, signal: controller.signal,
    get approval() { return approval; }, get write() { return write; },
    async run(overrides = {}) {
      const native = global.fetch;
      global.fetch = async (url, init) => {
        calls.push('lookup');
        requests.push({ url, init, body: JSON.parse(init.body) });
        return Response.json({ result: structured ? { isError: mcpError, structuredContent: preview } :
          { isError: mcpError, content: [{ type: 'text', text: JSON.stringify(preview) }] } });
      };
      try { return await tool.execute({ event_id: eventId, expected_version: 7, ...overrides },
        { agent: noAgent ? undefined : agent, callId: 'nested', rootCallId, signal: controller.signal }); }
      finally { global.fetch = native; }
    },
  };
}

const operationPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

test('Host registers separate create and complete tools with scoped disposers', async () => {
  const { apply } = await import('./index.js');
  const tools = new Map(), effects = [];
  apply({ effect: fn => effects.push(fn()), tools: { register: tool => {
    tools.set(tool.name, tool);
    return () => tools.delete(tool.name);
  } } });
  assert.deepEqual([...tools.keys()], ['todo_create_event', 'todo_complete_event']);
  const { parameters } = tools.get('todo_complete_event');
  assert.deepEqual(parameters.required, ['event_id', 'expected_version']);
  assert.equal(parameters.additionalProperties, false);
  for (const dispose of effects) dispose();
  assert.equal(tools.size, 0);
});

test('complete binds the latest single event, one approval, exact endpoint and HMAC, and compact receipt', async () => {
  const h = await completeHarness();
  const result = JSON.parse(await h.run());
  assert.deepEqual(h.calls, ['lookup', 'approval', 'write']);
  assert.deepEqual(h.credentials, ['TODO_DSH_CAPTURE_TOKEN', 'TODO_DSH_DIRECT_TOKEN']);
  const [{ url, init, body }] = h.requests;
  assert.equal(url, 'http://127.0.0.1:8000/mcp');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, `Bearer ${readKey}`);
  assert.deepEqual(body, { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'get_event_to_complete', arguments: { event_id: eventId } } });
  const { operation_id } = result;
  assert.match(operation_id, operationPattern);
  assert.equal(h.approval.agent, h.agent);
  assert.equal(h.approval.signal, h.signal);
  assert.equal(h.approval.callId, 'root');
  assert.equal(h.approval.toolName, 'todo_complete_event');
  assert.match(h.approval.reason, /标题："检查接口"/);
  assert.match(h.approval.reason, /归属："目标" → "模块" → "已有事情"/);
  assert.match(h.approval.reason, /状态：进行中 → 已完成.*自动催办可能暂停/);
  assert.ok(h.approval.reason.includes(`核对编号：${operation_id}`));
  assert.equal(h.write.url, 'http://127.0.0.1:8000/api/dsh-direct/events/complete');
  assert.ok(!h.write.signal.aborted);
  assert.deepEqual(JSON.parse(h.write.raw), { operation_id, event_id: eventId, expected_version: 7,
    expected_path: candidate.path, expected_title: candidate.title, expected_status: 'working' });
  assert.equal(h.write.signature, createHmac('sha256', writeKey)
    .update('todo-direct-complete-v1\n').update(h.write.raw, 'utf8').digest('hex'));
  assert.deepEqual(result, { status: '已完成正式事件', event_id: eventId, operation_id,
    title: candidate.title, path: candidate.path, version: 8 });
});

test('complete supports not-started preview and the direct approval call ID', async () => {
  const h = await completeHarness({ preview: { ...candidate, status: 'notStarted' }, structured: true, rootCallId: null });
  await h.run();
  assert.match(h.approval.reason, /状态：未开始 → 已完成/);
  assert.equal(h.approval.callId, 'nested');
  assert.equal(JSON.parse(h.write.raw).expected_status, 'notStarted');
});

test('stale or unverifiable completion preview stops before approval', async () => {
  for (const [cfg, error] of [
    [{ preview: { ...candidate, version: 8 } }, /事件已变化/],
    [{ preview: { ...candidate, status: 'completed' } }, /未能核实/],
    [{ preview: { ...candidate, status: 'cancelled' } }, /未能核实/],
    [{ preview: { ...candidate, event_id: thing } }, /未能核实/],
    [{ preview: { ...candidate, title: '伪造\u202e' } }, /未能核实/],
    [{ preview: { ...candidate, path: ['目标', '模块'] } }, /未能核实/],
    [{ preview: null }, /未能核实/],
    [{ mcpError: true, structured: true }, /未能核实/],
  ]) {
    const h = await completeHarness(cfg);
    await assert.rejects(h.run(), error);
    assert.deepEqual(h.calls, ['lookup']);
  }
});

test('completion validates candidate, key separation and approval context without sending requests', async () => {
  for (const [cfg, args] of [[{}, { event_id: 'invalid' }], [{}, { expected_version: '7' }],
    [{}, { expected_version: 1.5 }], [{ credential: '' }, {}], [{ credential: readKey }, {}], [{ noAgent: true }, {}]]) {
    const h = await completeHarness(cfg);
    await assert.rejects(h.run(args));
    assert.deepEqual(h.calls, []);
  }
});

test('completion only writes for allowed-once and never after cancellation', async () => {
  for (const cfg of [{ outcome: 'rejected' }, { outcome: 'unavailable' }, { outcome: 'allowed-always' }, { abort: true }]) {
    const h = await completeHarness(cfg);
    await assert.rejects(h.run());
    assert.deepEqual(h.calls, ['lookup', 'approval']);
  }
});

test('completion never retries a failed, conflicting or mismatched write and refers to the original operation', async () => {
  const replies = [
    () => { throw Error('simulated disconnect'); },
    () => Response.json({ detail: '不可信的响应正文' }, { status: 409 }),
    () => Response.json({}, { status: 500 }),
    () => new Response('not JSON'),
    () => Response.json(completionReceipt, { status: 202 }),
    ...[{ id: thing }, { type: 'thing' }, { name: '其他标题' }, { status: 'working' }, { version: 7 }, { version: 9 }]
      .map(changes => () => Response.json({ event: { ...completionReceipt.event, ...changes } })),
  ];
  for (const reply of replies) {
    const h = await completeHarness({ reply });
    await assert.rejects(h.run(), error => {
      const { operation_id } = JSON.parse(h.write.raw);
      assert.match(operation_id, operationPattern);
      assert.match(error.message, /mcp__todo_capture__get_recorded_event 核对原操作，不要重新完成/);
      assert.ok(error.message.includes(`操作标识：${operation_id}`));
      assert.ok(!error.message.includes('不可信的响应正文'));
      return true;
    });
    assert.deepEqual(h.calls, ['lookup', 'approval', 'write']);
  }
});
