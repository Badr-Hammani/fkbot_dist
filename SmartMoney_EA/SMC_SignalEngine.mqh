//+------------------------------------------------------------------+
//|  SMC_SignalEngine.mqh — Smart Money Concept signal layer          |
//|  Detects: institutional accumulation zones, liquidity pools,      |
//|  stop hunts, imbalances, and displacement candles on XAU/USD      |
//+------------------------------------------------------------------+
#ifndef SMC_SIGNAL_ENGINE_MQH
#define SMC_SIGNAL_ENGINE_MQH

#include "../Shared/Utils/MarketStructure.mqh"
#include "../Shared/Utils/SessionFilter.mqh"

//--- SMC signal types
enum ENUM_SMC_SIGNAL
{
   SMC_NONE             = 0,
   SMC_ACCUMULATION     = 1,   // Wyckoff-style accumulation zone long
   SMC_DISTRIBUTION     = 2,   // Wyckoff-style distribution zone short
   SMC_STOP_HUNT_LONG   = 3,   // Below-low stop hunt → long reversal
   SMC_STOP_HUNT_SHORT  = 4,   // Above-high stop hunt → short reversal
   SMC_INDUCEMENT_LONG  = 5,   // Retail longs flushed → institutional long
   SMC_INDUCEMENT_SHORT = 6,
   SMC_DISPLACEMENT_LONG = 7,  // Strong imbalance candle (bull)
   SMC_DISPLACEMENT_SHORT = 8,
   SMC_EQH_HUNT         = 9,   // Equal highs sweep (engineered liquidity)
   SMC_EQL_HUNT         = 10   // Equal lows sweep
};

struct LiquidityPool
{
   double   price;
   datetime formed_time;
   bool     is_above;     // true = sell-side liquidity (above price), false = buy-side
   int      touches;      // how many times price tested this level
   bool     has_been_swept;
   double   sweep_depth;  // how far below/above was the sweep wick?
};

struct AccumulationZone
{
   double   high;
   double   low;
   double   midpoint;
   datetime start_time;
   datetime end_time;
   int      consolidation_bars;  // bars spent in range
   bool     is_valid;            // >5 bars + volume compression
   double   range_pips;
};

struct DisplacementCandle
{
   double   open, high, low, close;
   datetime candle_time;
   bool     is_bullish;
   double   body_ratio;     // body / total range
   double   atr_multiple;   // how many ATRs does body span
   bool     closes_above_prev_swing;
};

struct SMCSignal
{
   ENUM_SMC_SIGNAL type;
   bool            is_long;
   double          entry_price;
   double          stop_loss;
   double          take_profit_1;
   double          take_profit_2;
   double          confidence;
   datetime        signal_time;
   string          description;

   double          pool_level;      // liquidity pool that was swept
   double          institution_zone_high;
   double          institution_zone_low;
};

//+------------------------------------------------------------------+
class CSMCSignalEngine
{
private:
   string          m_symbol;
   ENUM_TIMEFRAMES m_exec_tf;
   ENUM_TIMEFRAMES m_htf;

   CMarketStructure m_htf_struct;
   CMarketStructure m_exec_struct;
   CSessionFilter   m_session;

   LiquidityPool   m_pools[];
   int             m_pool_count;

   AccumulationZone m_acc_zones[];
   int             m_acc_count;

   int             m_atr_handle;
   int             m_vol_ma_handle;  // Volume MA for volume analysis proxy
   double          m_atr[];
   double          m_vol_ma[];

   //--- Detection sub-routines
   void     ScanLiquidityPools(const int lookback = 150);
   void     ScanAccumulationZones(const int lookback = 100);
   bool     DetectDisplacement(DisplacementCandle &dc, const int bar = 1);
   bool     DetectEqualHighsLows(bool &is_highs, double &level,
                                  const int lookback = 50);
   bool     DetectStopHunt(bool &is_bull_hunt, double &hunt_level,
                            double &entry_zone_high, double &entry_zone_low);

   //--- Volume proxy (tick volume as institutional footprint)
   bool     IsHighVolume(const int bar, const double multiplier = 1.5);

