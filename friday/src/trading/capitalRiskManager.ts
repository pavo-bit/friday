// ============================================================
// FRIDAY — Trading Copilot Dynamic Capital & Risk Manager
// Deterministic minor-unit sizing, daily loss & snapshot ledger
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { redactSecrets } from '../memory/redaction';
import { formatMinorUnits, toMinorUnits } from '../finance/money';
import {
  ExchangeCode,
  InstrumentType,
  PositionSizingResult,
  RiskConfigRecord,
  TradeCandidate,
  TradingCapitalSession,
} from './tradingTypes';

function todayIstDate(): string {
  // Asia/Kolkata (+05:30)
  const istMs = Date.now() + 330 * 60_000;
  return new Date(istMs).toISOString().slice(0, 10);
}

/**
 * Deterministic NSE/BSE cash-equity intraday cost estimate (brokerage + STT + exchange + SEBI + GST + stamp).
 */
export function estimateIntradayChargesMinor(
  entryPriceMinor: number,
  exitPriceMinor: number,
  quantity: number
): number {
  if (quantity <= 0) return 0;
  const buyTurnover = entryPriceMinor * quantity;
  const sellTurnover = exitPriceMinor * quantity;
  const totalTurnover = buyTurnover + sellTurnover;

  // Brokerage: 0.03% per leg capped at Rs 20 (2000 minor) per leg
  const buyBrok = Math.min(2000, Math.round(buyTurnover * 0.0003));
  const sellBrok = Math.min(2000, Math.round(sellTurnover * 0.0003));
  const brokerage = buyBrok + sellBrok;

  // STT intraday: 0.025% on sell side
  const stt = Math.round(sellTurnover * 0.00025);
  // Exchange txn + SEBI: ~0.00335% on total turnover
  const exchange = Math.round(totalTurnover * 0.0000335);
  // Stamp duty: 0.003% on buy side
  const stamp = Math.round(buyTurnover * 0.00003);
  // GST: 18% on (brokerage + exchange)
  const gst = Math.round((brokerage + exchange) * 0.18);

  return brokerage + stt + exchange + stamp + gst;
}

