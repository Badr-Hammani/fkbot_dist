//+------------------------------------------------------------------+
//|  ICT_SignalEngine.mqh — Order Block, FVG, Liquidity & entry logic |
//|  v1.1 Fixes: OB zone (open-to-extreme), sweep polarity, breaker  |
//|              blocks, Silver Bullet path, FVG fill direction,      |
//|              GMT offset wired, CopyBuffer guard                   |
//+------------------------------------------------------------------+
#ifndef ICT_SIGNAL_ENGINE_MQH
#define ICT_SIGNAL_ENGINE_MQH

#include "../Shared/Utils/MarketStructure.mqh"
#include "../Shared/Utils/SessionFilter.mqh"

enum ENUM_ICT_SIGNAL
{
   ICT_NONE            = 0,
   ICT_OB_BULLISH      = 1,
   ICT_OB_BEARISH      = 2,
   ICT_FVG_BULL        = 3,
   ICT_FVG_BEAR        = 4,
   ICT_BREAKER_BULL    = 5,
   ICT_BREAKER_BEAR    = 6,
   ICT_SILVER_BULLET   = 7,
   ICT_LIQUIDITY_SWEEP = 8
};

struct OrderBlock
{
   double   ob_high;          // full candle high (for reference)
   double   ob_low;           // full candle low (for reference)
   double   zone_upper;       // FIX H1: entry zone upper (OB open for bull, OB high for bear)
   double   zone_lower;       // FIX H1: entry zone lower (OB low for bull, OB open for bear)
   datetime formed_time;
   bool     is_bullish;
   bool     is_mitigated;
   bool     is_breaker;       // FIX H2: OB that was violated → breaker block
   int      strength;         // 1–5
};

struct FairValueGap
{
   double   upper;
   double   lower;
   datetime formed_time;
   bool     is_bullish;
   bool     is_filled;
   double   fill_pct;
};

struct ICTSignal
{
   ENUM_ICT_SIGNAL type;
   bool            is_long;
   double          entry_price;
   double          stop_loss;
   double          take_profit_1;
   double          take_profit_2;
   double          confidence;
   datetime        signal_time;
   string          description;
};

//+------------------------------------------------------------------+
class CICTSignalEngine
{
private:
   string          m_symbol;
   ENUM_TIMEFRAMES m_exec_tf;
   ENUM_TIMEFRAMES m_htf;

   CMarketStructure m_htf_struct;
   CMarketStructure m_exec_struct;
   CSessionFilter   m_session;      // FIX A4: owned here, configured from EA

   OrderBlock  m_order_blocks[];
   int         m_ob_count;

   FairValueGap m_fvgs[];
   int          m_fvg_count;

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

   bool     DetectLiquiditySweep(bool &is_bullish_sweep, double &sweep_level);

   // FIX H3: Silver Bullet — now uses session filter's corrected NY time
   bool     IsSilverBulletWindow();

   int      m_atr_handle;
   double   m_atr[];
   double   GetCurrentATR();

public:
   CICTSignalEngine();
   ~CICTSignalEngine();

   bool     Init(const string symbol,
                 const ENUM_TIMEFRAMES exec_tf = PERIOD_M15,
                 const ENUM_TIMEFRAMES htf     = PERIOD_H4);

   // FIX A4: wire EA session inputs into the owned SessionFilter
   void     ConfigureSession(const bool allow_asian,
                             const bool allow_london_open,
                             const bool allow_ny_open,
                             const bool allow_ny_pm,
                             const int  gmt_offset);

   void     UpdateContext();
   bool     GetBestSignal(ICTSignal &signal);

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

CICTSignalEngine::~CICTSignalEngine()
{
   if(m_atr_handle != INVALID_HANDLE)
      IndicatorRelease(m_atr_handle);
}

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
   Print("ICTSignalEngine v1.1: Init ", symbol,
         " ExecTF=", EnumToString(exec_tf),
         " HTF=",    EnumToString(htf));
   return true;
}

