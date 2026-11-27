// ============================================================
// FRIDAY — Financial Intelligence Service
// Local-first, decimal-safe, owner-isolated deterministic finance
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { redactSecrets } from '../memory/redaction';
import {
  addMinor,
  formatMinorUnits,
  MinorUnits,
  ratioPercent,
  subMinor,
  toMinorUnits,
} from './money';
import {
  CashFlowSummary,
  FinancialAccountRecord,
  FinancialBudgetRecord,
  FinancialDebtRecord,
  FinancialGoalRecord,
  FinancialHoldingRecord,
  FinancialSourceClassification,
  FinancialTransactionRecord,
  PortfolioAnalysis,
  TradingCapitalAllocationRecord,
  VALID_FINANCIAL_SOURCES,
} from './financeTypes';

function normalizeSource(raw?: string): FinancialSourceClassification {
  if (raw && VALID_FINANCIAL_SOURCES.has(raw as FinancialSourceClassification)) {
    return raw as FinancialSourceClassification;
  }
  return 'USER_ENTERED';
}

function currentMonthPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

export class FinanceService {
  // ---- Accounts & Historical Snapshots ----

  async upsertAccount(
    ownerId: string,
    input: {
      id?: string;
      name: string;
      accountType: string;
      balance: number | string;
      currency?: string;
      sourceClassification?: string;
      sourceName?: string;
      observedAt?: string;
    }
  ): Promise<FinancialAccountRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const id = input.id || uuidv4();
    const balanceMinor = toMinorUnits(input.balance);
    const currency = (input.currency || 'INR').trim().toUpperCase();
    const source = normalizeSource(input.sourceClassification);
    const sourceName = redactSecrets((input.sourceName || 'User Input').trim());
    const observedAt = input.observedAt || new Date().toISOString();
    const safeName = redactSecrets(input.name.trim());

    const existing = db
      .prepare(`SELECT owner_id FROM financial_accounts WHERE id = ?`)
      .get(id) as { owner_id?: string } | undefined;

    if (existing && existing.owner_id !== ownerId) {
      store.logAudit(ownerId, 'finance:account_forbidden', id, 'high', false);
      throw new Error('Forbidden: account belongs to another owner');
    }

    const tx = db.transaction(() => {
      if (existing) {
        db.prepare(
          `UPDATE financial_accounts
           SET name = ?, account_type = ?, currency = ?, balance_minor = ?,
               source_classification = ?, source_name = ?, observed_at = ?, updated_at = datetime('now')
           WHERE id = ? AND owner_id = ?`
        ).run(
          safeName,
          input.accountType.trim(),
          currency,
          balanceMinor,
          source,
          sourceName,
          observedAt,
          id,
          ownerId
        );
      } else {
        db.prepare(
          `INSERT INTO financial_accounts (
            id, owner_id, name, account_type, currency, balance_minor,
            source_classification, source_name, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          ownerId,
          safeName,
          input.accountType.trim(),
          currency,
          balanceMinor,
          source,
          sourceName,
          observedAt
        );
      }

      // Preserve historical snapshot on every creation/update
      db.prepare(
        `INSERT INTO financial_account_snapshots (
          id, account_id, owner_id, balance_minor, currency, source_classification, source_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(uuidv4(), id, ownerId, balanceMinor, currency, source, sourceName);
    });
    tx();

    store.logAudit(ownerId, 'finance:account_upsert', `${safeName} (${currency})`, 'medium', true);

    const row = db
      .prepare(`SELECT * FROM financial_accounts WHERE id = ? AND owner_id = ?`)
      .get(id, ownerId) as Record<string, unknown>;
    return this.mapAccount(row);
  }

  async listAccounts(ownerId: string): Promise<FinancialAccountRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const rows = db
      .prepare(`SELECT * FROM financial_accounts WHERE owner_id = ? ORDER BY updated_at DESC`)
      .all(ownerId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapAccount(r));
  }

  async getAccountSnapshots(ownerId: string, accountId: string): Promise<Array<Record<string, unknown>>> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    return db
      .prepare(
        `SELECT id, account_id, balance_minor, currency, source_classification, source_name, recorded_at
         FROM financial_account_snapshots
         WHERE owner_id = ? AND account_id = ?
         ORDER BY recorded_at ASC`
      )
      .all(ownerId, accountId) as Array<Record<string, unknown>>;
  }

