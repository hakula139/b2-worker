import type { ExecutionContext } from '@cloudflare/workers-types';

const B2_CACHE_TTL_SECONDS = 86400;

// response.clone() tees the ReadableStream, holding the entire body in memory
// until both branches are consumed. Workers have a 128 MB memory limit, so
// caching large files kills the worker mid-stream.
const B2_CACHE_MAX_SIZE = 100 * 1024 * 1024; // 100 MB

const isCacheableRequest = (request: Request): boolean =>
  request.method === 'GET' || request.method === 'HEAD';

const isCacheableResponse = (response: Response): boolean =>
  response.status === 200 &&
  Number(response.headers.get('content-length') ?? 0) <= B2_CACHE_MAX_SIZE;

export const getCached = async (request: Request): Promise<Response | null> => {
  if (!isCacheableRequest(request)) {
    return null;
  }
  return (await caches.default.match(request)) ?? null;
};

// Cache full responses at the edge.
// Skip 206 Partial Content (Cache API rejects it) and large files
// (response.clone() would exhaust the 128 MB worker memory limit).
export const cacheIfEligible = (
  request: Request,
  response: Response,
  ctx: ExecutionContext,
): Response => {
  if (!isCacheableRequest(request) || !isCacheableResponse(response)) {
    return response;
  }

  const cached = new Response(response.body, response);
  cached.headers.set('Cache-Control', `public, max-age=${B2_CACHE_TTL_SECONDS}`);
  ctx.waitUntil(caches.default.put(request, cached.clone()));
  return cached;
};