   //--- Confluence scorer
   double   ScoreLong (const double price, const AccumulationZone *az,
                       const LiquidityPool *pool);
   double   ScoreShort(const double price, const AccumulationZone *az,
                       const LiquidityPool *pool);

   double   GetATR();

public:
   CSMCSignalEngine();
   ~CSMCSignalEngine();

   bool     Init(const string symbol,
                 const ENUM_TIMEFRAMES exec_tf = PERIOD_M15,
                 const ENUM_TIMEFRAMES htf     = PERIOD_H4);

   void     UpdateContext();
   bool     GetBestSignal(SMCSignal &signal);

   //--- Accessors for dashboard
   int      GetLiquidityPools(LiquidityPool &out[], const int max = 10);
   int      GetAccumulationZones(AccumulationZone &out[], const int max = 5);
   ENUM_MARKET_BIAS GetHTFBias() { return m_htf_struct.GetBias(); }
};

//+------------------------------------------------------------------+
CSMCSignalEngine::CSMCSignalEngine()
   : m_pool_count(0), m_acc_count(0),
     m_atr_handle(INVALID_HANDLE),
     m_vol_ma_handle(INVALID_HANDLE)
{
   ArraySetAsSeries(m_atr,    true);
   ArraySetAsSeries(m_vol_ma, true);
}

//+------------------------------------------------------------------+
CSMCSignalEngine::~CSMCSignalEngine()
{
   if(m_atr_handle    != INVALID_HANDLE) IndicatorRelease(m_atr_handle);
   if(m_vol_ma_handle != INVALID_HANDLE) IndicatorRelease(m_vol_ma_handle);
}

//+------------------------------------------------------------------+
bool CSMCSignalEngine::Init(const string symbol,
                            const ENUM_TIMEFRAMES exec_tf,
                            const ENUM_TIMEFRAMES htf)
{
   m_symbol  = symbol;
   m_exec_tf = exec_tf;
   m_htf     = htf;

   if(!m_htf_struct.Init(symbol, htf, 5))     return false;
   if(!m_exec_struct.Init(symbol, exec_tf, 3)) return false;

   m_atr_handle    = iATR(symbol, exec_tf, 14);
   m_vol_ma_handle = iMA(symbol, exec_tf, 20, 0, MODE_SMA, VOLUME_TICK);

   if(m_atr_handle    == INVALID_HANDLE) return false;
   if(m_vol_ma_handle == INVALID_HANDLE) return false;

   ArrayResize(m_pools,     100);
   ArrayResize(m_acc_zones, 30);

   UpdateContext();
   Print("SMCSignalEngine: Initialised on ", symbol);
   return true;
}

//+------------------------------------------------------------------+
double CSMCSignalEngine::GetATR()
{
   if(CopyBuffer(m_atr_handle, 0, 0, 3, m_atr) < 1) return 0.0;
   return m_atr[1];
}

//+------------------------------------------------------------------+
bool CSMCSignalEngine::IsHighVolume(const int bar, const double multiplier)
{
   if(CopyBuffer(m_vol_ma_handle, 0, 0, bar + 2, m_vol_ma) < bar + 2) return false;
   long vol_arr[];
   ArraySetAsSeries(vol_arr, true);
   if(CopyTickVolume(m_symbol, m_exec_tf, 0, bar + 2, vol_arr) < bar + 2) return false;
   return ((double)vol_arr[bar] > m_vol_ma[bar] * multiplier);
}

