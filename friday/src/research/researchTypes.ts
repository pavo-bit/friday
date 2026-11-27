// ============================================================
// FRIDAY — Web Research & Browser Intelligence Types (Phase 14)
// ============================================================

export type EvidenceType =
  | 'business_category'
  | 'product_service'
  | 'target_customer'
  | 'pricing'
  | 'technology'
  | 'strength'
  | 'weakness'
  | 'general'
  | 'injection_blocked';

export type ValidationStatus = 'OBSERVED' | 'CORROBORATED' | 'UNVERIFIED' | 'QUARANTINED';

export type ResearchJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface BrowserSessionOptions {
  maxDepth?: number;
  maxPages?: number;
  timeoutMs?: number;
  sameDomainOnly?: boolean;
  allowedDomains?: string[];
  signal?: AbortSignal;
}

export interface BrowserPageResult {
  url: string;
  finalUrl: string;
  statusCode: number;
  title: string;
  metaDescription: string;
  headings: string[];
  links: string[];
  visibleText: string;
  pricingMentions: string[];
  techIndicators: string[];
  injectionDetected: boolean;
  paywallOrLoginDetected: boolean;
  fetchedAt: string;
}

export interface FailedPageRecord {
  url: string;
  reason: string;
  statusCode?: number;
  timestamp: string;
}

export interface ResearchFinding {
  id: string;
  sourceUrl: string;
  pageTitle: string;
  observation: string;
  timestamp: string;
  evidenceType: EvidenceType;
  confidence: number;
  validationStatus: ValidationStatus;
}

export interface WebsiteAnalysis {
  rootUrl: string;
  domain: string;
  pagesAnalyzed: number;
  businessCategory: string | null;
  productsAndServices: string[];
  targetCustomers: string[];
  pricing: string[];
  technologyIndicators: string[];
  strengths: string[];
  weaknesses: string[];
  facts: string[];
  hypotheses: string[];
  unknowns: string[];
  findings: ResearchFinding[];
  failedPages: FailedPageRecord[];
}

export interface WebsiteComparison {
  sites: WebsiteAnalysis[];
  crossCheckedClaims: string[];
  comparisonSummary: string;
}

export interface ResearchReport {
  jobId: string;
  query: string;
  mode: 'single_site' | 'multi_site_comparison';
  analyses: WebsiteAnalysis[];
  comparison?: WebsiteComparison;
  allFindings: ResearchFinding[];
  failedPages: FailedPageRecord[];
  injectionAttemptsBlocked: number;
  summary: string;
  generatedAt: string;
}

export interface ResearchJobRecord {
  id: string;
  actorId: string;
  conversationId: string;
  query: string;
  urls: string[];
  status: ResearchJobStatus;
  maxDepth: number;
  maxPages: number;
  pagesVisited: number;
  failedPages: FailedPageRecord[];
  report: ResearchReport | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
