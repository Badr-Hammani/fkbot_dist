//+------------------------------------------------------------------+
//|  ICT_SignalEngine.mqh — Order Block, FVG, Liquidity & entry logic |
//|  Implements full ICT methodology for XAU/USD                      |
//+------------------------------------------------------------------+
#ifndef ICT_SIGNAL_ENGINE_MQH
#define ICT_SIGNAL_ENGINE_MQH

#include "../Shared/Utils/MarketStructure.mqh"
#include "../Shared/Utils/SessionFilter.mqh"

//--- ICT-specific signal types (used by AdaptiveLearning)
enum ENUM_ICT_SIGNAL
{
   ICT_NONE            = 0,
   ICT_OB_BULLISH      = 1,  // Bullish Order Block entry
   ICT_OB_BEARISH      = 2,  // Bearish Order Block entry
   ICT_FVG_BULL        = 3,  // Fair Value Gap fill (long)
   ICT_FVG_BEAR        = 4,  // Fair Value Gap fill (short)
   ICT_BREAKER_BULL    = 5,  // Breaker block long
   ICT_BREAKER_BEAR    = 6,  // Breaker block short
   ICT_SILVER_BULLET   = 7,  // Silver Bullet setup
   ICT_LIQUIDITY_SWEEP = 8   // Stop hunt + reversal
};

struct OrderBlock
{
   double   high;
   double   low;
   datetime formed_time;
   bool     is_bullish;   // true = demand OB, false = supply OB
   bool     is_mitigated; // price has returned to OB
   bool     is_breaker;   // OB that was violated → becomes breaker
   int      strength;     // 1–5 based on impulse size & volume proxy
};

struct FairValueGap
{
   double   upper;
   double   lower;
   datetime formed_time;
   bool     is_bullish;
   bool     is_filled;
   double   fill_pct;    // 0.0–1.0 how much of gap has been covered
};

struct ICTSignal
{
   ENUM_ICT_SIGNAL type;
   bool            is_long;
   double          entry_price;
   double          stop_loss;
   double          take_profit_1;   // 1:1 or OB target
   double          take_profit_2;   // full PD array target
   double          confidence;      // 0.0–1.0
   datetime        signal_time;
   string          description;
};

//+------------------------------------------------------------------+
class CICTSignalEngine
{
private:
   string          m_symbol;
   ENUM_TIMEFRAMES m_exec_tf;   // execution (e.g. M5/M15)
   ENUM_TIMEFRAMES m_htf;       // higher timeframe bias (H4/D1)

   CMarketStructure m_htf_struct;
   CMarketStructure m_exec_struct;
   CSessionFilter   m_session;

   OrderBlock  m_order_blocks[];
   int         m_ob_count;

   FairValueGap m_fvgs[];
   int          m_fvg_count;

   //--- Detection helpers
   void     ScanOrderBlocks(const int lookback = 200);
   void     ScanFairValueGaps(const int lookback = 100);
   bool     IsImpulsiveMove(const int bar, const double hi[],
                            const double lo[], const double close[]);
   double   MeasureImpulseStrength(const int bar_start, const int bar_end,
                                   const double close[]);
   bool     IsValidOBEntry(const OrderBlock &ob, const double current_price,
                           const bool want_long);
   double   CalcOBConfidence(const OrderBlock &ob,
                             const ENUM_MARKET_BIAS htf_bias);

   //--- Liquidity sweep
   bool     DetectLiquiditySweep(bool &is_bullish_sweep,
                                  double &sweep_level);

   //--- Silver Bullet (09:30–10:00, 14:00–14:30 NY)
   bool     IsSilverBulletWindow();

   //--- ATR for internal stop placement
   int      m_atr_handle;
   double   m_atr[];
   double   GetCurrentATR();

public:
   CICTSignalEngine();
   ~CICTSignalEngine();

   bool     Init(const string symbol,
                 const ENUM_TIMEFRAMES exec_tf = PERIOD_M15,
                 const ENUM_TIMEFRAMES htf     = PERIOD_H4);

   //--- Call on each new bar
   void     UpdateContext();

   //--- Primary entry point: scan all ICT setups and return best signal
   bool     GetBestSignal(ICTSignal &signal);

