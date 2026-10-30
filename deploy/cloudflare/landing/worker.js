export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "www.vnbot.run") {
      url.hostname = "vnbot.run";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
