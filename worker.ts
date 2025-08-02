import { ExecutionContext, ExportedHandler } from '@cloudflare/workers-types';

export interface Env {
  B2_HOSTNAME: string;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const newUrl = `https://${env.B2_HOSTNAME}${url.pathname}${url.search}`;

    const newRequest = new Request(newUrl, request);
    newRequest.headers.set('Host', env.B2_HOSTNAME);

    return await fetch(newRequest);
  },
} satisfies ExportedHandler<Env>;