   //--- Individual scanner queries (for dashboard / debug)
   int      GetOrderBlocks(OrderBlock &out[], const int max = 10);
   int      GetFairValueGaps(FairValueGap &out[], const int max = 10);

   ENUM_MARKET_BIAS GetHTFBias() { return m_htf_struct.GetBias(); }
};

//+------------------------------------------------------------------+
CICTSignalEngine::CICTSignalEngine()
   : m_ob_count(0), m_fvg_count(0), m_atr_handle(INVALID_HANDLE)
{
   ArraySetAsSeries(m_atr, true);
}

//+------------------------------------------------------------------+
CICTSignalEngine::~CICTSignalEngine()
{
   if(m_atr_handle != INVALID_HANDLE)
      IndicatorRelease(m_atr_handle);
}

//+------------------------------------------------------------------+
bool CICTSignalEngine::Init(const string symbol,
                            const ENUM_TIMEFRAMES exec_tf,
                            const ENUM_TIMEFRAMES htf)
{
   m_symbol  = symbol;
   m_exec_tf = exec_tf;
   m_htf     = htf;

   if(!m_htf_struct.Init(symbol, htf,  5)) return false;
   if(!m_exec_struct.Init(symbol, exec_tf, 3)) return false;

   m_atr_handle = iATR(symbol, exec_tf, 14);
   if(m_atr_handle == INVALID_HANDLE) return false;

   ArrayResize(m_order_blocks, 50);
   ArrayResize(m_fvgs,         50);

   UpdateContext();
   Print("ICTSignalEngine: Initialised on ", symbol,
         " | ExecTF=", EnumToString(exec_tf),
         " | HTF=",    EnumToString(htf));
   return true;
}

//+------------------------------------------------------------------+
double CICTSignalEngine::GetCurrentATR()
{
   if(CopyBuffer(m_atr_handle, 0, 0, 3, m_atr) < 1) return 0.0;
   return m_atr[1];
}

//+------------------------------------------------------------------+
bool CICTSignalEngine::IsImpulsiveMove(const int bar, const double hi[],
                                       const double lo[], const double close[])
{
   double atr = GetCurrentATR();
   if(atr <= 0.0) return false;
   double candle_range = hi[bar] - lo[bar];
   return (candle_range > atr * 1.5);  // body > 1.5x ATR = impulse
}

//+------------------------------------------------------------------+
double CICTSignalEngine::MeasureImpulseStrength(const int bar_start,
                                                 const int bar_end,
                                                 const double close[])
{
   if(bar_end <= bar_start) return 0.0;
   double total_move = MathAbs(close[bar_start] - close[bar_end]);
   double atr = GetCurrentATR();
   if(atr <= 0.0) return 0.0;
   return MathMin(5.0, total_move / atr);
}

