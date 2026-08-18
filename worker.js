// worktrees.0001.dev — static site plus the Mac app download.
// The dmg is ~117 MB, far past the 25 MB static-asset limit, so it lives in
// R2 and streams through here at a stable URL that survives version bumps.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/download/mac") {
      const object = await env.APP_BUCKET.get("mac/Worktrees-arm64.dmg");
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "Content-Type": "application/x-apple-diskimage",
          "Content-Length": String(object.size),
          "Content-Disposition": 'attachment; filename="Worktrees.dmg"',
          "Cache-Control": "no-cache",
        },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
