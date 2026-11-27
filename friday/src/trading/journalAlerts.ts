// ============================================================
// FRIDAY — Trading Watchlist, Manual Journal & Deduplicated Alerts
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { redactSecrets } from '../memory/redaction';
import { formatMinorUnits, toMinorUnits } from '../finance/money';
import { getNotificationService } from '../services/notificationService';
import { ExchangeCode, InstrumentType } from './tradingTypes';

export interface WatchlistEntry {
  id: string;
  ownerId: string;
  exchange: ExchangeCode;
  symbol: string;
  instrumentType: InstrumentType;
  sector: string;
  lotSize: number;
  notes: string;
  createdAt: string;
}

export interface JournalEntryRecord {
  id: string;
  ownerId: string;
  exchange: ExchangeCode;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPriceMinor: number;
  entryPriceFormatted: string;
  exitPriceMinor: number | null;
  exitPriceFormatted: string | null;
  stopLossMinor: number;
  targetMinor: number;
  strategyId: string;
  entryAt: string;
  exitAt: string | null;
  chargesMinor: number;
  slippageMinor: number;
  realizedPnlMinor: number;
  realizedPnlFormatted: string;
  status: 'OPEN' | 'CLOSED';
  notes: string;
  sourceClassification: string;
}

export class TradingJournalService {
  async addWatchlistItem(
    ownerId: string,
    input: {
      exchange?: ExchangeCode;
      symbol: string;
      instrumentType?: InstrumentType;
      sector?: string;
      lotSize?: number;
      notes?: string;
    }
  ): Promise<WatchlistEntry> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const id = uuidv4();
    const exchange: ExchangeCode = input.exchange === 'BSE' ? 'BSE' : 'NSE';
    const symbol = input.symbol.trim().toUpperCase();
    const instrumentType: InstrumentType = input.instrumentType === 'FNO' ? 'FNO' : 'CASH_EQUITY';
    const sector = (input.sector || 'GENERAL').trim().toUpperCase();
    const lotSize = Math.max(1, Math.trunc(input.lotSize ?? 1));
    const notes = redactSecrets((input.notes || '').trim());

    db.prepare(
      `INSERT INTO trading_watchlists (id, owner_id, exchange, symbol, instrument_type, sector, lot_size, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, exchange, symbol) DO UPDATE SET
         instrument_type = excluded.instrument_type,
         sector = excluded.sector,
         lot_size = excluded.lot_size,
         notes = excluded.notes`
    ).run(id, ownerId, exchange, symbol, instrumentType, sector, lotSize, notes);