//+------------------------------------------------------------------+
void CSMCSignalEngine::ScanLiquidityPools(const int lookback)
{
   int    total = MathMin(lookback, Bars(m_symbol, m_exec_tf));
   double hi[], lo[], cl[];
   datetime times[];

   ArraySetAsSeries(hi,    true);
   ArraySetAsSeries(lo,    true);
   ArraySetAsSeries(cl,    true);
   ArraySetAsSeries(times, true);

   if(CopyHigh (m_symbol, m_exec_tf, 0, total, hi)    < total) return;
   if(CopyLow  (m_symbol, m_exec_tf, 0, total, lo)    < total) return;
   if(CopyClose(m_symbol, m_exec_tf, 0, total, cl)    < total) return;
   if(CopyTime (m_symbol, m_exec_tf, 0, total, times) < total) return;

   m_pool_count = 0;
   double atr   = GetATR();
   double tolerance = atr * 0.15;  // within 15% ATR = "equal" level

   //--- Find equal highs (sell-side liquidity) and equal lows (buy-side)
   for(int i = 3; i < total - 3 && m_pool_count < 98; i++)
   {
      //--- Equal highs: 2+ swing highs at approximately same level
      for(int j = i + 2; j < MathMin(i + 30, total - 1); j++)
      {
         if(MathAbs(hi[i] - hi[j]) <= tolerance &&
            hi[i] > hi[i+1] && hi[i] > hi[i-1] &&
            hi[j] > hi[j+1] && hi[j] > hi[j-1])
         {
            //--- Sell-side liquidity pool (resting buy stops above equal highs)
            LiquidityPool &p   = m_pools[m_pool_count];
            p.price            = (hi[i] + hi[j]) / 2.0;
            p.formed_time      = times[j];
            p.is_above         = true;  // liquidity sits above price
            p.touches          = 2;
            p.has_been_swept   = false;
            p.sweep_depth      = 0.0;
            m_pool_count++;
            break;
         }
      }

      //--- Equal lows: buy-side liquidity (sell stops rest below)
      for(int j = i + 2; j < MathMin(i + 30, total - 1); j++)
      {
         if(MathAbs(lo[i] - lo[j]) <= tolerance &&
            lo[i] < lo[i+1] && lo[i] < lo[i-1] &&
            lo[j] < lo[j+1] && lo[j] < lo[j-1])
         {
            LiquidityPool &p   = m_pools[m_pool_count];
            p.price            = (lo[i] + lo[j]) / 2.0;
            p.formed_time      = times[j];
            p.is_above         = false;  // liquidity sits below price
            p.touches          = 2;
            p.has_been_swept   = false;
            p.sweep_depth      = 0.0;
            m_pool_count++;
            break;
         }
      }
   }

   //--- Mark swept pools (price wicked through)
   double cp = iClose(m_symbol, m_exec_tf, 1);
   double ch = iHigh (m_symbol, m_exec_tf, 1);
   double cl1= iLow  (m_symbol, m_exec_tf, 1);

   for(int i = 0; i < m_pool_count; i++)
   {
      if(m_pools[i].is_above && ch > m_pools[i].price && cl[1] < m_pools[i].price)
      {
         m_pools[i].has_been_swept = true;
         m_pools[i].sweep_depth    = ch - m_pools[i].price;
      }
      if(!m_pools[i].is_above && cl1 < m_pools[i].price && cl[1] > m_pools[i].price)
      {
         m_pools[i].has_been_swept = true;
         m_pools[i].sweep_depth    = m_pools[i].price - cl1;
      }
   }
}

//+------------------------------------------------------------------+
void CSMCSignalEngine::ScanAccumulationZones(const int lookback)
{
   int    total = MathMin(lookback, Bars(m_symbol, m_exec_tf));
   double hi[], lo[], cl[];
   datetime times[];

   ArraySetAsSeries(hi,    true);
   ArraySetAsSeries(lo,    true);
   ArraySetAsSeries(cl,    true);
   ArraySetAsSeries(times, true);

   if(CopyHigh (m_symbol, m_exec_tf, 0, total, hi)    < total) return;
   if(CopyLow  (m_symbol, m_exec_tf, 0, total, lo)    < total) return;
   if(CopyClose(m_symbol, m_exec_tf, 0, total, cl)    < total) return;
   if(CopyTime (m_symbol, m_exec_tf, 0, total, times) < total) return;

   m_acc_count = 0;
   double atr  = GetATR();

   //--- Sliding window: find ranges where ATH-ATL < 2*ATR for 8+ bars
   for(int i = 10; i < total - 8 && m_acc_count < 28; i++)
   {
      double window_high = hi[i];
      double window_low  = lo[i];
      int    bar_count   = 0;

      for(int j = i; j >= MathMax(0, i - 30) && j >= 0; j--)
      {
         window_high = MathMax(window_high, hi[j]);
         window_low  = MathMin(window_low,  lo[j]);
         if((window_high - window_low) > atr * 2.0) break;
         bar_count++;
      }

      if(bar_count >= 8)
      {
         AccumulationZone &az = m_acc_zones[m_acc_count];
         az.high               = window_high;
         az.low                = window_low;
         az.midpoint           = (window_high + window_low) / 2.0;
         az.start_time         = times[i];
         az.end_time           = times[MathMax(0, i - bar_count + 1)];
         az.consolidation_bars = bar_count;
         az.range_pips         = (window_high - window_low) /
                                  SymbolInfoDouble(m_symbol, SYMBOL_POINT) / 10.0;
         az.is_valid           = (bar_count >= 8);
         m_acc_count++;
         i -= bar_count;  // skip scanned bars
      }
   }
}

