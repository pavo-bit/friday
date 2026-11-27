// ============================================================
// FRIDAY — API Routes: /friday/finance/*
// Authenticated, owner-isolated Financial Intelligence endpoints
// ============================================================

import { Router } from 'express';
import { requireCallerIdentity } from '../authContext';
import { getFinanceService } from '../../finance/financeService';
import { toMinorUnits } from '../../finance/money';

export const financeRoutes = Router();

financeRoutes.get('/overview', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const period = typeof req.query.period === 'string' ? req.query.period : undefined;
  const report = await getFinanceService().getFinancialReport(identity.actorId, period);
  res.json(report);
});

financeRoutes.get('/accounts', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const accounts = await getFinanceService().listAccounts(identity.actorId);
  res.json({ accounts });
});

financeRoutes.post('/accounts', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const account = await getFinanceService().upsertAccount(identity.actorId, req.body);
    res.status(201).json({ account });
  } catch (err) {
    const msg = (err as Error).message;
    res.status(msg.startsWith('Forbidden') ? 403 : 400).json({ error: msg });
  }
});

financeRoutes.get('/accounts/:id/snapshots', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const snapshots = await getFinanceService().getAccountSnapshots(identity.actorId, req.params.id);
  res.json({ snapshots });
});

financeRoutes.get('/transactions', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const period = typeof req.query.period === 'string' ? req.query.period : undefined;
  const txType =
    req.query.txType === 'income' || req.query.txType === 'expense' ? req.query.txType : undefined;
  const transactions = await getFinanceService().listTransactions(identity.actorId, { period, txType });
  res.json({ transactions });
});

financeRoutes.post('/transactions', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const transaction = await getFinanceService().recordTransaction(identity.actorId, req.body);
    res.status(201).json({ transaction });
  } catch (err) {
    const msg = (err as Error).message;
    res.status(msg.startsWith('Forbidden') ? 403 : 400).json({ error: msg });
  }
});

financeRoutes.get('/cashflow', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const period = typeof req.query.period === 'string' ? req.query.period : undefined;
  const cashFlow = await getFinanceService().getCashFlow(identity.actorId, period);
  res.json({ cashFlow });
});

financeRoutes.get('/budgets', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const period = typeof req.query.period === 'string' ? req.query.period : undefined;
  const budgets = await getFinanceService().listBudgets(identity.actorId, period);
  res.json({ budgets });
});

financeRoutes.post('/budgets', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const budget = await getFinanceService().upsertBudget(identity.actorId, req.body);
    res.status(201).json({ budget });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

financeRoutes.get('/goals', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const goals = await getFinanceService().listGoals(identity.actorId);
  res.json({ goals });
});

financeRoutes.post('/goals', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const goal = await getFinanceService().upsertGoal(identity.actorId, req.body);
    res.status(201).json({ goal });
  } catch (err) {
    const msg = (err as Error).message;
    res.status(msg.startsWith('Forbidden') ? 403 : 400).json({ error: msg });
  }
});

financeRoutes.get('/debts', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const debts = await getFinanceService().listDebts(identity.actorId);
  res.json({ debts });
});

financeRoutes.post('/debts', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const debt = await getFinanceService().upsertDebt(identity.actorId, req.body);
    res.status(201).json({ debt });
  } catch (err) {
    const msg = (err as Error).message;
    res.status(msg.startsWith('Forbidden') ? 403 : 400).json({ error: msg });
  }
});

financeRoutes.post('/debts/compare', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const { remaining, aprPct, paymentA, paymentB } = req.body || {};
    const svc = getFinanceService();
    const remMinor = toMinorUnits(remaining);
    const aprBps = Math.round(Number(aprPct || 0) * 100);
    res.json({
      scenarioA: svc.projectDebtRepayment(remMinor, aprBps, toMinorUnits(paymentA)),
      scenarioB: svc.projectDebtRepayment(remMinor, aprBps, toMinorUnits(paymentB)),
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

financeRoutes.get('/portfolio', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const svc = getFinanceService();
  const [holdings, analysis] = await Promise.all([
    svc.listHoldings(identity.actorId),
    svc.analyzePortfolio(identity.actorId),
  ]);
  res.json({ holdings, analysis });
});

financeRoutes.post('/holdings', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const holding = await getFinanceService().upsertHolding(identity.actorId, req.body);
    res.status(201).json({ holding });
  } catch (err) {
    const msg = (err as Error).message;
    res.status(msg.startsWith('Forbidden') ? 403 : 400).json({ error: msg });
  }
});

financeRoutes.get('/trading-capital', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  const allocation = await getFinanceService().getLatestTradingCapital(identity.actorId);
  res.json({ allocation });
});

financeRoutes.post('/trading-capital/confirm', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  try {
    const allocation = await getFinanceService().allocateTradingCapital(identity.actorId, req.body);
    res.status(201).json({ allocation });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
