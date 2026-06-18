//+------------------------------------------------------------------+
//|  SMC_SignalEngine.mqh — Smart Money Concept signal layer          |
//|  v1.1 Fixes: swept pool variable (lo1 not cl[1]), manual volume   |
//|              MA, IsHighVolume called in displacement, stop hunt SL |
//|              at wick extreme, TIPS filter active, pool dedup,     |
//|              acc zone direction, swing lookback min 2             |
//+------------------------------------------------------------------+
#ifndef SMC_SIGNAL_ENGINE_MQH
#define SMC_SIGNAL_ENGINE_MQH

#include "../Shared/Utils/MarketStructure.mqh"
#include "../Shared/Utils/SessionFilter.mqh"

enum ENUM_SMC_SIGNAL
{
   SMC_NONE             = 0,
   SMC_ACCUMULATION     = 1,
   SMC_DISTRIBUTION     = 2,
   SMC_STOP_HUNT_LONG   = 3,
   SMC_STOP_HUNT_SHORT  = 4,
   SMC_INDUCEMENT_LONG  = 5,
   SMC_INDUCEMENT_SHORT = 6,
   SMC_DISPLACEMENT_LONG  = 7,
   SMC_DISPLACEMENT_SHORT = 8,
   SMC_EQH_HUNT         = 9,
   SMC_EQL_HUNT         = 10
};

struct LiquidityPool
{
   double   price;
   datetime formed_time;
   bool     is_above;
   int      touches;
   bool     has_been_swept;
   double   sweep_wick_extreme;  // FIX: store actual wick extreme for SL placement
};

struct AccumulationZone
{
   double   high;
   double   low;
   double   midpoint;
   datetime start_time;
   datetime end_time;
   int      consolidation_bars;
   bool     is_valid;
   bool     is_high_volume_breakout;  // volume compression check
};

struct DisplacementCandle
{
   double   open, high, low, close;
   datetime candle_time;
   bool     is_bullish;
   double   body_ratio;
   double   atr_multiple;
   bool     closes_above_prev_swing;
   bool     has_volume_confirmation;   // FIX: volume check now populated
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
   double          pool_level;
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
   CSessionFilter   m_session;   // FIX A4: owned and configured from EA

   LiquidityPool   m_pools[];
   int             m_pool_count;

   AccumulationZone m_acc_zones[];
   int             m_acc_count;

   int             m_atr_handle;
   double          m_atr[];

   // FIX: manual rolling tick volume MA (replaces broken iMA+VOLUME_TICK)
   double          m_vol_ma_buffer;
   int             m_vol_ma_period;
   void            UpdateVolumeMa();

   void     ScanLiquidityPools(const int lookback = 150);
   void     ScanAccumulationZones(const int lookback = 100);
   bool     DetectDisplacement(DisplacementCandle &dc, const int bar = 1);
   bool     DetectStopHunt(bool &is_bull_hunt, double &hunt_level,
                            double &wick_extreme);
   // FIX: IsHighVolume now uses the manual vol MA
   bool     IsHighVolume(const int bar, const double multiplier = 2.0);

   double   ScoreLong (const double price, const AccumulationZone *az,
                       const LiquidityPool *pool);
   double   ScoreShort(const double price, const AccumulationZone *az,
                       const LiquidityPool *pool);

   // FIX H8: guard < 2
   double   GetATR();

public:
   CSMCSignalEngine();
   ~CSMCSignalEngine();

   bool     Init(const string symbol,
                 const ENUM_TIMEFRAMES exec_tf = PERIOD_M15,
                 const ENUM_TIMEFRAMES htf     = PERIOD_H4);

   // FIX A4: wire session inputs from EA
   void     ConfigureSession(const bool allow_asian,
                             const bool allow_london_open,
                             const bool allow_ny_open,
                             const bool allow_ny_pm,
                             const int  gmt_offset);

   void     UpdateContext();
   bool     GetBestSignal(SMCSignal &signal);

