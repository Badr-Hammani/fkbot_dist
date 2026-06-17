# Gold Trading EAs — Architecture & Implementation Plan
## ICT Method + Smart Money Concept | XAU/USD | MQL5

---

## 1. Project Overview

Two independent, production-grade Expert Advisors sharing a common infrastructure layer:

| EA | Strategy | Primary Signals |
|----|----------|-----------------|
| `ICT_GoldTrader` | Inner Circle Trader (ICT) | Order Blocks, FVGs, Liquidity Sweeps, Silver Bullet |
| `SMC_GoldTrader` | Smart Money Concept (SMC) | Liquidity Pools, Stop Hunts, Displacement Candles, Accumulation/Distribution |

Both EAs share:
- `Shared/NewsAPI/NewsConnector.mqh` — Real-time news + macro data
- `Shared/RiskManagement/RiskManager.mqh` — Position sizing, drawdown control
- `Shared/Utils/MarketStructure.mqh` — BOS/CHoCH, swing points
- `Shared/Utils/SessionFilter.mqh` — ICT killzones, session gates
- `Shared/Utils/AdaptiveLearning.mqh` — Rolling performance adaptation

---

## 2. Directory Structure

```
fkbot_dist/
├── ICT_EA/
│   ├── ICT_GoldTrader.mq5       # Main EA file
│   └── ICT_SignalEngine.mqh     # OB, FVG, liquidity sweep detection
│
├── SmartMoney_EA/
│   ├── SMC_GoldTrader.mq5       # Main EA file
│   └── SMC_SignalEngine.mqh     # Pools, stop hunts, displacement, accum.
│
├── Shared/
│   ├── NewsAPI/
│   │   └── NewsConnector.mqh    # NewsAPI.org + FRED + ForexFactory
│   ├── RiskManagement/
│   │   └── RiskManager.mqh      # ATR sizing, drawdown guard, trailing
│   └── Utils/
│       ├── MarketStructure.mqh  # BOS, CHoCH, swing detection
│       ├── SessionFilter.mqh    # ICT killzones, session timing
│       └── AdaptiveLearning.mqh # Rolling window, confidence adaptation
│
├── Backtesting/
│   ├── BacktestFramework.mqh    # OnTester(), custom criterion, WF helpers
│   └── BacktestConfig.ini       # MT5 Strategy Tester configuration
│
└── Docs/
    └── IMPLEMENTATION_PLAN.md   # This document
```

---

## 3. Module Responsibilities

### 3.1 Data Intake Layer
| Module | Inputs | Outputs |
|--------|--------|---------|
| `MarketStructure` | OHLC bars (exec TF + HTF) | BOS/CHoCH events, swing points, bias |
| `SessionFilter` | TimeCurrent(), GMT offset | Session enum, killzone bool |
| `NewsConnector` | NewsAPI/FRED/FF-calendar JSON | Sentiment score, upcoming events, DXY/yield |

### 3.2 Signal Generation Layer
| Module | Inputs | Outputs |
|--------|--------|---------|
| `ICT_SignalEngine` | MarketStructure + SessionFilter | `ICTSignal` (type, entry, SL, TP, confidence) |
| `SMC_SignalEngine` | MarketStructure + SessionFilter | `SMCSignal` (type, entry, SL, TP, confidence) |

### 3.3 Risk Management Layer
| Module | Function |
|--------|----------|
| `RiskManager.CalcLotSize()` | ATR-based position sizing (constant fractional risk) |
| `RiskManager.IsTradingAllowed()` | Equity DD + daily loss guard |
| `RiskManager.IsSpreadAcceptable()` | Rejects entry on high spread |
| `RiskManager.ManageOpenPositions()` | Breakeven + trailing stop on each bar |
| `RiskManager.IsMaxPositionsReached()` | Position count cap |

### 3.4 Adaptive Learning Layer
| Function | Behaviour |
|----------|-----------|
| `RecordTrade()` | Stores outcome in circular buffer (50-trade window) |
| `GetAdaptedThreshold()` | Raises/lowers confidence gate per signal type |
| `GetLotScaleFactor()` | Scales lots 0.5×–1.5× based on recent win rate |
| `SaveToFile() / LoadFromFile()` | Persists state across restarts |

---

## 4. ICT EA — Signal Logic (Pseudocode)

