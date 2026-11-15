// Production is deliberately excluded, even if these source files are served directly.
export function paperReviewAllowed(location = globalThis.location) {
  if (!location) return false;
  const url = new URL(location.href);
  return (url.origin === "https://www.jonathanmellon.com" && url.pathname.startsWith("/echo_viewer_permastaging/"))
    || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