export class CapitalRiskManager {
  async confirmSessionCapital(
    ownerId: string,
    input: {
      totalEquity: number | string;
      availableCash: number | string;
      allocatedCapital: number | string;
      confirmedByUser: boolean;
      currency?: string;
      sessionDate?: string;
      note?: string;
    }
  ): Promise<TradingCapitalSession> {
    if (!input.confirmedByUser) {
      throw new Error('Explicit user confirmation (confirmedByUser=true) is required to set trading capital.');
    }

    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const totalEquityMinor = toMinorUnits(input.totalEquity);
    const availableCashMinor = toMinorUnits(input.availableCash);
    const allocatedCapitalMinor = toMinorUnits(input.allocatedCapital);
    if (totalEquityMinor < 0 || availableCashMinor < 0 || allocatedCapitalMinor <= 0) {
      throw new Error('Capital values must be non-negative and allocatedCapital must be positive.');
    }
    if (allocatedCapitalMinor > availableCashMinor) {
      throw new Error('Allocated trading capital cannot exceed available cash.');
    }

    const sessionDate = input.sessionDate || todayIstDate();
    const currency = (input.currency || 'INR').trim().toUpperCase();
    const riskCfg = await this.getRiskConfig(ownerId);
    const maxDailyLossBps = riskCfg?.maxDailyLossBps ?? 200; // Used only for initial budget if configured

    const existing = db
      .prepare(`SELECT * FROM trading_capital_sessions WHERE owner_id = ? AND session_date = ?`)
      .get(ownerId, sessionDate) as Record<string, unknown> | undefined;

    let sessionId: string;
    let reservedCapitalMinor = 0;
    let realizedPnlMinor = 0;
    let unrealizedPnlMinor = 0;
    let dailyRiskBudgetMinor = Math.round((allocatedCapitalMinor * maxDailyLossBps) / 10_000);
    let remainingDailyRiskMinor = dailyRiskBudgetMinor;

    const tx = db.transaction(() => {
      if (existing) {
        sessionId = String(existing.id);
        // Preserve open-position reserve, realized P&L, and never increase daily risk budget mid-session
        reservedCapitalMinor = Number(existing.reserved_capital_minor);
        realizedPnlMinor = Number(existing.realized_pnl_minor);
        unrealizedPnlMinor = Number(existing.unrealized_pnl_minor);
        const prevBudget = Number(existing.daily_risk_budget_minor);
        const prevRemaining = Number(existing.remaining_daily_risk_minor);
        dailyRiskBudgetMinor = Math.min(prevBudget, dailyRiskBudgetMinor);
        remainingDailyRiskMinor = Math.min(prevRemaining, dailyRiskBudgetMinor);

        db.prepare(
          `UPDATE trading_capital_sessions
           SET total_equity_minor = ?, available_cash_minor = ?, allocated_capital_minor = ?,
               daily_risk_budget_minor = ?, remaining_daily_risk_minor = ?,
               currency = ?, confirmed_by_user = 1, updated_at = datetime('now')
           WHERE id = ?`
        ).run(
          totalEquityMinor,
          availableCashMinor,
          allocatedCapitalMinor,
          dailyRiskBudgetMinor,
          remainingDailyRiskMinor,
          currency,
          sessionId
        );
      } else {
        sessionId = uuidv4();
        db.prepare(
          `INSERT INTO trading_capital_sessions (
            id, owner_id, session_date, total_equity_minor, available_cash_minor,
            allocated_capital_minor, reserved_capital_minor, realized_pnl_minor,
            unrealized_pnl_minor, daily_risk_budget_minor, remaining_daily_risk_minor,
            currency, confirmed_by_user
          ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 1)`
        ).run(
          sessionId,
          ownerId,
          sessionDate,
          totalEquityMinor,
          availableCashMinor,
          allocatedCapitalMinor,
          dailyRiskBudgetMinor,
          remainingDailyRiskMinor,
          currency
        );
      }

      db.prepare(
        `INSERT INTO trading_capital_snapshots (
          id, session_id, owner_id, allocated_capital_minor, available_cash_minor,
          reserved_capital_minor, realized_pnl_minor, remaining_daily_risk_minor, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uuidv4(),
        sessionId!,
        ownerId,
        allocatedCapitalMinor,
        availableCashMinor,
        reservedCapitalMinor,
        realizedPnlMinor,
        remainingDailyRiskMinor,
        redactSecrets((input.note || 'User-confirmed session capital').trim())
      );
    });
    tx();

    store.logAudit(
      ownerId,
      'trading:capital_confirm',
      `${sessionDate} allocated=${formatMinorUnits(allocatedCapitalMinor)} ${currency}`,
      'high',
      true
    );

    return (await this.getSessionCapital(ownerId, sessionDate))!;
  }

  async getSessionCapital(
    ownerId: string,
    sessionDate = todayIstDate()
  ): Promise<TradingCapitalSession | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;

    const row = db
      .prepare(`SELECT * FROM trading_capital_sessions WHERE owner_id = ? AND session_date = ?`)
      .get(ownerId, sessionDate) as Record<string, unknown> | undefined;
    if (!row) return null;

    const allocated = Number(row.allocated_capital_minor);
    const reserved = Number(row.reserved_capital_minor);
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      sessionDate: String(row.session_date),
      totalEquityMinor: Number(row.total_equity_minor),
      availableCashMinor: Number(row.available_cash_minor),
      allocatedCapitalMinor: allocated,
      reservedCapitalMinor: reserved,
      availableForNewPositionsMinor: Math.max(0, allocated - reserved),
      realizedPnlMinor: Number(row.realized_pnl_minor),
      unrealizedPnlMinor: Number(row.unrealized_pnl_minor),
      dailyRiskBudgetMinor: Number(row.daily_risk_budget_minor),
      remainingDailyRiskMinor: Number(row.remaining_daily_risk_minor),
      currency: String(row.currency),
      confirmedByUser: Number(row.confirmed_by_user) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async getCapitalSnapshots(ownerId: string): Promise<Array<Record<string, unknown>>> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    return db
      .prepare(`SELECT * FROM trading_capital_snapshots WHERE owner_id = ? ORDER BY recorded_at ASC`)
      .all(ownerId) as Array<Record<string, unknown>>;
  }

  async recordDailyPnl(
    ownerId: string,
    realizedDeltaMinor: number,
    sessionDate = todayIstDate()
  ): Promise<TradingCapitalSession | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;

    const cur = await this.getSessionCapital(ownerId, sessionDate);
    if (!cur) return null;

    const nextRealized = cur.realizedPnlMinor + Math.trunc(realizedDeltaMinor);
    const lossAdded = realizedDeltaMinor < 0 ? Math.abs(Math.trunc(realizedDeltaMinor)) : 0;
    const nextRemainingRisk = Math.max(0, cur.remainingDailyRiskMinor - lossAdded);

    db.prepare(
      `UPDATE trading_capital_sessions
       SET realized_pnl_minor = ?, remaining_daily_risk_minor = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(nextRealized, nextRemainingRisk, cur.id);

    return this.getSessionCapital(ownerId, sessionDate);
  }

  // ---- Risk Configuration (never silently hardcoded) ----

  async setRiskConfig(
    ownerId: string,
    input: {
      maxRiskPerTradePct: number;
      maxDailyLossPct: number;
      maxOpenPositions: number;
      maxCapitalAllocationPct?: number;
      maxConcentrationPct?: number;
      maxConsecutiveLosses?: number;
      minRewardRiskRatio?: number;
      allowedExchanges?: ExchangeCode[];
      allowedInstruments?: InstrumentType[];
      sessionStartIst?: string;
      sessionEndIst?: string;
    }
  ): Promise<RiskConfigRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    if (input.maxRiskPerTradePct <= 0 || input.maxRiskPerTradePct > 10) {
      throw new Error('maxRiskPerTradePct must be between 0 and 10%');
    }
    if (input.maxDailyLossPct <= 0 || input.maxDailyLossPct > 25) {
      throw new Error('maxDailyLossPct must be between 0 and 25%');
    }
    if (input.maxOpenPositions < 1 || input.maxOpenPositions > 20) {
      throw new Error('maxOpenPositions must be between 1 and 20');
    }

    const maxRiskBps = Math.round(input.maxRiskPerTradePct * 100);
    const maxDailyLossBps = Math.round(input.maxDailyLossPct * 100);
    const maxCapAllocBps = Math.round((input.maxCapitalAllocationPct ?? 25) * 100);
    const maxConcBps = Math.round((input.maxConcentrationPct ?? 40) * 100);
    const maxConsec = input.maxConsecutiveLosses ?? 3;
    const minRrBps = Math.round((input.minRewardRiskRatio ?? 1.5) * 10_000);
    const exchanges = JSON.stringify(input.allowedExchanges || ['NSE', 'BSE']);
    const instruments = JSON.stringify(input.allowedInstruments || ['CASH_EQUITY']);
    const startIst = input.sessionStartIst || '09:15';
    const endIst = input.sessionEndIst || '15:30';

    db.prepare(
      `INSERT INTO trading_risk_configs (
        owner_id, max_risk_per_trade_bps, max_daily_loss_bps, max_open_positions,
        max_capital_allocation_bps, max_concentration_bps, max_consecutive_losses,
        min_reward_risk_bps, allowed_exchanges_json, allowed_instruments_json,
        session_start_ist, session_end_ist, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(owner_id) DO UPDATE SET
        max_risk_per_trade_bps = excluded.max_risk_per_trade_bps,
        max_daily_loss_bps = excluded.max_daily_loss_bps,
        max_open_positions = excluded.max_open_positions,
        max_capital_allocation_bps = excluded.max_capital_allocation_bps,
        max_concentration_bps = excluded.max_concentration_bps,
        max_consecutive_losses = excluded.max_consecutive_losses,
        min_reward_risk_bps = excluded.min_reward_risk_bps,
        allowed_exchanges_json = excluded.allowed_exchanges_json,
        allowed_instruments_json = excluded.allowed_instruments_json,
        session_start_ist = excluded.session_start_ist,
        session_end_ist = excluded.session_end_ist,
        updated_at = datetime('now')`
    ).run(
      ownerId,
      maxRiskBps,
      maxDailyLossBps,
      input.maxOpenPositions,
      maxCapAllocBps,
      maxConcBps,
      maxConsec,
      minRrBps,
      exchanges,
      instruments,
      startIst,
      endIst
    );

    store.logAudit(
      ownerId,
      'trading:risk_config_update',
      `risk=${input.maxRiskPerTradePct}% dailyLoss=${input.maxDailyLossPct}%`,
      'high',
      true
    );

    return (await this.getRiskConfig(ownerId))!;
  }

  async getRiskConfig(ownerId: string): Promise<RiskConfigRecord | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;

    const row = db
      .prepare(`SELECT * FROM trading_risk_configs WHERE owner_id = ?`)
      .get(ownerId) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      ownerId: String(row.owner_id),
      maxRiskPerTradeBps: Number(row.max_risk_per_trade_bps),
      maxDailyLossBps: Number(row.max_daily_loss_bps),
      maxOpenPositions: Number(row.max_open_positions),
      maxCapitalAllocationBps: Number(row.max_capital_allocation_bps),
      maxConcentrationBps: Number(row.max_concentration_bps),
      maxConsecutiveLosses: Number(row.max_consecutive_losses),
      minRewardRiskBps: Number(row.min_reward_risk_bps),
      allowedExchanges: JSON.parse(String(row.allowed_exchanges_json || '["NSE","BSE"]')),
      allowedInstruments: JSON.parse(String(row.allowed_instruments_json || '["CASH_EQUITY"]')),
      sessionStartIst: String(row.session_start_ist),
      sessionEndIst: String(row.session_end_ist),
      updatedAt: String(row.updated_at),
    };
  }

