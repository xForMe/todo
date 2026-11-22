import { createHmac, randomUUID } from 'node:crypto';
import { request } from 'node:http';

export const inject = ['tools', 'approval', 'credentials'];
const origin = 'http://127.0.0.1:8000';
const createName = 'todo_create_event';
const completeName = 'todo_complete_event';
const createPath = '/api/dsh-direct/events';
const completePath = '/api/dsh-direct/events/complete';
const openStatuses = new Map([['notStarted', '未开始'], ['working', '进行中']]);
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
const control = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const validDate = text => !text || (/^\d{4}-\d{2}-\d{2}$/.test(text) && !text.startsWith('0000') &&
  Number.isFinite(Date.parse(text)) && new Date(text).toISOString().slice(0, 10) === text);

function bounded(text, limit, allowNewline = false) {
  if (typeof text !== 'string' || Array.from(text).length > limit || /[\uD800-\uDFFF]/u.test(text) ||
      control.test(allowNewline ? text.replaceAll('\n', '') : text)) {
    throw Error('事件内容格式无效，请核对长度和控制字符。');
  }
  return text.trim();
}

async function jsonResponse(response) {
  if (!response.ok) throw Error('本机行间请求未成功。');
  return response.json();
}

async function readMcp(key, name, args, signal) {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const { result } = await jsonResponse(response);
  if (!result || result.isError) throw Error('只读查询未成功。');
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? 'null');
}

const validName = text => typeof text === 'string' && text && bounded(text, 120) === text;
const validPath = path => Array.isArray(path) && path.length === 3 && path.every(validName);

async function findExact(key, id, signal) {
  const value = await readMcp(key, 'find_matters', { query: id }, signal);
  const match = value?.matters?.[0];
  if (value?.truncated !== false || value?.matters?.length !== 1 || match?.thing_id !== id ||
      !Number.isSafeInteger(match?.version) || match.version < 1 || !validPath(match.path)) {
    throw Error('没有核实到唯一有效的事情；未创建，请先选择归属。');
  }
  return match;
}

const quoted = value => JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const displayPath = path => path.map(quoted).join(' → ');

function createApprovalMessage(data) {
  return [
    '是否在行间创建以下正式事件（未开始）？', `标题：${quoted(data.title)}`,
    `归属：${displayPath(data.expected_path)}`, `截止：${data.planned_date || '未设置'}`,
    `责任人：${data.owner ? quoted(data.owner) : '未指定'}`, `说明：${data.description ? quoted(data.description) : '无'}`,
    `核对编号：${data.operation_id}`,
  ].join(' ｜ ');
}

function completeApprovalMessage(data) {
  return [
    '是否在行间将这个正式事件标为已完成？', `标题：${quoted(data.expected_title)}`,
    `归属：${displayPath(data.expected_path)}`, `状态：${openStatuses.get(data.expected_status)} → 已完成`,
    '此事件的自动催办可能暂停', `核对编号：${data.operation_id}`,
  ].join(' ｜ ');
}

export function postNative(body, signature, signal, url = `${origin}${createPath}`) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Todo-Approval': `v1=${signature}` },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('error', reject);
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) res.destroy(Error('响应超过上限'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode === 200,
        json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(body, 'utf8');
  });
}

function requireApprovalContext(exec, action) {
  if (!exec.agent || !exec.callId) throw Error(`无法核实当前会话批准，未${action}事件。`);
  exec.signal.throwIfAborted();
}

async function resolveKeys(ctx, action) {
  const readKey = (await ctx.credentials.resolve('TODO_DSH_CAPTURE_TOKEN'))?.value;
  const writeKey = (await ctx.credentials.resolve('TODO_DSH_DIRECT_TOKEN'))?.value;
  if (!tokenPattern.test(readKey ?? '') || !tokenPattern.test(writeKey ?? '') || readKey === writeKey) {
    throw Error(`尚未配置独立的行间写入凭据，未${action}事件。`);
  }
  return { readKey, writeKey };
}

const createWrite = { name: createName, path: createPath, domain: 'todo-direct-create-v1\n', action: '创建',
  conflict: '归属或操作已变化，请先核对原操作再重新选择。' };
const completeWrite = { name: completeName, path: completePath, domain: 'todo-direct-complete-v1\n', action: '完成' };

async function writeApproved(ctx, exec, writeKey, { name, path, domain, action, conflict }, data, reason, post, verified) {
  const body = JSON.stringify(data);
  exec.signal.throwIfAborted();
  const outcome = await ctx.approval.request({ agent: exec.agent, callId: exec.rootCallId ?? exec.callId,
    toolName: name, reason, signal: exec.signal });
  if (outcome !== 'allowed-once') throw Error(`本次未获批准，未${action}正式事件。`);
  exec.signal.throwIfAborted();
  const signature = createHmac('sha256', writeKey).update(domain).update(body, 'utf8').digest('hex');
  const operation = `操作标识：${data.operation_id}`;
  const recover = `保存结果待核对。${operation}。请调用 mcp__todo_capture__get_recorded_event 核对原操作，不要重新${action}。`;
  // The action and operation ID stay in the approval prompt even if the turn is interrupted.
  let response;
  try {
    response = await post(body, signature, AbortSignal.any([exec.signal, AbortSignal.timeout(15000)]), `${origin}${path}`);
  } catch { throw Error(recover); }
  if (response?.status === 409) throw Error(conflict ? conflict + operation : recover);
  if ([400, 401, 403, 404, 413, 415, 422].includes(response?.status)) {
    throw Error(`行间拒绝了本次请求，未${action}事件。请核对凭据、归属和输入。`);
  }
  if (response?.status !== 200) throw Error(recover);
  let event;
  try { ({ event } = await jsonResponse(response)); } catch { throw Error(recover); }
  if (!verified(event)) throw Error(recover);
  return event;
}

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(createEventTool(ctx)));
  ctx.effect(() => ctx.tools.register(completeEventTool(ctx)));
}

