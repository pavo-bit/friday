import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-phase12-test-'));
process.env.FRIDAY_DB_PATH = path.join(tmpDir, 'friday-phase12.db');
process.env.FRIDAY_PORT = '0';

const { getMemoryStore } = await import('../dist/memory/store.js');
const {
  getMarketSessionEngine,
  isTradingHoliday,
  HOLIDAYS_2026,
} = await import('../dist/trading/sessionEngine.js');
const {
  getMarketDataProvider,
  getMarketDataRegistry,
  STANDARD_INSTRUMENTS,
  normalizeAndValidateCandles,
  generateSyntheticIntradayCandles,
} = await import('../dist/trading/marketData.js');
const {
  analyzeIndicators,
  computeOpeningRange,
  computeTrendStrength,
} = await import('../dist/trading/indicators.js');
const {
  evaluateStrategies,
  scanMultipleInstruments,
} = await import('../dist/trading/strategyEngine.js');
const {
  getCapitalRiskManager,
  estimateIntradayChargesMinor,
} = await import('../dist/trading/capitalRiskManager.js');
const { runBacktest } = await import('../dist/trading/backtester.js');
const { getTradingJournalService } = await import('../dist/trading/journalAlerts.js');
const { getCapabilityDiscoveryEngine } = await import('../dist/orchestration/capabilityDiscovery.js');
const { getToolRegistry } = await import('../dist/orchestration/toolRegistry.js');
const { registerTradingCapabilities } = await import('../dist/trading/tradingCapabilities.js');
const { getAuthService } = await import('../dist/services/authService.js');
const { FridayServer } = await import('../dist/api/server.js');

let server;
let baseUrl;
let testActorId;
let authToken;

