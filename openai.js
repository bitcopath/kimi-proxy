/**
 * OpenAI-compatible /v1 surface for kimi-proxy.
 *
 * Translates chat-completions requests into headless Kimi CLI runs:
 *   - Stateless: the full messages array is flattened into one prompt per call.
 *   - Brain-only: runs with agents/openai-brain.md (tools disabled).
 *   - tool_calls translation via a JSON output contract (see the agent file);
 *     unparseable output degrades gracefully to plain content.
 *   - Optional Bearer auth when PROXY_API_KEY is set.
 *
 * No new dependencies — wired into server.js's existing runKimi().
 */

const path = require('path');

const AGENT_FILE = path.join(__dirname, 'agents', 'openai-brain.md');
const MODEL_ID = process.env.KIMI_V1_MODEL || 'kimi-code';
const API_KEY = process.env.PROXY_API_KEY || '';

// ============================================================================
// Message flattening (OpenAI messages -> transcript prompt)
// ============================================================================

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p;
      if (p && p.type === 'text') return p.text || '';
      if (p && p.type === 'image_url') return '[image omitted: not supported by this endpoint]';
      return '';
    }).filter(Boolean).join('\n');
  }
  return String(content);
}

function flattenMessages(messages) {
  const parts = [];
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    if (m.role === 'system') {
      parts.push('[system]\n' + textOf(m.content));
    } else if (m.role === 'user') {
      parts.push('[user]\n' + textOf(m.content));
    } else if (m.role === 'assistant') {
      let block = '[assistant]\n' + textOf(m.content);
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        block += '\n[assistant tool_calls]\n' + m.tool_calls.map((tc) => {
          const fn = tc.function || {};
          return `${fn.name || 'unknown'}(${fn.arguments || '{}'})`;
        }).join('\n');
      }
      parts.push(block);
    } else if (m.role === 'tool') {
      parts.push(`[tool result: ${m.name || m.tool_call_id || 'tool'}]\n` + textOf(m.content));
    }
  }
  return parts.join('\n\n');
}

function buildPrompt(messages, tools) {
  let prompt = flattenMessages(messages);
  if (Array.isArray(tools) && tools.length) {
    prompt += '\n\nAVAILABLE TOOLS (JSON schemas):\n' + JSON.stringify(tools);
    prompt += '\n\nRespond per the output contract.';
  }
  prompt += '\n\n[assistant]\n';
  return prompt;
}

// ============================================================================
// Output-contract parsing (tool_calls mode)
// ============================================================================

function parseContract(raw) {
  let text = (raw || '').trim();
  if (!text) return { content: '' };
  // Strip markdown fences if the model added them anyway
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (obj && obj.type === 'tool_calls' && Array.isArray(obj.calls)) {
        const toolCalls = obj.calls
          .filter((c) => c && c.name)
          .map((c, i) => ({
            id: `call_${Date.now()}_${i}`,
            type: 'function',
            function: {
              name: String(c.name),
              arguments: typeof c.arguments === 'string'
                ? c.arguments
                : JSON.stringify(c.arguments || {})
            }
          }));
        if (toolCalls.length) return { toolCalls };
      }
      if (obj && obj.type === 'final' && typeof obj.content === 'string') {
        return { content: obj.content };
      }
    } catch {
      // fall through to graceful degradation
    }
  }
  // Model ignored the contract — return its text as plain content
  return { content: (raw || '').trim() };
}

// ============================================================================
// Handler factory (wired with server.js's runKimi)
// ============================================================================

function createV1Handler({ runKimi, logger }) {
  function authorized(req) {
    if (!API_KEY) return true;
    return (req.headers.authorization || '') === `Bearer ${API_KEY}`;
  }

  function modelsPayload() {
    return {
      object: 'list',
      data: [{
        id: MODEL_ID,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'kimi-proxy'
      }]
    };
  }

  function openaiError(message, type = 'invalid_request_error', code = null) {
    return { error: { message, type, param: null, code } };
  }

  function sseHeaders(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
  }

  function sseSend(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function chunkPayload(id, model, delta, finishReason) {
    return {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    };
  }

  async function handleChat(req, res, requestId, data) {
    const messages = data.messages;
    if (!Array.isArray(messages) || !messages.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(openaiError('messages must be a non-empty array')));
      return;
    }

    const tools = Array.isArray(data.tools) && data.tools.length ? data.tools : null;
    const wantStream = data.stream === true;
    const prompt = buildPrompt(messages, tools);
    const completionId = `chatcmpl-${requestId}`;

    logger.info({
      requestId,
      type: 'v1_chat_request',
      messageCount: messages.length,
      hasTools: !!tools,
      toolCount: tools ? tools.length : 0,
      stream: wantStream,
      promptLength: prompt.length
    }, `[${requestId}] /v1/chat/completions (msgs: ${messages.length}, tools: ${tools ? tools.length : 0}, stream: ${wantStream})`);

    const streaming = wantStream && !tools; // contract (tools) mode is buffered, see below
    if (wantStream) sseHeaders(res);

    const contentParts = [];
    const onLine = (obj) => {
      if (obj && obj.role === 'assistant' && typeof obj.content === 'string') {
        contentParts.push(obj.content);
        if (streaming) {
          sseSend(res, chunkPayload(completionId, MODEL_ID, { content: obj.content }, null));
        }
      }
    };

    try {
      await runKimi(prompt, null, requestId, {
        outputFormat: 'stream-json',
        extraArgs: ['--agent-file', AGENT_FILE],
        onLine
      });
    } catch (error) {
      logger.error({ requestId, type: 'v1_chat_error', error: error.message },
        `[${requestId}] /v1/chat/completions failed: ${error.message}`);
      if (wantStream) {
        sseSend(res, openaiError(`backend error: ${error.message}`, 'server_error'));
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(openaiError(`backend error: ${error.message}`, 'server_error')));
      }
      return;
    }

    let content = contentParts.join('\n');
    let toolCalls = null;
    if (tools) {
      const parsed = parseContract(content);
      if (parsed.toolCalls) {
        toolCalls = parsed.toolCalls;
        content = null;
      } else {
        content = parsed.content;
      }
    }

    logger.info({
      requestId,
      type: 'v1_chat_response',
      contentLength: content ? content.length : 0,
      toolCalls: toolCalls ? toolCalls.map((t) => t.function.name) : null
    }, `[${requestId}] /v1/chat/completions done (tool_calls: ${toolCalls ? toolCalls.length : 0})`);

    if (wantStream) {
      if (tools) {
        // Buffered contract mode: emit the mapped message as one chunk
        const delta = toolCalls
          ? { role: 'assistant', tool_calls: toolCalls }
          : { role: 'assistant', content };
        sseSend(res, chunkPayload(completionId, MODEL_ID, delta, null));
      }
      sseSend(res, chunkPayload(completionId, MODEL_ID, {}, toolCalls ? 'tool_calls' : 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {})
        },
        finish_reason: toolCalls ? 'tool_calls' : 'stop'
      }]
    }));
  }

  return { authorized, modelsPayload, handleChat, MODEL_ID };
}

module.exports = { createV1Handler };