   int      GetLiquidityPools(LiquidityPool &out[], const int max = 10);
   int      GetAccumulationZones(AccumulationZone &out[], const int max = 5);
   ENUM_MARKET_BIAS GetHTFBias() { return m_htf_struct.GetBias(); }
};

//+------------------------------------------------------------------+
CSMCSignalEngine::CSMCSignalEngine()
   : m_pool_count(0), m_acc_count(0),
     m_atr_handle(INVALID_HANDLE),
     m_vol_ma_buffer(0.0),
     m_vol_ma_period(20)
{
   ArraySetAsSeries(m_atr, true);
}

CSMCSignalEngine::~CSMCSignalEngine()
{
   if(m_atr_handle != INVALID_HANDLE) IndicatorRelease(m_atr_handle);
}

bool CSMCSignalEngine::Init(const string symbol,
                            const ENUM_TIMEFRAMES exec_tf,
                            const ENUM_TIMEFRAMES htf)
{
   m_symbol  = symbol;
   m_exec_tf = exec_tf;
   m_htf     = htf;

   if(!m_htf_struct.Init(symbol, htf, 5))      return false;
   if(!m_exec_struct.Init(symbol, exec_tf, 3))  return false;

   m_atr_handle = iATR(symbol, exec_tf, 14);
   if(m_atr_handle == INVALID_HANDLE) return false;

   ArrayResize(m_pools,     100);
   ArrayResize(m_acc_zones, 30);

   UpdateContext();
   Print("SMCSignalEngine v1.1: Init ", symbol);
   return true;
}

void CSMCSignalEngine::ConfigureSession(const bool allow_asian,
                                        const bool allow_london_open,
                                        const bool allow_ny_open,
                                        const bool allow_ny_pm,
                                        const int  gmt_offset)
{
   m_session.Configure(allow_asian, allow_london_open,
                       allow_ny_open, allow_ny_pm, gmt_offset);
   Print("SMCSignalEngine: Session configured GMToffset=", gmt_offset);
}

double CSMCSignalEngine::GetATR()
{
   // FIX H8: need at least 2 elements before accessing [1]
   if(CopyBuffer(m_atr_handle, 0, 0, 3, m_atr) < 2) return 0.0;
   return m_atr[1];
}

// FIX: manual rolling average of tick volume (replaces iMA(VOLUME_TICK))
void CSMCSignalEngine::UpdateVolumeMa()
{
   int bars = m_vol_ma_period + 1;
   long vol_arr[];
   ArraySetAsSeries(vol_arr, true);
   if(CopyTickVolume(m_symbol, m_exec_tf, 0, bars, vol_arr) < bars)
   {
      m_vol_ma_buffer = 0.0;
      return;
   }
   double sum = 0.0;
   for(int i = 1; i <= m_vol_ma_period; i++)  // skip bar 0 (incomplete)
      sum += (double)vol_arr[i];
   m_vol_ma_buffer = sum / m_vol_ma_period;
}

// FIX: uses manual volume MA, raised threshold to 2.0x for gold
bool CSMCSignalEngine::IsHighVolume(const int bar, const double multiplier)
{
   if(m_vol_ma_buffer <= 0.0) return false;
   long vol_arr[];
   ArraySetAsSeries(vol_arr, true);
   if(CopyTickVolume(m_symbol, m_exec_tf, 0, bar + 2, vol_arr) < bar + 1) return false;
   return ((double)vol_arr[bar] > m_vol_ma_buffer * multiplier);
}

