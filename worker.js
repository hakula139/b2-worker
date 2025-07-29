export default {
  async fetch(request) {
    const b2Hostname = 'f004.backblazeb2.com';

    const url = new URL(request.url);
    const originalPath = url.pathname;
    const newPath = `/file${originalPath}`;
    const newUrl = new URL(newPath, `https://${b2Hostname}`);
    const newRequest = new Request(newUrl, request);
    newRequest.headers.set('Host', b2Hostname);

    const response = await fetch(newRequest);

    if (!response.ok) {
      return response;
    }

    const newResponse = new Response(response.body, response);
    const filename = originalPath.split('/').pop();

    // Divide the filename into two parts: UUID and original filename
    const filenameParts = filename.split('_', 2);
    if (filenameParts.length > 1) {
      const originalFilename = filenameParts[1];
      newResponse.headers.set(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(originalFilename)}`,
      );
    }

    return newResponse;
  },
};
