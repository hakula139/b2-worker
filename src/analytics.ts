import type { ExecutionContext, IncomingRequestCfProperties } from '@cloudflare/workers-types';
import { formatInTimeZone } from 'date-fns-tz';
import type { Env } from './types';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DOWNLOAD_DEDUPE_TTL_SECONDS = 30;

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

const hashToHex = async (input: string, length = 16): Promise<string> => {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, length);
};

const getDateStr = (date: Date): string => formatInTimeZone(date, 'Asia/Shanghai', 'yyyy-MM-dd');

// -----------------------------------------------------------------------------
// Logical Path
// -----------------------------------------------------------------------------

const getLogicalPath = (url: URL): string | undefined => {
  const logicalPath = url.searchParams.get('logical_path');
  if (!logicalPath) return undefined;
  return logicalPath.startsWith('/') ? logicalPath : `/${logicalPath}`;
};

// -----------------------------------------------------------------------------
// Download Tracking
// -----------------------------------------------------------------------------

const shouldTrackDownload = (request: Request, logicalPath: string): boolean => {
  if (request.method !== 'GET') return false;
  if (logicalPath.endsWith('README.md')) return false;

  // Track full downloads and first chunk of multi-threaded downloads.
  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) return true;
  const rangeMatch = rangeHeader.match(/bytes=(\d+)-/);
  return Boolean(rangeMatch && rangeMatch[1] === '0');
};

const generateSessionId = async (ip: string, date: Date): Promise<string> =>
  hashToHex(`${ip}|${getDateStr(date)}`, 16);

const generateDedupeKey = async (ip: string, logicalPath: string, date: Date): Promise<string> =>
  hashToHex(`${ip}|${logicalPath}|${getDateStr(date)}`, 16);

// Deduplicate download events within a small time window.
const shouldSendDownloadEvent = async (
  logicalPath: string,
  client: ClientGeo,
): Promise<boolean> => {
  const dedupeKey = await generateDedupeKey(client.ip ?? '', logicalPath, new Date());
  const cacheKey = new Request(`https://cache-key.invalid/umami/${dedupeKey}`);
  const cache = caches.default;

  if (await cache.match(cacheKey)) return false;

  await cache.put(
    cacheKey,
    new Response('1', {
      headers: { 'Cache-Control': `max-age=${DOWNLOAD_DEDUPE_TTL_SECONDS}` },
    }),
  );
  return true;
};

const sendUmamiEvent = async (
  request: Request,
  env: Env,
  logicalPath: string,
  client: ClientGeo,
): Promise<void> => {
  if (!env.UMAMI_ENDPOINT || !env.UMAMI_WEBSITE_ID) return;

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

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

// Track download with Umami if applicable (Cloudreve only, triggered by logical_path param).
export const trackIfNeeded = async (
  request: Request,
  response: Response,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> => {
  const logicalPath = getLogicalPath(url);
  if (!response.ok || !logicalPath || !shouldTrackDownload(request, logicalPath)) return;

  const cf = (request as CloudflareRequest).cf;
  const client: ClientGeo = {
    ip: request.headers.get('cf-connecting-ip') ?? undefined,
    country: cf.country ?? request.headers.get('cf-ipcountry') ?? undefined,
    city: cf.city ?? request.headers.get('cf-ipcity') ?? undefined,
    regionCode: cf.regionCode ?? request.headers.get('cf-regioncode') ?? undefined,
  };

  if (await shouldSendDownloadEvent(logicalPath, client)) {
    ctx.waitUntil(sendUmamiEvent(request, env, logicalPath, client));
  }
};