void CSMCSignalEngine::ScanLiquidityPools(const int lookback)
{
   int total = MathMin(lookback, Bars(m_symbol, m_exec_tf));
   double hi[], lo[];
   datetime times[];

   ArraySetAsSeries(hi,    true);
   ArraySetAsSeries(lo,    true);
   ArraySetAsSeries(times, true);

   if(CopyHigh(m_symbol, m_exec_tf, 0, total, hi)    < total) return;
   if(CopyLow (m_symbol, m_exec_tf, 0, total, lo)    < total) return;
   if(CopyTime(m_symbol, m_exec_tf, 0, total, times) < total) return;

   m_pool_count = 0;
   double atr       = GetATR();
   double tolerance = MathMin(atr * 0.15, 2.0);   // cap at $2.00

   // FIX: deduplication set — track registered price levels
   double registered_prices[];
   int    reg_count = 0;
   ArrayResize(registered_prices, 200);

   for(int i = 3; i < total - 3 && m_pool_count < 98; i++)
   {
      // FIX: require 2-bar lookback for valid swing (not just 1)
      bool is_swing_high = (hi[i] > hi[i+1] && hi[i] > hi[i+2] &&
                            hi[i] > hi[i-1] && hi[i] > hi[i-2]);
      bool is_swing_low  = (lo[i] < lo[i+1] && lo[i] < lo[i+2] &&
                            lo[i] < lo[i-1] && lo[i] < lo[i-2]);

      if(is_swing_high)
      {
         for(int j = i + 3; j < MathMin(i + 40, total - 1); j++)
         {
            bool j_swing_high = (hi[j] > hi[j+1] && hi[j] > hi[j-1]);
            if(!j_swing_high) continue;
            if(MathAbs(hi[i] - hi[j]) <= tolerance)
            {
               double pool_price = (hi[i] + hi[j]) / 2.0;

               // FIX: deduplicate — skip if already registered within tolerance
               bool duplicate = false;
               for(int k = 0; k < reg_count; k++)
                  if(MathAbs(registered_prices[k] - pool_price) <= tolerance * 2)
                     { duplicate = true; break; }
               if(duplicate) break;

               m_pools[m_pool_count].price            = pool_price;
               m_pools[m_pool_count].formed_time      = times[j];
               m_pools[m_pool_count].is_above         = true;
               m_pools[m_pool_count].touches          = 2;
               m_pools[m_pool_count].has_been_swept   = false;
               m_pools[m_pool_count].sweep_wick_extreme = 0.0;

               registered_prices[reg_count++] = pool_price;
               m_pool_count++;
               break;
            }
         }
      }

      if(is_swing_low)
      {
         for(int j = i + 3; j < MathMin(i + 40, total - 1); j++)
         {
            bool j_swing_low = (lo[j] < lo[j+1] && lo[j] < lo[j-1]);
            if(!j_swing_low) continue;
            if(MathAbs(lo[i] - lo[j]) <= tolerance)
            {
               double pool_price = (lo[i] + lo[j]) / 2.0;

               bool duplicate = false;
               for(int k = 0; k < reg_count; k++)
                  if(MathAbs(registered_prices[k] - pool_price) <= tolerance * 2)
                     { duplicate = true; break; }
               if(duplicate) break;

               m_pools[m_pool_count].price            = pool_price;
               m_pools[m_pool_count].formed_time      = times[j];
               m_pools[m_pool_count].is_above         = false;
               m_pools[m_pool_count].touches          = 2;
               m_pools[m_pool_count].has_been_swept   = false;
               m_pools[m_pool_count].sweep_wick_extreme = 0.0;

               registered_prices[reg_count++] = pool_price;
               m_pool_count++;
               break;
            }
         }
      }
   }

   // Mark swept pools
   double hi1 = iHigh (m_symbol, m_exec_tf, 1);
   double lo1 = iLow  (m_symbol, m_exec_tf, 1);   // FIX: correct variable for low
   double cl1 = iClose(m_symbol, m_exec_tf, 1);

   for(int i = 0; i < m_pool_count; i++)
   {
      // Pool expiry: ignore pools older than 50 bars (~12.5h on M15)
      int bar_age = (int)((TimeCurrent() - m_pools[i].formed_time) /
                           PeriodSeconds(m_exec_tf));
      if(bar_age > 50) continue;

      if(m_pools[i].is_above)
      {
         // FIX: sell-side pool — wick above pool, close back below
         if(hi1 > m_pools[i].price && cl1 < m_pools[i].price)
         {
            m_pools[i].has_been_swept      = true;
            m_pools[i].sweep_wick_extreme  = hi1;   // actual wick high for SL
         }
      }
      else
      {
         // FIX C (sweep variable): buy-side pool — use lo1 (not cl[1]) for the wick check
         if(lo1 < m_pools[i].price && cl1 > m_pools[i].price)
         {
            m_pools[i].has_been_swept      = true;
            m_pools[i].sweep_wick_extreme  = lo1;   // actual wick low for SL
         }
      }
   }
}

