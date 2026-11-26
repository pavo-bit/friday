# FRIDAY — Financial Intelligence Module Specification

**Status:** Architecture & Design Specification (Pre-Implementation)  
**Repository:** `pavo-bit/friday`  
**Module Location:** `friday/src/finance/` (separate from `friday/src/trading/`)

---

## 1. Purpose & Separation of Concerns

The **Financial Intelligence Module** provides deterministic personal finance management (budgeting, cash flow, savings goals, debt repayment, portfolio tracking, asset allocation, scenario analysis, and financial decision support) while remaining strictly decoupled from **Trading Copilot** (`friday/src/trading/`).

- **No automatic wealth-to-trading conversion:** Total personal net worth or bank balances are **never** automatically treated as available intraday trading capital. Trading Copilot still requires explicit session-specific capital confirmation.
- **Controlled coordination:** When explicitly authorized by the user, Financial Intelligence can surface available liquid funds and upcoming commitments to inform capital decisions.
- **No autonomous money movement:** FRIDAY never initiates transfers, purchases, investments, or account modifications.
- **Zero cloud AI / external exposure:** Financial data never leaves the local host or goes to external AI APIs.

---

## 2. Module Architecture (`friday/src/finance/`)

```text
friday/src/finance/
├── models/
│   └── types.ts               # Integer-paise monetary types, source tags (verified|user_entered|estimated|outdated)
├── security/
│   └── financeEncryption.ts   # AES-256-GCM local encryption for sensitive account/holding notes
├── repositories/
│   └── financeRepository.ts   # SQLite persistence + audit trail
├── budgeting/
│   └── budgetService.ts       # Category budgets, monthly thresholds, cash-flow calculation
├── goals/
│   └── goalService.ts         # Savings goals & debt repayment schedules (deterministic amortization)
├── portfolio/
│   └── portfolioService.ts    # Holdings, asset allocation, drift detection
├── decision-support/
│   └── advisorService.ts      # Structured recommendations (assumptions, math, pros/cons, risks, missing info)
├── proactive/
│   └── financeMonitor.ts      # Opt-in budget/commitment/goal/allocation threshold alerts
├── api/
│   └── financeRoutes.ts       # Mounted at /friday/finance/*
└── tests/
    └── finance.test.mjs       # Deterministic unit & security tests
```

---

## 3. Data Model & SQLite Schema (Migration Proposal)

All monetary values use **integer paise** (`1 INR = 100 paise`). Every record carries:
- `data_source`: `'verified' | 'user_entered' | 'estimated' | 'outdated'`
- `as_of_timestamp`: ISO-8601 timestamp so cached or stale balances are never presented as live.

Proposed tables:
1. `finance_consent` (`id`, `scope`, `granted`, `granted_at`, `revoked_at`)
2. `finance_accounts` (`id`, `name`, `account_type`, `balance_paise`, `data_source`, `as_of_timestamp`, `encrypted_meta`)
3. `finance_transactions` (`id`, `account_id`, `kind` `'income'|'expense'|'transfer'`, `category`, `amount_paise`, `occurred_at`, `data_source`, `notes`)
4. `finance_budgets` (`id`, `category`, `monthly_limit_paise`, `alert_threshold_pct`, `active`)
5. `finance_goals` (`id`, `name`, `goal_type` `'savings'|'debt'`, `target_paise`, `current_paise`, `interest_rate_bps`, `due_date`, `monthly_commitment_paise`)
6. `finance_holdings` (`id`, `asset_class` `'equity'|'debt'|'gold'|'cash'`, `symbol`, `quantity`, `avg_cost_paise`, `current_value_paise`, `target_allocation_pct`, `data_source`, `as_of_timestamp`)
7. `finance_audit_log` (`id`, `actor`, `action`, `resource`, `details_redacted`, `created_at`)

---

## 4. API Contracts (`/friday/finance/*`)

- `GET/POST /friday/finance/consent` — explicit opt-in/revocation for financial tracking & proactive alerts.
- `GET/POST /friday/finance/accounts` — user-entered account balances with `asOfTimestamp` & `dataSource`.
- `GET/POST /friday/finance/transactions` — income/expense tracking + cash-flow summary (`GET /friday/finance/cashflow`).
- `GET/POST/PUT /friday/finance/budgets` — category budgets & threshold checks.
- `GET/POST /friday/finance/goals` — savings goals & debt payoff projections.
- `GET/POST /friday/finance/portfolio` — holdings & asset allocation drift analysis.
- `POST /friday/finance/scenario` — deterministic scenario & decision-support analysis returning `{ facts, assumptions, calculations, benefits, disadvantages, risks, missingInformation, reasoning }`.
- `GET /friday/finance/trading-coordination` — read-only summary of uncommitted liquid funds (requires explicit user confirmation before Trading Copilot uses it).

---

## 5. Security & Privacy Requirements

1. **Encryption at rest:** Sensitive account identifiers/metadata encrypted locally with AES-256-GCM (key stored outside SQLite / OS keychain, never logged).
2. **Explicit consent:** Financial routes enforce an active consent record; revoking consent stops proactive monitoring immediately.
3. **Strict redaction:** `redactSecrets` + financial redaction ensure account numbers, PAN, UPI IDs, and credentials never enter logs or LLM prompts.
4. **No external AI:** All calculations are deterministic; optional explanations use local Ollama (`qwen3:4b`) with sanitized summary numbers only.
5. **Standalone Android behavior:** Cached financial summaries on `friday_companion/` always display `Last updated: <timestamp>` and never claim live sync when the laptop is offline.

---

## 6. Testing Criteria

- Deterministic cash-flow, budget utilization, compound savings, and debt amortization tests (including zero/negative/missing inputs).
- Decision-support output schema validation (ensuring assumptions, risks, and missing info are always present).
- Consent enforcement & revocation tests (proactive alerts suppressed when revoked or data is outdated).
- Encryption round-trip & log redaction verification.
- Trading-isolation test confirming account wealth never auto-populates Trading Copilot capital.