    const row = db
      .prepare(`SELECT * FROM trading_watchlists WHERE owner_id = ? AND exchange = ? AND symbol = ?`)
      .get(ownerId, exchange, symbol) as Record<string, unknown>;
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      exchange: String(row.exchange) as ExchangeCode,
      symbol: String(row.symbol),
      instrumentType: String(row.instrument_type) as InstrumentType,
      sector: String(row.sector),
      lotSize: Number(row.lot_size),
      notes: String(row.notes || ''),
      createdAt: String(row.created_at),
    };
  }

  async listWatchlist(ownerId: string): Promise<WatchlistEntry[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const rows = db
      .prepare(`SELECT * FROM trading_watchlists WHERE owner_id = ? ORDER BY created_at DESC`)
      .all(ownerId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      exchange: String(row.exchange) as ExchangeCode,
      symbol: String(row.symbol),
      instrumentType: String(row.instrument_type) as InstrumentType,
      sector: String(row.sector),
      lotSize: Number(row.lot_size),
      notes: String(row.notes || ''),
      createdAt: String(row.created_at),
    }));
  }

  async recordJournalEntry(
    ownerId: string,
    input: {
      exchange?: ExchangeCode;
      symbol: string;
      side: 'LONG' | 'SHORT';
      quantity: number;
      entryPrice: number | string;
      exitPrice?: number | string | null;
      stopLoss: number | string;
      target: number | string;
      strategyId?: string;
      entryAt?: string;
      exitAt?: string | null;
      charges?: number | string;
      slippage?: number | string;
      notes?: string;
    }
  ): Promise<JournalEntryRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const id = uuidv4();
    const exchange: ExchangeCode = input.exchange === 'BSE' ? 'BSE' : 'NSE';
    const symbol = input.symbol.trim().toUpperCase();
    const side = input.side === 'SHORT' ? 'SHORT' : 'LONG';
    const quantity = Math.trunc(input.quantity);
    if (quantity <= 0) throw new Error('Quantity must be positive');

    const entryMinor = toMinorUnits(input.entryPrice);
    const exitMinor =
      input.exitPrice !== undefined && input.exitPrice !== null && input.exitPrice !== ''
        ? toMinorUnits(input.exitPrice)
        : null;
    const slMinor = toMinorUnits(input.stopLoss);
    const targetMinor = toMinorUnits(input.target);
    const chargesMinor = toMinorUnits(input.charges ?? 0);
    const slippageMinor = toMinorUnits(input.slippage ?? 0);

    let realizedPnlMinor = 0;
    let status: 'OPEN' | 'CLOSED' = 'OPEN';
    if (exitMinor !== null) {
      status = 'CLOSED';
      const gross =
        side === 'LONG' ? (exitMinor - entryMinor) * quantity : (entryMinor - exitMinor) * quantity;
      realizedPnlMinor = gross - chargesMinor - slippageMinor;
    }

    const entryAt = input.entryAt || new Date().toISOString();
    const exitAt = status === 'CLOSED' ? input.exitAt || new Date().toISOString() : null;
    const notes = redactSecrets((input.notes || '').trim());

    db.prepare(
      `INSERT INTO trading_journal_entries (
        id, owner_id, exchange, symbol, side, quantity,
        entry_price_minor, exit_price_minor, stop_loss_minor, target_minor,
        strategy_id, entry_at, exit_at, charges_minor, slippage_minor,
        realized_pnl_minor, status, notes, source_classification
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USER_ENTERED')`
    ).run(
      id,
      ownerId,
      exchange,
      symbol,
      side,
      quantity,
      entryMinor,
      exitMinor,
      slMinor,
      targetMinor,
      (input.strategyId || 'manual').trim(),
      entryAt,
      exitAt,
      chargesMinor,
      slippageMinor,
      realizedPnlMinor,
      status,
      notes
    );

    store.logAudit(ownerId, 'trading:journal_record', `${exchange}:${symbol} ${side} x${quantity}`, 'low', true);
    const list = await this.listJournal(ownerId);
    return list.find((j) => j.id === id)!;
  }

  async listJournal(ownerId: string, limit = 100): Promise<JournalEntryRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const rows = db
      .prepare(`SELECT * FROM trading_journal_entries WHERE owner_id = ? ORDER BY entry_at DESC LIMIT ?`)
      .all(ownerId, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      ownerId: String(r.owner_id),
      exchange: String(r.exchange) as ExchangeCode,
      symbol: String(r.symbol),
      side: String(r.side) as 'LONG' | 'SHORT',
      quantity: Number(r.quantity),
      entryPriceMinor: Number(r.entry_price_minor),
      entryPriceFormatted: formatMinorUnits(Number(r.entry_price_minor)),
      exitPriceMinor: r.exit_price_minor !== null ? Number(r.exit_price_minor) : null,
      exitPriceFormatted:
        r.exit_price_minor !== null ? formatMinorUnits(Number(r.exit_price_minor)) : null,
      stopLossMinor: Number(r.stop_loss_minor),
      targetMinor: Number(r.target_minor),
      strategyId: String(r.strategy_id),
      entryAt: String(r.entry_at),
      exitAt: r.exit_at ? String(r.exit_at) : null,
      chargesMinor: Number(r.charges_minor),
      slippageMinor: Number(r.slippage_minor),
      realizedPnlMinor: Number(r.realized_pnl_minor),
      realizedPnlFormatted: formatMinorUnits(Number(r.realized_pnl_minor)),
      status: String(r.status) as 'OPEN' | 'CLOSED',
      notes: String(r.notes || ''),
      sourceClassification: String(r.source_classification),
    }));
  }

  async publishTradingAlert(params: {
    ownerId: string;
    kind: 'setup_validated' | 'setup_invalidated' | 'risk_threshold' | 'stale_data' | 'session_change';
    symbol?: string;
    title: string;
    message: string;
    severity?: 'info' | 'warning' | 'critical';
    dedupeWindowMs?: number;
  }) {
    const dedupeKey = `trading:${params.ownerId}:${params.kind}:${params.symbol || 'global'}`;
    return getNotificationService().notify({
      severity: params.severity || (params.kind === 'risk_threshold' ? 'critical' : 'info'),
      title: params.title,
      message: redactSecrets(params.message),
      source: 'trading',
      dedupeKey,
      dedupeWindowMs: params.dedupeWindowMs ?? 5 * 60_000,
    });
  }
}

let _journalService: TradingJournalService | null = null;
export function getTradingJournalService(): TradingJournalService {
  if (!_journalService) {
    _journalService = new TradingJournalService();
  }
  return _journalService;
}
