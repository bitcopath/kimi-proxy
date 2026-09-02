/**
 * Unit tests for the /v1 thinking-only retry logic (openai.js).
 * Fully mocked: no live kimi CLI calls, no network.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createV1Handler, isThinkingOnlyCompletion } = require('../openai');

// ============================================================================
// Mocks
// ============================================================================

function mockLogger() {
  const entries = { info: [], warn: [], error: [] };
  return {
    entries,
    info: (obj, msg) => entries.info.push({ obj, msg }),
    warn: (obj, msg) => entries.warn.push({ obj, msg }),
    error: (obj, msg) => entries.error.push({ obj, msg })
  };
}

function mockRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    write(chunk) {
      this.body += chunk;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    }
  };
}

/**
 * Build a runKimi mock from a list of attempt scripts.
 * Each script: { content?: string, usage?: object, error?: Error }.
 * `content` is emitted as one stream-json assistant line via options.onLine.
 */
function mockRunKimi(scripts) {
  const calls = [];
  const runKimi = async (prompt, sessionId, requestId, options = {}) => {
    const script = scripts[Math.min(calls.length, scripts.length - 1)];
    calls.push({ prompt, sessionId, requestId, options });
    if (script.error) throw script.error;
    if (script.content && options.onLine) {
      options.onLine({ role: 'assistant', content: script.content });
    }
    return {
      response: script.content || '',
      usage: script.usage || null,
      sessionId: 'session_mock',
      durationMs: 1
    };
  };
  return { runKimi, calls };
}

const USAGE_A = { inputOther: 100, output: 50, inputCacheRead: 0, inputCacheCreation: 0 };
const USAGE_B = { inputOther: 200, output: 60, inputCacheRead: 0, inputCacheCreation: 0 };

function makeHandler(scripts) {
  const logger = mockLogger();
  const { runKimi, calls } = mockRunKimi(scripts);
  const v1 = createV1Handler({ runKimi, logger });
  return { v1, calls, logger };
}

const DATA = { messages: [{ role: 'user', content: 'hi' }] };

// ============================================================================
// isThinkingOnlyCompletion
// ============================================================================

test('isThinkingOnlyCompletion: empty content + no tool_calls is thinking-only', () => {
  assert.equal(isThinkingOnlyCompletion('', null), true);
  assert.equal(isThinkingOnlyCompletion(null, null), true);
  assert.equal(isThinkingOnlyCompletion('   \n  ', undefined), true);
  assert.equal(isThinkingOnlyCompletion('', []), true);
});

test('isThinkingOnlyCompletion: text or tool_calls means normal completion', () => {
  assert.equal(isThinkingOnlyCompletion('hello', null), false);
  assert.equal(isThinkingOnlyCompletion('', [{ id: 'call_1' }]), false);
  assert.equal(isThinkingOnlyCompletion(null, [{ id: 'call_1' }]), false);
});

// ============================================================================
// Normal passthrough (no retry)
// ============================================================================

test('normal response passes through with a single CLI call', async () => {
  const { v1, calls, logger } = makeHandler([{ content: 'Hello there', usage: USAGE_A }]);
  const res = mockRes();
  await v1.handleChat({}, res, 'req_test_normal', DATA);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env, undefined, 'first attempt must not set retry env');
  assert.equal(res.status, 200);

  const body = JSON.parse(res.body);
  assert.equal(body.choices[0].message.content, 'Hello there');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.usage.estimated, false);
  assert.equal(body.usage.prompt_tokens, 100);
  assert.equal(body.usage.completion_tokens, 50);
  assert.equal(logger.entries.warn.length, 0, 'no retry warnings on the happy path');
});

// ============================================================================
// Thinking-only -> retry with bigger budget -> success
// ============================================================================