//+------------------------------------------------------------------+
void CICTSignalEngine::ScanOrderBlocks(const int lookback)
{
   int total = MathMin(lookback, Bars(m_symbol, m_exec_tf));
   double hi[], lo[], op[], cl[];
   datetime times[];

   ArraySetAsSeries(hi,    true);
   ArraySetAsSeries(lo,    true);
   ArraySetAsSeries(op,    true);
   ArraySetAsSeries(cl,    true);
   ArraySetAsSeries(times, true);

   if(CopyHigh (m_symbol, m_exec_tf, 0, total, hi)    < total) return;
   if(CopyLow  (m_symbol, m_exec_tf, 0, total, lo)    < total) return;
   if(CopyOpen (m_symbol, m_exec_tf, 0, total, op)    < total) return;
   if(CopyClose(m_symbol, m_exec_tf, 0, total, cl)    < total) return;
   if(CopyTime (m_symbol, m_exec_tf, 0, total, times) < total) return;

   m_ob_count = 0;

   for(int i = 3; i < total - 3 && m_ob_count < 48; i++)
   {
      //--- Bullish OB: last bearish candle before a strong up-impulse
      if(cl[i] < op[i])  // bearish candle at index i
      {
         //--- Check if followed by bullish impulse (bars i-1, i-2)
         if(cl[i-1] > op[i-1] && IsImpulsiveMove(i-1, hi, lo, cl) &&
            cl[i-1] > hi[i])  // impulse closes above OB high
         {
            OrderBlock &ob = m_order_blocks[m_ob_count];
            ob.high         = hi[i];
            ob.low          = lo[i];
            ob.formed_time  = times[i];
            ob.is_bullish   = true;
            ob.is_mitigated = false;
            ob.is_breaker   = false;
            ob.strength     = (int)MathRound(MeasureImpulseStrength(i, i-3, cl));
            m_ob_count++;
         }
      }
      //--- Bearish OB: last bullish candle before a strong down-impulse
      else if(cl[i] > op[i])  // bullish candle
      {
         if(cl[i-1] < op[i-1] && IsImpulsiveMove(i-1, hi, lo, cl) &&
            cl[i-1] < lo[i])
         {
            OrderBlock &ob = m_order_blocks[m_ob_count];
            ob.high         = hi[i];
            ob.low          = lo[i];
            ob.formed_time  = times[i];
            ob.is_bullish   = false;
            ob.is_mitigated = false;
            ob.is_breaker   = false;
            ob.strength     = (int)MathRound(MeasureImpulseStrength(i, i-3, cl));
            m_ob_count++;
         }
      }
   }

   //--- Mark mitigated OBs (price returned to the OB zone)
   double current_price = iClose(m_symbol, m_exec_tf, 1);
   for(int i = 0; i < m_ob_count; i++)
   {
      if(m_order_blocks[i].is_bullish &&
         current_price <= m_order_blocks[i].high &&
         current_price >= m_order_blocks[i].low)
         m_order_blocks[i].is_mitigated = true;

      if(!m_order_blocks[i].is_bullish &&
         current_price >= m_order_blocks[i].low &&
         current_price <= m_order_blocks[i].high)
         m_order_blocks[i].is_mitigated = true;
   }
}

//+------------------------------------------------------------------+
void CICTSignalEngine::ScanFairValueGaps(const int lookback)
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

   m_fvg_count = 0;

   for(int i = 2; i < total - 1 && m_fvg_count < 48; i++)
   {
      //--- Bullish FVG: lo[i-1] > hi[i+1]  (gap between candle[i+1] high and candle[i-1] low)
      if(lo[i-1] > hi[i+1])
      {
         FairValueGap &fvg = m_fvgs[m_fvg_count];
         fvg.upper       = lo[i-1];
         fvg.lower       = hi[i+1];
         fvg.formed_time = times[i];
         fvg.is_bullish  = true;
         fvg.is_filled   = false;
         fvg.fill_pct    = 0.0;
         m_fvg_count++;
      }
      //--- Bearish FVG: hi[i-1] < lo[i+1]
      else if(hi[i-1] < lo[i+1])
      {
         FairValueGap &fvg = m_fvgs[m_fvg_count];
         fvg.upper       = lo[i+1];
         fvg.lower       = hi[i-1];
         fvg.formed_time = times[i];
         fvg.is_bullish  = false;
         fvg.is_filled   = false;
         fvg.fill_pct    = 0.0;
         m_fvg_count++;
      }
   }

   //--- Update fill percentage
   double cp = iClose(m_symbol, m_exec_tf, 1);
   for(int i = 0; i < m_fvg_count; i++)
   {
      double gap = m_fvgs[i].upper - m_fvgs[i].lower;
      if(gap <= 0.0) continue;
      if(m_fvgs[i].is_bullish)
         m_fvgs[i].fill_pct = MathMax(0.0, MathMin(1.0,
                              (m_fvgs[i].upper - cp) / gap));
      else
         m_fvgs[i].fill_pct = MathMax(0.0, MathMin(1.0,
                              (cp - m_fvgs[i].lower) / gap));
      if(m_fvgs[i].fill_pct >= 0.5) m_fvgs[i].is_filled = true;
   }
}

