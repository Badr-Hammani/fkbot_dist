//+------------------------------------------------------------------+
//|  MarketStructure.mqh — Swing high/low detection, BOS, CHoCH,     |
//|  trend bias, and Higher-Timeframe structure used by both EAs      |
//+------------------------------------------------------------------+
#ifndef MARKET_STRUCTURE_MQH
#define MARKET_STRUCTURE_MQH

enum ENUM_MARKET_BIAS
{
   BIAS_BULLISH  =  1,
   BIAS_BEARISH  = -1,
   BIAS_NEUTRAL  =  0
};

enum ENUM_STRUCTURE_EVENT
{
   STRUCT_NONE   = 0,
   STRUCT_BOS    = 1,  // Break of Structure (continuation)
   STRUCT_CHOCH  = 2   // Change of Character (reversal)
};

struct SwingPoint
{
   datetime  time;
   double    price;
   bool      is_high;   // true = swing high, false = swing low
   bool      is_broken; // has this level been traded through?
};

struct StructureEvent
{
   ENUM_STRUCTURE_EVENT type;
   datetime             time;
   double               level;
   ENUM_MARKET_BIAS     resulting_bias;
};

//+------------------------------------------------------------------+
class CMarketStructure
{
private:
   string         m_symbol;
   ENUM_TIMEFRAMES m_tf;
   int            m_swing_lookback;  // bars each side to confirm swing

   SwingPoint     m_highs[];
   SwingPoint     m_lows[];
   int            m_high_count;
   int            m_low_count;

   ENUM_MARKET_BIAS m_current_bias;
   StructureEvent   m_last_event;

   double   m_last_hh;   // last higher high
   double   m_last_hl;   // last higher low
   double   m_last_lh;   // last lower high
   double   m_last_ll;   // last lower low

   bool     IsSwingHigh(const int bar, const int lookback,
                        const double hi[]);
   bool     IsSwingLow(const int bar, const int lookback,
                       const double lo[]);

public:
   CMarketStructure();

   bool     Init(const string symbol, const ENUM_TIMEFRAMES tf,
                 const int swing_lookback = 3);

   //--- Main update — call on each new bar
   void     Update(const int bars_to_scan = 100);

   //--- Queries ---------------------------------------------------------
   ENUM_MARKET_BIAS  GetBias()        const { return m_current_bias; }
   StructureEvent    GetLastEvent()   const { return m_last_event; }

   //--- Get last N confirmed swing highs/lows
   int      GetSwingHighs(SwingPoint &out[], const int max_count = 5);
   int      GetSwingLows (SwingPoint &out[], const int max_count = 5);

   //--- Nearest unbroken swing high above / swing low below price
   bool     GetNearestResistance(const double price, SwingPoint &out);
   bool     GetNearestSupport   (const double price, SwingPoint &out);

   //--- Check for fresh BOS or CHoCH on latest bar
   ENUM_STRUCTURE_EVENT DetectStructureBreak();
};

//+------------------------------------------------------------------+
CMarketStructure::CMarketStructure()
   : m_high_count(0), m_low_count(0),
     m_current_bias(BIAS_NEUTRAL),
     m_last_hh(0), m_last_hl(0), m_last_lh(0), m_last_ll(0)
{
   m_last_event.type = STRUCT_NONE;
}

//+------------------------------------------------------------------+
bool CMarketStructure::Init(const string symbol,
                            const ENUM_TIMEFRAMES tf,
                            const int swing_lookback)
{
   m_symbol         = symbol;
   m_tf             = tf;
   m_swing_lookback = swing_lookback;
   ArrayResize(m_highs, 200);
   ArrayResize(m_lows,  200);
   Update(300);
   return true;
}

//+------------------------------------------------------------------+
bool CMarketStructure::IsSwingHigh(const int bar, const int lookback,
                                   const double hi[])
{
   for(int i = 1; i <= lookback; i++)
      if(hi[bar + i] >= hi[bar] || hi[bar - i] >= hi[bar]) return false;
   return true;
}

//+------------------------------------------------------------------+
bool CMarketStructure::IsSwingLow(const int bar, const int lookback,
                                  const double lo[])
{
   for(int i = 1; i <= lookback; i++)
      if(lo[bar + i] <= lo[bar] || lo[bar - i] <= lo[bar]) return false;
   return true;
}

