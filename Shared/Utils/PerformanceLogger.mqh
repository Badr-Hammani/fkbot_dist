//+------------------------------------------------------------------+
//|  PerformanceLogger.mqh — CSV trade log for post-analysis         |
//|  Writes one row per closed trade with full context for Excel /   |
//|  Python analysis to identify what's working and what isn't       |
//+------------------------------------------------------------------+
#ifndef PERFORMANCE_LOGGER_MQH
#define PERFORMANCE_LOGGER_MQH

class CPerformanceLogger
{
private:
   string   m_filename;
   int      m_file_handle;
   bool     m_initialised;
   string   m_ea_name;

   string   FormatDateTime(const datetime t);

public:
   CPerformanceLogger() : m_file_handle(INVALID_HANDLE), m_initialised(false) {}
   ~CPerformanceLogger() { Close(); }

   bool     Init(const string ea_name, const string symbol);
   void     Close();

   void     LogTrade(const ulong   ticket,
                     const bool    was_long,
                     const double  entry_price,
                     const double  exit_price,
                     const double  stop_loss,
                     const double  take_profit,
                     const double  lots,
                     const double  profit_usd,
                     const datetime open_time,
                     const datetime close_time,
                     const int     signal_type,
                     const double  confidence,
                     const double  env_score,
                     const string  description);

   void     LogSummary(const double balance,
                       const double equity,
                       const double win_rate,
                       const double profit_factor);
};

//+------------------------------------------------------------------+
string CPerformanceLogger::FormatDateTime(const datetime t)
{
   MqlDateTime dt;
   TimeToStruct(t, dt);
   return StringFormat("%04d-%02d-%02d %02d:%02d:%02d",
                       dt.year, dt.mon, dt.day, dt.hour, dt.min, dt.sec);
}

bool CPerformanceLogger::Init(const string ea_name, const string symbol)
{
   m_ea_name  = ea_name;
   m_filename = ea_name + "_" + symbol + "_trades.csv";

   bool file_exists = FileIsExist(m_filename, FILE_COMMON);
   m_file_handle    = FileOpen(m_filename,
                               FILE_WRITE | FILE_READ | FILE_CSV | FILE_COMMON,
                               ',', CP_UTF8);
   if(m_file_handle == INVALID_HANDLE)
   {
      Print("PerformanceLogger: Cannot open ", m_filename); return false;
   }

   if(!file_exists)
   {
      // Write CSV header
      FileWrite(m_file_handle,
                "Ticket", "EA", "Direction", "SignalType", "Confidence",
                "EnvScore", "EntryPrice", "ExitPrice", "StopLoss", "TakeProfit",
                "Lots", "ProfitUSD", "PipsRR", "OpenTime", "CloseTime",
                "DurationMin", "Description");
   }
   else
   {
      // Append — seek to end
      FileSeek(m_file_handle, 0, SEEK_END);
   }

   m_initialised = true;
   Print("PerformanceLogger: Logging to ", m_filename);
   return true;
}

void CPerformanceLogger::Close()
{
   if(m_file_handle != INVALID_HANDLE)
   {
      FileClose(m_file_handle);
      m_file_handle = INVALID_HANDLE;
   }
   m_initialised = false;
}

void CPerformanceLogger::LogTrade(const ulong   ticket,
                                   const bool    was_long,
                                   const double  entry_price,
                                   const double  exit_price,
                                   const double  stop_loss,
                                   const double  take_profit,
                                   const double  lots,
                                   const double  profit_usd,
                                   const datetime open_time,
                                   const datetime close_time,
                                   const int     signal_type,
                                   const double  confidence,
                                   const double  env_score,
                                   const string  description)
{
   if(!m_initialised || m_file_handle == INVALID_HANDLE) return;

   double sl_dist    = MathAbs(entry_price - stop_loss);
   double move       = was_long ? (exit_price - entry_price)
                                : (entry_price - exit_price);
   double pips_rr    = (sl_dist > 0.0) ? move / sl_dist : 0.0;

   long dur_min = (close_time - open_time) / 60;

   FileWrite(m_file_handle,
             (string)ticket,
             m_ea_name,
             (was_long ? "LONG" : "SHORT"),
             (string)signal_type,
             DoubleToString(confidence, 3),
             DoubleToString(env_score, 3),
             DoubleToString(entry_price, 2),
             DoubleToString(exit_price, 2),
             DoubleToString(stop_loss, 2),
             DoubleToString(take_profit, 2),
             DoubleToString(lots, 2),
             DoubleToString(profit_usd, 2),
             DoubleToString(pips_rr, 2),
             FormatDateTime(open_time),
             FormatDateTime(close_time),
             (string)dur_min,
             description);
}

void CPerformanceLogger::LogSummary(const double balance,
                                     const double equity,
                                     const double win_rate,
                                     const double profit_factor)
{
   if(!m_initialised || m_file_handle == INVALID_HANDLE) return;
   FileWrite(m_file_handle,
             "SUMMARY", m_ea_name, "",
             "", "", "",
             DoubleToString(balance, 2),
             DoubleToString(equity, 2),
             DoubleToString(win_rate, 2),
             DoubleToString(profit_factor, 3),
             "", "", "", FormatDateTime(TimeCurrent()), "", "", "");
}

#endif // PERFORMANCE_LOGGER_MQH