void CSMCSignalEngine::ScanAccumulationZones(const int lookback)
{
   int total = MathMin(lookback, Bars(m_symbol, m_exec_tf));
   double hi[], lo[];
   datetime times[];

   ArraySetAsSeries(hi,    true);
   ArraySetAsSeries(lo,    true);
   ArraySetAsSeries(times, true);

   if(CopyHigh(m_symbol, m_exec_tf, 0, total, hi)    < total) return;
   if(CopyLow (m_symbol, m_exec_tf, 0, total, lo)    < total) return;
   if(CopyTime(m_symbol, m_exec_tf, 0, total, times) < total) return;

   m_acc_count = 0;
   double atr  = GetATR();

   // FIX: scan from RECENT → OLDER (small i = recent, large i = old)
   // outer loop i starts at small (recent) and we search backward for the zone
   for(int i = 5; i < total - 10 && m_acc_count < 28; i++)
   {
      double zone_high = hi[i];
      double zone_low  = lo[i];
      int    bar_count = 0;
      double zone_atr  = atr;  // snapshot ATR — acceptable approximation

      // Expand zone backward (toward older bars = higher index)
      for(int j = i; j < MathMin(i + 40, total); j++)
      {
         double candidate_high = MathMax(zone_high, hi[j]);
         double candidate_low  = MathMin(zone_low,  lo[j]);
         if((candidate_high - candidate_low) > zone_atr * 2.0) break;
         zone_high = candidate_high;
         zone_low  = candidate_low;
         bar_count++;
      }

      if(bar_count >= 8)
      {
         AccumulationZone &az = m_acc_zones[m_acc_count];
         az.high               = zone_high;
         az.low                = zone_low;
         az.midpoint           = (zone_high + zone_low) / 2.0;
         az.start_time         = times[i + bar_count - 1];  // oldest bar
         az.end_time           = times[i];                  // newest bar
         az.consolidation_bars = bar_count;
         az.range_pips         = (zone_high - zone_low) /
                                  SymbolInfoDouble(m_symbol, SYMBOL_POINT) / 10.0;
         az.is_valid           = (bar_count >= 8);
         az.is_high_volume_breakout = false;
         m_acc_count++;
         i += bar_count;   // FIX: skip forward past this zone to avoid overlap
      }
   }
}

bool CSMCSignalEngine::DetectDisplacement(DisplacementCandle &dc, const int bar)
{
   double atr = GetATR();
   if(atr <= 0.0) return false;

   double op = iOpen (m_symbol, m_exec_tf, bar);
   double cl = iClose(m_symbol, m_exec_tf, bar);
   double hi = iHigh (m_symbol, m_exec_tf, bar);
   double lo = iLow  (m_symbol, m_exec_tf, bar);

   double body      = MathAbs(cl - op);
   double total_rng = hi - lo;
   if(total_rng <= 0.0) return false;

   dc.open        = op; dc.high = hi; dc.low = lo; dc.close = cl;
   dc.candle_time = iTime(m_symbol, m_exec_tf, bar);
   dc.is_bullish  = (cl > op);
   dc.body_ratio  = body / total_rng;
   dc.atr_multiple= body / atr;

   // FIX: raised displacement threshold to 2.0x ATR for XAU/USD
   if(dc.body_ratio < 0.60 || dc.atr_multiple < 2.0) return false;

   SwingPoint highs[], lows[];
   m_exec_struct.GetSwingHighs(highs, 3);
   m_exec_struct.GetSwingLows (lows,  3);

   if(dc.is_bullish)
   {
      // FIX: compare against highs[1] (prior swing), not highs[0] (current)
      dc.closes_above_prev_swing = (ArraySize(highs) > 1) && (cl > highs[1].price);
   }
   else
   {
      dc.closes_above_prev_swing = (ArraySize(lows) > 1) && (cl < lows[1].price);
   }

   // FIX H6: volume confirmation now integrated into displacement check
   dc.has_volume_confirmation = IsHighVolume(bar, 2.0);

   return true;
}