//+------------------------------------------------------------------+
void CMarketStructure::Update(const int bars_to_scan)
{
   int    total = MathMin(bars_to_scan, Bars(m_symbol, m_tf));
   double hi[], lo[];
   datetime times[];

   ArraySetAsSeries(hi,    true);
   ArraySetAsSeries(lo,    true);
   ArraySetAsSeries(times, true);

   if(CopyHigh(m_symbol, m_tf, 0, total, hi)    < total) return;
   if(CopyLow (m_symbol, m_tf, 0, total, lo)    < total) return;
   if(CopyTime(m_symbol, m_tf, 0, total, times) < total) return;

   m_high_count = 0;
   m_low_count  = 0;
   int lb = m_swing_lookback;

   for(int i = lb; i < total - lb; i++)
   {
      if(IsSwingHigh(i, lb, hi))
      {
         m_highs[m_high_count].time     = times[i];
         m_highs[m_high_count].price    = hi[i];
         m_highs[m_high_count].is_high  = true;
         m_highs[m_high_count].is_broken= false;
         m_high_count++;
         if(m_high_count >= ArraySize(m_highs) - 1) break;
      }
      if(IsSwingLow(i, lb, lo))
      {
         m_lows[m_low_count].time     = times[i];
         m_lows[m_low_count].price    = lo[i];
         m_lows[m_low_count].is_high  = false;
         m_lows[m_low_count].is_broken= false;
         m_low_count++;
         if(m_low_count >= ArraySize(m_lows) - 1) break;
      }
   }

   //--- Determine bias from last 4 swings (HH/HL = bull, LH/LL = bear)
   if(m_high_count >= 2 && m_low_count >= 2)
   {
      bool hh = m_highs[0].price > m_highs[1].price;  // recent > prior
      bool hl = m_lows[0].price  > m_lows[1].price;
      bool ll = m_lows[0].price  < m_lows[1].price;
      bool lh = m_highs[0].price < m_highs[1].price;

      if(hh && hl)       m_current_bias = BIAS_BULLISH;
      else if(ll && lh)  m_current_bias = BIAS_BEARISH;
      else               m_current_bias = BIAS_NEUTRAL;

      m_last_hh = hh ? m_highs[0].price : m_highs[1].price;
      m_last_hl = hl ? m_lows[0].price  : m_lows[1].price;
      m_last_lh = lh ? m_highs[0].price : m_highs[1].price;
      m_last_ll = ll ? m_lows[0].price  : m_lows[1].price;
   }
}

//+------------------------------------------------------------------+
int CMarketStructure::GetSwingHighs(SwingPoint &out[], const int max_count)
{
   int n = MathMin(max_count, m_high_count);
   ArrayResize(out, n);
   for(int i = 0; i < n; i++) out[i] = m_highs[i];
   return n;
}

//+------------------------------------------------------------------+
int CMarketStructure::GetSwingLows(SwingPoint &out[], const int max_count)
{
   int n = MathMin(max_count, m_low_count);
   ArrayResize(out, n);
   for(int i = 0; i < n; i++) out[i] = m_lows[i];
   return n;
}

//+------------------------------------------------------------------+
bool CMarketStructure::GetNearestResistance(const double price,
                                            SwingPoint &out)
{
   double best = DBL_MAX;
   bool found  = false;
   for(int i = 0; i < m_high_count; i++)
   {
      if(m_highs[i].price > price && m_highs[i].price < best && !m_highs[i].is_broken)
      {
         best = m_highs[i].price;
         out  = m_highs[i];
         found = true;
      }
   }
   return found;
}

//+------------------------------------------------------------------+
bool CMarketStructure::GetNearestSupport(const double price,
                                         SwingPoint &out)
{
   double best = 0.0;
   bool found  = false;
   for(int i = 0; i < m_low_count; i++)
   {
      if(m_lows[i].price < price && m_lows[i].price > best && !m_lows[i].is_broken)
      {
         best = m_lows[i].price;
         out  = m_lows[i];
         found = true;
      }
   }
   return found;
}

//+------------------------------------------------------------------+
ENUM_STRUCTURE_EVENT CMarketStructure::DetectStructureBreak()
{
   double close1 = iClose(m_symbol, m_tf, 1); // last closed bar

   if(m_current_bias == BIAS_BULLISH)
   {
      //--- Break below last Higher Low = CHoCH (potential reversal)
      if(close1 < m_last_hl)
      {
         m_last_event.type          = STRUCT_CHOCH;
         m_last_event.level         = m_last_hl;
         m_last_event.time          = iTime(m_symbol, m_tf, 1);
         m_last_event.resulting_bias = BIAS_BEARISH;
         m_current_bias             = BIAS_BEARISH;
         return STRUCT_CHOCH;
      }
      //--- Break above last Higher High = BOS (continuation)
      if(close1 > m_last_hh)
      {
         m_last_event.type          = STRUCT_BOS;
         m_last_event.level         = m_last_hh;
         m_last_event.time          = iTime(m_symbol, m_tf, 1);
         m_last_event.resulting_bias = BIAS_BULLISH;
         return STRUCT_BOS;
      }
   }
   else if(m_current_bias == BIAS_BEARISH)
   {
      //--- Break above last Lower High = CHoCH
      if(close1 > m_last_lh)
      {
         m_last_event.type          = STRUCT_CHOCH;
         m_last_event.level         = m_last_lh;
         m_last_event.time          = iTime(m_symbol, m_tf, 1);
         m_last_event.resulting_bias = BIAS_BULLISH;
         m_current_bias             = BIAS_BULLISH;
         return STRUCT_CHOCH;
      }
      //--- Break below last Lower Low = BOS
      if(close1 < m_last_ll)
      {
         m_last_event.type          = STRUCT_BOS;
         m_last_event.level         = m_last_ll;
         m_last_event.time          = iTime(m_symbol, m_tf, 1);
         m_last_event.resulting_bias = BIAS_BEARISH;
         return STRUCT_BOS;
      }
   }
   return STRUCT_NONE;
}

#endif // MARKET_STRUCTURE_MQH