//+------------------------------------------------------------------+
bool CICTSignalEngine::DetectLiquiditySweep(bool &is_bullish_sweep,
                                             double &sweep_level)
{
   //--- A sweep occurs when price wicks through a prior swing high/low
   //--- then rapidly reverses with a strong close back inside range.
   SwingPoint highs[], lows[];
   m_exec_struct.GetSwingHighs(highs, 3);
   m_exec_struct.GetSwingLows (lows,  3);

   double cl1 = iClose(m_symbol, m_exec_tf, 1);
   double hi1 = iHigh (m_symbol, m_exec_tf, 1);
   double lo1 = iLow  (m_symbol, m_exec_tf, 1);

   //--- Bearish sweep: wick above prior high, close back below it
   for(int i = 0; i < ArraySize(highs); i++)
   {
      if(hi1 > highs[i].price && cl1 < highs[i].price)
      {
         is_bullish_sweep = false;
         sweep_level      = highs[i].price;
         return true;
      }
   }

   //--- Bullish sweep: wick below prior low, close back above it
   for(int i = 0; i < ArraySize(lows); i++)
   {
      if(lo1 < lows[i].price && cl1 > lows[i].price)
      {
         is_bullish_sweep = true;
         sweep_level      = lows[i].price;
         return true;
      }
   }
   return false;
}

//+------------------------------------------------------------------+
bool CICTSignalEngine::IsSilverBulletWindow()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   int h = dt.hour, m = dt.min;
   //--- 09:30–10:00 or 14:00–14:30 NY time
   //--- Simplified: check server hour (caller adjusts for TZ)
   return ((h == 9 && m >= 30) || (h == 14 && m < 30));
}

//+------------------------------------------------------------------+
bool CICTSignalEngine::IsValidOBEntry(const OrderBlock &ob,
                                      const double current_price,
                                      const bool want_long)
{
   if(ob.is_mitigated || ob.is_breaker) return false;
   if(want_long  && !ob.is_bullish)     return false;
   if(!want_long &&  ob.is_bullish)     return false;

   //--- Price must be inside the OB zone
   if(want_long)
      return (current_price >= ob.low && current_price <= ob.high);
   else
      return (current_price <= ob.high && current_price >= ob.low);
}

//+------------------------------------------------------------------+
double CICTSignalEngine::CalcOBConfidence(const OrderBlock &ob,
                                          const ENUM_MARKET_BIAS htf_bias)
{
   double conf = 0.40;  // base confidence

   //--- Align with HTF bias
   if((ob.is_bullish && htf_bias == BIAS_BULLISH) ||
      (!ob.is_bullish && htf_bias == BIAS_BEARISH))
      conf += 0.25;

   //--- OB strength 1–5
   conf += (double)ob.strength * 0.05;

   //--- Session alignment (killzone = bonus)
   if(m_session.IsKillzone()) conf += 0.10;

   return MathMin(1.0, conf);
}

//+------------------------------------------------------------------+
void CICTSignalEngine::UpdateContext()
{
   m_htf_struct.Update();
   m_exec_struct.Update();
   ScanOrderBlocks(200);
   ScanFairValueGaps(100);
}