  // ---- Deterministic Position Sizing & Setup Validation ----

  async validateAndSizeCandidate(
    ownerId: string,
    candidate: Pick<
      TradeCandidate,
      'instrument' | 'direction' | 'suggestedEntryMinor' | 'stopLossMinor' | 'targetMinor' | 'dataQuality'
    >,
    options?: { slippageBps?: number; openPositionsCount?: number; consecutiveLosses?: number }
  ): Promise<PositionSizingResult> {
    const reasons: string[] = [];
    const session = await this.getSessionCapital(ownerId);
    const riskCfg = await this.getRiskConfig(ownerId);

    if (!session || !session.confirmedByUser) {
      reasons.push('Trading session capital is not confirmed. Please confirm available trading capital first.');
    }
    if (!riskCfg) {
      reasons.push('Risk management settings are not configured. Please configure max risk per trade and daily loss.');
    }

    if (candidate.dataQuality === 'STALE' || candidate.dataQuality === 'UNAVAILABLE') {
      reasons.push(`Market data is ${candidate.dataQuality}; live setup validation is suspended.`);
    }

    const entry = Math.trunc(candidate.suggestedEntryMinor);
    const sl = Math.trunc(candidate.stopLossMinor);
    const target = Math.trunc(candidate.targetMinor);

    if (entry <= 0 || sl <= 0 || target <= 0) {
      reasons.push('Entry, stop-loss, and target prices must be positive.');
    }

    if (candidate.direction === 'LONG' && (sl >= entry || target <= entry)) {
      reasons.push('Invalid LONG setup: stop-loss must be below entry and target must be above entry.');
    }
    if (candidate.direction === 'SHORT' && (sl <= entry || target >= entry)) {
      reasons.push('Invalid SHORT setup: stop-loss must be above entry and target must be below entry.');
    }

    const riskPerShare = Math.abs(entry - sl);
    const rewardPerShare = Math.abs(target - entry);
    const rr = riskPerShare > 0 ? Math.round((rewardPerShare / riskPerShare) * 100) / 100 : 0;

    if (riskCfg) {
      if (!riskCfg.allowedExchanges.includes(candidate.instrument.exchange)) {
        reasons.push(`Exchange ${candidate.instrument.exchange} is not enabled in risk configuration.`);
      }
      if (!riskCfg.allowedInstruments.includes(candidate.instrument.instrumentType)) {
        reasons.push(
          `Instrument type ${candidate.instrument.instrumentType} is not enabled.${candidate.instrument.instrumentType === 'FNO' ? ' Note: F&O carries leverage and expiry risks.' : ''}`
        );
      }
      const minRr = riskCfg.minRewardRiskBps / 10_000;
      if (rr < minRr) {
        reasons.push(`Reward-to-risk ratio ${rr} is below configured minimum ${minRr}.`);
      }
      if ((options?.openPositionsCount ?? 0) >= riskCfg.maxOpenPositions) {
        reasons.push(`Maximum open positions (${riskCfg.maxOpenPositions}) reached.`);
      }
      if ((options?.consecutiveLosses ?? 0) >= riskCfg.maxConsecutiveLosses) {
        reasons.push(`Maximum consecutive losses (${riskCfg.maxConsecutiveLosses}) reached.`);
      }
    }

    if (reasons.length > 0 || !session || !riskCfg) {
      return {
        approved: false,
        reasons,
        quantity: 0,
        positionValueMinor: 0,
        riskAmountMinor: 0,
        estimatedChargesMinor: 0,
        estimatedSlippageMinor: 0,
        rewardRiskRatio: rr,
        maxLossWithCostsMinor: 0,
        currency: session?.currency || 'INR',
      };
    }

    if (session.remainingDailyRiskMinor <= 0) {
      return {
        approved: false,
        reasons: ['Remaining daily risk budget is 0.'],
        quantity: 0,
        positionValueMinor: 0,
        riskAmountMinor: 0,
        estimatedChargesMinor: 0,
        estimatedSlippageMinor: 0,
        rewardRiskRatio: rr,
        maxLossWithCostsMinor: 0,
        currency: session.currency,
      };
    }

    const maxTradeRiskMinor = Math.min(
      Math.round((session.allocatedCapitalMinor * riskCfg.maxRiskPerTradeBps) / 10_000),
      session.remainingDailyRiskMinor
    );
    const maxCapAllocMinor = Math.min(
      session.availableForNewPositionsMinor,
      Math.round((session.allocatedCapitalMinor * riskCfg.maxCapitalAllocationBps) / 10_000)
    );

    const slippageBps = options?.slippageBps ?? 5; // 0.05% default slippage assumption
    const slippagePerShare = Math.round((entry * slippageBps) / 10_000);
    const effectiveRiskPerShare = riskPerShare + slippagePerShare;

    const qtyByRisk = Math.floor(maxTradeRiskMinor / Math.max(1, effectiveRiskPerShare));
    const qtyByCapital = Math.floor(maxCapAllocMinor / Math.max(1, entry));
    const lotSize = Math.max(1, candidate.instrument.lotSize || 1);
    const rawQty = Math.min(qtyByRisk, qtyByCapital);
    const quantity = Math.floor(rawQty / lotSize) * lotSize;

    if (quantity <= 0) {
      return {
        approved: false,
        reasons: ['Insufficient capital or risk budget for minimum lot size of 1 unit/lot.'],
        quantity: 0,
        positionValueMinor: 0,
        riskAmountMinor: 0,
        estimatedChargesMinor: 0,
        estimatedSlippageMinor: 0,
        rewardRiskRatio: rr,
        maxLossWithCostsMinor: 0,
        currency: session.currency,
      };
    }

    const positionValueMinor = entry * quantity;
    const riskAmountMinor = riskPerShare * quantity;
    const estimatedSlippageMinor = slippagePerShare * quantity;
    const estimatedChargesMinor = estimateIntradayChargesMinor(entry, sl, quantity);
    const maxLossWithCostsMinor = riskAmountMinor + estimatedSlippageMinor + estimatedChargesMinor;

    return {
      approved: true,
      reasons: [],
      quantity,
      positionValueMinor,
      riskAmountMinor,
      estimatedChargesMinor,
      estimatedSlippageMinor,
      rewardRiskRatio: rr,
      maxLossWithCostsMinor,
      currency: session.currency,
    };
  }
}

let _capitalRiskManager: CapitalRiskManager | null = null;
export function getCapitalRiskManager(): CapitalRiskManager {
  if (!_capitalRiskManager) {
    _capitalRiskManager = new CapitalRiskManager();
  }
  return _capitalRiskManager;
}