```
ON_NEW_BAR:
  1. Manage open positions (BE/trail)
  2. Process TP1 partial closes
  3. Scan closed trades → AdaptiveLearning.RecordTrade()

  GUARD CHECKS:
    - RiskManager.IsTradingAllowed()     → daily loss / DD
    - RiskManager.IsSpreadAcceptable()   → max 35 pts
    - RiskManager.IsMaxPositionsReached() → max 2 positions
    - NewsConnector.IsNewsBlackout()     → ±20 min around high-impact events
    - NewsConnector.GetGoldSentiment()   → skip if sentiment < threshold

  CONTEXT UPDATE:
    - HTF MarketStructure.Update()       → H4 bias (BOS/CHoCH/HH-HL/LH-LL)
    - Exec MarketStructure.Update()      → M15 swing points
    - ScanOrderBlocks(200 bars)
    - ScanFairValueGaps(100 bars)

  SIGNAL SELECTION (priority order):
    1. Liquidity Sweep + Reversal        → conf ~0.65–0.80
    2. Order Block entry (aligned w/ HTF)→ conf ~0.50–0.75
    3. Fair Value Gap fill               → conf ~0.50–0.65
    4. Silver Bullet (time-window OB)    → conf ~0.60–0.75

  CONFIDENCE GATE:
    - AdaptiveLearning.GetAdaptedThreshold(signal_type)
    - Skip if signal.confidence < threshold

  EXECUTION:
    - CalcLotSize(entry, SL) × AdaptiveLearning.GetLotScaleFactor()
    - Trade.Buy() or Trade.Sell() with TP2 as primary TP
    - TP1 partial close at 50% journey → set BE → trail to TP2
```

---

## 5. SMC EA — Signal Logic (Pseudocode)

```
ON_NEW_BAR:
  (Same guards as ICT — daily loss, DD, spread, news blackout)

  ADDITIONAL MACRO GUARDS:
    - FRED DXY 1-day change > +0.3% → suppress gold longs
    - FRED TIPS 10yr yield > 2.0%   → flag gold headwind (reduce lot scale)

  CONTEXT UPDATE:
    - HTF + Exec MarketStructure.Update()
    - ScanLiquidityPools(150 bars)   → equal highs/lows clusters
    - ScanAccumulationZones(100 bars)→ tight consolidation ranges

  SIGNAL SELECTION:
    1. Stop Hunt Reversal             → conf ~0.65–0.85  (highest priority)
       - Wick through equal high/low pool, close back inside
       - Volume spike confirmation
    2. Displacement Candle            → conf ~0.55–0.75
       - Body > 60% of candle range
       - Body > 1.5× ATR
       - Closes above/below prior swing
    3. Accumulation/Distribution Break→ conf ~0.50–0.70
       - 8+ bars in ATR*2 range
       - Price breaks cleanly above/below with volume

  EXECUTION:
    - Same sizing and partial-close ladder as ICT EA
    - SMC uses slightly wider SL (1.5× ATR vs ICT's 1.2×)
    - and wider TP2 (5× ATR vs ICT's 4×) — institutional targets
```

---

## 6. Risk Control Rules

| Rule | ICT EA | SMC EA |
|------|--------|--------|
| Risk per trade | 1.0% of balance | 1.0% of balance |
| Max daily loss | 3.0% → halt entries | 3.0% → halt entries |
| Max equity drawdown | 8.0% → halt all | 8.0% → halt all |
| Max total open risk | 5.0% | 5.0% |
| Max positions | 2 | 2 |
| Max spread | 35 pts (~3.5 pips) | 35 pts |
| SL multiplier (ATR) | 1.2× | 1.5× |
| TP1 (partial 50%) | 2.0× ATR | 2.5× ATR |
| TP2 (full close) | 4.0× ATR | 5.0× ATR |
| Breakeven trigger | 1.0× ATR profit | 1.2× ATR profit |
| Trailing stop step | 1.5× ATR | 1.8× ATR |

**Position Sizing Formula:**
```
risk_$ = balance × risk_pct / 100
sl_distance = |entry - stop_loss|
lots = risk_$ / (sl_distance / tick_size × tick_value)
lots = floor(lots / lot_step) × lot_step
lots = clamp(lots, min_lot, max_lot)
```

---

## 7. News & Macro Integration

### 7.1 Data Sources
| Source | Endpoint | Data Used |
|--------|----------|-----------|
| NewsAPI.org | `/v2/everything?q=gold+XAU` | Sentiment scoring (50 articles) |
| ForexFactory | `ff_calendar_thisweek.json` | High-impact event calendar |
| FRED (St. Louis Fed) | `DTWEXBGS` (DXY), `DFII10` (TIPS) | Macro headwind/tailwind |

### 7.2 Sentiment Scoring
- 12 bullish gold keywords (inflation, recession, rate cut, dovish, crisis...)
- 10 bearish gold keywords (rate hike, hawkish, taper, yield rise...)
- Score = sum of matched keywords across 50 articles
- Polarity: Very Bearish(−2) → Very Bullish(+2)
- Cache TTL: 5 minutes (avoids API rate limits)

### 7.3 Event Blackout Logic
```
For each high-impact USD/CNY/EUR event within 60 min:
  if TimeCurrent() ∈ [event_time − 20min, event_time + 15min]:
    return BLACKOUT → skip entry
```

---

## 8. Backtesting Framework

### 8.1 Strategy Tester Settings
- Model: **Every tick based on real ticks** (production validation)
- Initial model: **1-minute OHLC** (fast parameter sweep)
- Symbol: XAUUSD (5-digit broker)
- Period: M15 execution / H4 context
- Date range: 2022-01-01 to 2024-12-31 (3 years)
- Forward period: 2024-01-01 to 2024-12-31 (1-year OOS)