//+------------------------------------------------------------------+
bool CICTSignalEngine::GetBestSignal(ICTSignal &signal)
{
   signal.type       = ICT_NONE;
   signal.confidence = 0.0;

   if(!m_session.IsTradingSession()) return false;

   double price      = iClose(m_symbol, m_exec_tf, 1);
   double atr        = GetCurrentATR();
   if(atr <= 0.0) return false;

   ENUM_MARKET_BIAS htf_bias = m_htf_struct.GetBias();
   double best_conf  = 0.0;

   //--- 1. Order Block setups ----------------------------------------
   for(int i = 0; i < m_ob_count; i++)
   {
      bool want_long = (htf_bias == BIAS_BULLISH);
      if(!IsValidOBEntry(m_order_blocks[i], price, want_long)) continue;

      double conf = CalcOBConfidence(m_order_blocks[i], htf_bias);
      if(conf > best_conf)
      {
         best_conf         = conf;
         signal.type       = want_long ? ICT_OB_BULLISH : ICT_OB_BEARISH;
         signal.is_long    = want_long;
         signal.entry_price = price;
         signal.stop_loss  = want_long
                             ? m_order_blocks[i].low  - atr * 0.3
                             : m_order_blocks[i].high + atr * 0.3;
         signal.take_profit_1 = want_long
                             ? price + atr * 1.5
                             : price - atr * 1.5;
         signal.take_profit_2 = want_long
                             ? price + atr * 3.0
                             : price - atr * 3.0;
         signal.confidence = conf;
         signal.signal_time = TimeCurrent();
         signal.description = "ICT Order Block (" +
                              (want_long ? "BULL" : "BEAR") + ") strength=" +
                              IntegerToString(m_order_blocks[i].strength);
      }
   }

   //--- 2. FVG setups -----------------------------------------------
   for(int i = 0; i < m_fvg_count; i++)
   {
      if(m_fvgs[i].is_filled) continue;
      bool want_long = m_fvgs[i].is_bullish;

      //--- Must align with HTF bias
      if((want_long && htf_bias == BIAS_BEARISH) ||
         (!want_long && htf_bias == BIAS_BULLISH)) continue;

      //--- Price entering FVG zone
      bool in_fvg = (price >= m_fvgs[i].lower && price <= m_fvgs[i].upper);
      if(!in_fvg) continue;

      double conf = 0.50 + (m_session.IsKillzone() ? 0.15 : 0.0);
      if(conf > best_conf)
      {
         best_conf         = conf;
         signal.type       = want_long ? ICT_FVG_BULL : ICT_FVG_BEAR;
         signal.is_long    = want_long;
         signal.entry_price = price;
         signal.stop_loss  = want_long
                             ? m_fvgs[i].lower - atr * 0.5
                             : m_fvgs[i].upper + atr * 0.5;
         signal.take_profit_1 = want_long
                             ? price + atr * 2.0
                             : price - atr * 2.0;
         signal.take_profit_2 = want_long
                             ? price + atr * 4.0
                             : price - atr * 4.0;
         signal.confidence = conf;
         signal.signal_time = TimeCurrent();
         signal.description = "ICT Fair Value Gap (" +
                              (want_long ? "BULL" : "BEAR") + ") fill=" +
                              DoubleToString(m_fvgs[i].fill_pct * 100, 1) + "%";
      }
   }

   //--- 3. Liquidity Sweep + Reversal --------------------------------
   bool sweep_bull;
   double sweep_lvl;
   if(DetectLiquiditySweep(sweep_bull, sweep_lvl))
   {
      bool want_long = sweep_bull;
      if((want_long && htf_bias != BIAS_BEARISH) ||
         (!want_long && htf_bias != BIAS_BULLISH))
      {
         double conf = 0.65 + (m_session.IsKillzone() ? 0.15 : 0.0);
         if(conf > best_conf)
         {
            best_conf         = conf;
            signal.type       = ICT_LIQUIDITY_SWEEP;
            signal.is_long    = want_long;
            signal.entry_price = price;
            signal.stop_loss  = want_long
                               ? sweep_lvl - atr * 0.5
                               : sweep_lvl + atr * 0.5;
            signal.take_profit_1 = want_long
                               ? price + atr * 2.0
                               : price - atr * 2.0;
            signal.take_profit_2 = want_long
                               ? price + atr * 4.5
                               : price - atr * 4.5;
            signal.confidence = conf;
            signal.signal_time = TimeCurrent();
            signal.description = "ICT Liquidity Sweep " +
                                 (want_long ? "BULLISH" : "BEARISH") +
                                 " @ " + DoubleToString(sweep_lvl, 2);
         }
      }
   }

   return (signal.type != ICT_NONE && signal.confidence > 0.0);
}

//+------------------------------------------------------------------+
int CICTSignalEngine::GetOrderBlocks(OrderBlock &out[], const int max)
{
   int n = MathMin(max, m_ob_count);
   ArrayResize(out, n);
   for(int i = 0; i < n; i++) out[i] = m_order_blocks[i];
   return n;
}

//+------------------------------------------------------------------+
int CICTSignalEngine::GetFairValueGaps(FairValueGap &out[], const int max)
{
   int n = MathMin(max, m_fvg_count);
   ArrayResize(out, n);
   for(int i = 0; i < n; i++) out[i] = m_fvgs[i];
   return n;
}

#endif // ICT_SIGNAL_ENGINE_MQH
