# kimi-proxy (PUBLIC mirror) — Agent Notes

Sanitized public mirror of the private dev repo `~/projects/kimi-proxy`.
Pushes go to github.com/bitcopath/kimi-proxy ONLY (never the business
GitHub account; remote: git@github.com-bitcopath).

## Sync rule (prevents drift — established 2026-08-31)

- Code arrives here ONLY as sanitized copies from the private dev repo.
  Never develop directly in this mirror.
- Sanitization bar: no IPs/hostnames, no internal project names, no secrets,
  no .env, no private compose files, no customer references.
- Version bumps happen here at release time and must immediately be
  back-mirrored to the private repo so versions never diverge.
- Verify remote identity before pushing: `ssh -T git@github.com-bitcopath`
  must answer "Hi bitcopath!".