### 8.2 Custom Optimization Criterion
```
score = (PF × 0.4 + max(0, Sharpe) × 0.4)
        × (1 − DD_pct / 100)
        × log(max(1, trade_count))

Rejections:
  - trade_count < 30
  - profit_factor < 1.0
  - max_DD_pct > 15.0
```

### 8.3 Deployment Acceptance Criteria
| Metric | Minimum |
|--------|---------|
| Win Rate | ≥ 40% |
| Profit Factor | ≥ 1.30 |
| Max Drawdown | ≤ 12% |
| Sharpe Ratio | ≥ 0.50 |
| Trade Count (IS) | ≥ 50 |
| Walk-Forward Degradation | ≤ 35% |

---

## 9. Step-by-Step Implementation & Testing Schedule

### Phase 1 — Setup (Week 1)
1. Install MT5 + copy all MQL5 files to `MQL5/Experts/` and `MQL5/Include/`
2. Install JAson.mqh (MQL5 community JSON parser) to `MQL5/Include/`
3. Obtain API keys: NewsAPI.org (free tier), FRED (free), set in EA inputs
4. Add allowed URLs in MT5 Tools → Options → Expert Advisors:
   - `https://newsapi.org`
   - `https://api.stlouisfed.org`
   - `https://nfs.faireconomy.media`
5. Compile both EAs; fix any MQL5 version-specific API calls

### Phase 2 — Unit Testing (Week 1–2)
1. Test `MarketStructure` alone on XAUUSD H4 — verify BOS/CHoCH detection visually
2. Test `NewsConnector` — run `GetGoldSentiment()` in a test EA; log output
3. Test `RiskManager.CalcLotSize()` with known entry/SL pairs; verify math
4. Test `SessionFilter.IsKillzone()` against known London/NY open times

### Phase 3 — Signal Validation (Week 2–3)
1. Run ICT EA on 2020–2021 data (out of training range) in 1-min OHLC mode
2. Visual audit: mark every signal on chart; verify OBs and FVGs are correctly identified
3. Review Order Block strength scoring — adjust `atr_sl_multiplier` if SLs too tight/wide
4. Run SMC EA on same period; visually validate accumulation zones and pool detection

### Phase 4 — Backtesting (Week 3–4)
1. Run full backtest 2022–2024 with default parameters
2. Check raw stats: must meet acceptance criteria (Section 8.3)
3. Run optimization sweep (15 key parameters) using 1-min OHLC for speed
4. Apply best parameters to every-tick model for final validation
5. Validate walk-forward: IS 2022–2023, OOS 2024

### Phase 5 — Forward Testing / Demo (Month 2–3)
1. Deploy both EAs on separate demo accounts (MT5 broker with 5-digit XAUUSD)
2. Monitor daily: check positions, equity curve, signal log
3. Compare live performance vs backtest expectancy
4. After 30+ trades per EA: evaluate if live PF ≥ 1.20

### Phase 6 — Live Deployment (Month 3+)
1. Start with 50% of normal risk (0.5% per trade) for 2 weeks
2. Scale to full risk after confirming live results match demo
3. Monthly review: run `AdaptiveLearning.SaveToFile()` audit
4. Quarterly: re-run backtest with new 3-month data appended

---

## 10. Scalability & Future Expansion

| Extension | Implementation Path |
|-----------|---------------------|
| Multi-symbol | Add symbol parameter array; spawn one signal engine per pair |
| ML signal scoring | Replace `confidence` calculation with ONNX model inference (MT5 native) |
| Telegram alerts | Add `WebRequest` calls to Telegram Bot API in `OnTick()` |
| Dashboard panel | Create `CChartObject`-based overlay in separate indicator |
| Portfolio correlation | Add `CorrelationFilter` to `RiskManager` — check DXY/SPX/BTC correlation |
| Regime detection | Add HMM-style volatility regime classifier using ATR percentile |
| Live ML retraining | Export `AdaptiveLearning` data to CSV; train Python model; import back as ONNX |

---

## 11. Key External Dependencies

| Dependency | Version | Source |
|-----------|---------|--------|
| MT5 build | ≥ 3000 | MetaTrader5 |
| JAson.mqh | latest | MQL5 Code Base |
| NewsAPI | v2 | newsapi.org (free: 100 req/day) |
| FRED API | v1 | fred.stlouisfed.org (free) |
| ForexFactory calendar | public JSON | nfs.faireconomy.media |

---

## 12. Risk Disclaimer

These EAs are research tools. Past backtest performance does not guarantee future results.  
- Always test on demo first (minimum 3 months, 50+ trades per strategy).
- Gold (XAU/USD) is highly volatile; use broker max spread limits.
- News API latency (~500ms–2s) means live news filter may be slightly delayed.
- The adaptive learning module adjusts risk in real time — monitor equity curve weekly.
