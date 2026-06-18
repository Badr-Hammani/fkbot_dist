//+------------------------------------------------------------------+
//|  SessionFilter.mqh — ICT killzone / session gate                  |
//|  v1.1 — Fixed: GMT offset now properly applied to all time checks |
//+------------------------------------------------------------------+
#ifndef SESSION_FILTER_MQH
#define SESSION_FILTER_MQH

enum ENUM_SESSION
{
   SESSION_NONE        = 0,
   SESSION_ASIAN       = 1,
   SESSION_LONDON_OPEN = 2,
   SESSION_LONDON      = 3,
   SESSION_NY_OPEN     = 4,
   SESSION_NY_PM       = 5,
   SESSION_OVERLAP     = 6
};

struct SessionConfig
{
   bool allow_asian;
   bool allow_london_open;
   bool allow_ny_open;
   bool allow_ny_pm;
   int  gmt_offset;          // broker server GMT offset in hours (e.g. 2 for EET winter)
};

class CSessionFilter
{
private:
   SessionConfig m_cfg;

   // FIX C2: GetNYHour() always uses configured gmt_offset — not zero default
   int  GetNYHour();
   bool InRange(const int h, const int start, const int end);

public:
   CSessionFilter();

   // FIX A4: Init() must be explicitly called with full config from the EA
   void        Init(const SessionConfig &cfg);

   // Convenience setter used when EA inputs are available but SessionConfig is not pre-built
   void        Configure(const bool allow_asian,
                         const bool allow_london_open,
                         const bool allow_ny_open,
                         const bool allow_ny_pm,
                         const int  gmt_offset);

   bool        IsTradingSession();
   ENUM_SESSION GetCurrentSession();
   bool        IsKillzone();

   // Returns current NY hour (exposed so signal engines can use it for Silver Bullet)
   int         GetCurrentNYHour();
   int         GetCurrentNYMinute();

   bool        IsAsianRangeFormed();
};

//+------------------------------------------------------------------+
CSessionFilter::CSessionFilter()
{
   m_cfg.allow_asian       = false;
   m_cfg.allow_london_open = true;
   m_cfg.allow_ny_open     = true;
   m_cfg.allow_ny_pm       = false;
   m_cfg.gmt_offset        = 0;
}

void CSessionFilter::Init(const SessionConfig &cfg)
{
   m_cfg = cfg;
}

void CSessionFilter::Configure(const bool allow_asian,
                               const bool allow_london_open,
                               const bool allow_ny_open,
                               const bool allow_ny_pm,
                               const int  gmt_offset)
{
   m_cfg.allow_asian       = allow_asian;
   m_cfg.allow_london_open = allow_london_open;
   m_cfg.allow_ny_open     = allow_ny_open;
   m_cfg.allow_ny_pm       = allow_ny_pm;
   m_cfg.gmt_offset        = gmt_offset;
}

// FIX C2: converts broker server time → UTC → NY time using configured offset
int CSessionFilter::GetNYHour()
{
   MqlDateTime srv_dt;
   TimeToStruct(TimeCurrent(), srv_dt);

   // Server time → UTC
   int utc_hour = (srv_dt.hour - m_cfg.gmt_offset + 24) % 24;

   // UTC → NY: -4 in summer (Mar–Nov), -5 in winter
   MqlDateTime utc_dt;
   TimeToStruct(TimeGMT(), utc_dt);
   int ny_offset = (utc_dt.mon >= 3 && utc_dt.mon <= 11) ? -4 : -5;

   return (utc_hour + ny_offset + 24) % 24;
}

int CSessionFilter::GetCurrentNYHour()   { return GetNYHour(); }

int CSessionFilter::GetCurrentNYMinute()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   return dt.min;
}

bool CSessionFilter::InRange(const int h, const int start, const int end)
{
   if(start <= end) return (h >= start && h < end);
   return (h >= start || h < end);
}

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

ENUM_SESSION CSessionFilter::GetCurrentSession()
{
   int h = GetNYHour();
   if(InRange(h, 20, 24) || InRange(h, 0, 3)) return SESSION_ASIAN;
   if(InRange(h, 2,  5))  return SESSION_LONDON_OPEN;
   if(InRange(h, 8,  11)) return SESSION_OVERLAP;
   if(InRange(h, 3,  12)) return SESSION_LONDON;
   if(InRange(h, 13, 16)) return SESSION_NY_PM;
   return SESSION_NONE;
}

bool CSessionFilter::IsKillzone()
{
   int h = GetNYHour();
   return InRange(h, 2, 5) || InRange(h, 8, 11) || InRange(h, 13, 16);
}

bool CSessionFilter::IsAsianRangeFormed()
{
   int h = GetNYHour();
   return (h >= 2);
}

#endif // SESSION_FILTER_MQH