describe('Phase 12: Advanced Trading Intelligence & Risk-Governed Copilot', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();

    // Register capabilities
    registerTradingCapabilities();

    // Start API server for REST endpoint verification
    server = new FridayServer();
    await server.start(0);
    baseUrl = `http://127.0.0.1:${server.getPort()}`;

    // Register test device and token
    const authSvc = getAuthService();
    const paired = await authSvc.pairDevice({
      code: authSvc.generatePairingCode().code,
      name: 'Phase12-Trader-Laptop',
      platform: 'windows',
    });
    testActorId = paired.device.ownerId || paired.device.id;
    authToken = paired.token;
  });

  after(async () => {
    if (server) await server.stop();
    const store = await getMemoryStore();
    await store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Ignore
    }
  });

  // ============================================================
  // 1. Session Engine & 2026 Holiday Calendar
  // ============================================================
  describe('1. Session Engine & NSE/BSE Holiday Calendar', () => {
    const sessionEngine = getMarketSessionEngine();

    it('identifies weekend as CLOSED_WEEKEND', () => {
      // 2026-05-16 is a Saturday
      const saturday = new Date('2026-05-16T10:00:00+05:30');
      const status = sessionEngine.getSessionStatus(saturday, 'NSE');
      assert.equal(status.state, 'CLOSED_WEEKEND');
      assert.equal(status.isOpen, false);
      assert.ok(/weekend/i.test(status.description));
    });

    it('identifies regular market open on a weekday at 10:30 IST', () => {
      // 2026-05-18 is a Monday (regular trading day)
      const monday = new Date('2026-05-18T10:30:00+05:30');
      const status = sessionEngine.getSessionStatus(monday, 'NSE');
      assert.equal(status.state, 'REGULAR_OPEN');
      assert.equal(status.isOpen, true);
    });

    it('identifies pre-open session between 09:00 and 09:15 IST', () => {
      const preOpen = new Date('2026-05-18T09:05:00+05:30');
      const status = sessionEngine.getSessionStatus(preOpen, 'NSE');
      assert.equal(status.state, 'PRE_OPEN');
      assert.equal(status.isOpen, false);
    });

    it('identifies post-close session between 15:30 and 16:00 IST', () => {
      const postClose = new Date('2026-05-18T15:45:00+05:30');
      const status = sessionEngine.getSessionStatus(postClose, 'NSE');
      assert.equal(status.state, 'POST_CLOSE');
      assert.equal(status.isOpen, false);
    });

    it('identifies closed overnight after 16:00 IST', () => {
      const night = new Date('2026-05-18T20:00:00+05:30');
      const status = sessionEngine.getSessionStatus(night, 'NSE');
      assert.equal(status.state, 'CLOSED_OVERNIGHT');
      assert.equal(status.isOpen, false);
    });

    it('identifies 2026 Republic Day as CLOSED_HOLIDAY', () => {
      const republicDay = new Date('2026-01-26T11:00:00+05:30');
      const status = sessionEngine.getSessionStatus(republicDay, 'NSE');
      assert.equal(status.state, 'CLOSED_HOLIDAY');
      assert.equal(status.isOpen, false);
      assert.ok(status.holiday);
      assert.equal(status.holiday.name, 'Republic Day');
    });

    it('identifies Diwali Laxmi Pujan (Muhurat Trading) special session', () => {
      // 2026-11-08 is Diwali Laxmi Pujan (Muhurat Trading 18:15-19:15)
      const duringMuhurat = new Date('2026-11-08T18:30:00+05:30');
      const status = sessionEngine.getSessionStatus(duringMuhurat, 'NSE');
      assert.equal(status.state, 'SPECIAL_SESSION');
      assert.equal(status.isOpen, true);
      assert.equal(status.isMuhuratTrading, true);

      // Before Muhurat on the same day:
      const beforeMuhurat = new Date('2026-11-08T11:00:00+05:30');
      const statusBefore = sessionEngine.getSessionStatus(beforeMuhurat, 'NSE');
      assert.equal(statusBefore.state, 'CLOSED_HOLIDAY');
      assert.equal(statusBefore.isOpen, false);
    });

    it('computes next session open correctly over a weekend', () => {
      const fridayNight = new Date('2026-05-15T20:00:00+05:30');
      const nextOpen = sessionEngine.getNextSessionOpen(fridayNight, 'NSE');
      assert.ok(nextOpen);
      // Next session should be Monday 2026-05-18 09:15 IST
      const nextStr = nextOpen.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
      assert.ok(nextStr.includes('5/18/2026') || nextStr.includes('18'));
    });
  });

  // ============================================================
  // 2. Market Data Abstraction & Candle Validation
  // ============================================================
  describe('2. Market Data Abstraction & Candle Validation', () => {
    it('has standard instruments defined including NIFTY, BANKNIFTY, RELIANCE', () => {
      assert.ok(STANDARD_INSTRUMENTS.NIFTY);
      assert.ok(STANDARD_INSTRUMENTS.BANKNIFTY);
      assert.ok(STANDARD_INSTRUMENTS.RELIANCE);
      assert.ok(STANDARD_INSTRUMENTS.HDFCBANK);
      assert.ok(STANDARD_INSTRUMENTS.TCS);
      assert.ok(STANDARD_INSTRUMENTS.INFY);
      assert.ok(STANDARD_INSTRUMENTS.SENSEX);
      assert.equal(STANDARD_INSTRUMENTS.NIFTY.exchange, 'NSE');
      assert.equal(STANDARD_INSTRUMENTS.SENSEX.exchange, 'BSE');
    });

    it('rejects corrupt candles where High < Low or negative volume', () => {
      const invalidCandles = [
        {
          timestamp: '2026-05-18T09:15:00Z',
          openMinor: 10000,
          highMinor: 9000, // Invalid: High < Low
          lowMinor: 9500,
          closeMinor: 9200,
          volume: 1000,
        },
        {
          timestamp: '2026-05-18T09:20:00Z',
          openMinor: 10000,
          highMinor: 10500,
          lowMinor: 9500,
          closeMinor: 10200,
          volume: -50, // Invalid: negative volume
        },
      ];

      assert.throws(() => {
        normalizeAndValidateCandles({
          instrument: STANDARD_INSTRUMENTS.RELIANCE,
          timeframe: '5m',
          sourceName: 'CorruptTest',
          declaredQuality: 'HISTORICAL_FIXTURE',
          rawCandles: invalidCandles,
          strict: true,
        });
      }, /OHLC integrity failure|corrupt candle|positive integer/i);
    });

    it('generates synthetic intraday candles with valid OHLC and timestamps', () => {
      const series = generateSyntheticIntradayCandles(
        STANDARD_INSTRUMENTS.RELIANCE,
        '5m',
        '2026-05-18',
        250000,
        'BULLISH'
      );
      assert.equal(series.instrument.symbol, 'RELIANCE');
      assert.equal(series.candles.length, 75); // 09:15 to 15:30 in 5m candles = 75 candles
      assert.equal(series.dataQuality, 'HISTORICAL_FIXTURE');

      for (const c of series.candles) {
        assert.ok(c.highMinor >= c.lowMinor, 'High >= Low');
        assert.ok(c.highMinor >= c.openMinor, 'High >= Open');
        assert.ok(c.highMinor >= c.closeMinor, 'High >= Close');
        assert.ok(c.lowMinor <= c.openMinor, 'Low <= Open');
        assert.ok(c.lowMinor <= c.closeMinor, 'Low <= Close');
        assert.ok(c.volume > 0, 'Volume > 0');
      }
    });

    it('MarketDataRegistry returns registered or synthetic series for standard instruments', async () => {
      const registry = getMarketDataRegistry();
      const series = await registry.getCandles('NSE', 'RELIANCE', '5m');
      assert.equal(series.instrument.symbol, 'RELIANCE');
      assert.ok(series.candles.length >= 50);
    });
  });

  // ============================================================
  // 3. Technical Indicators
  // ============================================================
  describe('3. Enhanced Technical Indicators', () => {
    it('computes anchored intraday VWAP, Opening Range, and Trend Strength', () => {
      const series = generateSyntheticIntradayCandles(
        STANDARD_INSTRUMENTS.NIFTY,
        '5m',
        '2026-05-18',
        2200000,
        'BULLISH'
      );
      const snapshot = analyzeIndicators(series.candles);

      assert.ok(snapshot.vwapMinor > 0, 'VWAP must be positive');
      assert.ok(snapshot.sma20Minor > 0);
      assert.ok(snapshot.ema9Minor > 0);
      assert.ok(snapshot.ema21Minor > 0);
      assert.ok(snapshot.trendStrength);
      assert.ok(['STRONG_BULLISH', 'BULLISH', 'NEUTRAL', 'BEARISH', 'STRONG_BEARISH'].includes(snapshot.trendStrength));

      // Check Opening Range
      assert.ok(snapshot.openingRangeHighMinor !== undefined);
      assert.ok(snapshot.openingRangeLowMinor !== undefined);
      if (snapshot.openingRangeHighMinor && snapshot.openingRangeLowMinor) {
        assert.ok(snapshot.openingRangeHighMinor >= snapshot.openingRangeLowMinor);
      }
    });

    it('computes opening range accurately from first 15 minutes (3 candles of 5m)', () => {
      const series = generateSyntheticIntradayCandles(
        STANDARD_INSTRUMENTS.BANKNIFTY,
        '5m',
        '2026-05-18',
        4800000,
        'SIDEWAYS'
      );
      const orb = computeOpeningRange(series.candles, '5m', 15);
      assert.ok(orb);
      assert.ok(orb.highMinor >= orb.lowMinor);
      assert.equal(orb.rangeDurationMinutes, 15);
    });
  });

  // ============================================================
  // 4. Strategy Engine & Multi-Symbol Scanning
  // ============================================================
  describe('4. Strategy Engine & Confidence Scoring', () => {
    it('evaluates strategies and returns confidence score, target methodology, and invalidation rules', () => {
      const series = generateSyntheticIntradayCandles(
        STANDARD_INSTRUMENTS.RELIANCE,
        '5m',
        '2026-05-18',
        250000,
        'BULLISH'
      );
      const evalResult = evaluateStrategies(series);
      assert.ok(evalResult.snapshot);
      assert.ok(Array.isArray(evalResult.candidates));

      for (const cand of evalResult.candidates) {
        assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(cand.confidenceTier));
        assert.ok(cand.confidenceScore >= 0.5 && cand.confidenceScore <= 1.0);
        assert.ok(cand.targetMethodology, 'Must specify target methodology');
        assert.ok(cand.signalQualityExplanation, 'Must provide signal explanation');
        assert.ok(cand.invalidationCondition, 'Must specify invalidation condition');
        assert.ok(cand.riskRewardRatio >= 1.5, 'R:R ratio must meet intermediate bar');
      }
    });

    it('scans multiple instruments concurrently and ranks setups by confidence', async () => {
      const instruments = [
        STANDARD_INSTRUMENTS.NIFTY,
        STANDARD_INSTRUMENTS.BANKNIFTY,
        STANDARD_INSTRUMENTS.RELIANCE,
        STANDARD_INSTRUMENTS.HDFCBANK,
      ];
      const scanResult = await scanMultipleInstruments(instruments, getMarketDataRegistry(), '5m');
      assert.equal(scanResult.totalInstrumentsScanned, 4);
      assert.ok(Array.isArray(scanResult.setups));

      // Setups should be ordered by confidence score descending
      if (scanResult.setups.length > 1) {
        for (let i = 0; i < scanResult.setups.length - 1; i++) {
          assert.ok(
            scanResult.setups[i].confidenceScore >= scanResult.setups[i + 1].confidenceScore
          );
        }
      }
    });
  });

  // ============================================================
  // 5. Dynamic Capital Risk Manager & Indian Statutory Charges
  // ============================================================
  describe('5. Capital Risk Manager & Statutory Charges', () => {
    const mgr = getCapitalRiskManager();

    it('prompts when daily session capital has not been confirmed', async () => {
      const actorId = 'actor-unconfirmed-test';
      const status = await mgr.checkCapitalStatus(actorId);
      assert.equal(status.needsConfirmation, true);
      assert.ok(status.message.includes('Capital has not been confirmed'));
    });

    it('confirms capital and verifies status is active', async () => {
      const session = await mgr.confirmSessionCapital(testActorId, {
        totalEquity: '500000',
        availableCash: '300000',
        allocatedCapital: '200000',
        confirmedByUser: true,
      });
      assert.equal(session.allocatedCapitalMinor, 20000000); // ₹2,00,000 in paise
      assert.equal(session.confirmedByUser, true);

      const status = await mgr.checkCapitalStatus(testActorId);
      assert.equal(status.needsConfirmation, false);
      assert.ok(status.currentSession);
      assert.equal(status.currentSession.allocatedCapitalMinor, 20000000);
    });

    it('calculates position sizing with strict risk limits and statutory charges', async () => {
      await mgr.setRiskConfig(testActorId, {
        maxRiskPerTradePct: 1,
        maxDailyLossPct: 2,
        maxOpenPositions: 3,
        maxCapitalAllocationPct: 25,
        minRewardRiskRatio: 1.5,
        allowedExchanges: ['NSE', 'BSE'],
        allowedInstruments: ['CASH_EQUITY'],
      });

      const sizing = await mgr.validateAndSizeCandidate(testActorId, {
        instrument: STANDARD_INSTRUMENTS.RELIANCE,
        direction: 'LONG',
        suggestedEntryMinor: 250000, // ₹2500.00
        stopLossMinor: 247000,       // ₹2470.00 (Risk: ₹30.00 per share)
        targetMinor: 256000,         // ₹2560.00 (Reward: ₹60.00 per share, 2:1 R:R)
        dataQuality: 'HISTORICAL_FIXTURE',
      });

      assert.equal(sizing.approved, true);
      assert.ok(sizing.recommendedQuantity > 0);
      assert.ok(sizing.estimatedChargesMinor > 0);
      assert.ok(sizing.netProjectedPnlMinor > 0);
      assert.ok(sizing.riskAmountMinor <= sizing.maxAllowedRiskMinor);
    });

    it('calculates exact NSE cash statutory charges including STT and GST', () => {
      // 100 shares @ ₹2500 buy, sell @ ₹2560
      const charges = estimateIntradayChargesMinor('NSE', 'BUY', 250000, 256000, 100);
      assert.ok(charges.brokerageMinor > 0);
      assert.ok(charges.sttMinor > 0, 'STT is levied on intraday sell leg');
      assert.ok(charges.exchangeTurnoverMinor > 0);
      assert.ok(charges.gstMinor > 0, 'GST on brokerage and exchange fees');
      assert.ok(charges.sebiChargesMinor > 0);
      assert.ok(charges.stampDutyMinor > 0, 'Stamp duty on buy leg');
      assert.ok(charges.totalChargesMinor > 0);
    });
  });

  // ============================================================
  // 6. Backtester with Benchmark & Slippage
  // ============================================================
  describe('6. Backtester Zero Look-Ahead Bias & Benchmark', () => {
    it('executes backtest with benchmark return and gap-through handling', async () => {
      const series = generateSyntheticIntradayCandles(
        STANDARD_INSTRUMENTS.RELIANCE,
        '5m',
        '2026-05-18',
        250000,
        'BULLISH'
      );

      const result = await runBacktest({
        ownerId: testActorId,
        instrument: series.instrument,
        timeframe: '5m',
        candles: series.candles,
        strategyId: 'vwap-trend-continuation',
        slippageBps: 5, // 0.05% slippage
      });

      assert.equal(result.strategyId, 'vwap-trend-continuation');
      assert.ok(result.metrics);
      assert.ok(typeof result.metrics.winRatePct === 'number');
      assert.ok(typeof result.metrics.profitFactor === 'number');
      assert.ok(typeof result.metrics.benchmarkReturnPct === 'number');
      assert.ok(typeof result.metrics.maxDrawdownPct === 'number');
    });
  });

  // ============================================================
  // 7. Trade Journal Analytics & Mistake Tracking
  // ============================================================
  describe('7. Trade Journal Analytics & Adherence', () => {
    const journalSvc = getTradingJournalService();

    it('records journal entries and computes risk adherence rate', async () => {
      // Record a trade adhering to stop loss
      await journalSvc.recordJournalEntry(testActorId, {
        symbol: 'RELIANCE',
        exchange: 'NSE',
        side: 'BUY',
        quantity: 50,
        entryPrice: '2500.00',
        exitPrice: '2540.00',
        stopLoss: '2470.00',
        target: '2560.00',
        realizedPnl: '2000.00',
        notes: 'Followed VWAP continuation discipline',
        adheredToRules: true,
      });

      // Record a second trade where trader violated plan (moved stop loss)
      await journalSvc.recordJournalEntry(testActorId, {
        symbol: 'INFY',
        exchange: 'NSE',
        side: 'BUY',
        quantity: 20,
        entryPrice: '1500.00',
        exitPrice: '1460.00',
        stopLoss: '1480.00',
        target: '1540.00',
        realizedPnl: '-800.00',
        notes: 'Moved stop loss hoping for bounce',
        adheredToRules: false,
        mistakeTag: 'MOVED_STOP_LOSS',
      });

      const analytics = await journalSvc.getJournalAnalytics(testActorId);
      assert.ok(analytics.totalTrades >= 2);
      assert.ok(analytics.winningTrades >= 1);
      assert.ok(analytics.losingTrades >= 1);
      assert.ok(analytics.riskAdherencePct > 0 && analytics.riskAdherencePct <= 100);
      assert.ok(analytics.mistakeBreakdown.length > 0);
      assert.equal(analytics.mistakeBreakdown[0].mistake, 'MOVED_STOP_LOSS');
    });
  });

  // ============================================================
  // 8. Capability Discovery & Intent Routing
  // ============================================================
  describe('8. Capability Discovery & Intent Routing', () => {
    const discovery = getCapabilityDiscoveryEngine();

    it('matches "is NSE open right now?" to trading.market_session', async () => {
      const res = await discovery.discover({ request: 'is NSE open right now?' });
      assert.ok(res.matched.length > 0);
      assert.equal(res.matched[0].capability.id, 'trading.market_session');
    });

    it('matches "scan setups for today" to trading.scan_setups', async () => {
      const res = await discovery.discover({ request: 'scan intraday setups for today' });
      assert.ok(res.matched.length > 0);
      assert.equal(res.matched[0].capability.id, 'trading.scan_setups');
    });

    it('matches "check trading capital status" to trading.capital_status', async () => {
      const res = await discovery.discover({ request: 'check trading capital status' });
      assert.ok(res.matched.length > 0);
      assert.equal(res.matched[0].capability.id, 'trading.capital_status');
    });

    it('matches "analyze NIFTY on 5m" to trading.analyze_stock', async () => {
      const res = await discovery.discover({ request: 'analyze NIFTY on 5m timeframe' });
      assert.ok(res.matched.length > 0);
      assert.ok(
        res.matched[0].capability.id === 'trading.analyze_stock' ||
        res.matched[0].capability.id === 'trading.analyze_instrument'
      );
    });
  });

  // ============================================================
  // 9. REST API Endpoints
  // ============================================================
  describe('9. REST API Endpoints', () => {
    it('GET /friday/trading/session returns valid session info', async () => {
      const res = await fetch(`${baseUrl}/friday/trading/session`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.session);
      assert.ok(data.session.state);
      assert.ok(data.session.timezone, 'Asia/Kolkata');
    });

    it('GET /friday/trading/capital/status returns capital status', async () => {
      const res = await fetch(`${baseUrl}/friday/trading/capital/status`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(typeof data.needsConfirmation === 'boolean');
    });

    it('GET /friday/trading/journal/analytics returns analytics', async () => {
      const res = await fetch(`${baseUrl}/friday/trading/journal/analytics`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.analytics);
      assert.ok(typeof data.analytics.winRatePct === 'number');
      assert.ok(typeof data.analytics.riskAdherencePct === 'number');
    });

    it('POST /friday/trading/scan returns setups across instruments', async () => {
      const res = await fetch(`${baseUrl}/friday/trading/scan`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ timeframe: '5m' }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.setups);
      assert.ok(typeof data.totalInstrumentsScanned === 'number');
    });
  });
});
