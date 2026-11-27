// ============================================================
// FRIDAY — Isolated Browser & HTML Extraction Adapter (Phase 14.1)
// Bounded multi-page navigation, redirect handling, resource cleanup,
// login/paywall respect, and untrusted-content sanitization.
// ============================================================

import * as dns from 'dns/promises';
import * as net from 'net';
import { sanitizeRetrievedText } from '../orchestration/contextResolution';
import { BrowserPageResult, BrowserSessionOptions, FailedPageRecord } from './researchTypes';

const MAX_BODY_BYTES = 1_500_000; // 1.5 MB per page cap
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_PAGES = 5;

export function isBlockedIp(rawIp: string): boolean {
  const ip = rawIp.replace(/^\[|\]$/g, '').trim();
  const mappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const v4 = mappedMatch ? mappedMatch[1] : net.isIPv4(ip) ? ip : null;
  if (v4) {
    const parts = v4.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // Multicast / reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true; // fe80::/10 link-local
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
    if (lower.startsWith('ff')) return true; // ff00::/8 multicast
    return false;
  }

  return true;
}

export interface CrawlSessionOutcome {
  pages: BrowserPageResult[];
  failedPages: FailedPageRecord[];
  cancelled: boolean;
  sessionClosed: boolean;
}

export class IsolatedBrowserAdapter {
  private activeControllers = new Map<string, AbortController>();

