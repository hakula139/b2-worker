import { ExecutionContext, ExportedHandler } from '@cloudflare/workers-types';

export interface Env {
  B2_HOSTNAME: string;
  UMAMI_ENDPOINT?: string;
  UMAMI_WEBSITE_ID?: string;
}

interface UmamiEventPayload {
  hostname: string;
  screen: string;
  language: string;
  url: string;
  referrer?: string;
  title: string;
  website: string;
  name: string;
  data?: Record<string, unknown>;
}

interface UmamiRequest {
  type: 'event';
  payload: UmamiEventPayload;
}

const getLogicalPath = (url: URL): string | undefined => {
  const logicalPath = url.searchParams.get('logical_path');
  return logicalPath?.startsWith('/') ? logicalPath : `/${logicalPath}`;
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

  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) {
    return true;
  }

  // Only track once for multi-threaded downloads.
  const rangeMatch = rangeHeader.match(/bytes=(\d+)-/);
  return Boolean(rangeMatch && rangeMatch[1] === '0');
};

const trackDownload = async (request: Request, env: Env, path: string): Promise<void> => {
  if (!env.UMAMI_ENDPOINT || !env.UMAMI_WEBSITE_ID) {
    return;
  }

  const url = new URL(request.url);
  const userAgent = request.headers.get('user-agent') ?? '';
  const referrer = request.headers.get('referer') ?? '';
  const acceptLanguage = request.headers.get('accept-language') || 'en-US';
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const country = request.headers.get('cf-ipcountry') ?? '';
  const city = request.headers.get('cf-ipcity') ?? '';
  const regionCode = request.headers.get('cf-regioncode') ?? '';

  const payload: UmamiRequest = {
    type: 'event',
    payload: {
      hostname: url.hostname,
      screen: '1920x1080',
      language: acceptLanguage.split(',')[0],
      url: path,
      referrer: referrer,
      title: `Download: ${path}`,
      website: env.UMAMI_WEBSITE_ID,
      name: 'file-download',
    },
  };

  try {
    await fetch(env.UMAMI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
        ...(ip ? { 'CF-Connecting-IP': ip, 'X-Forwarded-For': ip, 'X-Real-IP': ip } : {}),
        ...(country ? { 'CF-IPCountry': country } : {}),
        ...(city ? { 'CF-IPCity': city } : {}),
        ...(regionCode ? { 'CF-RegionCode': regionCode } : {}),
      },
      body: JSON.stringify(payload),
    });
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
      ctx.waitUntil(trackDownload(request, env, logicalPath));
    }

    return response;
  },
} satisfies ExportedHandler<Env>;