export function createEventTool(ctx, post = postNative) {
  return {
    name: createName,
    description: '仅在用户明确要求录入单个待办时使用；对具体事件请求一次 Harness 批准，然后直接写入行间。归属不明先向用户澄清。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['thing_id', 'title'],
      properties: {
        thing_id: { type: 'string', description: '从 mcp__todo_capture__find_matters 取得的已有事情 ID。' },
        title: { type: 'string', description: '事件名称，最多 120 字。' },
        owner: { type: 'string', description: '用户明确指定的责任人，最多 80 字。未知可不传。' },
        planned_date: { type: 'string', description: '用户指定的截止日期，YYYY-MM-DD；未知可不传。' },
        description: { type: 'string', description: '用户选定的必要说明，最多 500 字；不传全量会话。' },
      },
    },
    output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] },
    async execute(args, exec) {
      requireApprovalContext(exec, createWrite.action);
      const id = String(args.thing_id ?? '').toLowerCase();
      const title = bounded(args.title, 120);
      const owner = bounded(args.owner ?? '', 80);
      const planned_date = bounded(args.planned_date ?? '', 10);
      const description = bounded(args.description ?? '', 500, true);
      if (!uuid.test(id) || !title || !validDate(planned_date)) throw Error('请提供有效的已有事情、标题及日期。');
      const { readKey, writeKey } = await resolveKeys(ctx, createWrite.action);
      let match;
      try { match = await findExact(readKey, id, exec.signal); }
      catch { throw Error('未能核实归属，未创建事件。请检查行间连接，或重新选择已有事情。'); }
      const operation_id = randomUUID();
      const data = { operation_id, thing_id: id, expected_version: match.version, expected_path: match.path,
        title, owner, planned_date, description };
      const event = await writeApproved(ctx, exec, writeKey, createWrite, data, createApprovalMessage(data), post,
        event => event?.type === 'event' && uuid.test(event.id ?? '') && event.parent === id && event.name === title &&
          event.owner === owner && event.planEnd === planned_date && event.description === description && event.status === 'notStarted');
      return JSON.stringify({ status: '已创建正式事件', event_id: event.id, operation_id, title, path: data.expected_path });
    },
  };
}

export function completeEventTool(ctx, post = postNative) {
  return {
    name: completeName,
    description: '仅在用户明确要求将单个已有事件标为完成且已确定目标时使用。核对当前状态和归属，经用户批准后标为已完成；没有可靠候选或有多个合理候选时先向用户澄清。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['event_id', 'expected_version'],
      properties: {
        event_id: { type: 'string', description: '从 mcp__todo_capture__locate_event 返回的已确定候选取得的事件 ID。' },
        expected_version: { type: 'integer', minimum: 1, maximum: 2_147_483_647,
          description: '同一候选返回的 version，不要向用户索取或猜测。' },
      },
    },
    output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] },
    async execute(args, exec) {
      requireApprovalContext(exec, completeWrite.action);
      const event_id = typeof args.event_id === 'string' ? args.event_id.toLowerCase() : '';
      const { expected_version } = args;
      if (!uuid.test(event_id) || !Number.isSafeInteger(expected_version) || expected_version < 1 || expected_version > 2_147_483_647) {
        throw Error('请先定位并选择一个有效的已有事件，未完成事件。');
      }
      const { readKey, writeKey } = await resolveKeys(ctx, completeWrite.action);
      let preview;
      try {
        preview = await readMcp(readKey, 'get_event_to_complete', { event_id }, exec.signal);
        if (preview?.event_id !== event_id || !openStatuses.has(preview.status) || !validName(preview.title) || !validPath(preview.path)) {
          throw Error('事件不可用。');
        }
      } catch {
        throw Error('未能核实该未结束事件，未完成事件。请检查行间连接或重新定位。');
      }
      if (preview.version !== expected_version) throw Error('事件已变化，未完成事件。请重新定位并核对。');
      const data = { operation_id: randomUUID(), event_id, expected_version, expected_path: preview.path,
        expected_title: preview.title, expected_status: preview.status };
      const event = await writeApproved(ctx, exec, writeKey, completeWrite, data, completeApprovalMessage(data), post,
        event => event?.type === 'event' && event.id === event_id && event.name === data.expected_title &&
          event.status === 'completed' && event.version === expected_version + 1);
      return JSON.stringify({ status: '已完成正式事件', event_id, operation_id: data.operation_id,
        title: event.name, path: data.expected_path, version: event.version });
    },
  };
}