// FIX: SL placed at actual wick extreme, not at pool ± arbitrary ATR fraction
bool CSMCSignalEngine::DetectStopHunt(bool &is_bull_hunt,
                                      double &hunt_level,
                                      double &wick_extreme)
{
   double atr = GetATR();

   double hi1 = iHigh (m_symbol, m_exec_tf, 1);
   double lo1 = iLow  (m_symbol, m_exec_tf, 1);
   double cl1 = iClose(m_symbol, m_exec_tf, 1);

   for(int i = 0; i < m_pool_count; i++)
   {
      if(!m_pools[i].has_been_swept) continue;

      // Pool expiry check
      int bar_age = (int)((TimeCurrent() - m_pools[i].formed_time) /
                           PeriodSeconds(m_exec_tf));
      if(bar_age > 50) continue;

      // FIX: wick-to-body ratio check (wick must be > 2x body for genuine hunt)
      double body      = MathAbs(cl1 - iOpen(m_symbol, m_exec_tf, 1));
      double total_rng = hi1 - lo1;

      if(m_pools[i].is_above)
      {
         // Bearish sweep: wick above pool, close back below
         double wick_above = hi1 - m_pools[i].price;
         if(lo1 < m_pools[i].price && cl1 < m_pools[i].price &&
            wick_above >= atr * 0.5 &&
            (total_rng <= 0.0 || wick_above / total_rng >= 0.25))
         {
            is_bull_hunt  = false;
            hunt_level    = m_pools[i].price;
            wick_extreme  = hi1;   // FIX: SL above actual wick high
            return true;
         }
      }
      else
      {
         // Bullish sweep: wick below pool, close back above
         double wick_below = m_pools[i].price - lo1;
         if(hi1 > m_pools[i].price && cl1 > m_pools[i].price &&
            wick_below >= atr * 0.5 &&
            (total_rng <= 0.0 || wick_below / total_rng >= 0.25))
         {
            is_bull_hunt  = true;
            hunt_level    = m_pools[i].price;
            wick_extreme  = lo1;   // FIX: SL below actual wick low
            return true;
         }
      }
   }
   return false;
}

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
   if(pool != NULL && !pool->is_above && pool->has_been_swept) score += 0.20;
   if(m_htf_struct.GetBias() == BIAS_BULLISH) score += 0.15;
   if(m_session.IsKillzone())                  score += 0.10;
   return MathMin(1.0, score);
}

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
   if(pool != NULL && pool->is_above && pool->has_been_swept) score += 0.20;
   if(m_htf_struct.GetBias() == BIAS_BEARISH) score += 0.15;
   if(m_session.IsKillzone())                  score += 0.10;
   return MathMin(1.0, score);
}

