# b2-worker

A Cloudflare Worker that proxies requests to [Backblaze B2](https://www.backblaze.com/cloud-storage), enabling free egress through the [Cloudflare Bandwidth Alliance](https://www.cloudflare.com/bandwidth-alliance/).

## Features

- **Private bucket support**: Signs requests with AWS Signature V4 for private B2 buckets, so files are only accessible through Cloudflare (no direct B2 egress charges)
- **Pre-signed URL passthrough**: Forwards pre-signed S3 URLs (e.g., from [Cloudreve](https://github.com/cloudreve/Cloudreve)) without modification
- **Download tracking**: Tracks file downloads via [Umami](https://umami.is/) analytics, with per-IP deduplication

## Setup

```bash
pnpm install
```

## Configuration

Public configuration is in `wrangler.toml`:

| Variable           | Description                   |
| ------------------ | ----------------------------- |
| `B2_HOSTNAME`      | B2 S3-compatible API endpoint |
| `UMAMI_ENDPOINT`   | Umami analytics API URL       |
| `UMAMI_WEBSITE_ID` | Umami website ID for tracking |

Secrets are set via Wrangler CLI (required for private bucket signing):

```bash
wrangler secret put B2_ACCESS_KEY_ID
wrangler secret put B2_SECRET_ACCESS_KEY
```

## Development

```bash
pnpm dev     # Start local dev server on port 8787
pnpm check   # Type-check
```

## Deployment

```bash
pnpm deploy
```
