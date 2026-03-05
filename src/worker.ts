import type { ExecutionContext, ExportedHandler } from '@cloudflare/workers-types';
import type { Env } from './types';
import { fetchFromB2 } from './s3';
import { getCached, cacheIfEligible } from './cache';
import { trackIfNeeded } from './analytics';

// -----------------------------------------------------------------------------
// CORS
// -----------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
};

const withCors = (response: Response): Response => {
  const res = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.headers.set(key, value);
  }
  return res;
};

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    const cached = await getCached(request);
    if (cached) {
      return withCors(cached);
    }

    let response = await fetchFromB2(request, url, env);
    response = cacheIfEligible(request, response, ctx);

    await trackIfNeeded(request, response, url, env, ctx);

    return withCors(response);
  },
} satisfies ExportedHandler<Env>;