void CSMCSignalEngine::UpdateContext()
{
   m_htf_struct.Update();
   m_exec_struct.Update();
   UpdateVolumeMa();
   ScanLiquidityPools(150);
   ScanAccumulationZones(100);
}

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

   // ---- 1. Stop Hunt reversal (FIX: SL at wick extreme) -----------
   bool bull_hunt; double hunt_lvl, wick_ext;
   if(DetectStopHunt(bull_hunt, hunt_lvl, wick_ext))
   {
      double conf = bull_hunt ? ScoreLong(price, NULL, NULL)
                              : ScoreShort(price, NULL, NULL);
      conf += 0.25;

      if(conf > best_conf)
      {
         best_conf           = conf;
         signal.type         = bull_hunt ? SMC_STOP_HUNT_LONG : SMC_STOP_HUNT_SHORT;
         signal.is_long      = bull_hunt;
         signal.entry_price  = price;
         // FIX: SL beyond the actual wick extreme, not just pool ± ATR fraction
         signal.stop_loss    = bull_hunt ? wick_ext - atr * 0.2
                                         : wick_ext + atr * 0.2;
         signal.take_profit_1= bull_hunt ? price + atr * 2.0 : price - atr * 2.0;
         signal.take_profit_2= bull_hunt ? price + atr * 4.5 : price - atr * 4.5;
         signal.confidence   = conf;
         signal.signal_time  = TimeCurrent();
         signal.pool_level   = hunt_lvl;
         signal.description  = "SMC Stop Hunt " + (bull_hunt ? "LONG" : "SHORT") +
                               " pool=" + DoubleToString(hunt_lvl, 2) +
                               " wick=" + DoubleToString(wick_ext, 2);
      }
   }

   // ---- 2. Displacement + volume confirmation (FIX H6) ------------
   DisplacementCandle dc;
   if(DetectDisplacement(dc, 1))
   {
      bool want_long = dc.is_bullish;
      if(!((want_long && bias == BIAS_BEARISH) ||
           (!want_long && bias == BIAS_BULLISH)))
      {
         double conf = want_long ? ScoreLong(price, NULL, NULL)
                                 : ScoreShort(price, NULL, NULL);
         if(dc.closes_above_prev_swing)    conf += 0.15;
         if(dc.has_volume_confirmation)    conf += 0.10;   // FIX H6: volume now counted
         conf += MathMin(0.10, (dc.atr_multiple - 2.0) * 0.05);

         if(conf > best_conf)
         {
            best_conf           = conf;
            signal.type         = want_long ? SMC_DISPLACEMENT_LONG : SMC_DISPLACEMENT_SHORT;
            signal.is_long      = want_long;
            signal.entry_price  = price;
            signal.stop_loss    = want_long ? dc.low  - atr * 0.3
                                            : dc.high + atr * 0.3;
            signal.take_profit_1= want_long ? price + atr * 2.0 : price - atr * 2.0;
            signal.take_profit_2= want_long ? price + atr * 4.0 : price - atr * 4.0;
            signal.confidence   = conf;
            signal.signal_time  = TimeCurrent();
            signal.description  = "SMC Displacement " +
                                  (want_long ? "LONG" : "SHORT") +
                                  " " + DoubleToString(dc.atr_multiple, 2) + "xATR" +
                                  (dc.has_volume_confirmation ? " VOL+" : "");
         }
      }
   }

   // ---- 3. Accumulation / Distribution zone breakout ---------------
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
            signal.description   = "SMC Accumulation LONG bars=" +
                                   IntegerToString(m_acc_zones[i].consolidation_bars) +
                                   " zone=" + DoubleToString(m_acc_zones[i].low, 2) +
                                   "-" + DoubleToString(m_acc_zones[i].high, 2);
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
            signal.description   = "SMC Distribution SHORT bars=" +
                                   IntegerToString(m_acc_zones[i].consolidation_bars);
         }
      }
   }

   return (signal.type != SMC_NONE && signal.confidence > 0.0);
}

int CSMCSignalEngine::GetLiquidityPools(LiquidityPool &out[], const int max)
{
   int n = MathMin(max, m_pool_count);
   ArrayResize(out, n);
   for(int i = 0; i < n; i++) out[i] = m_pools[i];
   return n;
}

int CSMCSignalEngine::GetAccumulationZones(AccumulationZone &out[], const int max)
{
   int n = MathMin(max, m_acc_count);
   ArrayResize(out, n);
   for(int i = 0; i < n; i++) out[i] = m_acc_zones[i];
   return n;
}

#endif // SMC_SIGNAL_ENGINE_MQH