  // ---- Income & Expense Transactions ----

  async recordTransaction(
    ownerId: string,
    input: {
      txType: 'income' | 'expense';
      category: string;
      amount: number | string;
      currency?: string;
      description?: string;
      accountId?: string;
      occurredAt?: string;
      sourceClassification?: string;
      sourceName?: string;
    }
  ): Promise<FinancialTransactionRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const amountMinor = toMinorUnits(input.amount);
    if (amountMinor <= 0) {
      throw new Error('Transaction amount must be positive');
    }

    if (input.accountId) {
      const acc = db
        .prepare(`SELECT owner_id FROM financial_accounts WHERE id = ?`)
        .get(input.accountId) as { owner_id?: string } | undefined;
      if (!acc || acc.owner_id !== ownerId) {
        throw new Error('Forbidden or missing account for transaction');
      }
    }

    const id = uuidv4();
    const currency = (input.currency || 'INR').trim().toUpperCase();
    const source = normalizeSource(input.sourceClassification);
    const sourceName = redactSecrets((input.sourceName || 'User Input').trim());
    const safeDesc = redactSecrets((input.description || '').trim());
    const occurredAt = input.occurredAt || new Date().toISOString();

    db.prepare(
      `INSERT INTO financial_transactions (
        id, owner_id, account_id, tx_type, category, amount_minor, currency,
        description, occurred_at, source_classification, source_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      ownerId,
      input.accountId || null,
      input.txType,
      input.category.trim().toLowerCase(),
      amountMinor,
      currency,
      safeDesc,
      occurredAt,
      source,
      sourceName
    );

    store.logAudit(
      ownerId,
      `finance:tx_${input.txType}`,
      `${input.category} ${formatMinorUnits(amountMinor)} ${currency}`,
      'low',
      true
    );

    const row = db
      .prepare(`SELECT * FROM financial_transactions WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    return this.mapTransaction(row);
  }

  async listTransactions(
    ownerId: string,
    options?: { period?: string; txType?: 'income' | 'expense'; limit?: number }
  ): Promise<FinancialTransactionRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    const clauses = ['owner_id = ?'];
    const params: unknown[] = [ownerId];
    if (options?.period) {
      clauses.push('occurred_at LIKE ?');
      params.push(`${options.period}%`);
    }
    if (options?.txType) {
      clauses.push('tx_type = ?');
      params.push(options.txType);
    }
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    params.push(limit);

