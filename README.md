# Kimi Proxy

Turn your **Kimi Code CLI** membership into a simple HTTP API on your home network.

Any app, script, or AI coder agent on the same Wi-Fi can send a prompt and get a response — no API keys in the app, no cloud billing surprises.

```
┌─────────────┐   HTTP (LAN)   ┌─────────────┐   CLI   ┌─────────────┐
│  Your app   │ ─────────────→ │  kimi-proxy │ ──────→ │  Kimi Code  │
│  / agent    │                │  (Docker)   │         │  (Allegro)  │
└─────────────┘                └─────────────┘         └─────────────┘
```

## What you need

- A computer/server that stays on (a mini-PC, old laptop, NAS, etc.).
- [Docker](https://docs.docker.com/get-docker/) + Docker Compose installed.
- A **Kimi Code CLI** account with an active membership/quota.
- Both devices on the same network (or VPN).

> **Not a Kimi user?** This same pattern works for Claude Code, Codex, Grok Build, or any CLI that accepts a prompt. See [Adapting to other AI tools](#adapting-to-other-ai-tools).

---

## Easiest setup: paste this to your AI coder

Copy the block below and paste it into **Claude Code**, **Kimi**, **Grok Build**, or any coding agent:

```text
Set up the repo https://github.com/bitcopath/kimi-proxy on my Docker server.

Steps:
1. Clone it.
2. Copy .env.example to .env and ask me for the correct HOST_KIMI_CODE_PATH and SERVER_PORT.
3. Build and start with docker compose up -d.
4. Open Portainer (or ssh into the server), enter the kimi-proxy container console, and run `kimi login` so I can authenticate.
5. Test with: curl http://THIS_SERVER_IP:SERVER_PORT/health
6. Report the working URL.
```

---

## Manual setup

### 1. Clone the repo

```bash
git clone https://github.com/bitcopath/kimi-proxy.git
cd kimi-proxy
```

### 2. Copy the example environment file

```bash
cp .env.example .env
```

### 3. Edit `.env`

The only value you really need is `HOST_KIMI_CODE_PATH`.

| Variable | What to put | Example |
|----------|-------------|---------|
| `SERVER_PORT` | Free port on your server. | `8083` |
| `HOST_KIMI_CODE_PATH` | Where Kimi Code stores your login on the server. | `/home/yourname/.kimi-code` |
| `KIMI_TIMEOUT_MS` | How long one call can run. | `300000` (5 min) |
| `LOG_LEVEL` | How chatty the logs are. | `info` |
| `LOG_SENSITIVE` | Set to `true` only while debugging. | `false` |

**How to find `HOST_KIMI_CODE_PATH`:**

```bash
# On the Docker server, run:
ls -la ~/.kimi-code
# Use that full path in .env
```

### 4. Start the container

```bash
docker compose up -d --build
```

### 5. Log in to Kimi inside the container

The container has the Kimi CLI installed, but **you** must authenticate it once. The easiest way is through **Portainer**:

1. Install [Portainer CE](https://docs.portainer.io/start/install) (free web UI for Docker).
2. Open Portainer → **Containers** → click `kimi-proxy`.
3. Click **Console** → **Connect**.
4. Run `kimi login` and follow the device-auth / browser steps.

See [docs/PORTAINER_SETUP.md](docs/PORTAINER_SETUP.md) for screenshots.

> Alternative: `docker exec -it kimi-proxy bash` then `kimi login`.

### 6. Test

Find your server IP (usually in your router admin or with `ip addr` on Linux).

```bash
curl http://YOUR_SERVER_IP:8083/health
```

You should get `{"status":"ok"}`.

```bash
curl -sS http://YOUR_SERVER_IP:8083/query \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Say hello in one sentence."}'
```

---

## API

### `POST /query`

```json
{
  "prompt": "Explain Docker in one paragraph.",
  "sessionId": "optional-resume-id",
  "model": "optional-model-id"
}
```

Response:

```json
{
  "success": true,
  "response": "Docker is...",
  "durationMs": 3200,
  "requestId": "req_...",
  "sessionId": "optional-resume-id"
}
```

### `GET /health`

Returns `{"status":"ok"}` when the proxy is alive and can find the Kimi binary.

---

## Use it from your app

```javascript
const res = await fetch('http://YOUR_SERVER_IP:8083/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'Write a todo list for today.' })
});
const data = await res.json();
console.log(data.response);
```

---

## Adapting to other AI tools

The wrapper is tiny on purpose. To adapt it:

1. Replace the CLI binary name (`kimi`) with `claude`, `codex`, `grok`, or whatever.
2. Replace the CLI flags in `runKimi()` with that tool's headless prompt flags.
3. Adjust response parsing if the tool returns JSON differently.

See [bitcopath/grok-proxy](https://github.com/bitcopath/grok-proxy) for the same pattern applied to Grok Build.

---

## Security notes

- Keep this on your home network or VPN. Do not expose the port to the public internet.
- Your Kimi auth lives only in the mounted host path (`HOST_KIMI_CODE_PATH`), not in the repo.
- `LOG_SENSITIVE=false` by default so prompts and responses are not written to disk.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Cannot connect` from another computer | Same Wi-Fi/VPN? Firewall? Check `YOUR_SERVER_IP`. |
| `Kimi CLI not found` | Did `docker compose up -d --build` finish? Check `kimi --version` inside the container console. |
| `Not signed in` / auth error | Run `kimi login` inside the container console. |
| `Missing required variable HOST_KIMI_CODE_PATH` | You forgot to copy `.env.example` → `.env` or left the placeholder path. |

---

## License

MIT — see [LICENSE](LICENSE).
