// ============================================================
// FRIDAY — Web Research Engine (Phase 14.2)
// Pipeline: User Request -> Website Navigation -> Evidence Extraction
//           -> Validation -> Analysis -> Research Report
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { getBrowserAdapter } from './browserAdapter';
import {
  BrowserPageResult,
  EvidenceType,
  FailedPageRecord,
  ResearchFinding,
  ResearchJobRecord,
  ResearchReport,
  WebsiteAnalysis,
  WebsiteComparison,
} from './researchTypes';

export class WebResearchEngine {
  /**
   * Analyze a single website (with bounded multi-page crawl) and persist job + findings.
   */
  async analyzeWebsite(params: {
    actorId: string;
    conversationId?: string;
    url: string;
    query?: string;
    maxDepth?: number;
    maxPages?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ResearchJobRecord> {
    return this.runResearchJob({
      actorId: params.actorId,
      conversationId: params.conversationId || 'default',
      urls: [params.url],
      query: params.query || `Analyze website ${params.url}`,
      maxDepth: params.maxDepth ?? 1,
      maxPages: params.maxPages ?? 5,
      timeoutMs: params.timeoutMs ?? 8_000,
      signal: params.signal,
    });
  }

  /**
   * Compare multiple websites/domains side-by-side with cross-checked evidence.
   */
  async compareWebsites(params: {
    actorId: string;
    conversationId?: string;
    urls: string[];
    query?: string;
    maxDepth?: number;
    maxPagesPerSite?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ResearchJobRecord> {
    if (!params.urls || params.urls.length < 2) {
      throw new Error('At least two URLs are required for website comparison.');
    }
    return this.runResearchJob({
      actorId: params.actorId,
      conversationId: params.conversationId || 'default',
      urls: params.urls.slice(0, 5),
      query: params.query || `Compare ${params.urls.length} websites`,
      maxDepth: params.maxDepth ?? 1,
      maxPages: params.maxPagesPerSite ?? 3,
      timeoutMs: params.timeoutMs ?? 8_000,
      signal: params.signal,
    });
  }

  async cancelJob(jobId: string, actorId: string): Promise<boolean> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return false;

    const row = db
      .prepare(`SELECT id, status FROM research_jobs WHERE id = ? AND actor_id = ?`)
      .get(jobId, actorId) as { id: string; status: string } | undefined;
    if (!row) return false;

    getBrowserAdapter().cancelSession(jobId);
    if (row.status === 'QUEUED' || row.status === 'RUNNING') {
      db.prepare(
        `UPDATE research_jobs SET status = 'CANCELLED', updated_at = datetime('now'), completed_at = datetime('now') WHERE id = ? AND actor_id = ?`
      ).run(jobId, actorId);
    }
    return true;
  }

  async getJob(jobId: string, actorId: string): Promise<ResearchJobRecord | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;
    const row = db
      .prepare(`SELECT * FROM research_jobs WHERE id = ? AND actor_id = ?`)
      .get(jobId, actorId) as Record<string, unknown> | undefined;
    return row ? this.mapJobRow(row) : null;
  }

  async listJobs(actorId: string, limit = 20): Promise<ResearchJobRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const rows = db
      .prepare(`SELECT * FROM research_jobs WHERE actor_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(actorId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapJobRow(r));
  }

  private async runResearchJob(params: {
    actorId: string;
    conversationId: string;
    urls: string[];
    query: string;
    maxDepth: number;
    maxPages: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<ResearchJobRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    const jobId = uuidv4();
    const browser = getBrowserAdapter();

    // Validate all URLs upfront
    for (const u of params.urls) {
      browser.validatePublicUrl(u);
    }

    if (db) {
      db.prepare(
        `INSERT INTO research_jobs (id, actor_id, conversation_id, query, urls_json, status, max_depth, max_pages)
         VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?)`
      ).run(
        jobId,
        params.actorId,
        params.conversationId,
        params.query,
        JSON.stringify(params.urls),
        params.maxDepth,
        params.maxPages
      );
    }

    const analyses: WebsiteAnalysis[] = [];
    const allFindings: ResearchFinding[] = [];
    const allFailed: FailedPageRecord[] = [];
    let totalPagesVisited = 0;
    let injectionAttemptsBlocked = 0;
    let wasCancelled = false;

    try {
      for (let i = 0; i < params.urls.length; i++) {
        const targetUrl = params.urls[i];
        const sessionId = `${jobId}:${i}`;
        const outcome = await browser.crawl(sessionId, targetUrl, {
          maxDepth: params.maxDepth,
          maxPages: params.maxPages,
          timeoutMs: params.timeoutMs,
          sameDomainOnly: true,
          signal: params.signal,
        });

        totalPagesVisited += outcome.pages.length;
        allFailed.push(...outcome.failedPages);
        if (outcome.cancelled) {
          wasCancelled = true;
          break;
        }

        const analysis = this.buildWebsiteAnalysis(targetUrl, outcome.pages, outcome.failedPages);
        analyses.push(analysis);
        allFindings.push(...analysis.findings);
        injectionAttemptsBlocked += outcome.pages.filter((p) => p.injectionDetected).length;
      }

      if (wasCancelled) {
        if (db) {
          db.prepare(
            `UPDATE research_jobs
             SET status = 'CANCELLED', pages_visited = ?, failed_pages_json = ?, updated_at = datetime('now'), completed_at = datetime('now')
             WHERE id = ?`
          ).run(totalPagesVisited, JSON.stringify(allFailed), jobId);
        }
        return (await this.getJob(jobId, params.actorId))!;
      }

      const mode = params.urls.length > 1 ? 'multi_site_comparison' : 'single_site';
      const comparison = mode === 'multi_site_comparison' ? this.buildComparison(analyses) : undefined;
      const summary = this.buildReportSummary(analyses, comparison, allFailed, injectionAttemptsBlocked);

      const report: ResearchReport = {
        jobId,
        query: params.query,
        mode,
        analyses,
        comparison,
        allFindings,
        failedPages: allFailed,
        injectionAttemptsBlocked,
        summary,
        generatedAt: new Date().toISOString(),
      };

      if (db) {
        const tx = db.transaction(() => {
          db.prepare(
            `UPDATE research_jobs
             SET status = 'COMPLETED', pages_visited = ?, failed_pages_json = ?, report_json = ?,
                 updated_at = datetime('now'), completed_at = datetime('now')
             WHERE id = ?`
          ).run(totalPagesVisited, JSON.stringify(allFailed), JSON.stringify(report), jobId);

          const insertFinding = db.prepare(
            `INSERT INTO research_findings
             (id, job_id, actor_id, source_url, page_title, evidence_type, observation, confidence, validation_status, observed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          );
          for (const f of allFindings) {
            insertFinding.run(
              f.id,
              jobId,
              params.actorId,
              f.sourceUrl,
              f.pageTitle,
              f.evidenceType,
              f.observation,
              f.confidence,
              f.validationStatus,
              f.timestamp
            );
          }
        });
        tx();
      }

      return (await this.getJob(jobId, params.actorId))!;
    } catch (err) {
      if (db) {
        db.prepare(
          `UPDATE research_jobs SET status = 'FAILED', error = ?, updated_at = datetime('now'), completed_at = datetime('now') WHERE id = ?`
        ).run((err as Error).message, jobId);
      }
      throw err;
    }
  }

  private buildWebsiteAnalysis(
    rootUrl: string,
    pages: BrowserPageResult[],
    failedPages: FailedPageRecord[]
  ): WebsiteAnalysis {
    const domain = new URL(rootUrl).hostname;
    const findings: ResearchFinding[] = [];
    const seenObservations = new Set<string>();

    const addFinding = (
      page: BrowserPageResult,
      evidenceType: EvidenceType,
      observation: string,
      confidence: number,
      validationStatus: ResearchFinding['validationStatus']
    ) => {
      const dedupeKey = `${evidenceType}::${observation.toLowerCase().trim()}`;
      if (seenObservations.has(dedupeKey)) return;
      seenObservations.add(dedupeKey);
      findings.push({
        id: uuidv4(),
        sourceUrl: page.finalUrl,
        pageTitle: page.title,
        observation,
        timestamp: page.fetchedAt,
        evidenceType,
        confidence,
        validationStatus,
      });
    };

    const productsAndServices: string[] = [];
    const targetCustomers: string[] = [];
    const pricing: string[] = [];
    const techIndicators: string[] = [];
    const facts: string[] = [];
    const hypotheses: string[] = [];
    const unknowns: string[] = [];
    let businessCategory: string | null = null;

    for (const page of pages) {
      if (page.injectionDetected) {
        addFinding(
          page,
          'injection_blocked',
          'Potential prompt-injection text detected and quarantined from page content.',
          1.0,
          'QUARANTINED'
        );
      }

      const combinedText = `${page.title} ${page.metaDescription} ${page.headings.join(' ')} ${page.visibleText}`;

      if (!businessCategory) {
        businessCategory = this.inferBusinessCategory(combinedText);
        if (businessCategory) {
          addFinding(page, 'business_category', `Category indicator: ${businessCategory}`, 0.78, 'OBSERVED');
        }
      }

      // Extract services/products from headings & text
      for (const h of page.headings) {
        if (/\b(service|product|platform|solution|feature|erp|consulting|cloud|analytics|ai)\b/i.test(h)) {
          if (!productsAndServices.includes(h)) {
            productsAndServices.push(h);
            addFinding(page, 'product_service', `Heading indicates offering: "${h}"`, 0.82, 'OBSERVED');
          }
        }
      }

      // Target customers
      const audienceMatches = combinedText.matchAll(
        /\bfor\s+(startups|enterprises|small\s+businesses|smbs|developers|teams|agencies|hospitals|schools|retailers|traders)\b/gi
      );
      for (const am of audienceMatches) {
        const cust = am[1].toLowerCase();
        if (!targetCustomers.includes(cust)) {
          targetCustomers.push(cust);
          addFinding(page, 'target_customer', `Explicit audience mention: "${am[0]}"`, 0.85, 'OBSERVED');
        }
      }

      // Pricing
      for (const p of page.pricingMentions) {
        if (!pricing.includes(p)) {
          pricing.push(p);
          addFinding(page, 'pricing', `Public pricing mention: ${p}`, 0.9, 'OBSERVED');
        }
      }

      // Observable tech stack
      for (const t of page.techIndicators) {
        if (!techIndicators.includes(t)) {
          techIndicators.push(t);
          addFinding(page, 'technology', `Observable technology indicator: ${t}`, 0.92, 'OBSERVED');
        }
      }

      if (page.metaDescription) {
        facts.push(`${page.title}: ${page.metaDescription}`);
      } else {
        facts.push(`Visited ${page.finalUrl} (${page.title})`);
      }
    }

    const strengths: string[] = [];
    const weaknesses: string[] = [];
    if (pricing.length > 0) {
      strengths.push('Transparent publicly listed pricing.');
    } else {
      unknowns.push('Public pricing is not listed on the inspected pages.');
      weaknesses.push('No public pricing found on inspected pages.');
    }

    if (techIndicators.length === 0) {
      unknowns.push('Technology stack could not be determined from publicly observable headers or HTML markers.');
    }

    if (pages.length > 0 && productsAndServices.length > 0) {
      strengths.push(`Clear product/service headings (${productsAndServices.length} identified).`);
    }
    if (failedPages.length > 0) {
      weaknesses.push(`${failedPages.length} page(s) failed or were restricted during inspection.`);
    }
    if (!businessCategory) {
      unknowns.push('Business category could not be conclusively determined from inspected text.');
    } else {
      hypotheses.push(`Appears positioned in "${businessCategory}" based on page copy.`);
    }

    return {
      rootUrl,
      domain,
      pagesAnalyzed: pages.length,
      businessCategory,
      productsAndServices,
      targetCustomers,
      pricing,
      technologyIndicators: techIndicators,
      strengths,
      weaknesses,
      facts,
      hypotheses,
      unknowns,
      findings,
      failedPages,
    };
  }

  private buildComparison(analyses: WebsiteAnalysis[]): WebsiteComparison {
    const crossCheckedClaims: string[] = [];
    const withPricing = analyses.filter((a) => a.pricing.length > 0).map((a) => a.domain);
    const withoutPricing = analyses.filter((a) => a.pricing.length === 0).map((a) => a.domain);

    if (withPricing.length > 0) {
      crossCheckedClaims.push(`Public pricing observed on: ${withPricing.join(', ')}.`);
    }
    if (withoutPricing.length > 0) {
      crossCheckedClaims.push(`No public pricing observed on: ${withoutPricing.join(', ')}.`);
    }

    const lines = analyses.map(
      (a, idx) =>
        `${idx + 1}. ${a.domain} (${a.pagesAnalyzed} page(s)): Category=${a.businessCategory || 'Unknown'} | Offerings=${a.productsAndServices.length} | Pricing=${a.pricing.length > 0 ? a.pricing[0] : 'Not listed'} | Tech=${a.technologyIndicators.length > 0 ? a.technologyIndicators.join(', ') : 'Unknown'}`
    );

    return {
      sites: analyses,
      crossCheckedClaims,
      comparisonSummary: lines.join('\n'),
    };
  }

  private buildReportSummary(
    analyses: WebsiteAnalysis[],
    comparison: WebsiteComparison | undefined,
    failedPages: FailedPageRecord[],
    injectionCount: number
  ): string {
    if (comparison) {
      return `Compared ${analyses.length} websites:\n${comparison.comparisonSummary}${injectionCount > 0 ? `\n(${injectionCount} prompt-injection attempt(s) quarantined.)` : ''}`;
    }
    const a = analyses[0];
    if (!a) {
      return `No pages could be analyzed (${failedPages.length} failed).`;
    }
    return [
      `Research report for ${a.domain} (${a.pagesAnalyzed} page(s) inspected):`,
      `- Category: ${a.businessCategory || 'Unknown'}`,
      `- Offerings: ${a.productsAndServices.slice(0, 4).join(', ') || 'None explicitly identified'}`,
      `- Pricing: ${a.pricing.slice(0, 3).join('; ') || 'Unknown / not publicly listed'}`,
      `- Observable Tech: ${a.technologyIndicators.join(', ') || 'Unknown (no public markers observed)'}`,
      ...(injectionCount > 0 ? [`- Security: ${injectionCount} prompt-injection attempt(s) quarantined.`] : []),
    ].join('\n');
  }

  private inferBusinessCategory(text: string): string | null {
    if (/\b(saas|software|cloud\s+platform|api|developer\s+tools|erp)\b/i.test(text)) return 'Software / SaaS';
    if (/\b(agency|consulting|design\s+studio|digital\s+marketing)\b/i.test(text)) return 'Agency / Consulting';
    if (/\b(e-?commerce|shop|store|cart|checkout)\b/i.test(text)) return 'E-Commerce';
    if (/\b(fintech|banking|trading|payments|investment)\b/i.test(text)) return 'Fintech / Financial Services';
    if (/\b(education|course|academy|learning|university)\b/i.test(text)) return 'Education / EdTech';
    return null;
  }

  private mapJobRow(row: Record<string, unknown>): ResearchJobRecord {
    return {
      id: String(row.id),
      actorId: String(row.actor_id),
      conversationId: String(row.conversation_id || 'default'),
      query: String(row.query),
      urls: JSON.parse(String(row.urls_json || '[]')),
      status: row.status as ResearchJobRecord['status'],
      maxDepth: Number(row.max_depth ?? 1),
      maxPages: Number(row.max_pages ?? 5),
      pagesVisited: Number(row.pages_visited ?? 0),
      failedPages: JSON.parse(String(row.failed_pages_json || '[]')),
      report: row.report_json ? JSON.parse(String(row.report_json)) : null,
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
    };
  }
}

let _researchEngine: WebResearchEngine | null = null;
export function getWebResearchEngine(): WebResearchEngine {
  if (!_researchEngine) {
    _researchEngine = new WebResearchEngine();
  }
  return _researchEngine;
}
