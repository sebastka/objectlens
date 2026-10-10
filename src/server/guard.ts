// ObjectLens has no login: it is meant to run on the user's own machine. Whatever the browser
// can reach on localhost, any web page open in that browser can try to reach too, so two
// guards keep other sites out:
//   - Host allow-list: a DNS rebinding attack makes evil.example resolve to 127.0.0.1, so the
//     browser treats our API as same-origin with evil.example. Its requests then carry
//     "Host: evil.example", which is refused.
//   - Same-origin check on state-changing requests (CSRF), from Fetch Metadata or Origin.
import type { Context, MiddlewareHandler } from 'hono';
import type { Config } from './config.ts';

/** "host:port", "[::1]:port" or "host" → lowercased host name without port. */
export function hostName(header: string): string {
  const h = header.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const i = h.lastIndexOf(':');
  return i < 0 ? h : h.slice(0, i);
}

export function allowedHosts(cfg: Config['http']): Set<string> {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', ...cfg.allowedHosts]);
  const listen = cfg.host.toLowerCase();
  if (listen !== '0.0.0.0' && listen !== '::') hosts.add(listen.includes(':') ? `[${listen}]` : listen);
  return hosts;
}

/** The Host the request was sent to; @hono/node-server builds the URL from it (or :authority). */
const requestHost = (c: Context) => c.req.header('host') ?? new URL(c.req.url).host;

export function hostGuard(cfg: Config['http']): MiddlewareHandler {
  const hosts = allowedHosts(cfg);
  return async (c, next) => {
    const host = requestHost(c);
    if (!hosts.has(hostName(host))) {
      return c.text(`Host "${host}" is not allowed; add it to ALLOWED_HOSTS if you meant to use it.`, 403);
    }
    return next();
  };
}

export function sameOriginGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next();
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return c.json({ error: 'cross-site request refused' }, 403);
    const origin = c.req.header('origin');
    if (origin && !site) {
      let ok = false;
      try {
        ok = new URL(origin).host === requestHost(c);
      } catch {
        // malformed Origin
      }
      if (!ok) return c.json({ error: 'cross-origin request refused' }, 403);
    }
    // Every write is a JSON or upload request sent by the UI with this header. A plain HTML
    // form cannot set it, which also covers browsers without Fetch Metadata.
    if (c.req.header('x-objectlens') !== '1') return c.json({ error: 'missing X-ObjectLens header' }, 403);
    return next();
  };
}
