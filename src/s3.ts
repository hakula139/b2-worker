import { AwsClient } from 'aws4fetch';
import type { Env } from './types';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// S3 authentication query parameters — must be stripped before re-signing
const S3_AUTH_PARAMS = new Set([
  'X-Amz-Algorithm',
  'X-Amz-Content-Sha256',
  'X-Amz-Credential',
  'X-Amz-Date',
  'X-Amz-Expires',
  'X-Amz-Signature',
  'X-Amz-SignedHeaders',
  'X-Amz-Security-Token',
]);

// Only forward these headers to B2 — Cloudflare-injected headers (x-real-ip,
// cf-connecting-ip, etc.) get signed by aws4fetch but stripped from the
// outbound fetch, causing B2 to reject the request with InvalidRequest.
const S3_SAFE_HEADERS = ['range', 'if-none-match', 'if-modified-since'];

// -----------------------------------------------------------------------------
// URL / Query String Helpers
// -----------------------------------------------------------------------------

// Filter params from a raw query string without round-tripping through
// URLSearchParams, which re-encodes with application/x-www-form-urlencoded
// rules (%20 → +) and breaks AWS Signature V4 pre-signed URLs.
const filterRawParams = (raw: string, predicate: (param: string) => boolean): string => {
  if (!raw) {
    return '';
  }
  const cleaned = raw.substring(1).split('&').filter(predicate).join('&');
  return cleaned ? `?${cleaned}` : '';
};

const isPresigned = (url: URL): boolean => url.searchParams.has('X-Amz-Signature');

// Strip `logical_path` (Cloudreve analytics param) from the raw query string.
const stripLogicalPath = (raw: string): string =>
  filterRawParams(raw, (p) => !p.startsWith('logical_path='));

// Strip S3 auth params, preserving response overrides (e.g., response-content-disposition).
const stripS3AuthParams = (raw: string): string =>
  filterRawParams(raw, (p) => !S3_AUTH_PARAMS.has(p.split('=')[0]));

// -----------------------------------------------------------------------------
// S3 / B2
// -----------------------------------------------------------------------------

// Extract S3 region from B2 hostname (e.g., "s3.us-west-004.backblazeb2.com" → "us-west-004")
const getRegion = (hostname: string): string => {
  const match = hostname.match(/^s3\.(.+)\.backblazeb2\.com$/);
  return match?.[1] ?? 'us-west-004';
};

const pickS3SafeHeaders = (request: Request): Headers => {
  const headers = new Headers();
  for (const name of S3_SAFE_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
};

// Fetch an object from B2, handling both pre-signed and unsigned requests.
//
// When credentials are available, all requests are re-signed by the worker.
// Pre-signed URLs from upstream (PeerTube, Cloudreve) embed the CDN host
// (b2.hakula.xyz) in their signature, which won't match when forwarded to
// B2 (s3.us-west-004.backblazeb2.com). Stripping the auth params and
// re-signing preserves response overrides like response-content-disposition.
export const fetchFromB2 = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const b2Search = stripLogicalPath(url.search);

  if (env.B2_ACCESS_KEY_ID && env.B2_SECRET_ACCESS_KEY) {
    const b2SearchFinal = isPresigned(url) ? stripS3AuthParams(b2Search) : b2Search;
    const b2Url = `https://${env.B2_HOSTNAME}${url.pathname}${b2SearchFinal}`;

    const aws = new AwsClient({
      accessKeyId: env.B2_ACCESS_KEY_ID,
      secretAccessKey: env.B2_SECRET_ACCESS_KEY,
      region: getRegion(env.B2_HOSTNAME),
      service: 's3',
    });
    const signedRequest = await aws.sign(b2Url, {
      method: request.method,
      headers: pickS3SafeHeaders(request),
    });
    return fetch(signedRequest);
  }

  // No credentials configured: forward as-is (best effort for pre-signed URLs)
  const b2Url = `https://${env.B2_HOSTNAME}${url.pathname}${b2Search}`;
  const b2Request = new Request(b2Url, request);
  b2Request.headers.set('Host', env.B2_HOSTNAME);
  return fetch(b2Request);
};