  /**
   * Validate a public HTTP(S) URL. Rejects file://, javascript:, data:, and invalid URLs.
   */
  validatePublicUrl(rawUrl: string): URL {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
      throw new Error('URL cannot be empty.');
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`Invalid URL: "${trimmed}"`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported protocol "${parsed.protocol}". Only http:// and https:// are permitted.`);
    }
    if (!parsed.hostname) {
      throw new Error('URL must include a valid hostname.');
    }
    const allowLocal = process.env.FRIDAY_ALLOW_LOCALHOST_RESEARCH === 'true';
    const hostLower = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!allowLocal) {
      if (hostLower === 'localhost' || hostLower.endsWith('.local') || hostLower.endsWith('.internal')) {
        throw new Error(`SSRF protection: blocked local/internal hostname "${parsed.hostname}".`);
      }
      if (net.isIP(hostLower) && isBlockedIp(hostLower)) {
        throw new Error(`SSRF protection: blocked non-public IP address "${parsed.hostname}".`);
      }
    }
    return parsed;
  }

  /**
   * DNS-rebinding & destination IP check performed right before each HTTP hop.
   */
  async assertSafeDestination(parsed: URL): Promise<void> {
    this.validatePublicUrl(parsed.toString());
    if (process.env.FRIDAY_ALLOW_LOCALHOST_RESEARCH === 'true') return;
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) {
      if (isBlockedIp(host)) {
        throw new Error(`SSRF protection: blocked destination IP "${host}".`);
      }
      return;
    }
    const records = await dns.lookup(host, { all: true });
    if (!records || records.length === 0) {
      throw new Error(`DNS resolution failed for "${host}".`);
    }
    for (const rec of records) {
      if (isBlockedIp(rec.address)) {
        throw new Error(`SSRF protection: "${host}" resolved to blocked IP "${rec.address}".`);
      }
    }
  }

  /**
   * Cancel an active crawl session by sessionId.
   */
  cancelSession(sessionId: string): boolean {
    const ctrl = this.activeControllers.get(sessionId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  getActiveSessionCount(): number {
    return this.activeControllers.size;
  }

  /**
   * Execute an isolated, bounded crawl starting from rootUrl.
   * Always cleans up AbortControllers and visited sets in finally.
   */
  async crawl(
    sessionId: string,
    rootUrl: string,
    options: BrowserSessionOptions = {}
  ): Promise<CrawlSessionOutcome> {
    const parsedRoot = this.validatePublicUrl(rootUrl);
    const maxDepth = Math.min(3, Math.max(0, options.maxDepth ?? DEFAULT_MAX_DEPTH));
    const maxPages = Math.min(15, Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES));
    const timeoutMs = Math.min(20_000, Math.max(500, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const sameDomainOnly = options.sameDomainOnly ?? true;
    const allowedDomains = new Set(
      (options.allowedDomains && options.allowedDomains.length > 0
        ? options.allowedDomains
        : [parsedRoot.hostname]
      ).map((d) => d.toLowerCase())
    );

    const sessionCtrl = new AbortController();
    this.activeControllers.set(sessionId, sessionCtrl);
    if (options.signal) {
      if (options.signal.aborted) sessionCtrl.abort();
      options.signal.addEventListener('abort', () => sessionCtrl.abort(), { once: true });
    }

    const visited = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [{ url: parsedRoot.toString(), depth: 0 }];
    const pages: BrowserPageResult[] = [];
    const failedPages: FailedPageRecord[] = [];
    let cancelled = false;

    try {
      while (queue.length > 0 && pages.length < maxPages) {
        if (sessionCtrl.signal.aborted) {
          cancelled = true;
          break;
        }

        const next = queue.shift()!;
        const normalizedUrl = this.normalizeUrl(next.url);
        if (visited.has(normalizedUrl)) continue;
        visited.add(normalizedUrl);

        let target: URL;
        try {
          target = this.validatePublicUrl(normalizedUrl);
        } catch (err) {
          failedPages.push({
            url: normalizedUrl,
            reason: (err as Error).message,
            timestamp: new Date().toISOString(),
          });
          continue;
        }

        if (sameDomainOnly && !allowedDomains.has(target.hostname.toLowerCase())) {
          continue;
        }

        const pageRes = await this.fetchAndExtract(target.toString(), timeoutMs, sessionCtrl.signal);
        if ('reason' in pageRes) {
          if (sessionCtrl.signal.aborted) {
            cancelled = true;
            break;
          }
          failedPages.push(pageRes);
          continue;
        }

        pages.push(pageRes);

        if (next.depth < maxDepth && !pageRes.paywallOrLoginDetected) {
          for (const link of pageRes.links) {
            const normLink = this.normalizeUrl(link);
            if (!visited.has(normLink) && queue.length < maxPages * 3) {
              queue.push({ url: normLink, depth: next.depth + 1 });
            }
          }
        }
      }
    } finally {
      // Guarantee browser/session resource cleanup
      visited.clear();
      queue.length = 0;
      this.activeControllers.delete(sessionId);
    }

    return {
      pages,
      failedPages,
      cancelled,
      sessionClosed: !this.activeControllers.has(sessionId),
    };
  }

  private async fetchAndExtract(
    url: string,
    timeoutMs: number,
    sessionSignal: AbortSignal
  ): Promise<BrowserPageResult | FailedPageRecord> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onSessionAbort = () => controller.abort();
    sessionSignal.addEventListener('abort', onSessionAbort, { once: true });

    try {
      let currentUrl = url;
      let response: Response | null = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const parsedHop = new URL(currentUrl);
        await this.assertSafeDestination(parsedHop);

        response = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': 'FRIDAY-ResearchBot/1.0 (+local-first-assistant)',
            Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) break;
          if (hop === MAX_REDIRECTS) {
            return {
              url,
              reason: `Exceeded maximum redirect hops (${MAX_REDIRECTS}).`,
              statusCode: response.status,
              timestamp: new Date().toISOString(),
            };
          }
          const nextUrl = new URL(location, currentUrl);
          await this.assertSafeDestination(nextUrl);
          currentUrl = nextUrl.toString();
          continue;
        }
        break;
      }

      if (!response) {
        return {
          url,
          reason: 'No HTTP response received.',
          timestamp: new Date().toISOString(),
        };
      }

      if (response.status === 401 || response.status === 402 || response.status === 403) {
        return {
          url,
          reason: `Access restricted (HTTP ${response.status}); FRIDAY does not bypass logins or paywalls.`,
          statusCode: response.status,
          timestamp: new Date().toISOString(),
        };
      }

      if (!response.ok) {
        return {
          url,
          reason: `HTTP ${response.status} ${response.statusText}`,
          statusCode: response.status,
          timestamp: new Date().toISOString(),
        };
      }

      const rawText = await response.text();
      const boundedHtml = rawText.slice(0, MAX_BODY_BYTES);
      const finalUrl = currentUrl;

      return this.parseHtml(finalUrl, response.status, boundedHtml, response.headers);
    } catch (err) {
      const msg = (err as Error).name === 'AbortError'
        ? (sessionSignal.aborted ? 'Research cancelled by user' : `Navigation timeout after ${timeoutMs}ms`)
        : ((err as Error).message || 'Navigation failed');
      return {
        url,
        reason: msg,
        timestamp: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
      sessionSignal.removeEventListener('abort', onSessionAbort);
    }
  }

  private parseHtml(
    finalUrl: string,
    statusCode: number,
    html: string,
    headers: Headers
  ): BrowserPageResult {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const rawTitle = this.decodeEntities(this.stripTags(titleMatch?.[1] || '')).trim();

    const metaDescMatch =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i) ||
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i);
    const rawDesc = this.decodeEntities(metaDescMatch?.[1] || '').trim();

    const headings: string[] = [];
    for (const m of html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
      const h = this.decodeEntities(this.stripTags(m[1])).trim();
      if (h && !headings.includes(h) && headings.length < 25) {
        headings.push(h);
      }
    }

    const links: string[] = [];
    for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>/gi)) {
      try {
        const resolved = new URL(m[1].trim(), finalUrl);
        if ((resolved.protocol === 'http:' || resolved.protocol === 'https:') && !links.includes(resolved.toString())) {
          links.push(resolved.toString());
        }
      } catch {
        // Ignore malformed hrefs
      }
      if (links.length >= 40) break;
    }

    // Remove script/style/noscript before extracting visible text
    const bodyWithoutScripts = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
    const rawVisible = this.decodeEntities(this.stripTags(bodyWithoutScripts)).replace(/\s+/g, ' ').trim();

    // Check for prompt injection in untrusted webpage content
    const titleCheck = sanitizeRetrievedText(rawTitle);
    const descCheck = sanitizeRetrievedText(rawDesc);
    const bodyCheck = sanitizeRetrievedText(rawVisible.slice(0, 12_000));
    const injectionDetected = titleCheck.flagged || descCheck.flagged || bodyCheck.flagged;

    const paywallOrLoginDetected =
      /\b(sign\s+in\s+to\s+continue|subscribe\s+to\s+read|member-only\s+story|paywall|enter\s+your\s+password)\b/i.test(
        rawVisible
      );

    // Observable pricing mentions (strictly grounded in text)
    const pricingMentions: string[] = [];
    const priceMatches = rawVisible.matchAll(
      /(?:free\s+tier|free\s+plan|starter|pro|enterprise|pricing)[^.!?]{0,60}(?:\$|₹|€|£|inr|usd)\s*\d+(?:,\d+)*(?:\.\d+)?(?:\s*\/\s*(?:mo|month|yr|year|user))?|(?:₹|\$|€|£)\s*\d+(?:,\d+)*(?:\.\d+)?\s*(?:\/\s*(?:mo|month|yr|year|user))?/gi
    );
    for (const pm of priceMatches) {
      const snippet = pm[0].trim();
      const alreadyCovered = pricingMentions.some((existing) => existing.includes(snippet) || snippet.includes(existing));
      if (snippet && !alreadyCovered && pricingMentions.length < 10) {
        pricingMentions.push(snippet);
      }
    }

    // Strictly observable technology indicators (never fabricated)
    const techIndicators = this.extractObservableTech(html, headers);

    return {
      url: finalUrl,
      finalUrl,
      statusCode,
      title: titleCheck.safe || finalUrl,
      metaDescription: descCheck.safe,
      headings: headings.map((h) => sanitizeRetrievedText(h).safe),
      links,
      visibleText: bodyCheck.safe,
      pricingMentions,
      techIndicators,
      injectionDetected,
      paywallOrLoginDetected,
      fetchedAt: new Date().toISOString(),
    };
  }

  private extractObservableTech(html: string, headers: Headers): string[] {
    const found = new Set<string>();
    const poweredBy = headers.get('x-powered-by');
    if (poweredBy) found.add(`Header X-Powered-By: ${poweredBy}`);
    const serverHdr = headers.get('server');
    if (serverHdr && !/^(cloudflare|nginx|apache)$/i.test(serverHdr.trim()) ? true : Boolean(serverHdr)) {
      if (serverHdr) found.add(`Server: ${serverHdr}`);
    }
    const genMatch = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
    if (genMatch?.[1]) found.add(`Meta generator: ${genMatch[1].trim()}`);

    if (/__NEXT_DATA__|_next\/static/i.test(html)) found.add('Next.js (observable _next/static)');
    if (/wp-content\/|wp-includes\//i.test(html)) found.add('WordPress (observable wp-content)');
    if (/cdn\.shopify\.com/i.test(html)) found.add('Shopify (observable cdn.shopify.com)');
    if (/data-reactroot|react-dom/i.test(html)) found.add('React (observable DOM/script)');
    if (/__NUXT__|_nuxt\//i.test(html)) found.add('Nuxt.js (observable _nuxt)');
    if (/tailwindcss|tw-/i.test(html) && /tailwind/i.test(html)) found.add('Tailwind CSS (observable stylesheet)');

    return Array.from(found);
  }

  private stripTags(input: string): string {
    return input.replace(/<[^>]+>/g, ' ');
  }

  private decodeEntities(input: string): string {
    return input
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  private normalizeUrl(raw: string): string {
    try {
      const u = new URL(raw);
      u.hash = '';
      if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
        u.pathname = u.pathname.slice(0, -1);
      }
      return u.toString();
    } catch {
      return raw;
    }
  }
}

let _browserAdapter: IsolatedBrowserAdapter | null = null;
export function getBrowserAdapter(): IsolatedBrowserAdapter {
  if (!_browserAdapter) {
    _browserAdapter = new IsolatedBrowserAdapter();
  }
  return _browserAdapter;
}