    const rows = db
      .prepare(
        `SELECT * FROM financial_transactions WHERE ${clauses.join(' AND ')} ORDER BY occurred_at DESC LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => this.mapTransaction(r));
  }

  // ---- Cash Flow Analysis ----

  async getCashFlow(ownerId: string, period = currentMonthPeriod()): Promise<CashFlowSummary> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    const missingData: string[] = [];
    const assumptions = ['All figures computed in exact minor units (1/100th of currency unit).'];

    if (!db) {
      return {
        period,
        currency: 'INR',
        totalIncomeMinor: 0,
        totalIncomeFormatted: '0.00',
        totalExpenseMinor: 0,
        totalExpenseFormatted: '0.00',
        netCashFlowMinor: 0,
        netCashFlowFormatted: '0.00',
        savingsRatePct: 0,
        transactionCount: 0,
        byCategory: [],
        sourceClassifications: [],
        missingData: ['Database unavailable'],
        assumptions,
      };
    }

    const txs = await this.listTransactions(ownerId, { period, limit: 500 });
    store.logAudit(ownerId, 'finance:cash_flow_read', `period=${period}`, 'low', true);

    if (txs.length === 0) {
      missingData.push(`No income or expense transactions recorded for period ${period}.`);
    }

    let totalIncomeMinor = 0;
    let totalExpenseMinor = 0;
    const catMap = new Map<string, { category: string; txType: 'income' | 'expense'; amountMinor: number }>();
    const sources = new Set<FinancialSourceClassification>();
    const currency = txs[0]?.currency || 'INR';

    for (const tx of txs) {
      sources.add(tx.sourceClassification);
      if (tx.txType === 'income') {
        totalIncomeMinor = addMinor(totalIncomeMinor, tx.amountMinor);
      } else {
        totalExpenseMinor = addMinor(totalExpenseMinor, tx.amountMinor);
      }
      const key = `${tx.txType}:${tx.category}`;
      const existing = catMap.get(key) || { category: tx.category, txType: tx.txType, amountMinor: 0 };
      existing.amountMinor = addMinor(existing.amountMinor, tx.amountMinor);
      catMap.set(key, existing);
    }

    const netCashFlowMinor = subMinor(totalIncomeMinor, totalExpenseMinor);
    const savingsRatePct =
      totalIncomeMinor > 0 ? ratioPercent(netCashFlowMinor, totalIncomeMinor) : 0;
    if (totalIncomeMinor === 0 && totalExpenseMinor > 0) {
      missingData.push('Income is 0 for this period; savings rate cannot be computed reliably.');
    }

    return {
      period,
      currency,
      totalIncomeMinor,
      totalIncomeFormatted: formatMinorUnits(totalIncomeMinor),
      totalExpenseMinor,
      totalExpenseFormatted: formatMinorUnits(totalExpenseMinor),
      netCashFlowMinor,
      netCashFlowFormatted: formatMinorUnits(netCashFlowMinor),
      savingsRatePct,
      transactionCount: txs.length,
      byCategory: Array.from(catMap.values()).map((c) => ({
        ...c,
        amountFormatted: formatMinorUnits(c.amountMinor),
      })),
      sourceClassifications: Array.from(sources),
      missingData,
      assumptions,
    };
  }

  // ---- Budgets ----

  async upsertBudget(
    ownerId: string,
    input: {
      category: string;
      period?: string;
      limit: number | string;
      currency?: string;
      sourceClassification?: string;
      sourceName?: string;
    }
  ): Promise<FinancialBudgetRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const period = input.period || currentMonthPeriod();
    const category = input.category.trim().toLowerCase();
    const limitMinor = toMinorUnits(input.limit);
    if (limitMinor <= 0) throw new Error('Budget limit must be positive');
    const currency = (input.currency || 'INR').trim().toUpperCase();
    const source = normalizeSource(input.sourceClassification);
    const sourceName = redactSecrets((input.sourceName || 'User Input').trim());

    const existing = db
      .prepare(`SELECT id FROM financial_budgets WHERE owner_id = ? AND category = ? AND period = ?`)
      .get(ownerId, category, period) as { id?: string } | undefined;

    const id = existing?.id || uuidv4();
    if (existing) {
      db.prepare(
        `UPDATE financial_budgets
         SET limit_minor = ?, currency = ?, source_classification = ?, source_name = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(limitMinor, currency, source, sourceName, id);
    } else {
      db.prepare(
        `INSERT INTO financial_budgets (
          id, owner_id, category, period, limit_minor, currency, source_classification, source_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, ownerId, category, period, limitMinor, currency, source, sourceName);
    }

    store.logAudit(ownerId, 'finance:budget_upsert', `${category} (${period})`, 'low', true);
    const budgets = await this.listBudgets(ownerId, period);
    return budgets.find((b) => b.id === id)!;
  }

  async listBudgets(ownerId: string, period = currentMonthPeriod()): Promise<FinancialBudgetRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    const rows = db
      .prepare(`SELECT * FROM financial_budgets WHERE owner_id = ? AND period = ? ORDER BY category ASC`)
      .all(ownerId, period) as Array<Record<string, unknown>>;

    const txs = await this.listTransactions(ownerId, { period, txType: 'expense', limit: 500 });
    const spentByCat = new Map<string, number>();
    for (const tx of txs) {
      spentByCat.set(tx.category, addMinor(spentByCat.get(tx.category) || 0, tx.amountMinor));
    }

    return rows.map((r) => {
      const cat = String(r.category);
      const limitMinor = Number(r.limit_minor);
      const spentMinor = spentByCat.get(cat) || 0;
      const utilizationPct = ratioPercent(spentMinor, limitMinor);
      return {
        id: String(r.id),
        ownerId: String(r.owner_id),
        category: cat,
        period: String(r.period),
        limitMinor,
        limitFormatted: formatMinorUnits(limitMinor),
        spentMinor,
        spentFormatted: formatMinorUnits(spentMinor),
        utilizationPct,
        overBudget: spentMinor > limitMinor,
        currency: String(r.currency),
        sourceClassification: normalizeSource(String(r.source_classification)),
        sourceName: String(r.source_name),
      };
    });
  }

  // ---- Savings & Financial Goals ----

  async upsertGoal(
    ownerId: string,
    input: {
      id?: string;
      name: string;
      target: number | string;
      current?: number | string;
      monthlyContribution?: number | string;
      targetDate?: string;
      currency?: string;
      sourceClassification?: string;
      sourceName?: string;
    }
  ): Promise<FinancialGoalRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const id = input.id || uuidv4();
    const targetMinor = toMinorUnits(input.target);
    const currentMinor = toMinorUnits(input.current ?? 0);
    const monthlyMinor = toMinorUnits(input.monthlyContribution ?? 0);
    if (targetMinor <= 0) throw new Error('Goal target must be positive');

    const currency = (input.currency || 'INR').trim().toUpperCase();
    const source = normalizeSource(input.sourceClassification);
    const sourceName = redactSecrets((input.sourceName || 'User Input').trim());
    const safeName = redactSecrets(input.name.trim());
    const status = currentMinor >= targetMinor ? 'completed' : 'active';

    const existing = db
      .prepare(`SELECT owner_id FROM financial_goals WHERE id = ?`)
      .get(id) as { owner_id?: string } | undefined;

    if (existing && existing.owner_id !== ownerId) {
      throw new Error('Forbidden: goal belongs to another owner');
    }

    if (existing) {
      db.prepare(
        `UPDATE financial_goals
         SET name = ?, target_minor = ?, current_minor = ?, monthly_contribution_minor = ?,
             target_date = ?, currency = ?, status = ?, source_classification = ?, source_name = ?,
             updated_at = datetime('now')
         WHERE id = ? AND owner_id = ?`
      ).run(
        safeName,
        targetMinor,
        currentMinor,
        monthlyMinor,
        input.targetDate || null,
        currency,
        status,
        source,
        sourceName,
        id,
        ownerId
      );
    } else {
      db.prepare(
        `INSERT INTO financial_goals (
          id, owner_id, name, target_minor, current_minor, monthly_contribution_minor,
          target_date, currency, status, source_classification, source_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        ownerId,
        safeName,
        targetMinor,
        currentMinor,
        monthlyMinor,
        input.targetDate || null,
        currency,
        status,
        source,
        sourceName
      );
    }

    store.logAudit(ownerId, 'finance:goal_upsert', safeName, 'low', true);
    const goals = await this.listGoals(ownerId);
    return goals.find((g) => g.id === id)!;
  }