// FIX A4: called from EA OnInit() to wire inputs into the owned session filter
void CICTSignalEngine::ConfigureSession(const bool allow_asian,
                                        const bool allow_london_open,
                                        const bool allow_ny_open,
                                        const bool allow_ny_pm,
                                        const int  gmt_offset)
{
   m_session.Configure(allow_asian, allow_london_open,
                       allow_ny_open, allow_ny_pm, gmt_offset);
   Print("ICTSignalEngine: Session configured — GMToffset=", gmt_offset,
         " London=", allow_london_open, " NY=", allow_ny_open);
}

// FIX H8: guard < 2 before accessing m_atr[1]
double CICTSignalEngine::GetCurrentATR()
{
   if(CopyBuffer(m_atr_handle, 0, 0, 3, m_atr) < 2) return 0.0;
   return m_atr[1];
}

bool CICTSignalEngine::IsImpulsiveMove(const int bar, const double hi[],
                                       const double lo[], const double close[])
{
   double atr = GetCurrentATR();
   if(atr <= 0.0) return false;
   return ((hi[bar] - lo[bar]) > atr * 1.5);
}

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
//  FIX H1 + H2: OB zone = open-to-low (bull demand) / open-to-high (bear supply)
//  FIX H2: marks breaker blocks when an OB is subsequently violated
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

   for(int i = 3; i < total - 5 && m_ob_count < 48; i++)
   {
      // FIX H1 (last opposing candle): ensure candle i is the LAST bearish before impulse
      // — i.e., candle i-1 must be the start of a bullish displacement
      // (no intervening bearish candles between i and the impulse)
      if(cl[i] < op[i])  // candidate bullish OB (bearish candle)
      {
         bool impulse_at_i1 = (cl[i-1] > op[i-1] && IsImpulsiveMove(i-1, hi, lo, cl));
         bool closes_above  = (cl[i-1] > hi[i]);   // impulse closes above OB high
         // Verify candle i is the last bearish candle (i-1 is bullish)
         bool is_last_opposing = (cl[i-1] > op[i-1]);

         if(impulse_at_i1 && closes_above && is_last_opposing)
         {
            OrderBlock &ob = m_order_blocks[m_ob_count];
            ob.ob_high      = hi[i];
            ob.ob_low       = lo[i];
            // FIX H1: demand OB zone = open down to low (the mitigation zone)
            ob.zone_upper   = op[i];
            ob.zone_lower   = lo[i];
            ob.formed_time  = times[i];
            ob.is_bullish   = true;
            ob.is_mitigated = false;
            ob.is_breaker   = false;
            ob.strength     = (int)MathRound(MeasureImpulseStrength(i, i-3, cl));
            m_ob_count++;
         }
      }
      else if(cl[i] > op[i])  // candidate bearish OB (bullish candle)
      {
         bool impulse_at_i1 = (cl[i-1] < op[i-1] && IsImpulsiveMove(i-1, hi, lo, cl));
         bool closes_below  = (cl[i-1] < lo[i]);
         bool is_last_opposing = (cl[i-1] < op[i-1]);

         if(impulse_at_i1 && closes_below && is_last_opposing)
         {
            OrderBlock &ob = m_order_blocks[m_ob_count];
            ob.ob_high      = hi[i];
            ob.ob_low       = lo[i];
            // FIX H1: supply OB zone = open up to high (the mitigation zone)
            ob.zone_upper   = hi[i];
            ob.zone_lower   = op[i];
            ob.formed_time  = times[i];
            ob.is_bullish   = false;
            ob.is_mitigated = false;
            ob.is_breaker   = false;
            ob.strength     = (int)MathRound(MeasureImpulseStrength(i, i-3, cl));
            m_ob_count++;
         }
      }
   }

   double current_price = iClose(m_symbol, m_exec_tf, 1);

   for(int i = 0; i < m_ob_count; i++)
   {
      OrderBlock &ob = m_order_blocks[i];

      // Mitigated: price returned to the zone
      if(current_price >= ob.zone_lower && current_price <= ob.zone_upper)
         ob.is_mitigated = true;

      // FIX H2: BREAKER BLOCK detection — OB that price violated beyond its origin
      // Bullish OB violated when price closes below the OB low → becomes bearish breaker
      if(ob.is_bullish && current_price < ob.ob_low)
         ob.is_breaker = true;
      // Bearish OB violated when price closes above the OB high → becomes bullish breaker
      if(!ob.is_bullish && current_price > ob.ob_high)
         ob.is_breaker = true;
   }
}

