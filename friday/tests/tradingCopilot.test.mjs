import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-phase7-test-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-phase7.db');
process.env.FRIDAY_PORT = '0';

const { getMemoryStore } = await import('../dist/memory/store.js');
const { getCapitalRiskManager, estimateIntradayChargesMinor } = await import(
  '../dist/trading/capitalRiskManager.js'
);
const { normalizeAndValidateCandles, getMarketDataProvider } = await import(
  '../dist/trading/marketData.js'
);
const { analyzeIndicators } = await import('../dist/trading/indicators.js');
const { evaluateStrategies } = await import('../dist/trading/strategyEngine.js');
const { runBacktest } = await import('../dist/trading/backtester.js');
const { getTradingJournalService } = await import('../dist/trading/journalAlerts.js');
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

function makeTrendingCandles(count = 60, startMs = Date.parse('2026-11-27T04:00:00Z')) {
  const candles = [];
  let price = 100_000; // Rs 1000.00
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + 350;
    candles.push({
      timestamp: new Date(startMs + i * 5 * 60_000).toISOString(),
      openMinor: open,
      highMinor: close + 200,
      lowMinor: open - 150,
      closeMinor: close,
      volume: i === count - 1 ? 50_000 : 10_000 + i * 100,
    });
    price = close;
  }
  return candles;
}

