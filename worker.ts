import { ExecutionContext, ExportedHandler } from '@cloudflare/workers-types';

export interface Env {
  B2_HOSTNAME: string;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const originalPath = url.pathname;
    const newPath = `/file${originalPath}`;
    const newUrl = new URL(newPath, `https://${env.B2_HOSTNAME}`);

    // Forward all query parameters (including signature parameters for private buckets)
    for (const [key, value] of url.searchParams) {
      newUrl.searchParams.set(key, value);
    }

    const newRequest = new Request(newUrl, request);
    newRequest.headers.set('Host', env.B2_HOSTNAME);

    return await fetch(newRequest);
  },
} satisfies ExportedHandler<Env>;
