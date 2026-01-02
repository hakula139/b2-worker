import {
  ExecutionContext,
  ExportedHandler,
  type IncomingRequestCfProperties,
} from '@cloudflare/workers-types';

interface Env {
  B2_HOSTNAME: string;
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
}

interface UmamiRequest {
  type: 'event';
  payload: UmamiPageviewPayload;
}

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

const shouldTrackDownload = (request: Request, logicalPath: string): boolean => {
  if (request.method !== 'GET') {
    return false;
  }

  if (logicalPath.endsWith('README.md')) {
    return false;
  }

  // Track both full downloads and first chunk of multi-threaded downloads.
  // - No Range header: Simple browser download or curl / wget
  // - Range: bytes=0-*: First chunk of multi-threaded download manager
  // Note: Some download managers make both types of requests, causing duplicates.
  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) {
    return true;
  }

  const rangeMatch = rangeHeader.match(/bytes=(\d+)-/);
  return Boolean(rangeMatch && rangeMatch[1] === '0');
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
  const referrer = request.headers.get('referer') ?? undefined;
  const acceptLanguage = request.headers.get('accept-language') || 'en-US';
  const { ip, country, city, regionCode } = client;

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
    const url = new URL(request.url);
    const logicalPath = getLogicalPath(url);
    const b2Search = getB2Search(url);
    const newUrl = `https://${env.B2_HOSTNAME}${url.pathname}${b2Search}`;

    const newRequest = new Request(newUrl, request);
    newRequest.headers.set('Host', env.B2_HOSTNAME);

    const response = await fetch(newRequest);

    // Track download with Umami.
    if (response.ok && logicalPath && shouldTrackDownload(request, logicalPath)) {
      const cf = (request as CloudflareRequest).cf;
      const client: ClientGeo = {
        ip: request.headers.get('cf-connecting-ip') ?? undefined,
        country: cf.country ?? request.headers.get('cf-ipcountry') ?? undefined,
        city: cf.city ?? request.headers.get('cf-ipcity') ?? undefined,
        regionCode: cf.regionCode ?? request.headers.get('cf-regioncode') ?? undefined,
      };

      ctx.waitUntil(trackDownload(request, env, logicalPath, client));
    }

    return response;
  },
} satisfies ExportedHandler<Env>;
