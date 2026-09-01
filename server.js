/**
 * Kimi Proxy
 * HTTP → Kimi Code CLI → JSON response.
 * Lets any app on your LAN call Kimi through a membership you already have.
 */

const http = require('http');
const { spawn } = require('child_process');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ============================================================================
// Configuration
// ============================================================================
const SERVICE_VERSION = '3.1.0';
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOGS_DIR = process.env.LOGS_DIR || path.join(__dirname, 'logs');
const KIMI_TIMEOUT_MS = parseInt(process.env.KIMI_TIMEOUT_MS, 10) || 300000;
const KIMI_CODE_BIN_DIR = process.env.KIMI_CODE_BIN_DIR || '/root/.kimi-code/bin';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_SENSITIVE = process.env.LOG_SENSITIVE === 'true';

// ============================================================================
// Logging
// ============================================================================
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}
const logFile = path.join(LOGS_DIR, `kimi-proxy-${new Date().toISOString().split('T')[0]}.log`);

const logger = pino({
  level: LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: 'kimi-proxy', version: SERVICE_VERSION }
}, pino.multistream([
  { stream: process.stdout },
  { stream: fs.createWriteStream(logFile, { flags: 'a' }) }
]));

logger.info({ logFile, sensitiveLogging: LOG_SENSITIVE }, 'Kimi proxy started logging');

// ============================================================================
// Resolve Kimi binary
// ============================================================================
function resolveKimiBin() {
  const candidates = [
    process.env.KIMI_BIN,
    '/usr/local/bin/kimi',
    path.join(KIMI_CODE_BIN_DIR, 'kimi')
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return 'kimi';
}

const KIMI_BIN = resolveKimiBin();

function kimiEnv() {
  const basePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  const pathParts = basePath.split(':').filter(Boolean);
  if (!pathParts.includes(KIMI_CODE_BIN_DIR)) {
    pathParts.unshift(KIMI_CODE_BIN_DIR);
  }
  return {
    ...process.env,
    PATH: pathParts.join(':'),
    HOME: process.env.HOME || '/root',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TERM: 'dumb'
  };
}

logger.info({ kimiBin: KIMI_BIN }, `Resolved Kimi binary: ${KIMI_BIN}`);

// ============================================================================
// Request tracking
// ============================================================================
class RequestTracker {
  constructor() {
    this.counter = 0;
  }
  next() {
    return `req_${Date.now()}_${++this.counter}`;
  }
}
const tracker = new RequestTracker();

// ============================================================================
// Run Kimi CLI
// ============================================================================
function runKimi(prompt, sessionId, requestId, options = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const args = [];

    if (sessionId) {
      args.push('--session', sessionId);
    }

    args.push('--prompt', prompt);
    args.push('--output-format', options.outputFormat || 'text');

    if (options.model) {
      args.push('--model', options.model);
    }

    // Extra CLI flags (e.g. ['--agent-file', path] for the /v1 brain mode)
    if (Array.isArray(options.extraArgs) && options.extraArgs.length) {
      args.push(...options.extraArgs);
    }

    logger.info({
      requestId,
      type: 'kimi_start',
      kimiBin: KIMI_BIN,
      promptLength: prompt.length,
      sessionId: sessionId || null,
      hasSession: !!sessionId,
      model: options.model || null,
      ...(LOG_SENSITIVE ? { fullPrompt: prompt, args } : {})
    }, `[${requestId}] Starting Kimi CLI (${prompt.length} chars, session: ${sessionId || 'none'})`);

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const kimi = spawn(KIMI_BIN, args, {
      cwd: DATA_DIR,
      env: kimiEnv()
    });

    let output = '';
    let stderr = '';
    let firstDataTime = null;
    let lineBuf = '';

    kimi.stdout.on('data', (d) => {
      if (!firstDataTime) firstDataTime = Date.now();
      const chunk = d.toString();
      output += chunk;

      // NDJSON line callback for stream-json consumers (the /v1 surface)
      if (options.onLine) {
        lineBuf += chunk;
        let idx;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx).trim();
          lineBuf = lineBuf.slice(idx + 1);
          if (line) {
            try {
              options.onLine(JSON.parse(line));
            } catch {
              // non-JSON line — ignore
            }
          }
        }
      }
      logger.debug({
        requestId,
        type: 'kimi_stdout_chunk',
        chunkLength: chunk.length,
        ...(LOG_SENSITIVE ? { chunk: chunk.substring(0, 500) } : {})
      }, `[${requestId}] stdout chunk (${chunk.length} chars)`);
    });

    kimi.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      logger.warn({
        requestId,
        type: 'kimi_stderr',
        chunkLength: chunk.length,
        ...(LOG_SENSITIVE ? { chunk: chunk.substring(0, 400) } : {})
      }, `[${requestId}] stderr (${chunk.length} chars)`);
    });

    const timeout = setTimeout(() => {
      kimi.kill();
      reject(new Error(`Kimi timeout after ${KIMI_TIMEOUT_MS}ms`));
    }, KIMI_TIMEOUT_MS);

    kimi.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - start;
      const timeToFirstData = firstDataTime ? firstDataTime - start : null;

      logger.info({
        requestId,
        type: 'kimi_complete',
        exitCode: code,
        durationMs: duration,
        timeToFirstDataMs: timeToFirstData,
        outputLength: output.length,
        stderrLength: stderr.length,
        sessionId: sessionId || null,
        ...(LOG_SENSITIVE ? { fullOutput: output, stderr } : {})
      }, `[${requestId}] Kimi complete in ${duration}ms`);

      if (code !== 0) {
        reject(new Error(`Kimi exited with code ${code}: ${stderr || output}`));
        return;
      }

      let responseText = output.trim();
      const lines = output.trim().split('\n');
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.result?.content?.[0]?.text) {
            responseText = parsed.result.content[0].text;
            break;
          }
          if (typeof parsed.text === 'string') {
            responseText = parsed.text;
            break;
          }
          if (typeof parsed.response === 'string') {
            responseText = parsed.response;
            break;
          }
        } catch {
          // plain text line
        }
      }

      logger.info({
        requestId,
        type: 'kimi_response',
        responseLength: responseText.length,
        // CLI emits no token counts (checked v0.39.1) — chars/4 estimate so
        // the stats collector gets per-request usage. estimated:true marks it.
        usage: {
          prompt_tokens: Math.ceil(prompt.length / 4),
          completion_tokens: Math.ceil(responseText.length / 4),
          total_tokens: Math.ceil((prompt.length + responseText.length) / 4),
          estimated: true
        },
        ...(LOG_SENSITIVE ? { responseText } : {})
      }, `[${requestId}] Final response (${responseText.length} chars)`);

      resolve(responseText);
    });

    kimi.on('error', (error) => {
      clearTimeout(timeout);
      logger.error({
        requestId,
        type: 'kimi_error',
        error: error.message
      }, `[${requestId}] Kimi process error: ${error.message}`);
      reject(error);
    });
  });
}