//+------------------------------------------------------------------+
// FIX H4: corrected fill_pct direction for bullish FVG
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
      // Bullish FVG: gap between older candle high (i+1) and newer candle low (i-1)
      if(lo[i-1] > hi[i+1])
      {
         FairValueGap &fvg = m_fvgs[m_fvg_count];
         fvg.upper       = lo[i-1];   // top of gap (newer low)
         fvg.lower       = hi[i+1];   // bottom of gap (older high)
         fvg.formed_time = times[i];
         fvg.is_bullish  = true;
         fvg.is_filled   = false;
         fvg.fill_pct    = 0.0;
         m_fvg_count++;
      }
      // Bearish FVG
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

   double cp = iClose(m_symbol, m_exec_tf, 1);
   for(int i = 0; i < m_fvg_count; i++)
   {
      double gap = m_fvgs[i].upper - m_fvgs[i].lower;
      if(gap <= 0.0) continue;
      // FIX H4: bullish fill = how far price has ENTERED the gap from below
      // fill_pct=0 when cp==lower (just touched), 1 when cp==upper (fully filled)
      if(m_fvgs[i].is_bullish)
         m_fvgs[i].fill_pct = MathMax(0.0, MathMin(1.0,
                              (cp - m_fvgs[i].lower) / gap));
      else
         m_fvgs[i].fill_pct = MathMax(0.0, MathMin(1.0,
                              (m_fvgs[i].upper - cp) / gap));

      if(m_fvgs[i].fill_pct >= 0.5) m_fvgs[i].is_filled = true;
   }
}

//+------------------------------------------------------------------+
// FIX C1: sweep POLARITY corrected
// Bullish stop hunt (sweep below prior lows) → SHORT signal (smart money sells above)
// Bearish stop hunt (sweep above prior highs) → LONG signal (smart money buys back)
//+------------------------------------------------------------------+
bool CICTSignalEngine::DetectLiquiditySweep(bool &want_long,
                                             double &sweep_level)
{
   SwingPoint highs[], lows[];
   m_exec_struct.GetSwingHighs(highs, 5);   // check more swing points for EQH
   m_exec_struct.GetSwingLows (lows,  5);

   double hi1 = iHigh (m_symbol, m_exec_tf, 1);
   double lo1 = iLow  (m_symbol, m_exec_tf, 1);
   double cl1 = iClose(m_symbol, m_exec_tf, 1);

   // Price wicks ABOVE prior high then closes BACK BELOW it
   // = buy-side liquidity swept = SELL signal (ICT: smart money used buystops to sell)
   for(int i = 0; i < ArraySize(highs); i++)
   {
      if(hi1 > highs[i].price && cl1 < highs[i].price)
      {
         want_long   = false;        // FIX C1: sweep above highs → SHORT
         sweep_level = highs[i].price;
         return true;
      }
   }

   // Price wicks BELOW prior low then closes BACK ABOVE it
   // = sell-side liquidity swept = BUY signal (ICT: smart money used sellstops to buy)
   for(int i = 0; i < ArraySize(lows); i++)
   {
      if(lo1 < lows[i].price && cl1 > lows[i].price)
      {
         want_long   = true;         // FIX C1: sweep below lows → LONG
         sweep_level = lows[i].price;
         return true;
      }
   }
   return false;
}

//+------------------------------------------------------------------+
// FIX H3 + C2: uses session filter's corrected NY hour
//+------------------------------------------------------------------+
bool CICTSignalEngine::IsSilverBulletWindow()
{
   int h = m_session.GetCurrentNYHour();
   int m = m_session.GetCurrentNYMinute();
   // ICT Silver Bullet: 09:30–10:00 NY and 14:00–14:30 NY
   return ((h == 9 && m >= 30) || (h == 10 && m == 0) ||
           (h == 14 && m < 30));
}

