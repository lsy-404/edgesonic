const FRONTEND_ROUTES = new Set([
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/confirm-email-change",
  "/activation",
  "/dashboard",
  "/library",
  "/starred",
  "/sources",
  "/files",
  "/users",
  "/settings",
  "/tools",
  "/radio",
  "/podcasts",
  "/shares",
  "/playlists",
  "/about",
  "/work",
]);

const SERVER_PREFIXES = ["/rest", "/tag", "/storage", "/edgesonic", "/share"];

function isServerPath(pathname: string): boolean {
  return SERVER_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isStaticPath(pathname: string): boolean {
  return pathname.startsWith("/assets/")
    || pathname.startsWith("/icons/")
    || pathname === "/favicon.svg"
    || pathname === "/index.html"
    || pathname === "/sw.js"
    || pathname === "/manifest.webmanifest"
    || pathname === "/build-info.json"
    || /\/[^/]*\.[^/]+$/.test(pathname);
}

/** Redirect a browser request to the hash route understood by the Vue SPA. */
export function spaHashRedirect(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const url = new URL(request.url);
  if (isServerPath(url.pathname) || isStaticPath(url.pathname)) return null;
  if (!FRONTEND_ROUTES.has(url.pathname)) return null;

  const target = new URL(url.origin);
  target.pathname = "/";
  target.hash = `${url.pathname}${url.search}`;
  return Response.redirect(target.toString(), 308);
}
