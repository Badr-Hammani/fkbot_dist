//+------------------------------------------------------------------+
//|  TradeFilter.mqh — Multi-factor profitability filter             |
//|  Combines: D1 trend, RSI momentum, ATR volatility regime,        |
//|  day-of-week quality, and session quality into a single gate      |
//|  that both EAs consult before opening any position.              |
//+------------------------------------------------------------------+
#ifndef TRADE_FILTER_MQH
#define TRADE_FILTER_MQH

struct FilterResult
{
   bool   allowed;
   double quality_score;    // 0.0–1.0: how good the current environment is
   string reason;           // human-readable explanation if blocked
};

class CTradeFilter
{
private:
   string          m_symbol;
   ENUM_TIMEFRAMES m_exec_tf;

   //--- Indicator handles
   int   m_d1_ema_handle;      // D1 EMA for macro trend
   int   m_rsi_handle;         // RSI on exec TF
   int   m_atr_pct_handle;     // ATR on exec TF for regime detection
   int   m_atr_d1_handle;      // ATR on D1 for historical percentile

   double m_d1_ema[];
   double m_rsi[];
   double m_atr_exec[];
   double m_atr_d1[];

   //--- Config
   int    m_d1_ema_period;     // default 50
   int    m_rsi_period;        // default 14
   double m_rsi_ob;            // overbought level for SELL filter (default 70)
   double m_rsi_os;            // oversold level for BUY filter (default 30)
   double m_atr_regime_pct;    // suppress if ATR > this percentile (default 0.90)
   int    m_atr_lookback;      // bars for ATR percentile (default 200)

   //--- Day-of-week thresholds
   bool   m_allow_monday;      // Monday often low-conviction
   bool   m_allow_friday_pm;   // Friday PM often reversal noise

   //--- Helpers
   double GetATRPercentile();
   bool   IsDayAllowed();

public:
   CTradeFilter();
   ~CTradeFilter();

   bool     Init(const string symbol,
                 const ENUM_TIMEFRAMES exec_tf,
                 const int    d1_ema_period   = 50,
                 const int    rsi_period       = 14,
                 const double rsi_ob           = 70.0,
                 const double rsi_os           = 30.0,
                 const double atr_regime_pct   = 0.90,
                 const bool   allow_monday     = true,
                 const bool   allow_friday_pm  = false);

   //--- Primary gate — call before every entry
   FilterResult Evaluate(const bool want_long);

   //--- Individual component checks (for debug / dashboard)
   bool     IsDailyTrendBullish();
   bool     IsDailyTrendBearish();
   double   GetRSI();
   bool     IsVolatilityNormal();
   double   GetEnvironmentScore(const bool want_long);

   //--- Confidence bonus to add to signal confidence when environment is good
   double   GetConfidenceBonus(const bool want_long);
};

//+------------------------------------------------------------------+
CTradeFilter::CTradeFilter()
   : m_d1_ema_handle(INVALID_HANDLE),
     m_rsi_handle(INVALID_HANDLE),
     m_atr_pct_handle(INVALID_HANDLE),
     m_atr_d1_handle(INVALID_HANDLE),
     m_d1_ema_period(50),
     m_rsi_period(14),
     m_rsi_ob(70.0),
     m_rsi_os(30.0),
     m_atr_regime_pct(0.90),
     m_atr_lookback(200),
     m_allow_monday(true),
     m_allow_friday_pm(false)
{
   ArraySetAsSeries(m_d1_ema,    true);
   ArraySetAsSeries(m_rsi,       true);
   ArraySetAsSeries(m_atr_exec,  true);
   ArraySetAsSeries(m_atr_d1,    true);
}

CTradeFilter::~CTradeFilter()
{
   if(m_d1_ema_handle    != INVALID_HANDLE) IndicatorRelease(m_d1_ema_handle);
   if(m_rsi_handle       != INVALID_HANDLE) IndicatorRelease(m_rsi_handle);
   if(m_atr_pct_handle   != INVALID_HANDLE) IndicatorRelease(m_atr_pct_handle);
   if(m_atr_d1_handle    != INVALID_HANDLE) IndicatorRelease(m_atr_d1_handle);
}

bool CTradeFilter::Init(const string symbol,
                        const ENUM_TIMEFRAMES exec_tf,
                        const int    d1_ema_period,
                        const int    rsi_period,
                        const double rsi_ob,
                        const double rsi_os,
                        const double atr_regime_pct,
                        const bool   allow_monday,
                        const bool   allow_friday_pm)
{
   m_symbol          = symbol;
   m_exec_tf         = exec_tf;
   m_d1_ema_period   = d1_ema_period;
   m_rsi_period      = rsi_period;
   m_rsi_ob          = rsi_ob;
   m_rsi_os          = rsi_os;
   m_atr_regime_pct  = atr_regime_pct;
   m_allow_monday    = allow_monday;
   m_allow_friday_pm = allow_friday_pm;

   m_d1_ema_handle  = iMA (symbol, PERIOD_D1, d1_ema_period, 0, MODE_EMA, PRICE_CLOSE);
   m_rsi_handle     = iRSI(symbol, exec_tf, rsi_period, PRICE_CLOSE);
   m_atr_pct_handle = iATR(symbol, exec_tf, 14);
   m_atr_d1_handle  = iATR(symbol, PERIOD_D1, 14);

   if(m_d1_ema_handle  == INVALID_HANDLE ||
      m_rsi_handle     == INVALID_HANDLE ||
      m_atr_pct_handle == INVALID_HANDLE ||
      m_atr_d1_handle  == INVALID_HANDLE)
   {
      Print("TradeFilter: Failed to create one or more indicator handles");
      return false;
   }
   Print("TradeFilter: Init on ", symbol, " D1EMA(", d1_ema_period, ") RSI(", rsi_period, ")");
   return true;
}