test('thinking-only first attempt retries with effort=low and a bigger budget', async () => {
  const { v1, calls, logger } = makeHandler([
    { content: '', usage: USAGE_A },        // thinking-only
    { content: 'Recovered answer', usage: USAGE_B }
  ]);
  const res = mockRes();
  await v1.handleChat({}, res, 'req_test_retry', DATA);

  assert.equal(calls.length, 2);

  const retryEnv = calls[1].options.env;
  assert.ok(retryEnv, 'retry attempt must pass env knobs');
  assert.equal(retryEnv.KIMI_MODEL_THINKING_EFFORT, 'low');
  assert.equal(retryEnv.KIMI_MODEL_MAX_COMPLETION_TOKENS, '65536');

  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.choices[0].message.content, 'Recovered answer');

  // Usage must reflect BOTH actual CLI calls.
  assert.equal(body.usage.estimated, false);
  assert.equal(body.usage.prompt_tokens, 300);
  assert.equal(body.usage.completion_tokens, 110);

  const retries = logger.entries.warn.filter((e) => e.obj.type === 'v1_thinking_only_retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].obj.retry, 1);
});

// ============================================================================
// Thinking-only on all attempts -> 502
// ============================================================================

test('thinking-only on every attempt returns 502 with a clear error', async () => {
  const { v1, calls, logger } = makeHandler([
    { content: '', usage: USAGE_A },
    { content: ' \n ', usage: USAGE_A },
    { content: '', usage: USAGE_A }
  ]);
  const res = mockRes();
  await v1.handleChat({}, res, 'req_test_502', DATA);

  assert.equal(calls.length, 3, 'initial attempt + 2 retries');
  assert.equal(calls[1].options.env.KIMI_MODEL_MAX_COMPLETION_TOKENS, '65536');
  assert.equal(calls[2].options.env.KIMI_MODEL_MAX_COMPLETION_TOKENS, '131072');
  assert.equal(calls[2].options.env.KIMI_MODEL_THINKING_EFFORT, 'low');

  assert.equal(res.status, 502);
  const body = JSON.parse(res.body);
  assert.match(body.error.message, /thinking-only response after 2 retries; retry the request/);
  assert.equal(body.error.code, 'thinking_only');

  const exhausted = logger.entries.error.filter((e) => e.obj.type === 'v1_thinking_only_exhausted');
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].obj.attempts, 3);
});

test('no content is fabricated when retries are exhausted', async () => {
  const { v1 } = makeHandler([{ content: '' }, { content: '' }, { content: '' }]);
  const res = mockRes();
  await v1.handleChat({}, res, 'req_test_nofab', DATA);

  assert.equal(res.status, 502);
  const body = JSON.parse(res.body);
  assert.ok(!body.choices, 'must not return a fabricated completion');
});

// ============================================================================
// Streaming mode: exhausted retries -> SSE error event
// ============================================================================

test('streaming request gets an SSE error (not a fabricated chunk) after exhausted retries', async () => {
  const { v1, calls } = makeHandler([{ content: '' }, { content: '' }, { content: '' }]);
  const res = mockRes();
  await v1.handleChat({}, res, 'req_test_sse', { ...DATA, stream: true });

  assert.equal(calls.length, 3);
  assert.equal(res.status, 200, 'SSE headers are sent before the attempts run');
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.match(res.body, /thinking-only response after 2 retries/);
  assert.match(res.body, /data: \[DONE\]/);
  assert.doesNotMatch(res.body, /finish_reason":"stop/, 'must not emit a fake stop chunk');
});

// ============================================================================
// Streaming happy path still streams content chunks
// ============================================================================

test('streaming normal response streams content then stop', async () => {
  const { v1, calls } = makeHandler([{ content: 'streamed!', usage: USAGE_A }]);
  const res = mockRes();
  await v1.handleChat({}, res, 'req_test_sse_ok', { ...DATA, stream: true });

  assert.equal(calls.length, 1);
  assert.match(res.body, /streamed!/);
  assert.match(res.body, /finish_reason":"stop/);
  assert.match(res.body, /data: \[DONE\]/);
});
