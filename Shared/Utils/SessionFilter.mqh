//+------------------------------------------------------------------+
//|  SessionFilter.mqh — Killzone/session time gate for gold trading  |
//|  ICT killzones: London Open, NY Open, NY PM, Asian Range          |
//+------------------------------------------------------------------+
#ifndef SESSION_FILTER_MQH
#define SESSION_FILTER_MQH

enum ENUM_SESSION
{
   SESSION_NONE        = 0,
   SESSION_ASIAN       = 1,
   SESSION_LONDON_OPEN = 2,   // 02:00 – 05:00 NY time
   SESSION_LONDON      = 3,   // 03:00 – 11:00 NY time
   SESSION_NY_OPEN     = 4,   // 08:00 – 11:00 NY time
   SESSION_NY_PM       = 5,   // 13:00 – 16:00 NY time
   SESSION_OVERLAP     = 6    // London/NY overlap 08:00–11:00
};

struct SessionConfig
{
   bool allow_asian;
   bool allow_london_open;   // ICT killzone 1 (02:00-05:00 NY)
   bool allow_ny_open;       // ICT killzone 2 (08:00-11:00 NY)
   bool allow_ny_pm;         // ICT killzone 3 (13:00-16:00 NY)
   int  gmt_offset;          // broker server GMT offset in hours
};

class CSessionFilter
{
private:
   SessionConfig m_cfg;

   int  GetNYHour();
   bool InRange(const int h, const int start, const int end);

public:
   CSessionFilter();
   void        Init(const SessionConfig &cfg);
   bool        IsTradingSession();
   ENUM_SESSION GetCurrentSession();
   bool        IsKillzone();            // true if in any ICT killzone
   bool        IsAsianRangeFormed();    // true after Asian session closes
   void        GetAsianRange(double &range_high, double &range_low);
};

//+------------------------------------------------------------------+
CSessionFilter::CSessionFilter() { m_cfg.gmt_offset = 0; }

//+------------------------------------------------------------------+
void CSessionFilter::Init(const SessionConfig &cfg) { m_cfg = cfg; }

//+------------------------------------------------------------------+
int CSessionFilter::GetNYHour()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);

   //--- Approximate NY hour from broker server time
   int server_hour = dt.hour;
   //--- NY = UTC-5 (winter) / UTC-4 (summer); broker offset given
   int utc_hour = (server_hour - m_cfg.gmt_offset + 24) % 24;

   //--- Rough DST approximation: NY is UTC-4 Apr-Oct, UTC-5 Nov-Mar
   MqlDateTime utc_dt;
   TimeToStruct(TimeGMT(), utc_dt);
   int ny_offset = (utc_dt.mon >= 4 && utc_dt.mon <= 10) ? -4 : -5;
   return (utc_hour + ny_offset + 24) % 24;
}

//+------------------------------------------------------------------+
bool CSessionFilter::InRange(const int h, const int start, const int end)
{
   if(start <= end) return (h >= start && h < end);
   return (h >= start || h < end); // wraps midnight
}

//+------------------------------------------------------------------+
bool CSessionFilter::IsTradingSession()
{
   ENUM_SESSION s = GetCurrentSession();
   switch(s)
   {
      case SESSION_ASIAN:       return m_cfg.allow_asian;
      case SESSION_LONDON_OPEN: return m_cfg.allow_london_open;
      case SESSION_NY_OPEN:
      case SESSION_OVERLAP:     return m_cfg.allow_ny_open;
      case SESSION_NY_PM:       return m_cfg.allow_ny_pm;
      default:                  return false;
   }
}

//+------------------------------------------------------------------+
ENUM_SESSION CSessionFilter::GetCurrentSession()
{
   int h = GetNYHour();

   if(InRange(h, 20, 24) || InRange(h, 0, 3)) return SESSION_ASIAN;
   if(InRange(h, 2,  5))  return SESSION_LONDON_OPEN;
   if(InRange(h, 8,  11)) return SESSION_OVERLAP;      // both London+NY
   if(InRange(h, 3,  12)) return SESSION_LONDON;
   if(InRange(h, 13, 16)) return SESSION_NY_PM;
   return SESSION_NONE;
}

//+------------------------------------------------------------------+
bool CSessionFilter::IsKillzone()
{
   int h = GetNYHour();
   return InRange(h, 2, 5) || InRange(h, 8, 11) || InRange(h, 13, 16);
}

//+------------------------------------------------------------------+
bool CSessionFilter::IsAsianRangeFormed()
{
   int h = GetNYHour();
   //--- Asian range considered set after 02:00 NY (London Open start)
   return (h >= 2);
}

//+------------------------------------------------------------------+
void CSessionFilter::GetAsianRange(double &range_high, double &range_low)
{
   //--- Collect H1 bars from the last Asian session (20:00–02:00 NY)
   int    total = Bars("XAUUSD", PERIOD_H1);
   double hi[], lo[];
   datetime t[];
   ArraySetAsSeries(hi, true);
   ArraySetAsSeries(lo, true);
   ArraySetAsSeries(t,  true);

   int copied = MathMin(10, total);
   CopyHigh("XAUUSD", PERIOD_H1, 0, copied, hi);
   CopyLow ("XAUUSD", PERIOD_H1, 0, copied, lo);
   CopyTime("XAUUSD", PERIOD_H1, 0, copied, t);

   range_high = 0.0; range_low = DBL_MAX;
   for(int i = 0; i < copied; i++)
   {
      MqlDateTime dt; TimeToStruct(t[i], dt);
      int ny_h = (dt.hour - m_cfg.gmt_offset + 5 + 24) % 24;
      if(ny_h >= 20 || ny_h < 2)  // Asian window
      {
         if(hi[i] > range_high) range_high = hi[i];
         if(lo[i] < range_low)  range_low  = lo[i];
      }
   }
   if(range_low == DBL_MAX) range_low = 0.0;
}

#endif // SESSION_FILTER_MQH