//+------------------------------------------------------------------+
bool CSMCSignalEngine::DetectDisplacement(DisplacementCandle &dc,
                                           const int bar)
{
   double atr = GetATR();
   if(atr <= 0.0) return false;

   double op = iOpen (m_symbol, m_exec_tf, bar);
   double cl = iClose(m_symbol, m_exec_tf, bar);
   double hi = iHigh (m_symbol, m_exec_tf, bar);
   double lo = iLow  (m_symbol, m_exec_tf, bar);

   double body       = MathAbs(cl - op);
   double total_rng  = hi - lo;
   if(total_rng <= 0.0) return false;

   dc.open       = op; dc.high = hi; dc.low = lo; dc.close = cl;
   dc.candle_time = iTime(m_symbol, m_exec_tf, bar);
   dc.is_bullish  = (cl > op);
   dc.body_ratio  = body / total_rng;
   dc.atr_multiple= body / atr;

   //--- Displacement: large body (>60% of range), body > 1.5x ATR
   if(dc.body_ratio < 0.60 || dc.atr_multiple < 1.5) return false;

   //--- Closes above previous swing high (bull) or below (bear)
   SwingPoint highs[], lows[];
   m_exec_struct.GetSwingHighs(highs, 2);
   m_exec_struct.GetSwingLows (lows,  2);

   if(dc.is_bullish && ArraySize(highs) > 0)
      dc.closes_above_prev_swing = (cl > highs[0].price);
   else if(!dc.is_bullish && ArraySize(lows) > 0)
      dc.closes_above_prev_swing = (cl < lows[0].price);
   else
      dc.closes_above_prev_swing = false;

   return true;
}

//+------------------------------------------------------------------+
bool CSMCSignalEngine::DetectStopHunt(bool &is_bull_hunt,
                                       double &hunt_level,
                                       double &entry_high,
                                       double &entry_low)
{
   double atr = GetATR();

   //--- A stop hunt: current bar wicks significantly beyond a pool,
   //--- then closes back inside the pool range with a large wick.
   for(int i = 0; i < m_pool_count; i++)
   {
      if(!m_pools[i].has_been_swept) continue;

      double hi1 = iHigh (m_symbol, m_exec_tf, 1);
      double lo1 = iLow  (m_symbol, m_exec_tf, 1);
      double cl1 = iClose(m_symbol, m_exec_tf, 1);

      //--- Bullish stop hunt: wick below equal lows pool, close back above
      if(!m_pools[i].is_above &&
         lo1 < m_pools[i].price &&
         cl1 > m_pools[i].price &&
         (m_pools[i].price - lo1) >= atr * 0.3)
      {
         is_bull_hunt = true;
         hunt_level   = m_pools[i].price;
         entry_high   = cl1 + atr * 0.1;
         entry_low    = m_pools[i].price;
         return true;
      }

      //--- Bearish stop hunt: wick above equal highs pool, close back below
      if(m_pools[i].is_above &&
         hi1 > m_pools[i].price &&
         cl1 < m_pools[i].price &&
         (hi1 - m_pools[i].price) >= atr * 0.3)
      {
         is_bull_hunt = false;
         hunt_level   = m_pools[i].price;
         entry_high   = m_pools[i].price;
         entry_low    = cl1 - atr * 0.1;
         return true;
      }
   }
   return false;
}