bool CTradeFilter::IsDailyTrendBullish()
{
   if(CopyBuffer(m_d1_ema_handle, 0, 0, 3, m_d1_ema) < 2) return false;
   double price_d1 = iClose(m_symbol, PERIOD_D1, 1);
   return (price_d1 > m_d1_ema[1]);
}

bool CTradeFilter::IsDailyTrendBearish()
{
   if(CopyBuffer(m_d1_ema_handle, 0, 0, 3, m_d1_ema) < 2) return false;
   double price_d1 = iClose(m_symbol, PERIOD_D1, 1);
   return (price_d1 < m_d1_ema[1]);
}

double CTradeFilter::GetRSI()
{
   if(CopyBuffer(m_rsi_handle, 0, 0, 3, m_rsi) < 2) return 50.0;
   return m_rsi[1];
}

double CTradeFilter::GetATRPercentile()
{
   int bars = MathMin(m_atr_lookback, Bars(m_symbol, m_exec_tf));
   if(CopyBuffer(m_atr_pct_handle, 0, 0, bars, m_atr_exec) < bars) return 0.5;

   double current_atr = m_atr_exec[1];
   int    below_count = 0;
   for(int i = 2; i < bars; i++)
      if(m_atr_exec[i] < current_atr) below_count++;

   return (double)below_count / (bars - 2);
}

bool CTradeFilter::IsVolatilityNormal()
{
   return (GetATRPercentile() <= m_atr_regime_pct);
}

bool CTradeFilter::IsDayAllowed()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);

   if(!m_allow_monday && dt.day_of_week == 1) return false;

   if(!m_allow_friday_pm && dt.day_of_week == 5 && dt.hour >= 18) return false;

   // Never trade Sunday (market just opened, spreads wide)
   if(dt.day_of_week == 0) return false;

   return true;
}

double CTradeFilter::GetEnvironmentScore(const bool want_long)
{
   double score = 0.50;

   // D1 EMA trend alignment (+0.20 for with-trend, -0.15 for counter-trend)
   bool bull_trend = IsDailyTrendBullish();
   bool bear_trend = IsDailyTrendBearish();
   if(want_long  && bull_trend)  score += 0.20;
   if(!want_long && bear_trend)  score += 0.20;
   if(want_long  && bear_trend)  score -= 0.15;
   if(!want_long && bull_trend)  score -= 0.15;

   // RSI momentum alignment
   double rsi = GetRSI();
   if(want_long  && rsi >= 50.0 && rsi <= 65.0) score += 0.10;  // momentum with buy
   if(!want_long && rsi <= 50.0 && rsi >= 35.0) score += 0.10;  // momentum with sell
   if(want_long  && rsi > 70.0)                  score -= 0.10;  // overbought on buy
   if(!want_long && rsi < 30.0)                  score -= 0.10;  // oversold on sell

   // Volatility regime
   double atr_pct = GetATRPercentile();
   if(atr_pct <= 0.70)       score += 0.10;   // calm market = cleaner signals
   else if(atr_pct >= 0.90)  score -= 0.15;   // chaotic market = noisy signals

   // Day quality
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   if(dt.day_of_week == 2 || dt.day_of_week == 3 || dt.day_of_week == 4)
      score += 0.10;   // Tue/Wed/Thu = highest quality days for gold

   return MathMax(0.0, MathMin(1.0, score));
}

double CTradeFilter::GetConfidenceBonus(const bool want_long)
{
   double env = GetEnvironmentScore(want_long);
   // Scale bonus: 0.0 at env=0.5 (neutral), up to +0.15 at env=1.0
   return MathMax(0.0, (env - 0.50) * 0.30);
}

FilterResult CTradeFilter::Evaluate(const bool want_long)
{
   FilterResult result;
   result.allowed      = true;
   result.quality_score = 0.5;
   result.reason       = "";

   // 1. Day-of-week gate (hard block)
   if(!IsDayAllowed())
   {
      result.allowed = false;
      result.reason  = "Day-of-week blocked (Sun/Mon/Fri-PM)";
      return result;
   }

   // 2. RSI extremes (hard block — don't buy overbought, don't sell oversold)
   double rsi = GetRSI();
   if(want_long && rsi > m_rsi_ob)
   {
      result.allowed = false;
      result.reason  = "RSI overbought (" + DoubleToString(rsi, 1) + ") — no buy";
      return result;
   }
   if(!want_long && rsi < m_rsi_os)
   {
      result.allowed = false;
      result.reason  = "RSI oversold (" + DoubleToString(rsi, 1) + ") — no sell";
      return result;
   }

   // 3. Extreme volatility (hard block)
   if(!IsVolatilityNormal())
   {
      result.allowed = false;
      result.reason  = "ATR in top " +
                       DoubleToString((1.0 - m_atr_regime_pct) * 100, 0) +
                       "% (volatility spike) — skip";
      return result;
   }

   // 4. Counter-trend with weak environment (soft block)
   double env = GetEnvironmentScore(want_long);
   if(env < 0.30)
   {
      result.allowed = false;
      result.reason  = "Environment score too low (" + DoubleToString(env, 2) +
                       ") — counter-trend in unfavorable conditions";
      return result;
   }

   result.quality_score = env;
   return result;
}

#endif // TRADE_FILTER_MQH
