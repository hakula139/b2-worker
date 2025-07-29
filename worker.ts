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
    const newRequest = new Request(newUrl, request);
    newRequest.headers.set('Host', env.B2_HOSTNAME);

    const response = await fetch(newRequest);
    if (!response.ok) {
      return response;
    }

    const newResponse = new Response(response.body, response);
    // Split the filename into two parts: UUID and original filename
    const originalFilename = originalPath.split('/').pop()?.split('_', 2).at(1);
    if (originalFilename) {
      // Set the Content-Disposition header to force the browser to download the file with the original filename
      newResponse.headers.set(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(originalFilename)}`,
      );
    }

    return newResponse;
  },
} satisfies ExportedHandler<Env>;
