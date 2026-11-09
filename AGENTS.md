# AGENTS.md: b2-worker

Read [README.md](README.md) for setup, configuration, and deployment.

## Worker contracts

- Use Web APIs available in Cloudflare Workers. The runtime has no `nodejs_compat` flag.
- Preserve pre-signed S3 URLs without modification. Sign unsigned upstream requests with `aws4fetch` when private bucket credentials are available.
- Keep cached object responses below 100 MB to fit the Worker's 128 MB memory limit.
- The entry exports a default object satisfying `ExportedHandler<Env>`. `Env` lives in `src/types.ts`, with optional secrets so public buckets work without them.
- Keep filenames kebab-case and group type imports before value imports.

## Operations

- Store secrets through Wrangler, with local values in ignored files. The Umami website ID is public configuration.
- Development requests can reach live B2 and analytics endpoints. Runtime verification requires authorization before external requests.
- Cloudflare Workers Builds owns deployment. Changes to GitHub CI must preserve its production and preview builds.

## Verification

```bash
pnpm check
pnpm lint
pnpm format
pnpm spellcheck
```
