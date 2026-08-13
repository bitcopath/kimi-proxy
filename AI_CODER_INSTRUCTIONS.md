# AI Coder Instructions

**For Claude Code, Kimi, Grok Build, or any coding agent.**

A human wants to run this repo on their Docker server. Do the setup for them, ask only when you truly need input, and never invent values.

## Context

This repo wraps the **Kimi Code CLI** in a small HTTP server so apps on the same LAN can call it.

## Setup steps

1. Clone `https://github.com/bitcopath/kimi-proxy.git` on the target Docker server.
2. `cd kimi-proxy`
3. `cp .env.example .env`
4. Ask the human:
   - What is the full host path to their Kimi Code config/auth dir? ( usually `~/.kimi-code` )
   - What free port should the proxy use? (default `8083`)
5. Write those values into `.env`.
6. Run `docker compose up -d --build`.
7. Verify the container is running: `docker ps | grep kimi-proxy`.
8. Guide the human to authenticate Kimi inside the container once:
   - Option A (easiest): open Portainer → Containers → kimi-proxy → Console → run `kimi login`.
   - Option B: `docker exec -it kimi-proxy bash` then `kimi login`.
9. Test health from the server: `curl http://localhost:8083/health` (use their chosen port).
10. Tell the human the LAN URL: `http://<server-ip>:<port>`.

## Rules

- Do **not** put the human's Kimi password or auth token in any file, env var, or chat.
- Do **not** expose the proxy port to the public internet.
- If Docker is not installed, install Docker + Docker Compose first or stop and ask the human.
- If the Kimi CLI install step inside the Dockerfile fails, check network connectivity and Kimi Code CLI availability in the human's region.

## One-line summary

> Build and run the Docker container, mount the host's `~/.kimi-code` into it, then run `kimi login` inside the container console.