  async listGoals(ownerId: string): Promise<FinancialGoalRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    const rows = db
      .prepare(`SELECT * FROM financial_goals WHERE owner_id = ? ORDER BY updated_at DESC`)
      .all(ownerId) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const targetMinor = Number(r.target_minor);
      const currentMinor = Number(r.current_minor);
      const remainingMinor = Math.max(0, subMinor(targetMinor, currentMinor));
      const monthlyContributionMinor = Number(r.monthly_contribution_minor);
      const estimatedMonthsToGoal =
        remainingMinor === 0
          ? 0
          : monthlyContributionMinor > 0
            ? Math.ceil(remainingMinor / monthlyContributionMinor)
            : null;
      return {
        id: String(r.id),
        ownerId: String(r.owner_id),
        name: String(r.name),
        targetMinor,
        targetFormatted: formatMinorUnits(targetMinor),
        currentMinor,
        currentFormatted: formatMinorUnits(currentMinor),
        remainingMinor,
        remainingFormatted: formatMinorUnits(remainingMinor),
        progressPct: Math.min(100, ratioPercent(currentMinor, targetMinor)),
        monthlyContributionMinor,
        estimatedMonthsToGoal,
        targetDate: r.target_date ? String(r.target_date) : null,
        currency: String(r.currency),
        status: String(r.status),
        sourceClassification: normalizeSource(String(r.source_classification)),
        sourceName: String(r.source_name),
      };
    });
  }

  // ---- Debts & Deterministic Repayment Projections ----

  async upsertDebt(
    ownerId: string,
    input: {
      id?: string;
      name: string;
      lender?: string;
      principal: number | string;
      remaining?: number | string;
      aprPct?: number;
      minPayment: number | string;
      currency?: string;
      sourceClassification?: string;
      sourceName?: string;
    }
  ): Promise<FinancialDebtRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const id = input.id || uuidv4();
    const principalMinor = toMinorUnits(input.principal);
    const remainingMinor = toMinorUnits(input.remaining ?? input.principal);
    const minPaymentMinor = toMinorUnits(input.minPayment);
    const aprBps = Math.max(0, Math.round((input.aprPct ?? 0) * 100));
    const currency = (input.currency || 'INR').trim().toUpperCase();
    const source = normalizeSource(input.sourceClassification);
    const sourceName = redactSecrets((input.sourceName || 'User Input').trim());
    const safeName = redactSecrets(input.name.trim());
    const safeLender = redactSecrets((input.lender || '').trim());
    const status = remainingMinor <= 0 ? 'paid_off' : 'active';

    const existing = db
      .prepare(`SELECT owner_id FROM financial_debts WHERE id = ?`)
      .get(id) as { owner_id?: string } | undefined;
    if (existing && existing.owner_id !== ownerId) {
      throw new Error('Forbidden: debt belongs to another owner');
    }

    if (existing) {
      db.prepare(
        `UPDATE financial_debts
         SET name = ?, lender = ?, principal_minor = ?, remaining_minor = ?, apr_bps = ?,
             min_payment_minor = ?, currency = ?, status = ?, source_classification = ?, source_name = ?,
             updated_at = datetime('now')
         WHERE id = ? AND owner_id = ?`
      ).run(
        safeName,
        safeLender,
        principalMinor,
        remainingMinor,
        aprBps,
        minPaymentMinor,
        currency,
        status,
        source,
        sourceName,
        id,
        ownerId
      );
    } else {
      db.prepare(
        `INSERT INTO financial_debts (
          id, owner_id, name, lender, principal_minor, remaining_minor, apr_bps,
          min_payment_minor, currency, status, source_classification, source_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        ownerId,
        safeName,
        safeLender,
        principalMinor,
        remainingMinor,
        aprBps,
        minPaymentMinor,
        currency,
        status,
        source,
        sourceName
      );
    }

    store.logAudit(ownerId, 'finance:debt_upsert', safeName, 'low', true);
    const debts = await this.listDebts(ownerId);
    return debts.find((d) => d.id === id)!;
  }

  async listDebts(ownerId: string): Promise<FinancialDebtRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    const rows = db
      .prepare(`SELECT * FROM financial_debts WHERE owner_id = ? ORDER BY apr_bps DESC`)
      .all(ownerId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      ownerId: String(r.owner_id),
      name: String(r.name),
      lender: String(r.lender || ''),
      principalMinor: Number(r.principal_minor),
      remainingMinor: Number(r.remaining_minor),
      remainingFormatted: formatMinorUnits(Number(r.remaining_minor)),
      aprBps: Number(r.apr_bps),
      aprPct: Number(r.apr_bps) / 100,
      minPaymentMinor: Number(r.min_payment_minor),
      minPaymentFormatted: formatMinorUnits(Number(r.min_payment_minor)),
      currency: String(r.currency),
      status: String(r.status),
      sourceClassification: normalizeSource(String(r.source_classification)),
      sourceName: String(r.source_name),
    }));
  }

  projectDebtRepayment(
    remainingMinor: MinorUnits,
    aprBps: number,
    monthlyPaymentMinor: MinorUnits
  ): {
    monthsToPayoff: number | null;
    totalInterestMinor: number;
    totalInterestFormatted: string;
    totalPaidMinor: number;
    totalPaidFormatted: string;
    amortizes: boolean;
    assumptions: string[];
  } {
    let balance = Math.trunc(remainingMinor);
    const payment = Math.trunc(monthlyPaymentMinor);
    let totalInterest = 0;
    let totalPaid = 0;
    let months = 0;
    const maxMonths = 600;

    if (balance <= 0) {
      return {
        monthsToPayoff: 0,
        totalInterestMinor: 0,
        totalInterestFormatted: '0.00',
        totalPaidMinor: 0,
        totalPaidFormatted: '0.00',
        amortizes: true,
        assumptions: ['Balance is already 0.00.'],
      };
    }

    if (payment <= 0) {
      return {
        monthsToPayoff: null,
        totalInterestMinor: 0,
        totalInterestFormatted: '0.00',
        totalPaidMinor: 0,
        totalPaidFormatted: '0.00',
        amortizes: false,
        assumptions: ['Monthly payment must be > 0 to amortize debt.'],
      };
    }

    while (balance > 0 && months < maxMonths) {
      // Monthly interest in minor units: balance * apr_bps / (12 * 10000)
      const interest = Math.round((balance * aprBps) / 120_000);
      if (months === 0 && payment <= interest && aprBps > 0) {
        return {
          monthsToPayoff: null,
          totalInterestMinor: 0,
          totalInterestFormatted: '0.00',
          totalPaidMinor: 0,
          totalPaidFormatted: '0.00',
          amortizes: false,
          assumptions: ['Monthly payment does not exceed monthly interest; balance will not amortize.'],
        };
      }
      const due = balance + interest;
      const actualPayment = Math.min(due, payment);
      balance = due - actualPayment;
      totalInterest += interest;
      totalPaid += actualPayment;
      months++;
    }

    return {
      monthsToPayoff: balance === 0 ? months : null,
      totalInterestMinor: totalInterest,
      totalInterestFormatted: formatMinorUnits(totalInterest),
      totalPaidMinor: totalPaid,
      totalPaidFormatted: formatMinorUnits(totalPaid),
      amortizes: balance === 0,
      assumptions: [
        'Assumes constant monthly payment and fixed APR compounded monthly in integer minor units.',
      ],
    };
  }

  // ---- Portfolio Holdings & Asset Allocation ----

  async upsertHolding(
    ownerId: string,
    input: {
      id?: string;
      symbol: string;
      assetClass: string;
      quantity: number;
      avgCost: number | string;
      currentValue: number | string;
      currency?: string;
      sourceClassification?: string;
      sourceName?: string;
      observedAt?: string;
    }
  ): Promise<FinancialHoldingRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const id = input.id || uuidv4();
    const quantityMilli = Math.round(input.quantity * 1000);
    const avgCostMinor = toMinorUnits(input.avgCost);
    const currentValueMinor = toMinorUnits(input.currentValue);
    const currency = (input.currency || 'INR').trim().toUpperCase();
    const source = normalizeSource(input.sourceClassification);
    const sourceName = redactSecrets((input.sourceName || 'User Input').trim());
    const observedAt = input.observedAt || new Date().toISOString();
    const symbol = input.symbol.trim().toUpperCase();
    const assetClass = input.assetClass.trim().toLowerCase();

    const existing = db
      .prepare(`SELECT owner_id FROM financial_holdings WHERE id = ?`)
      .get(id) as { owner_id?: string } | undefined;
    if (existing && existing.owner_id !== ownerId) {
      throw new Error('Forbidden: holding belongs to another owner');
    }

    if (existing) {
      db.prepare(
        `UPDATE financial_holdings
         SET symbol = ?, asset_class = ?, quantity_milli = ?, avg_cost_minor = ?,
             current_value_minor = ?, currency = ?, source_classification = ?, source_name = ?,
             observed_at = ?, updated_at = datetime('now')
         WHERE id = ? AND owner_id = ?`
      ).run(
        symbol,
        assetClass,
        quantityMilli,
        avgCostMinor,
        currentValueMinor,
        currency,
        source,
        sourceName,
        observedAt,
        id,
        ownerId
      );
    } else {
      db.prepare(
        `INSERT INTO financial_holdings (
          id, owner_id, symbol, asset_class, quantity_milli, avg_cost_minor,
          current_value_minor, currency, source_classification, source_name, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        ownerId,
        symbol,
        assetClass,
        quantityMilli,
        avgCostMinor,
        currentValueMinor,
        currency,
        source,
        sourceName,
        observedAt
      );
    }

    store.logAudit(ownerId, 'finance:holding_upsert', `${symbol} (${assetClass})`, 'low', true);
    const holdings = await this.listHoldings(ownerId);
    return holdings.find((h) => h.id === id)!;
  }

  async listHoldings(ownerId: string): Promise<FinancialHoldingRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    const rows = db
      .prepare(`SELECT * FROM financial_holdings WHERE owner_id = ? ORDER BY current_value_minor DESC`)
      .all(ownerId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      ownerId: String(r.owner_id),
      symbol: String(r.symbol),
      assetClass: String(r.asset_class),
      quantityMilli: Number(r.quantity_milli),
      avgCostMinor: Number(r.avg_cost_minor),
      currentValueMinor: Number(r.current_value_minor),
      currentValueFormatted: formatMinorUnits(Number(r.current_value_minor)),
      currency: String(r.currency),
      sourceClassification: normalizeSource(String(r.source_classification)),
      sourceName: String(r.source_name),
      observedAt: String(r.observed_at),
    }));
  }

  async analyzePortfolio(ownerId: string): Promise<PortfolioAnalysis> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    const holdings = await this.listHoldings(ownerId);
    store.logAudit(ownerId, 'finance:portfolio_analyze', `holdings=${holdings.length}`, 'low', true);

    if (holdings.length === 0) {
      return {
        currency: 'INR',
        totalValueMinor: 0,
        totalValueFormatted: '0.00',
        holdingsCount: 0,
        allocationByAssetClass: [],
        topHoldingConcentrationPct: 0,
        concentrationRisk: 'none',
        hasUnverifiedOrStaleData: false,
        sourceClassifications: [],
        assumptions: ['No holdings recorded yet.'],
        missingData: ['Add holdings to analyze asset allocation and concentration.'],
      };
    }

    const currency = holdings[0].currency;
    let totalValueMinor = 0;
    const classTotals = new Map<string, number>();
    const sources = new Set<FinancialSourceClassification>();
    let maxHoldingMinor = 0;

    for (const h of holdings) {
      sources.add(h.sourceClassification);
      totalValueMinor = addMinor(totalValueMinor, h.currentValueMinor);
      classTotals.set(h.assetClass, addMinor(classTotals.get(h.assetClass) || 0, h.currentValueMinor));
      if (h.currentValueMinor > maxHoldingMinor) {
        maxHoldingMinor = h.currentValueMinor;
      }
    }

    const allocationByAssetClass = Array.from(classTotals.entries()).map(([assetClass, valueMinor]) => ({
      assetClass,
      valueMinor,
      valueFormatted: formatMinorUnits(valueMinor),
      sharePct: ratioPercent(valueMinor, totalValueMinor),
    }));

    const topHoldingConcentrationPct = ratioPercent(maxHoldingMinor, totalValueMinor);
    const concentrationRisk: PortfolioAnalysis['concentrationRisk'] =
      topHoldingConcentrationPct >= 40
        ? 'high'
        : topHoldingConcentrationPct >= 25
          ? 'moderate'
          : 'low';

    const hasUnverifiedOrStaleData = Array.from(sources).some(
      (s) => s === 'ESTIMATED' || s === 'OUTDATED' || s === 'IMPORTED_PENDING_VERIFICATION'
    );

    if (db) {
      db.prepare(
        `INSERT INTO financial_portfolio_snapshots (
          id, owner_id, total_value_minor, currency, allocation_json, source_classification
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        uuidv4(),
        ownerId,
        totalValueMinor,
        currency,
        JSON.stringify(allocationByAssetClass),
        hasUnverifiedOrStaleData ? 'ESTIMATED' : holdings[0].sourceClassification
      );
    }

    return {
      currency,
      totalValueMinor,
      totalValueFormatted: formatMinorUnits(totalValueMinor),
      holdingsCount: holdings.length,
      allocationByAssetClass,
      topHoldingConcentrationPct,
      concentrationRisk,
      hasUnverifiedOrStaleData,
      sourceClassifications: Array.from(sources),
      assumptions: [
        'Concentration risk thresholds: >=40% high, >=25% moderate, <25% low.',
        'Valuations reflect recorded holding values and do not imply guaranteed future returns.',
      ],
      missingData: [],
    };
  }

  // ---- Trading Capital Coordination Contract (Strictly Isolated) ----

  async allocateTradingCapital(
    ownerId: string,
    input: {
      allocatedCapital: number | string;
      currency?: string;
      confirmedByUser: boolean;
      confirmationNote?: string;
    }
  ): Promise<TradingCapitalAllocationRecord> {
    if (!input.confirmedByUser) {
      throw new Error('Explicit user confirmation (confirmedByUser=true) is required to allocate trading capital');
    }
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const minor = toMinorUnits(input.allocatedCapital);
    if (minor < 0) throw new Error('Allocated trading capital cannot be negative');

    const id = uuidv4();
    const currency = (input.currency || 'INR').trim().toUpperCase();
    const note = redactSecrets((input.confirmationNote || 'User-confirmed trading capital allocation').trim());

    db.prepare(
      `INSERT INTO financial_trading_capital_allocations (
        id, owner_id, allocated_capital_minor, currency, confirmed_by_user, confirmation_note, source_classification
      ) VALUES (?, ?, ?, ?, 1, ?, 'USER_ENTERED')`
    ).run(id, ownerId, minor, currency, note);

    store.logAudit(
      ownerId,
      'finance:trading_capital_confirm',
      `${formatMinorUnits(minor)} ${currency}`,
      'high',
      true
    );

    const row = db
      .prepare(`SELECT * FROM financial_trading_capital_allocations WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      allocatedCapitalMinor: Number(row.allocated_capital_minor),
      allocatedCapitalFormatted: formatMinorUnits(Number(row.allocated_capital_minor)),
      currency: String(row.currency),
      confirmedByUser: Number(row.confirmed_by_user) === 1,
      confirmationNote: String(row.confirmation_note),
      sourceClassification: normalizeSource(String(row.source_classification)),
      createdAt: String(row.created_at),
    };
  }

  async getLatestTradingCapital(ownerId: string): Promise<TradingCapitalAllocationRecord | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;
    const row = db
      .prepare(
        `SELECT * FROM financial_trading_capital_allocations WHERE owner_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(ownerId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      allocatedCapitalMinor: Number(row.allocated_capital_minor),
      allocatedCapitalFormatted: formatMinorUnits(Number(row.allocated_capital_minor)),
      currency: String(row.currency),
      confirmedByUser: Number(row.confirmed_by_user) === 1,
      confirmationNote: String(row.confirmation_note),
      sourceClassification: normalizeSource(String(row.source_classification)),
      createdAt: String(row.created_at),
    };
  }

  // ---- Comprehensive Financial Overview Report ----

  async getFinancialReport(ownerId: string, period = currentMonthPeriod()) {
    const [accounts, cashFlow, budgets, goals, debts, portfolio, tradingCapital] = await Promise.all([
      this.listAccounts(ownerId),
      this.getCashFlow(ownerId, period),
      this.listBudgets(ownerId, period),
      this.listGoals(ownerId),
      this.listDebts(ownerId),
      this.analyzePortfolio(ownerId),
      this.getLatestTradingCapital(ownerId),
    ]);

    const totalAccountBalanceMinor = accounts.reduce((acc, a) => addMinor(acc, a.balanceMinor), 0);
    const totalDebtRemainingMinor = debts.reduce((acc, d) => addMinor(acc, d.remainingMinor), 0);
    const netWorthMinor = subMinor(
      addMinor(totalAccountBalanceMinor, portfolio.totalValueMinor),
      totalDebtRemainingMinor
    );

    const store = await getMemoryStore();
    store.logAudit(ownerId, 'finance:report_read', `period=${period}`, 'low', true);

    return {
      period,
      currency: cashFlow.currency || accounts[0]?.currency || 'INR',
      netWorthMinor,
      netWorthFormatted: formatMinorUnits(netWorthMinor),
      totalAccountBalanceMinor,
      totalAccountBalanceFormatted: formatMinorUnits(totalAccountBalanceMinor),
      totalDebtRemainingMinor,
      totalDebtRemainingFormatted: formatMinorUnits(totalDebtRemainingMinor),
      accounts,
      cashFlow,
      budgets,
      goals,
      debts,
      portfolio,
      tradingCapital,
    };
  }

  private mapAccount(r: Record<string, unknown>): FinancialAccountRecord {
    const balanceMinor = Number(r.balance_minor);
    return {
      id: String(r.id),
      ownerId: String(r.owner_id),
      name: String(r.name),
      accountType: String(r.account_type),
      currency: String(r.currency),
      balanceMinor,
      balanceFormatted: formatMinorUnits(balanceMinor),
      sourceClassification: normalizeSource(String(r.source_classification)),
      sourceName: String(r.source_name),
      observedAt: String(r.observed_at),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  private mapTransaction(r: Record<string, unknown>): FinancialTransactionRecord {
    const amountMinor = Number(r.amount_minor);
    return {
      id: String(r.id),
      ownerId: String(r.owner_id),
      accountId: r.account_id ? String(r.account_id) : null,
      txType: String(r.tx_type) as 'income' | 'expense',
      category: String(r.category),
      amountMinor,
      amountFormatted: formatMinorUnits(amountMinor),
      currency: String(r.currency),
      description: String(r.description || ''),
      occurredAt: String(r.occurred_at),
      sourceClassification: normalizeSource(String(r.source_classification)),
      sourceName: String(r.source_name),
      createdAt: String(r.created_at),
    };
  }
}

let _financeService: FinanceService | null = null;
export function getFinanceService(): FinanceService {
  if (!_financeService) {
    _financeService = new FinanceService();
  }
  return _financeService;
}
