# CLAUDE.md — b2-worker

## Project Overview

b2-worker is a Cloudflare Workers proxy in front of [Backblaze B2](https://www.backblaze.com/cloud-storage), exposing private B2 buckets at <https://b2.hakula.xyz> while leveraging the [Cloudflare Bandwidth Alliance](https://www.cloudflare.com/bandwidth-alliance/) so egress stays free. It serves two upstream clients: [Cloudreve](https://github.com/cloudreve/Cloudreve) (which already pre-signs S3 URLs) and PeerTube (which expects unsigned object reads). Download events are mirrored into [Umami](https://umami.is/) for per-file analytics.

### Repo Layout

```text
.
├── .github/workflows/
│   └── ci.yml                  # PR validation: type/format/lint/spell (deploy = Cloudflare Workers Builds)
├── src/
│   ├── worker.ts               # fetch entry: CORS, cache, dispatch
│   ├── s3.ts                   # B2 forwarding (presigned passthrough or AWS sign)
│   ├── cache.ts                # edge-cache helpers
│   ├── analytics.ts            # Umami event reporting with per-IP dedup
│   └── types.ts                # Env interface
├── wrangler.toml
├── package.json
├── tsconfig.json
└── .cspell.json
```

## Stack

- **Runtime**: Cloudflare Workers (V8 isolate). No `nodejs_compat` flag — pure Web APIs only.
- **B2 access**: Either passthrough of pre-signed S3 URLs, or worker-side signing via [`aws4fetch`](https://github.com/mhart/aws4fetch).
- **Edge cache**: Cloudflare Cache API (`caches.default`) for object responses; capped to 100 MB to stay under the 128 MB worker memory limit.
- **Analytics**: HTTP POST to a self-hosted Umami instance; per-IP / per-path / per-day dedup via short-TTL cache entries.

## Build & Deploy

### Local development

```bash
pnpm install
pnpm dev                     # wrangler dev on port 8787
pnpm check                   # tsc --noEmit
```

### Manual deploy

```bash
pnpm wrangler login                              # one-time OAuth
pnpm wrangler secret put B2_ACCESS_KEY_ID        # private bucket signing
pnpm wrangler secret put B2_SECRET_ACCESS_KEY
pnpm deploy
```

### CI deploy

Cloudflare Workers Builds is connected to this repo and auto-deploys on every push. Production branch is `main`; non-production branches get preview builds. The pipeline runs `pnpm i` then `pnpm run deploy` (and `pnpm run upload` for uploads). Manage at _Workers & Pages → b2 → Settings → Build_.

GitHub Actions only runs `ci.yml` for code-quality validation (type / lint / format / spell). Deploy lives entirely on Cloudflare's side, so no `CLOUDFLARE_*` repo secrets are needed.

## Coding Conventions

### TypeScript

- Worker entry exports a default object satisfying `ExportedHandler<Env>`.
- `Env` is hand-written in `src/types.ts`. Optional secrets (`?`) so the public-bucket path runs without them.
- File naming: kebab-case.
- Imports: type imports first, then value imports, grouped by source.
- Sparse comments — only when _why_ is non-obvious (V8 quirk, AWS SigV4 detail, upstream client contract).

### Secrets discipline

The repo is **public**. Anything sensitive goes through `wrangler secret put` — never into `wrangler.toml` or source. The Umami website ID is committed because it's a public identifier, not an auth token.

### Git Conventions

- Commit messages: `type(scope): description`
  - Types: `feat`, `fix`, `refactor`, `docs`, `test`, `ci`, `chore`, `style`, `perf`.
  - Scope: most specific area changed (e.g., `s3`, `cache`, `analytics`, `ci`).
- One logical change per commit.
- Branches: `<type>/<short-name>`.

## Verification

Run after implementation and before review:

```bash
pnpm check                   # tsc --noEmit
pnpm lint                    # eslint
pnpm format                  # prettier --check
pnpm spellcheck              # cspell
```

`pnpm dev` is the smoke test for runtime behavior — wrangler dev hits the live B2 endpoint unless `--local` is passed.
