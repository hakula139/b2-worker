import { AwsClient } from 'aws4fetch';
import {
  ExecutionContext,
  ExportedHandler,
  type IncomingRequestCfProperties,
} from '@cloudflare/workers-types';
import { formatInTimeZone } from 'date-fns-tz';

interface Env {
  B2_HOSTNAME: string;
  B2_ACCESS_KEY_ID?: string;
  B2_SECRET_ACCESS_KEY?: string;
  UMAMI_ENDPOINT?: string;
  UMAMI_WEBSITE_ID?: string;
}

interface CloudflareRequest extends Request {
  cf: IncomingRequestCfProperties;
}

interface ClientGeo {
  ip?: string;
  country?: string;
  city?: string;
  regionCode?: string;
}

interface UmamiPageviewPayload {
  website: string;
  hostname: string;
  url: string;
  title: string;
  referrer?: string;
  screen: string;
  language: string;
  id?: string;
}

interface UmamiRequest {
  type: 'event';
  payload: UmamiPageviewPayload;
}

// Extract S3 region from B2 hostname (e.g., "s3.us-west-004.backblazeb2.com" -> "us-west-004")
const getRegion = (hostname: string): string => {
  const match = hostname.match(/^s3\.(.+)\.backblazeb2\.com$/);
  return match?.[1] ?? 'us-west-004';
};

// Check if the request already carries S3 pre-signed query parameters
const isPresigned = (url: URL): boolean => url.searchParams.has('X-Amz-Signature');

const getLogicalPath = (url: URL): string | undefined => {
  const logicalPath = url.searchParams.get('logical_path');
  if (!logicalPath) {
    return undefined;
  }
  return logicalPath.startsWith('/') ? logicalPath : `/${logicalPath}`;
};

const getB2Search = (url: URL): string => {
  const b2Params = new URLSearchParams(url.search);
  b2Params.delete('logical_path');
  const b2Search = b2Params.toString();
  return b2Search ? `?${b2Search}` : '';
};

const hashToHex = async (input: string, length = 16): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hash));
  return hashArray
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, length);
};

const getDateStr = (date: Date): string => formatInTimeZone(date, 'Asia/Shanghai', 'yyyy-MM-dd');

const generateSessionId = async (ip: string, date: Date): Promise<string> => {
  const dateStr = getDateStr(date);
  return hashToHex(`${ip}|${dateStr}`, 16);
};

const shouldTrackDownload = (request: Request, logicalPath: string): boolean => {
  if (request.method !== 'GET') {
    return false;
  }

  // Ignore README.md.
  if (logicalPath.endsWith('README.md')) {
    return false;
  }

  // Track full downloads and first chunk of multi-threaded downloads.
  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) {
    return true;
  }
  const rangeMatch = rangeHeader.match(/bytes=(\d+)-/);
  return Boolean(rangeMatch && rangeMatch[1] === '0');
};

const DOWNLOAD_DEDUPE_TTL_SECONDS = 30;

const generateDedupeKey = async (ip: string, logicalPath: string, date: Date): Promise<string> => {
  const dateStr = getDateStr(date);
  return hashToHex(`${ip}|${logicalPath}|${dateStr}`, 16);
};

// Deduplicate download events within a small time window.
const shouldSendDownloadEvent = async (
  logicalPath: string,
  client: ClientGeo,
): Promise<boolean> => {
  const dedupeKey = await generateDedupeKey(client.ip ?? '', logicalPath, new Date());

  const cacheKey = new Request(`https://cache-key.invalid/umami/${dedupeKey}`);
  const cache = caches.default;

  if (await cache.match(cacheKey)) {
    return false;
  }

  await cache.put(
    cacheKey,
    new Response('1', {
      headers: {
        'Cache-Control': `max-age=${DOWNLOAD_DEDUPE_TTL_SECONDS}`,
      },
    }),
  );
  return true;
};

const trackDownload = async (
  request: Request,
  env: Env,
  logicalPath: string,
  client: ClientGeo,
): Promise<void> => {
  if (!env.UMAMI_ENDPOINT || !env.UMAMI_WEBSITE_ID) {
    return;
  }

  const userAgent = request.headers.get('user-agent') ?? '';
  const referrer = request.headers.get('referer') ?? '';
  const acceptLanguage = request.headers.get('accept-language') || 'en-US';
  const { ip, country, city, regionCode } = client;
  const sessionId = ip ? await generateSessionId(ip, new Date()) : undefined;

  const payload: UmamiRequest = {
    type: 'event',
    payload: {
      website: env.UMAMI_WEBSITE_ID,
      hostname: 'cloud.hakula.xyz',
      url: logicalPath,
      title: logicalPath,
      referrer,
      screen: '1920x1080',
      language: acceptLanguage.split(',')[0],
      ...(sessionId ? { id: sessionId } : {}),
    },
  };

  try {
    const response = await fetch(env.UMAMI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
        ...(ip ? { 'CF-Connecting-IP': ip, 'X-Real-IP': ip, 'X-Forwarded-For': ip } : {}),
        ...(country ? { 'CF-IPCountry': country } : {}),
        ...(city ? { 'CF-IPCity': city } : {}),
        ...(regionCode ? { 'CF-RegionCode': regionCode } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`Umami rejected event: ${response.status}`, await response.text());
    }
  } catch (error) {
    console.error('Failed to send Umami event:', error);
  }
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Short-circuit CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);
    const logicalPath = getLogicalPath(url);
    const b2Search = getB2Search(url);
    const b2Url = `https://${env.B2_HOSTNAME}${url.pathname}${b2Search}`;

    let response: Response;

    if (!isPresigned(url) && env.B2_ACCESS_KEY_ID && env.B2_SECRET_ACCESS_KEY) {
      // Unsigned requests to private buckets: sign with B2 credentials
      const aws = new AwsClient({
        accessKeyId: env.B2_ACCESS_KEY_ID,
        secretAccessKey: env.B2_SECRET_ACCESS_KEY,
        region: getRegion(env.B2_HOSTNAME),
        service: 's3',
      });
      const signedRequest = await aws.sign(b2Url, { method: request.method });
      response = await fetch(signedRequest);
    } else {
      // Pre-signed requests (e.g., from Cloudreve) or no credentials configured: forward as-is
      const b2Request = new Request(b2Url, request);
      b2Request.headers.set('Host', env.B2_HOSTNAME);
      response = await fetch(b2Request);
    }

    // Track download with Umami (Cloudreve only, triggered by logical_path param).
    if (response.ok && logicalPath && shouldTrackDownload(request, logicalPath)) {
      const cf = (request as CloudflareRequest).cf;
      const client: ClientGeo = {
        ip: request.headers.get('cf-connecting-ip') ?? undefined,
        country: cf.country ?? request.headers.get('cf-ipcountry') ?? undefined,
        city: cf.city ?? request.headers.get('cf-ipcity') ?? undefined,
        regionCode: cf.regionCode ?? request.headers.get('cf-regioncode') ?? undefined,
      };

      if (await shouldSendDownloadEvent(logicalPath, client)) {
        // Track download event in the background to avoid blocking the response.
        ctx.waitUntil(trackDownload(request, env, logicalPath, client));
      }
    }

    // Add CORS headers for cross-origin media playback.
    const corsResponse = new Response(response.body, response);
    corsResponse.headers.set('Access-Control-Allow-Origin', '*');
    corsResponse.headers.set(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Content-Type',
    );

    return corsResponse;
  },
} satisfies ExportedHandler<Env>;