// ============================================================================
// OpenAI-compatible /v1 surface (see openai.js)
// ============================================================================
const { createV1Handler } = require('./openai');
const v1 = createV1Handler({ runKimi, logger });

// ============================================================================
// HTTP server
// ============================================================================
const server = http.createServer(async (req, res) => {
  const requestId = tracker.next();
  const startTime = Date.now();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const reqPath = (req.url || '').split('?')[0];

  // OpenAI-compatible surface: GET /v1/models
  if (reqPath === '/v1/models' && req.method === 'GET') {
    if (!v1.authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid API key', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(v1.modelsPayload()));
    return;
  }

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'kimi-proxy',
      version: SERVICE_VERSION,
      kimiBin: KIMI_BIN,
      kimiBinExists: KIMI_BIN === 'kimi' ? null : fs.existsSync(KIMI_BIN),
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      logFile
    }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    try {
      logger.info({
        requestId,
        type: 'http_request',
        method: req.method,
        url: req.url,
        bodyLength: body.length,
        ...(LOG_SENSITIVE ? { fullBody: body } : {})
      }, `[${requestId}] HTTP ${req.method} ${req.url} (${body.length} chars)`);

      const data = JSON.parse(body);

      // OpenAI-compatible chat completions → headless Kimi brain
      if (reqPath === '/v1/chat/completions') {
        if (!v1.authorized(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid API key', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }));
          return;
        }
        await v1.handleChat(req, res, requestId, data);
        return;
      }

      if (!data.prompt) {
        logger.error({ requestId, type: 'missing_prompt' }, 'Missing prompt');
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing prompt' }));
        return;
      }

      logger.info({
        requestId,
        type: 'request_received',
        promptLength: data.prompt.length,
        sessionId: data.sessionId || null,
        hasSession: !!data.sessionId,
        model: data.model || null,
        ...(LOG_SENSITIVE ? { fullPrompt: data.prompt } : {})
      }, `[${requestId}] Request (session: ${data.sessionId || 'none'})`);

      const result = await runKimi(data.prompt, data.sessionId, requestId, {
        model: data.model,
        outputFormat: data.outputFormat || 'text'
      });
      const duration = Date.now() - startTime;

      logger.info({
        requestId,
        type: 'http_response',
        durationMs: duration,
        responseLength: result.length,
        ...(LOG_SENSITIVE ? { fullResponse: result } : {})
      }, `[${requestId}] Response sent in ${duration}ms`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        response: result,
        durationMs: duration,
        requestId,
        sessionId: data.sessionId || null
      }));
    } catch (error) {
      logger.error({
        requestId,
        type: 'request_error',
        error: error.message,
        stack: error.stack
      }, `[${requestId}] Error: ${error.message}`);

      res.writeHead(500);
      res.end(JSON.stringify({
        success: false,
        error: error.message,
        requestId
      }));
    }
  });
});

server.listen(PORT, () => {
  logger.info({
    type: 'server_started',
    port: PORT,
    version: SERVICE_VERSION,
    kimiBin: KIMI_BIN,
    sensitiveLogging: LOG_SENSITIVE,
    logFile
  }, `Kimi proxy v${SERVICE_VERSION} listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  logger.info({ type: 'shutdown', signal: 'SIGTERM' }, 'Shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  logger.info({ type: 'shutdown', signal: 'SIGINT' }, 'Shutting down...');
  server.close(() => process.exit(0));
});