bool CICTSignalEngine::IsValidOBEntry(const OrderBlock &ob,
                                      const double current_price,
                                      const bool want_long)
{
   if(ob.is_mitigated) return false;

   // Breaker blocks trade in OPPOSITE direction to original OB
   if(ob.is_breaker)
   {
      // Bullish OB violated → bearish breaker (want_long must be false)
      if(ob.is_bullish  && want_long)  return false;
      if(!ob.is_bullish && !want_long) return false;
      // Entry inside the original OB's zone (now acting as supply/demand flip)
      return (current_price >= ob.zone_lower && current_price <= ob.zone_upper);
   }

   if(want_long  && !ob.is_bullish) return false;
   if(!want_long &&  ob.is_bullish) return false;

   return (current_price >= ob.zone_lower && current_price <= ob.zone_upper);
}

double CICTSignalEngine::CalcOBConfidence(const OrderBlock &ob,
                                          const ENUM_MARKET_BIAS htf_bias)
{
   double conf = 0.40;
   if((ob.is_bullish && htf_bias == BIAS_BULLISH) ||
      (!ob.is_bullish && htf_bias == BIAS_BEARISH)) conf += 0.25;
   if(ob.is_breaker)   conf += 0.10;   // breaker blocks add confluence
   conf += (double)MathMin(ob.strength, 5) * 0.05;
   if(m_session.IsKillzone()) conf += 0.10;
   return MathMin(1.0, conf);
}

void CICTSignalEngine::UpdateContext()
{
   m_htf_struct.Update();
   m_exec_struct.Update();
   ScanOrderBlocks(200);
   ScanFairValueGaps(100);
}

