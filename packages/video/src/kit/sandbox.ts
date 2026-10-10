/**
 * Network sandbox for the render page.
 *
 * Scenes run the PR's real components (and model-written code) in the render browser. They
 * must not reach the network: a request would make frames non-deterministic and is an
 * exfiltration channel. Only the local bundle server and the Google Fonts used by the kit are
 * allowed; everything else is refused, and refusals are logged as "Feature-Rec sandbox".
 * Imported first by the bundle entry, before any scene code runs.
 */

const ALLOWED_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

function allowed(input: unknown): boolean {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request)?.url;
    const url = new URL(raw, window.location.href);
    if (url.protocol === "data:" || url.protocol === "blob:") return true;
    return url.origin === window.location.origin || ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function refuse(kind: string, target: unknown): void {
  console.warn(`Feature-Rec sandbox: blocked ${kind} ${String((target as Request)?.url ?? target)}`);
}

if (typeof window !== "undefined" && !(window as { __featureRecSandbox?: boolean }).__featureRecSandbox) {
  (window as { __featureRecSandbox?: boolean }).__featureRecSandbox = true;

  const realFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (allowed(input)) return realFetch(input, init);
    refuse("fetch", input);
    return Promise.reject(new TypeError("Network access is disabled while rendering"));
  };

  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    if (!allowed(url)) {
      refuse("XMLHttpRequest", url);
      throw new TypeError("Network access is disabled while rendering");
    }
    return (realOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;

  const blockCtor = (name: "WebSocket" | "EventSource") => {
    const Real = window[name] as unknown as new (...a: unknown[]) => unknown;
    if (!Real) return;
    (window as unknown as Record<string, unknown>)[name] = function (url: unknown, ...rest: unknown[]) {
      if (!allowed(url)) {
        refuse(name, url);
        throw new TypeError("Network access is disabled while rendering");
      }
      return new Real(url, ...rest);
    };
  };
  blockCtor("WebSocket");
  blockCtor("EventSource");

  if (navigator.sendBeacon) {
    navigator.sendBeacon = (url: string | URL) => {
      refuse("sendBeacon", url);
      return false;
    };
  }

  // Images, media, iframes, scripts and styles loaded by the components themselves.
  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' data: blob: https://fonts.googleapis.com https://fonts.gstatic.com",
    "frame-src 'none'",
  ].join("; ");
  document.head.prepend(csp);
}

export {};