describe('Phase 7: Trading Copilot Deterministic Foundation', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();

    const auth = getAuthService();
    const pA = await auth.pairDevice({
      code: auth.generatePairingCode().code,
      name: 'Trading Device A',
      platform: 'android',
    });
    deviceA = pA.device;
    tokenA = pA.token;

    const pB = await auth.pairDevice({
      code: auth.generatePairingCode().code,
      name: 'Trading Device B',
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
      // Ignore Windows temp file lock
    }
  });

  it('Dynamic capital confirmation, snapshots, daily risk preservation, and risk config enforcement', async () => {
    const mgr = getCapitalRiskManager();
    const ownerA = `device:${deviceA.id}`;

    // Unconfirmed capital rejected
    await assert.rejects(
      () =>
        mgr.confirmSessionCapital(ownerA, {
          totalEquity: '200000.00',
          availableCash: '150000.00',
          allocatedCapital: '100000.00',
          confirmedByUser: false,
        }),
      /Explicit user confirmation/
    );

    // Sizing rejected before risk config & capital are set
    const unconfSize = await mgr.validateAndSizeCandidate(ownerA, {
      instrument: {
        exchange: 'NSE',
        symbol: 'RELIANCE',
        name: 'Reliance Industries',
        instrumentType: 'CASH_EQUITY',
        sector: 'ENERGY',
        lotSize: 1,
        tickSizeMinor: 5,
      },
      direction: 'LONG',
      suggestedEntryMinor: 250_000,
      stopLossMinor: 245_000,
      targetMinor: 260_000,
      dataQuality: 'HISTORICAL_FIXTURE',
    });
    assert.equal(unconfSize.approved, false);
    assert.ok(unconfSize.reasons.length >= 2);

    // Configure risk limits + confirm initial capital
    await mgr.setRiskConfig(ownerA, {
      maxRiskPerTradePct: 1,
      maxDailyLossPct: 2,
      maxOpenPositions: 3,
      maxCapitalAllocationPct: 25,
      minRewardRiskRatio: 1.5,
      allowedExchanges: ['NSE', 'BSE'],
      allowedInstruments: ['CASH_EQUITY'],
    });

    const s1 = await mgr.confirmSessionCapital(ownerA, {
      totalEquity: '500000.00',
      availableCash: '200000.00',
      allocatedCapital: '100000.00',
      confirmedByUser: true,
    });
    assert.equal(s1.dailyRiskBudgetMinor, 200_000); // 2% of Rs 1,00,000 = Rs 2,000

    // Record a loss -> remaining daily risk drops
    await mgr.recordDailyPnl(ownerA, -50_000); // -Rs 500

    // Increasing allocated capital mid-session must NOT increase dailyRiskBudget or remainingDailyRisk
    const s2 = await mgr.confirmSessionCapital(ownerA, {
      totalEquity: '500000.00',
      availableCash: '200000.00',
      allocatedCapital: '150000.00',
      confirmedByUser: true,
      note: 'Mid-session top-up',
    });
    assert.equal(s2.dailyRiskBudgetMinor, 200_000);
    assert.equal(s2.remainingDailyRiskMinor, 150_000);

    const snapshots = await mgr.getCapitalSnapshots(ownerA);
    assert.equal(snapshots.length, 2);

    // Valid position sizing with charges & slippage
    const sized = await mgr.validateAndSizeCandidate(ownerA, {
      instrument: {
        exchange: 'NSE',
        symbol: 'TCS',
        name: 'TCS',
        instrumentType: 'CASH_EQUITY',
        sector: 'IT',
        lotSize: 1,
        tickSizeMinor: 5,
      },
      direction: 'LONG',
      suggestedEntryMinor: 100_000, // Rs 1000
      stopLossMinor: 98_000, // Rs 980 (risk Rs 20/share)
      targetMinor: 104_000, // Rs 1040 (RR = 2.0)
      dataQuality: 'HISTORICAL_FIXTURE',
    });
    assert.equal(sized.approved, true);
    assert.ok(sized.quantity > 0);
    assert.ok(sized.estimatedChargesMinor > 0);
    assert.equal(
      estimateIntradayChargesMinor(100_000, 98_000, sized.quantity),
      sized.estimatedChargesMinor
    );

    // Invalid SL direction rejected
    const badSl = await mgr.validateAndSizeCandidate(ownerA, {
      instrument: {
        exchange: 'NSE',
        symbol: 'TCS',
        name: 'TCS',
        instrumentType: 'CASH_EQUITY',
        sector: 'IT',
        lotSize: 1,
        tickSizeMinor: 5,
      },
      direction: 'LONG',
      suggestedEntryMinor: 100_000,
      stopLossMinor: 101_000,
      targetMinor: 105_000,
      dataQuality: 'HISTORICAL_FIXTURE',
    });
    assert.equal(badSl.approved, false);
  });

  it('Market data handles duplicates, out-of-order, missing gaps, staleness, indicators & strategies', async () => {
    const inst = {
      exchange: 'NSE',
      symbol: 'INFY',
      name: 'Infosys',
      instrumentType: 'CASH_EQUITY',
      sector: 'IT',
      lotSize: 1,
      tickSizeMinor: 5,
    };

    const raw = makeTrendingCandles(60);
    // Inject duplicate and out-of-order candle, and drop bar 10 to create a missing candle gap
    const tampered = [raw[2], raw[0], raw[1], raw[1], ...raw.slice(3, 10), ...raw.slice(11)];

    const series = normalizeAndValidateCandles({
      instrument: inst,
      timeframe: '5m',
      sourceName: 'TestFixture',
      declaredQuality: 'HISTORICAL_FIXTURE',
      rawCandles: tampered,
    });
    assert.equal(series.duplicatesRemoved, 1);
    assert.equal(series.missingCandlesDetected, 1);
    assert.equal(series.candles[0].timestamp, raw[0].timestamp);

    const ind = analyzeIndicators(series.candles);
    assert.equal(ind.warmupComplete, true);
    assert.ok(ind.vwapMinor !== null);
    assert.ok(ind.rsi14 !== null && ind.rsi14 > 50);
    assert.ok(ind.ema9Minor !== null && ind.ema20Minor !== null && ind.ema50Minor !== null);
    assert.ok(ind.ema9Minor > ind.ema20Minor && ind.ema20Minor > ind.ema50Minor);
    assert.ok(ind.macd !== null);
    assert.ok(ind.atr14Minor !== null);

    const evalRes = evaluateStrategies(series);
    assert.equal(evalRes.suspended, false);
    assert.ok(evalRes.candidates.length >= 1);

    // Stale LIVE data suspends setup evaluation
    const staleSeries = normalizeAndValidateCandles({
      instrument: inst,
      timeframe: '5m',
      sourceName: 'TestLive',
      declaredQuality: 'LIVE',
      rawCandles: raw,
      maxStaleSeconds: 60,
      nowMs: Date.parse(raw[raw.length - 1].timestamp) + 600_000,
    });
    assert.equal(staleSeries.stale, true);
    assert.equal(staleSeries.quality, 'STALE');
    const staleEval = evaluateStrategies(staleSeries);
    assert.equal(staleEval.suspended, true);
    assert.equal(staleEval.candidates.length, 0);
  });

  it('Trading journal, deduplicated alerts, and zero-look-ahead backtesting', async () => {
    const ownerA = `device:${deviceA.id}`;
    const jSvc = getTradingJournalService();

    const entry = await jSvc.recordJournalEntry(ownerA, {
      exchange: 'NSE',
      symbol: 'HDFCBANK',
      side: 'LONG',
      quantity: 10,
      entryPrice: '1500.00',
      exitPrice: '1530.00',
      stopLoss: '1485.00',
      target: '1530.00',
      charges: '25.00',
      slippage: '10.00',
      notes: 'Clean breakout',
    });
    // Gross: (1530 - 1500) * 10 = 300.00 (30000 minor) - 25.00 - 10.00 = 265.00
    assert.equal(entry.realizedPnlFormatted, '265.00');
    assert.equal(entry.status, 'CLOSED');

    // Alert deduplication
    const a1 = await jSvc.publishTradingAlert({
      ownerId: ownerA,
      kind: 'setup_validated',
      symbol: 'HDFCBANK',
      title: 'Setup Validated',
      message: 'HDFCBANK LONG setup validated',
    });
    const a2 = await jSvc.publishTradingAlert({
      ownerId: ownerA,
      kind: 'setup_validated',
      symbol: 'HDFCBANK',
      title: 'Setup Validated',
      message: 'Duplicate alert should be suppressed',
    });
    assert.ok(a1 !== null);
    assert.equal(a2, null);

    // Backtesting (no look-ahead + OOS split + historical simulation flag)
    const bt = await runBacktest({
      ownerId: ownerA,
      instrument: {
        exchange: 'NSE',
        symbol: 'INFY',
        name: 'Infosys',
        instrumentType: 'CASH_EQUITY',
        sector: 'IT',
        lotSize: 1,
        tickSizeMinor: 5,
      },
      timeframe: '5m',
      candles: makeTrendingCandles(80),
      strategyId: 'vwap_trend_continuation',
    });
    assert.equal(bt.isHistoricalSimulation, true);
    assert.ok(bt.outOfSample !== null);
  });

  it('Enforces owner isolation, capability discovery, and orchestrator presentation', async () => {
    const ownerA = `device:${deviceA.id}`;
    // Device B sees no capital or journal from Device A
    const resB = await fetch(`${baseUrl}/friday/trading/overview`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(resB.status, 200);
    const bodyB = await resB.json();
    assert.equal(bodyB.session, null);
    assert.equal(bodyB.journal.length, 0);

    // Capability discovery
    const disc = await getCapabilityDiscoveryEngine().discover({
      request: 'Show my remaining risk budget',
    });
    assert.ok(disc.matched.some((c) => c.capability.id === 'trading.risk_budget'));

    // Orchestrator -> ResultVerifier -> DisplayManager
    getMarketDataProvider().registerFixture(
      {
        exchange: 'NSE',
        symbol: 'SBIN',
        name: 'SBI',
        instrumentType: 'CASH_EQUITY',
        sector: 'BANKING',
        lotSize: 1,
        tickSizeMinor: 5,
      },
      '5m',
      makeTrendingCandles(60)
    );

    const plan = await getToolPlanner().validateProposedPlan({
      originalRequest: 'Show my remaining risk budget',
      steps: [
        {
          stepId: 'rb1',
          capabilityId: 'trading.risk_budget',
          arguments: {},
          dependencies: [],
        },
      ],
    });
    const orch = getBackgroundOrchestrator();
    const submitted = await orch.submitPlan(plan, {
      ownerId: ownerA,
      grantedPermissions: ['trading:read'],
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
  });
});
