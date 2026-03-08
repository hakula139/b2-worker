import { AwsClient } from 'aws4fetch';
import type { Env } from './types';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

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
// Pre-signed URLs (Cloudreve) already carry valid S3 auth signed against B2's
// hostname and are forwarded as-is. Unsigned requests (PeerTube) are signed
// with the worker's own B2 credentials.
export const fetchFromB2 = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const b2Search = stripLogicalPath(url.search);
  const b2Url = `https://${env.B2_HOSTNAME}${url.pathname}${b2Search}`;

  if (isPresigned(url)) {
    // Pre-signed URLs (e.g., from Cloudreve) already carry valid S3 auth
    // params signed against B2's hostname. Forward as-is.
    const b2Request = new Request(b2Url, {
      method: request.method,
      headers: pickS3SafeHeaders(request),
    });
    return fetch(b2Request);
  }

  if (env.B2_ACCESS_KEY_ID && env.B2_SECRET_ACCESS_KEY) {
    // Unsigned requests (e.g., from PeerTube): sign with our own B2 credentials
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

  // No credentials and no pre-signed params: forward unsigned (public buckets only)
  const b2Request = new Request(b2Url, {
    method: request.method,
    headers: pickS3SafeHeaders(request),
  });
  return fetch(b2Request);
};
