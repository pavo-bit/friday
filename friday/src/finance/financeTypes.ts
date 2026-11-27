// ============================================================
// FRIDAY — Financial Intelligence Types & Source Classification
// ============================================================

export type FinancialSourceClassification =
  | 'USER_ENTERED'
  | 'CONNECTED_VERIFIED'
  | 'ESTIMATED'
  | 'OUTDATED'
  | 'IMPORTED_PENDING_VERIFICATION';

export const VALID_FINANCIAL_SOURCES = new Set<FinancialSourceClassification>([
  'USER_ENTERED',
  'CONNECTED_VERIFIED',
  'ESTIMATED',
  'OUTDATED',
  'IMPORTED_PENDING_VERIFICATION',
]);

export interface FinancialAccountRecord {
  id: string;
  ownerId: string;
  name: string;
  accountType: string;
  currency: string;
  balanceMinor: number;
  balanceFormatted: string;
  sourceClassification: FinancialSourceClassification;
  sourceName: string;
  observedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialTransactionRecord {
  id: string;
  ownerId: string;
  accountId: string | null;
  txType: 'income' | 'expense';
  category: string;
  amountMinor: number;
  amountFormatted: string;
  currency: string;
  description: string;
  occurredAt: string;
  sourceClassification: FinancialSourceClassification;
  sourceName: string;
  createdAt: string;
}

export interface FinancialBudgetRecord {
  id: string;
  ownerId: string;
  category: string;
  period: string;
  limitMinor: number;
  limitFormatted: string;
  spentMinor: number;
  spentFormatted: string;
  utilizationPct: number;
  overBudget: boolean;
  currency: string;
  sourceClassification: FinancialSourceClassification;
  sourceName: string;
}

export interface FinancialGoalRecord {
  id: string;
  ownerId: string;
  name: string;
  targetMinor: number;
  targetFormatted: string;
  currentMinor: number;
  currentFormatted: string;
  remainingMinor: number;
  remainingFormatted: string;
  progressPct: number;
  monthlyContributionMinor: number;
  estimatedMonthsToGoal: number | null;
  targetDate: string | null;
  currency: string;
  status: string;
  sourceClassification: FinancialSourceClassification;
  sourceName: string;
}

export interface FinancialDebtRecord {
  id: string;
  ownerId: string;
  name: string;
  lender: string;
  principalMinor: number;
  remainingMinor: number;
  remainingFormatted: string;
  aprBps: number;
  aprPct: number;
  minPaymentMinor: number;
  minPaymentFormatted: string;
  currency: string;
  status: string;
  sourceClassification: FinancialSourceClassification;
  sourceName: string;
}

export interface FinancialHoldingRecord {
  id: string;
  ownerId: string;
  symbol: string;
  assetClass: string;
  quantityMilli: number;
  avgCostMinor: number;
  currentValueMinor: number;
  currentValueFormatted: string;
  currency: string;
  sourceClassification: FinancialSourceClassification;
  sourceName: string;
  observedAt: string;
}

export interface CashFlowSummary {
  period: string;
  currency: string;
  totalIncomeMinor: number;
  totalIncomeFormatted: string;
  totalExpenseMinor: number;
  totalExpenseFormatted: string;
  netCashFlowMinor: number;
  netCashFlowFormatted: string;
  savingsRatePct: number;
  transactionCount: number;
  byCategory: Array<{ category: string; txType: 'income' | 'expense'; amountMinor: number; amountFormatted: string }>;
  sourceClassifications: FinancialSourceClassification[];
  missingData: string[];
  assumptions: string[];
}

export interface PortfolioAnalysis {
  currency: string;
  totalValueMinor: number;
  totalValueFormatted: string;
  holdingsCount: number;
  allocationByAssetClass: Array<{
    assetClass: string;
    valueMinor: number;
    valueFormatted: string;
    sharePct: number;
  }>;
  topHoldingConcentrationPct: number;
  concentrationRisk: 'low' | 'moderate' | 'high' | 'none';
  hasUnverifiedOrStaleData: boolean;
  sourceClassifications: FinancialSourceClassification[];
  assumptions: string[];
  missingData: string[];
}

export interface TradingCapitalAllocationRecord {
  id: string;
  ownerId: string;
  allocatedCapitalMinor: number;
  allocatedCapitalFormatted: string;
  currency: string;
  confirmedByUser: boolean;
  confirmationNote: string;
  sourceClassification: FinancialSourceClassification;
  createdAt: string;
}