bool CICTSignalEngine::GetBestSignal(ICTSignal &signal)
{
   signal.type       = ICT_NONE;
   signal.confidence = 0.0;

   if(!m_session.IsTradingSession()) return false;

   double price = iClose(m_symbol, m_exec_tf, 1);
   double atr   = GetCurrentATR();
   if(atr <= 0.0) return false;

   ENUM_MARKET_BIAS htf_bias = m_htf_struct.GetBias();
   double best_conf = 0.0;

   // ---- 1. Order Block (including breaker blocks) ------------------
   for(int i = 0; i < m_ob_count; i++)
   {
      bool want_long;
      if(m_order_blocks[i].is_breaker)
         want_long = !m_order_blocks[i].is_bullish;  // violated bull OB → short
      else
         want_long = (htf_bias == BIAS_BULLISH);

      if(!IsValidOBEntry(m_order_blocks[i], price, want_long)) continue;

      double conf = CalcOBConfidence(m_order_blocks[i], htf_bias);
      if(conf > best_conf)
      {
         best_conf         = conf;
         signal.type       = m_order_blocks[i].is_breaker
                             ? (want_long ? ICT_BREAKER_BULL : ICT_BREAKER_BEAR)
                             : (want_long ? ICT_OB_BULLISH   : ICT_OB_BEARISH);
         signal.is_long    = want_long;
         signal.entry_price = price;
         // SL below OB low (bull) or above OB high (bear)
         signal.stop_loss  = want_long
                             ? m_order_blocks[i].ob_low  - atr * 0.3
                             : m_order_blocks[i].ob_high + atr * 0.3;
         signal.take_profit_1 = want_long ? price + atr * 2.0 : price - atr * 2.0;
         signal.take_profit_2 = want_long ? price + atr * 4.0 : price - atr * 4.0;
         signal.confidence = conf;
         signal.signal_time = TimeCurrent();
         signal.description = (m_order_blocks[i].is_breaker ? "ICT Breaker " : "ICT OB ") +
                              (want_long ? "BULL" : "BEAR") +
                              " str=" + IntegerToString(m_order_blocks[i].strength);
      }
   }

   // ---- 2. FVG setups -----------------------------------------------
   for(int i = 0; i < m_fvg_count; i++)
   {
      if(m_fvgs[i].is_filled) continue;
      bool want_long = m_fvgs[i].is_bullish;

      if((want_long && htf_bias == BIAS_BEARISH) ||
         (!want_long && htf_bias == BIAS_BULLISH)) continue;

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
         signal.take_profit_1 = want_long ? price + atr * 2.0 : price - atr * 2.0;
         signal.take_profit_2 = want_long ? price + atr * 4.0 : price - atr * 4.0;
         signal.confidence = conf;
         signal.signal_time = TimeCurrent();
         signal.description = "ICT FVG " + (want_long ? "BULL" : "BEAR") +
                              " fill=" + DoubleToString(m_fvgs[i].fill_pct * 100, 1) + "%";
      }
   }

   // ---- 3. Liquidity Sweep + Reversal (FIX C1: polarity corrected) -
   bool sweep_long; double sweep_lvl;
   if(DetectLiquiditySweep(sweep_long, sweep_lvl))
   {
      double conf = 0.65 + (m_session.IsKillzone() ? 0.15 : 0.0);
      if(conf > best_conf)
      {
         best_conf         = conf;
         signal.type       = ICT_LIQUIDITY_SWEEP;
         signal.is_long    = sweep_long;
         signal.entry_price = price;
         signal.stop_loss  = sweep_long
                            ? sweep_lvl - atr * 0.5
                            : sweep_lvl + atr * 0.5;
         signal.take_profit_1 = sweep_long ? price + atr * 2.0 : price - atr * 2.0;
         signal.take_profit_2 = sweep_long ? price + atr * 4.5 : price - atr * 4.5;
         signal.confidence = conf;
         signal.signal_time = TimeCurrent();
         signal.description = "ICT Liquidity Sweep " +
                             (sweep_long ? "LONG" : "SHORT") +
                             " @ " + DoubleToString(sweep_lvl, 2);
      }
   }

   // ---- 4. Silver Bullet (FIX H3: now actually generates the signal) -
   if(IsSilverBulletWindow())
   {
      // Silver Bullet requires a FVG to enter within the killzone window
      for(int i = 0; i < m_fvg_count; i++)
      {
         if(m_fvgs[i].is_filled) continue;
         bool want_long = m_fvgs[i].is_bullish;
         if((want_long && htf_bias == BIAS_BEARISH) ||
            (!want_long && htf_bias == BIAS_BULLISH)) continue;

         bool in_fvg = (price >= m_fvgs[i].lower && price <= m_fvgs[i].upper);
         if(!in_fvg) continue;

         double conf = 0.72;  // Silver Bullet + FVG in killzone = high priority
         if(conf > best_conf)
         {
            best_conf         = conf;
            signal.type       = ICT_SILVER_BULLET;
            signal.is_long    = want_long;
            signal.entry_price = price;
            signal.stop_loss  = want_long
                               ? m_fvgs[i].lower - atr * 0.5
                               : m_fvgs[i].upper + atr * 0.5;
            signal.take_profit_1 = want_long ? price + atr * 2.5 : price - atr * 2.5;
            signal.take_profit_2 = want_long ? price + atr * 5.0 : price - atr * 5.0;
            signal.confidence = conf;
            signal.signal_time = TimeCurrent();
            signal.description = "ICT Silver Bullet FVG " +
                                 (want_long ? "LONG" : "SHORT") +
                                 " @ NY " + IntegerToString(m_session.GetCurrentNYHour()) +
                                 ":" + IntegerToString(m_session.GetCurrentNYMinute());
         }
      }
   }

   return (signal.type != ICT_NONE && signal.confidence > 0.0);
}

int CICTSignalEngine::GetOrderBlocks(OrderBlock &out[], const int max)
{
   int n = MathMin(max, m_ob_count);
   ArrayResize(out, n);
   for(int i = 0; i < n; i++) out[i] = m_order_blocks[i];
   return n;
}

int CICTSignalEngine::GetFairValueGaps(FairValueGap &out[], const int max)
{
   int n = MathMin(max, m_fvg_count);
   ArrayResize(out, n);
   for(int i = 0; i < n; i++) out[i] = m_fvgs[i];
   return n;
}

#endif // ICT_SIGNAL_ENGINE_MQH
