// ============================================================
// FRIDAY — Financial Intelligence Capabilities
// Registered in CapabilityRegistry for discovery & orchestration
// ============================================================

import { getFinanceService } from './financeService';
import { toMinorUnits } from './money';
import type { CapabilityRegistry } from '../orchestration/toolRegistry';

export function registerFinanceCapabilities(registry: CapabilityRegistry): void {
  registry.register({
    id: 'finance.cash_flow',
    name: 'finance_cash_flow',
    description:
      'Analyze personal income, expenses, spending, and monthly cash flow from verified or user-entered records.',
    category: 'finance',
    version: '1.0.0',
    riskLevel: 'low',
    permissions: ['finance:read'],
    timeoutMs: 5_000,
    trusted: true,
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'Optional YYYY-MM period (defaults to current month)' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string' },
        totalIncomeFormatted: { type: 'string' },
        totalExpenseFormatted: { type: 'string' },
        netCashFlowFormatted: { type: 'string' },
      },
      required: ['period', 'totalIncomeFormatted', 'totalExpenseFormatted', 'netCashFlowFormatted'],
    },
    execute: async (args, ctx) => {
      const ownerId = ctx.actor || 'local';
      const period = typeof args.period === 'string' && args.period.trim() ? args.period.trim() : undefined;
      const cf = await getFinanceService().getCashFlow(ownerId, period);
      return {
        verified: true,
        data: {
          ...cf,
          sourceName: 'FRIDAY Local Finance Ledger',
          sourceType: cf.sourceClassifications.includes('CONNECTED_VERIFIED') ? 'live' : 'user_entered',
          timestamp: new Date().toISOString(),
          freshnessSeconds: 0,
        },
        message:
          cf.transactionCount === 0
            ? `No transactions recorded for ${cf.period}. Add income or expense records to compute cash flow.`
            : `Cash flow (${cf.period}): Income ${cf.currency} ${cf.totalIncomeFormatted}, Expenses ${cf.currency} ${cf.totalExpenseFormatted}, Net ${cf.currency} ${cf.netCashFlowFormatted} (${cf.savingsRatePct}% savings rate).`,
      };
    },
  });

  registry.register({
    id: 'finance.budget_status',
    name: 'finance_budget_status',
    description: 'Check personal budget limits, category spending, and budget utilization.',
    category: 'finance',
    version: '1.0.0',
    riskLevel: 'low',
    permissions: ['finance:read'],
    timeoutMs: 5_000,
    trusted: true,
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        rows: { type: 'array' },
      },
      required: ['rows'],
    },
    execute: async (args, ctx) => {
      const ownerId = ctx.actor || 'local';
      const period = typeof args.period === 'string' && args.period.trim() ? args.period.trim() : undefined;
      const budgets = await getFinanceService().listBudgets(ownerId, period);
      const rows = budgets.map((b) => ({
        category: b.category,
        limit: `${b.currency} ${b.limitFormatted}`,
        spent: `${b.currency} ${b.spentFormatted}`,
        utilizationPct: `${b.utilizationPct}%`,
        overBudget: b.overBudget,
        source: b.sourceClassification,
      }));
      return {
        verified: true,
        data: {
          rows,
          sourceName: 'FRIDAY Local Finance Ledger',
          sourceType: 'user_entered',
          timestamp: new Date().toISOString(),
          freshnessSeconds: 0,
        },
        message:
          budgets.length === 0
            ? 'No budgets configured for this period.'
            : `Tracked ${budgets.length} budget(s); ${budgets.filter((b) => b.overBudget).length} over budget.`,
      };
    },
  });

  registry.register({
    id: 'finance.goal_progress',
    name: 'finance_goal_progress',
    description: 'Check savings goals, remaining target amount, and estimated months to goal.',
    category: 'finance',
    version: '1.0.0',
    riskLevel: 'low',
    permissions: ['finance:read'],
    timeoutMs: 5_000,
    trusted: true,
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        rows: { type: 'array' },
      },
      required: ['rows'],
    },
    execute: async (_args, ctx) => {
      const ownerId = ctx.actor || 'local';
      const goals = await getFinanceService().listGoals(ownerId);
      const rows = goals.map((g) => ({
        name: g.name,
        progressPct: `${g.progressPct}%`,
        current: `${g.currency} ${g.currentFormatted}`,
        target: `${g.currency} ${g.targetFormatted}`,
        remaining: `${g.currency} ${g.remainingFormatted}`,
        monthsLeft: g.estimatedMonthsToGoal ?? 'N/A',
        source: g.sourceClassification,
      }));
      return {
        verified: true,
        data: {
          rows,
          sourceName: 'FRIDAY Local Finance Ledger',
          sourceType: 'user_entered',
          timestamp: new Date().toISOString(),
          freshnessSeconds: 0,
        },
        message:
          goals.length === 0
            ? 'No financial goals configured yet.'
            : `Tracking ${goals.length} financial goal(s).`,
      };
    },
  });

  registry.register({
    id: 'finance.portfolio_analyze',
    name: 'finance_portfolio_analyze',
    description: 'Analyze current investment portfolio, asset allocation, and concentration risk.',
    category: 'finance',
    version: '1.0.0',
    riskLevel: 'low',
    permissions: ['finance:read'],
    timeoutMs: 5_000,
    trusted: true,
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        totalValueFormatted: { type: 'string' },
        concentrationRisk: { type: 'string' },
      },
      required: ['totalValueFormatted', 'concentrationRisk'],
    },
    execute: async (_args, ctx) => {
      const ownerId = ctx.actor || 'local';
      const analysis = await getFinanceService().analyzePortfolio(ownerId);
      return {
        verified: true,
        data: {
          ...analysis,
          rows: analysis.allocationByAssetClass,
          sourceName: 'FRIDAY Local Portfolio Ledger',
          sourceType: analysis.hasUnverifiedOrStaleData ? 'cached' : 'user_entered',
          timestamp: new Date().toISOString(),
          freshnessSeconds: 0,
        },
        message:
          analysis.holdingsCount === 0
            ? 'No investment holdings recorded yet.'
            : `Portfolio total: ${analysis.currency} ${analysis.totalValueFormatted} across ${analysis.holdingsCount} holding(s). Top holding concentration: ${analysis.topHoldingConcentrationPct}% (${analysis.concentrationRisk} risk).`,
      };
    },
  });

  registry.register({
    id: 'finance.debt_scenario',
    name: 'finance_debt_scenario',
    description: 'Compare two deterministic debt repayment scenarios (monthly payment vs payoff time and interest).',
    category: 'finance',
    version: '1.0.0',
    riskLevel: 'low',
    permissions: ['finance:read'],
    timeoutMs: 5_000,
    trusted: true,
    inputSchema: {
      type: 'object',
      properties: {
        remaining: { type: ['number', 'string'] },
        aprPct: { type: 'number' },
        paymentA: { type: ['number', 'string'] },
        paymentB: { type: ['number', 'string'] },
      },
      required: ['remaining', 'aprPct', 'paymentA', 'paymentB'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        rows: { type: 'array' },
      },
      required: ['rows'],
    },
    execute: async (args) => {
      const svc = getFinanceService();
      const remMinor = toMinorUnits(args.remaining as number | string);
      const aprBps = Math.round(Number(args.aprPct) * 100);
      const scA = svc.projectDebtRepayment(remMinor, aprBps, toMinorUnits(args.paymentA as number | string));
      const scB = svc.projectDebtRepayment(remMinor, aprBps, toMinorUnits(args.paymentB as number | string));
      return {
        verified: true,
        data: {
          rows: [
            {
              scenario: 'Scenario A',
              monthlyPayment: String(args.paymentA),
              monthsToPayoff: scA.monthsToPayoff ?? 'Does not amortize',
              totalInterest: scA.totalInterestFormatted,
              totalPaid: scA.totalPaidFormatted,
            },
            {
              scenario: 'Scenario B',
              monthlyPayment: String(args.paymentB),
              monthsToPayoff: scB.monthsToPayoff ?? 'Does not amortize',
              totalInterest: scB.totalInterestFormatted,
              totalPaid: scB.totalPaidFormatted,
            },
          ],
          sourceName: 'FRIDAY Deterministic Amortization Engine',
          sourceType: 'user_entered',
          timestamp: new Date().toISOString(),
          freshnessSeconds: 0,
        },
        message: `Scenario A: ${scA.monthsToPayoff ?? 'N/A'} months (interest ${scA.totalInterestFormatted}); Scenario B: ${scB.monthsToPayoff ?? 'N/A'} months (interest ${scB.totalInterestFormatted}).`,
      };
    },
  });

  registry.register({
    id: 'finance.report',
    name: 'finance_report',
    description: 'Generate a comprehensive personal financial overview report including net worth, cash flow, budgets, goals, and debts.',
    category: 'finance',
    version: '1.0.0',
    riskLevel: 'low',
    permissions: ['finance:read'],
    timeoutMs: 5_000,
    trusted: true,
    inputSchema: {
      type: 'object',
      properties: { period: { type: 'string' } },
    },
    outputSchema: {
      type: 'object',
      properties: {
        netWorthFormatted: { type: 'string' },
      },
      required: ['netWorthFormatted'],
    },
    execute: async (args, ctx) => {
      const ownerId = ctx.actor || 'local';
      const period = typeof args.period === 'string' && args.period.trim() ? args.period.trim() : undefined;
      const report = await getFinanceService().getFinancialReport(ownerId, period);
      return {
        verified: true,
        data: {
          ...report,
          sourceName: 'FRIDAY Local Finance Ledger',
          sourceType: 'user_entered',
          timestamp: new Date().toISOString(),
          freshnessSeconds: 0,
        },
        message: `Financial Overview (${report.period}): Net Worth ${report.currency} ${report.netWorthFormatted} (Accounts ${report.totalAccountBalanceFormatted}, Portfolio ${report.portfolio.totalValueFormatted}, Debts ${report.totalDebtRemainingFormatted}).`,
      };
    },
  });

  registry.register({
    id: 'finance.trading_capital_confirm',
    name: 'finance_trading_capital_confirm',
    description:
      'Record an explicitly user-confirmed trading capital allocation snapshot without modifying total wealth or trading risk limits.',
    category: 'finance',
    version: '1.0.0',
    riskLevel: 'high',
    permissions: ['finance:write'],
    timeoutMs: 5_000,
    trusted: true,
    inputSchema: {
      type: 'object',
      properties: {
        allocatedCapital: { type: ['number', 'string'] },
        currency: { type: 'string' },
        confirmedByUser: { type: 'boolean' },
        confirmationNote: { type: 'string' },
      },
      required: ['allocatedCapital', 'confirmedByUser'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        allocatedCapitalFormatted: { type: 'string' },
      },
      required: ['allocatedCapitalFormatted'],
    },
    execute: async (args, ctx) => {
      const ownerId = ctx.actor || 'local';
      const rec = await getFinanceService().allocateTradingCapital(ownerId, {
        allocatedCapital: args.allocatedCapital as number | string,
        currency: typeof args.currency === 'string' ? args.currency : undefined,
        confirmedByUser: Boolean(args.confirmedByUser),
        confirmationNote: typeof args.confirmationNote === 'string' ? args.confirmationNote : undefined,
      });
      return {
        verified: true,
        data: rec,
        message: `Confirmed trading capital snapshot: ${rec.currency} ${rec.allocatedCapitalFormatted}.`,
      };
    },
  });
}
