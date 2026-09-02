/**
 * Real token-usage capture for kimi-proxy.
 *
 * The Kimi CLI's one-shot mode (-p) prints no token counts on stdout, but
 * every run writes its session wire log under
 *   $HOME/.kimi-code/sessions/<wd_dir>/<session_id>/agents/<agent>/wire.jsonl
 * containing per-request records shaped like:
 *   {"type":"usage.record","agentId":"main","model":"kimi-code/k3",
 *    "usage":{"inputOther":9712,"output":21,"inputCacheRead":20992,
 *             "inputCacheCreation":0},"usageScope":"turn","time":1788340137141}
 * (verified on CLI v0.39.1, 2026-09-02).
 *
 * The session id is emitted by the CLI itself:
 *   - stream-json mode: a {"role":"meta","type":"session.resume_hint",
 *     "session_id":"session_..."} line on stdout
 *   - text mode: "To resume this session: kimi -r session_<id>" on stderr
 */

const fs = require('fs');
const path = require('path');

const SESSION_ID_RE = /session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Find the session id of a finished CLI run.
 * Scans stdout lines for the stream-json resume-hint meta line first,
 * then falls back to a regex over stderr (text mode) and stdout.
 */
function extractSessionId(output, stderr) {
  for (const line of (output || '').split('\n')) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.type === 'session.resume_hint' &&
          typeof parsed.session_id === 'string') {
        return parsed.session_id;
      }
    } catch {
      // plain text line
    }
  }
  const m = SESSION_ID_RE.exec(stderr || '') || SESSION_ID_RE.exec(output || '');
  return m ? m[0] : null;
}

/**
 * Sum all usage.record entries written for a session since `sinceMs`
 * (epoch ms; pass 0 to count everything). The time filter keeps resumed
 * sessions (--session) from re-counting earlier requests' usage.
 * Returns the summed raw usage {inputOther, output, inputCacheRead,
 * inputCacheCreation} or null when no records were found.
 */
function readSessionUsage(homeDir, sessionId, sinceMs) {
  if (!sessionId) return null;
  const sessionsRoot = path.join(homeDir, '.kimi-code', 'sessions');
  let wdDirs;
  try {
    wdDirs = fs.readdirSync(sessionsRoot);
  } catch {
    return null;
  }

  const sum = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
  let records = 0;

  for (const wdDir of wdDirs) {
    const agentsDir = path.join(sessionsRoot, wdDir, sessionId, 'agents');
    let agents;
    try {
      agents = fs.readdirSync(agentsDir);
    } catch {
      continue; // session not under this working-dir bucket
    }
    for (const agent of agents) {
      const wireFile = path.join(agentsDir, agent, 'wire.jsonl');
      let content;
      try {
        content = fs.readFileSync(wireFile, 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        if (!line.includes('"usage.record"')) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type !== 'usage.record' || !rec.usage) continue;
        if (sinceMs && typeof rec.time === 'number' && rec.time < sinceMs) continue;
        for (const key of Object.keys(sum)) {
          if (typeof rec.usage[key] === 'number') sum[key] += rec.usage[key];
        }
        records += 1;
      }
    }
  }

  return records > 0 ? sum : null;
}

/**
 * Map raw CLI usage to the OpenAI shape. prompt_tokens counts every input
 * token the request consumed, including cached prefixes (matching how the
 * provider meters them); the cache split is kept in the extra fields.
 * Falls back to the chars/4 estimate (estimated:true) when no real usage
 * could be parsed, so downstream consumers can tell the difference.
 */
function toOpenAiUsage(raw, promptChars, completionChars) {
  if (raw && typeof raw.output === 'number') {
    const other = raw.inputOther || 0;
    const cacheRead = raw.inputCacheRead || 0;
    const cacheCreation = raw.inputCacheCreation || 0;
    const prompt = other + cacheRead + cacheCreation;
    return {
      prompt_tokens: prompt,
      completion_tokens: raw.output,
      total_tokens: prompt + raw.output,
      input_other_tokens: other,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreation,
      estimated: false
    };
  }
  const p = Math.ceil((promptChars || 0) / 4);
  const c = Math.ceil((completionChars || 0) / 4);
  return {
    prompt_tokens: p,
    completion_tokens: c,
    total_tokens: p + c,
    estimated: true
  };
}

module.exports = { extractSessionId, readSessionUsage, toOpenAiUsage };