//+------------------------------------------------------------------+
double CSMCSignalEngine::ScoreLong(const double price,
                                   const AccumulationZone *az,
                                   const LiquidityPool *pool)
{
   double score = 0.40;

   if(az != NULL && price >= az->low && price <= az->high)
   {
      score += 0.15;
      score += MathMin(0.10, az->consolidation_bars * 0.01);
   }

   if(pool != NULL && !pool->is_above && pool->has_been_swept)
      score += 0.20;  // buy-side pool swept = institutional entry

   if(m_htf_struct.GetBias() == BIAS_BULLISH) score += 0.15;
   if(m_session.IsKillzone())                  score += 0.10;

   return MathMin(1.0, score);
}

//+------------------------------------------------------------------+
double CSMCSignalEngine::ScoreShort(const double price,
                                    const AccumulationZone *az,
                                    const LiquidityPool *pool)
{
   double score = 0.40;

   if(az != NULL && price >= az->low && price <= az->high)
   {
      score += 0.15;
      score += MathMin(0.10, az->consolidation_bars * 0.01);
   }

   if(pool != NULL && pool->is_above && pool->has_been_swept)
      score += 0.20;  // sell-side pool swept = institutional short

   if(m_htf_struct.GetBias() == BIAS_BEARISH) score += 0.15;
   if(m_session.IsKillzone())                  score += 0.10;

   return MathMin(1.0, score);
}

//+------------------------------------------------------------------+
void CSMCSignalEngine::UpdateContext()
{
   m_htf_struct.Update();
   m_exec_struct.Update();
   ScanLiquidityPools(150);
   ScanAccumulationZones(100);
}

