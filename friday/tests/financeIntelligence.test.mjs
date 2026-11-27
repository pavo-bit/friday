import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-phase6-test-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-phase6.db');
process.env.FRIDAY_PORT = '0';

const { getMemoryStore } = await import('../dist/memory/store.js');
const { toMinorUnits, formatMinorUnits, addMinor, subMinor, ratioPercent } = await import(
  '../dist/finance/money.js'
);
const { getFinanceService } = await import('../dist/finance/financeService.js');
const { getCapabilityRegistry } = await import('../dist/orchestration/toolRegistry.js');
const { getCapabilityDiscoveryEngine } = await import('../dist/orchestration/capabilityDiscovery.js');
const { getToolPlanner } = await import('../dist/orchestration/toolPlanner.js');
const { getBackgroundOrchestrator } = await import('../dist/orchestration/backgroundOrchestrator.js');
const { getAuthService } = await import('../dist/services/authService.js');
const { FridayServer } = await import('../dist/api/server.js');

let server;
let baseUrl;
let deviceA;
let tokenA;
let deviceB;
let tokenB;

describe('Phase 6: Financial Intelligence Foundation', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();

    const auth = getAuthService();
    const pA = await auth.pairDevice({
      code: auth.generatePairingCode().code,
      name: 'Finance Device A',
      platform: 'android',
    });
    deviceA = pA.device;
    tokenA = pA.token;

    const pB = await auth.pairDevice({
      code: auth.generatePairingCode().code,
      name: 'Finance Device B',
      platform: 'android',
    });
    deviceB = pB.device;
    tokenB = pB.token;

    server = new FridayServer();
    await server.start(0);
    baseUrl = `http://127.0.0.1:${server.getPort()}`;
  });

  after(async () => {
    await server?.stop();
    const store = await getMemoryStore();
    await store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Ignore Windows file-lock cleanup race in temp dir
    }
  });

  it('Exact decimal-safe minor-unit arithmetic avoids IEEE-754 floating-point drift', () => {
    const a = toMinorUnits('0.10');
    const b = toMinorUnits('0.20');
    const sum = addMinor(a, b);
    assert.equal(sum, 30);
    assert.equal(formatMinorUnits(sum), '0.30');
    assert.equal(toMinorUnits('1234.565'), 123457); // Half-up rounding
    assert.equal(subMinor(toMinorUnits('100.00'), toMinorUnits('33.33')), 6667);
    assert.equal(ratioPercent(2500, 10000), 25);
  });

  it('Preserves historical account snapshots, cash flow, budgets, goals, debt projections, and portfolio allocation', async () => {
    const svc = getFinanceService();
    const ownerA = `device:${deviceA.id}`;
    const period = '2026-11';

    // Account + historical snapshot preservation on balance update
    const acc = await svc.upsertAccount(ownerA, {
      name: 'Primary Checking',
      accountType: 'bank',
      balance: '50000.00',
      currency: 'INR',
      sourceClassification: 'USER_ENTERED',
    });
    await svc.upsertAccount(ownerA, {
      id: acc.id,
      name: 'Primary Checking',
      accountType: 'bank',
      balance: '55000.00',
      currency: 'INR',
      sourceClassification: 'USER_ENTERED',
    });
    const snapshots = await svc.getAccountSnapshots(ownerA, acc.id);
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].balance_minor, 5000000);
    assert.equal(snapshots[1].balance_minor, 5500000);

    // Income & Expense + Cash Flow
    await svc.recordTransaction(ownerA, {
      txType: 'income',
      category: 'salary',
      amount: '100000.00',
      occurredAt: '2026-11-05T10:00:00Z',
    });
    await svc.recordTransaction(ownerA, {
      txType: 'expense',
      category: 'groceries',
      amount: '12500.50',
      description: 'Groceries with secret Bearer sk-test-secret-12345678901234567890',
      occurredAt: '2026-11-10T10:00:00Z',
    });

    const txs = await svc.listTransactions(ownerA, { period });
    assert.equal(txs.length, 2);
    assert.ok(!txs[0].description.includes('sk-test-secret-1234567890'));

    const cf = await svc.getCashFlow(ownerA, period);
    assert.equal(cf.totalIncomeFormatted, '100000.00');
    assert.equal(cf.totalExpenseFormatted, '12500.50');
    assert.equal(cf.netCashFlowFormatted, '87499.50');
    assert.equal(cf.savingsRatePct, 87.5);

    // Budget utilization
    const budget = await svc.upsertBudget(ownerA, {
      category: 'groceries',
      period,
      limit: '10000.00',
    });
    assert.equal(budget.overBudget, true);
    assert.equal(budget.utilizationPct, 125.01);

    // Savings goal
    const goal = await svc.upsertGoal(ownerA, {
      name: 'Emergency Fund',
      target: '300000.00',
      current: '150000.00',
      monthlyContribution: '25000.00',
    });
    assert.equal(goal.progressPct, 50);
    assert.equal(goal.estimatedMonthsToGoal, 6);

    // Debt repayment scenarios
    const sc1 = svc.projectDebtRepayment(toMinorUnits('100000.00'), 1200, toMinorUnits('5000.00'));
    const sc2 = svc.projectDebtRepayment(toMinorUnits('100000.00'), 1200, toMinorUnits('10000.00'));
    assert.equal(sc1.amortizes, true);
    assert.equal(sc2.amortizes, true);
    assert.ok(sc2.monthsToPayoff < sc1.monthsToPayoff);
    assert.ok(sc2.totalInterestMinor < sc1.totalInterestMinor);

    // Portfolio allocation & unverified/outdated classification
    await svc.upsertHolding(ownerA, {
      symbol: 'NIFTYBEES',
      assetClass: 'equity',
      quantity: 100,
      avgCost: '240.00',
      currentValue: '60000.00',
      sourceClassification: 'USER_ENTERED',
    });
    await svc.upsertHolding(ownerA, {
      symbol: 'LIQUIDBEES',
      assetClass: 'debt',
      quantity: 40,
      avgCost: '1000.00',
      currentValue: '40000.00',
      sourceClassification: 'OUTDATED',
    });
    const portfolio = await svc.analyzePortfolio(ownerA);
    assert.equal(portfolio.totalValueFormatted, '100000.00');
    assert.equal(portfolio.topHoldingConcentrationPct, 60);
    assert.equal(portfolio.concentrationRisk, 'high');
    assert.equal(portfolio.hasUnverifiedOrStaleData, true);
  });

  it('Enforces strict owner isolation, audit logging, and trading capital confirmation contract', async () => {
    const svc = getFinanceService();
    const ownerA = `device:${deviceA.id}`;
    const ownerB = `device:${deviceB.id}`;

    // Device B sees zero records from Device A via REST
    const resB = await fetch(`${baseUrl}/friday/finance/overview`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(resB.status, 200);
    const bodyB = await resB.json();
    assert.equal(bodyB.accounts.length, 0);
    assert.equal(bodyB.netWorthFormatted, '0.00');

    // Unauthenticated remote/bad token gets 401
    const unauthRes = await fetch(`${baseUrl}/friday/finance/overview`, {
      headers: { Authorization: 'Bearer frd_bad_token' },
    });
    assert.equal(unauthRes.status, 401);

    // Trading capital requires explicit confirmedByUser=true
    await assert.rejects(
      () =>
        svc.allocateTradingCapital(ownerA, {
          allocatedCapital: '25000.00',
          confirmedByUser: false,
        }),
      /Explicit user confirmation/
    );

    const confirmed = await svc.allocateTradingCapital(ownerA, {
      allocatedCapital: '25000.00',
      confirmedByUser: true,
      confirmationNote: 'Intraday session budget',
    });
    assert.equal(confirmed.allocatedCapitalFormatted, '25000.00');
    assert.equal(confirmed.confirmedByUser, true);

    // Device B does not see Device A trading capital
    assert.equal(await svc.getLatestTradingCapital(ownerB), null);

    // Audit records exist for financial access/mutations
    const store = await getMemoryStore();
    const audits = store.getAuditLogs(50);
    assert.ok(audits.some((a) => a.actor === ownerA && a.action === 'finance:trading_capital_confirm'));
  });

  it('Integrates with CapabilityDiscovery, BackgroundOrchestrator, ResultVerifier, and DisplayManager', async () => {
    const registry = getCapabilityRegistry();
    assert.ok(registry.get('finance.cash_flow'));
    assert.ok(registry.get('finance.portfolio_analyze'));
    assert.ok(registry.get('finance.debt_scenario'));

    const discovery = await getCapabilityDiscoveryEngine().discover({ request: 'Show my monthly cash flow' });
    assert.ok(discovery.matched.some((c) => c.capability.id === 'finance.cash_flow'));

    const plan = await getToolPlanner().validateProposedPlan({
      originalRequest: 'Show my monthly cash flow',
      steps: [
        {
          stepId: 'cf1',
          capabilityId: 'finance.cash_flow',
          arguments: { period: '2026-11' },
          dependencies: [],
        },
      ],
    });

    const orch = getBackgroundOrchestrator();
    const submitted = await orch.submitPlan(plan, {
      ownerId: `device:${deviceA.id}`,
      grantedPermissions: ['finance:read'],
    });

    let task;
    for (let i = 0; i < 40; i++) {
      task = await orch.getTask(submitted.taskId);
      if (task?.status === 'COMPLETED') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(task?.status, 'COMPLETED');

    const presRes = await fetch(`${baseUrl}/friday/tasks/${submitted.taskId}/presentation`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(presRes.status, 200);
    const { presentation } = await presRes.json();
    assert.equal(presentation.verificationStatus, 'VERIFIED');
    assert.equal(presentation.provenance[0].sourceName, 'FRIDAY Local Finance Ledger');
  });
});