//+------------------------------------------------------------------+
bool CSMCSignalEngine::GetBestSignal(SMCSignal &signal)
{
   signal.type       = SMC_NONE;
   signal.confidence = 0.0;

   if(!m_session.IsTradingSession()) return false;

   double price = iClose(m_symbol, m_exec_tf, 1);
   double atr   = GetATR();
   if(atr <= 0.0) return false;

   ENUM_MARKET_BIAS bias = m_htf_struct.GetBias();
   double best_conf = 0.0;

   //--- 1. Stop Hunt / Liquidity Sweep Reversal ----------------------
   bool bull_hunt; double hunt_lvl, ez_hi, ez_lo;
   if(DetectStopHunt(bull_hunt, hunt_lvl, ez_hi, ez_lo))
   {
      double conf = bull_hunt ? ScoreLong(price, NULL, NULL)
                              : ScoreShort(price, NULL, NULL);
      conf += 0.25;  // sweep = strong institutional footprint

      if(conf > best_conf)
      {
         best_conf           = conf;
         signal.type         = bull_hunt ? SMC_STOP_HUNT_LONG : SMC_STOP_HUNT_SHORT;
         signal.is_long      = bull_hunt;
         signal.entry_price  = price;
         signal.stop_loss    = bull_hunt ? hunt_lvl - atr * 0.5
                                         : hunt_lvl + atr * 0.5;
         signal.take_profit_1= bull_hunt ? price + atr * 2.0
                                         : price - atr * 2.0;
         signal.take_profit_2= bull_hunt ? price + atr * 4.5
                                         : price - atr * 4.5;
         signal.confidence   = conf;
         signal.signal_time  = TimeCurrent();
         signal.pool_level   = hunt_lvl;
         signal.description  = "SMC Stop Hunt " + (bull_hunt ? "LONG" : "SHORT") +
                               " @ " + DoubleToString(hunt_lvl, 2);
      }
   }

   //--- 2. Accumulation → Displacement entry -------------------------
   DisplacementCandle dc;
   if(DetectDisplacement(dc, 1))
   {
      bool want_long = dc.is_bullish;
      if((want_long && bias != BIAS_BEARISH) ||
         (!want_long && bias != BIAS_BULLISH))
      {
         double conf = want_long ? ScoreLong(price, NULL, NULL)
                                 : ScoreShort(price, NULL, NULL);
         if(dc.closes_above_prev_swing) conf += 0.15;
         conf += MathMin(0.10, (dc.atr_multiple - 1.5) * 0.05);

         if(conf > best_conf)
         {
            best_conf           = conf;
            signal.type         = want_long ? SMC_DISPLACEMENT_LONG
                                            : SMC_DISPLACEMENT_SHORT;
            signal.is_long      = want_long;
            signal.entry_price  = price;
            signal.stop_loss    = want_long ? dc.low  - atr * 0.3
                                            : dc.high + atr * 0.3;
            signal.take_profit_1= want_long ? price + atr * 2.0
                                            : price - atr * 2.0;
            signal.take_profit_2= want_long ? price + atr * 4.0
                                            : price - atr * 4.0;
            signal.confidence   = conf;
            signal.signal_time  = TimeCurrent();
            signal.description  = "SMC Displacement " +
                                  (want_long ? "LONG" : "SHORT") +
                                  " body=" + DoubleToString(dc.atr_multiple, 2) + "xATR";
         }
      }
   }

   //--- 3. Accumulation Zone breakout --------------------------------
   for(int i = 0; i < m_acc_count; i++)
   {
      if(!m_acc_zones[i].is_valid) continue;

      bool above_zone = price > m_acc_zones[i].high;
      bool below_zone = price < m_acc_zones[i].low;

      if(above_zone && bias != BIAS_BEARISH)
      {
         double conf = ScoreLong(price, &m_acc_zones[i], NULL);
         if(conf > best_conf)
         {
            best_conf            = conf;
            signal.type          = SMC_ACCUMULATION;
            signal.is_long       = true;
            signal.entry_price   = price;
            signal.stop_loss     = m_acc_zones[i].low - atr * 0.3;
            signal.take_profit_1 = price + atr * 2.0;
            signal.take_profit_2 = price + atr * 4.0;
            signal.confidence    = conf;
            signal.signal_time   = TimeCurrent();
            signal.institution_zone_high = m_acc_zones[i].high;
            signal.institution_zone_low  = m_acc_zones[i].low;
            signal.description   = "SMC Accumulation Break LONG | zone=" +
                                   DoubleToString(m_acc_zones[i].low, 2) +
                                   "-" + DoubleToString(m_acc_zones[i].high, 2) +
                                   " bars=" + IntegerToString(m_acc_zones[i].consolidation_bars);
         }
      }
      else if(below_zone && bias != BIAS_BULLISH)
      {
         double conf = ScoreShort(price, &m_acc_zones[i], NULL);
         if(conf > best_conf)
         {
            best_conf            = conf;
            signal.type          = SMC_DISTRIBUTION;
            signal.is_long       = false;
            signal.entry_price   = price;
            signal.stop_loss     = m_acc_zones[i].high + atr * 0.3;
            signal.take_profit_1 = price - atr * 2.0;
            signal.take_profit_2 = price - atr * 4.0;
            signal.confidence    = conf;
            signal.signal_time   = TimeCurrent();
            signal.institution_zone_high = m_acc_zones[i].high;
            signal.institution_zone_low  = m_acc_zones[i].low;
            signal.description   = "SMC Distribution Break SHORT | zone=" +
                                   DoubleToString(m_acc_zones[i].low, 2) +
                                   "-" + DoubleToString(m_acc_zones[i].high, 2);
         }
      }
   }

   return (signal.type != SMC_NONE && signal.confidence > 0.0);
}

//+------------------------------------------------------------------+
int CSMCSignalEngine::GetLiquidityPools(LiquidityPool &out[], const int max)
{
   int n = MathMin(max, m_pool_count);
   ArrayResize(out, n);
   for(int i = 0; i < n; i++) out[i] = m_pools[i];
   return n;
}

//+------------------------------------------------------------------+
int CSMCSignalEngine::GetAccumulationZones(AccumulationZone &out[], const int max)
{
   int n = MathMin(max, m_acc_count);
   ArrayResize(out, n);
   for(int i = 0; i < n; i++) out[i] = m_acc_zones[i];
   return n;
}

#endif // SMC_SIGNAL_ENGINE_MQH
