//+------------------------------------------------------------------+
//|  AdaptiveLearning.mqh — Lightweight performance tracker that      |
//|  adjusts signal confidence thresholds based on recent win rate.   |
//|  Uses a rolling window of the last N closed trades.               |
//+------------------------------------------------------------------+
#ifndef ADAPTIVE_LEARNING_MQH
#define ADAPTIVE_LEARNING_MQH

struct TradeRecord
{
   datetime open_time;
   datetime close_time;
   double   profit_pips;
   bool     was_winner;
   int      signal_type;   // strategy-specific tag (e.g. OB_BULL = 1)
   double   confidence_at_entry; // 0.0–1.0
};

class CAdaptiveLearning
{
private:
   TradeRecord m_history[];
   int         m_window_size;   // rolling window length
   int         m_count;
   int         m_head;          // circular buffer head

   //--- Per-signal-type stats
   double   m_win_rate[16];     // indexed by signal_type (up to 16 types)
   int      m_signal_trades[16];
   int      m_signal_wins[16];

   double   m_confidence_floor; // never go below this threshold
   double   m_confidence_ceil;  // never go above this
   double   m_base_threshold;   // starting minimum confidence

   void     RecalcStats();

public:
   CAdaptiveLearning();

   void     Init(const int window_size       = 50,
                 const double base_threshold = 0.55,
                 const double floor          = 0.40,
                 const double ceil           = 0.85);

   //--- Record outcome of a closed trade
   void     RecordTrade(const datetime open_time,
                        const datetime close_time,
                        const double   profit_pips,
                        const int      signal_type,
                        const double   confidence_at_entry);

   //--- Query adapted minimum confidence for a signal type
   double   GetAdaptedThreshold(const int signal_type);

   //--- Overall rolling win rate
   double   GetOverallWinRate();

   //--- Suggested lot scale factor [0.5 – 1.5] based on recent performance
   double   GetLotScaleFactor();

   //--- Persist to / restore from a file (survives restarts)
   bool     SaveToFile(const string filename);
   bool     LoadFromFile(const string filename);
};

//+------------------------------------------------------------------+
CAdaptiveLearning::CAdaptiveLearning()
   : m_window_size(50), m_count(0), m_head(0),
     m_confidence_floor(0.40), m_confidence_ceil(0.85),
     m_base_threshold(0.55)
{
   ArrayInitialize(m_win_rate,      0.5);
   ArrayInitialize(m_signal_trades, 0);
   ArrayInitialize(m_signal_wins,   0);
}

//+------------------------------------------------------------------+
void CAdaptiveLearning::Init(const int window_size,
                             const double base_threshold,
                             const double floor,
                             const double ceil)
{
   m_window_size      = window_size;
   m_base_threshold   = base_threshold;
   m_confidence_floor = floor;
   m_confidence_ceil  = ceil;
   ArrayResize(m_history, m_window_size);
}

//+------------------------------------------------------------------+
void CAdaptiveLearning::RecalcStats()
{
   ArrayInitialize(m_signal_trades, 0);
   ArrayInitialize(m_signal_wins,   0);

   for(int i = 0; i < m_count; i++)
   {
      int st = MathMin(m_history[i].signal_type, 15);
      m_signal_trades[st]++;
      if(m_history[i].was_winner) m_signal_wins[st]++;
   }

   for(int i = 0; i < 16; i++)
   {
      if(m_signal_trades[i] > 0)
         m_win_rate[i] = (double)m_signal_wins[i] / m_signal_trades[i];
      else
         m_win_rate[i] = 0.5; // prior
   }
}

//+------------------------------------------------------------------+
void CAdaptiveLearning::RecordTrade(const datetime open_time,
                                    const datetime close_time,
                                    const double   profit_pips,
                                    const int      signal_type,
                                    const double   confidence_at_entry)
{
   if(m_count < m_window_size) m_count++;
   m_history[m_head].open_time           = open_time;
   m_history[m_head].close_time          = close_time;
   m_history[m_head].profit_pips         = profit_pips;
   m_history[m_head].was_winner          = (profit_pips > 0.0);
   m_history[m_head].signal_type         = MathMin(signal_type, 15);
   m_history[m_head].confidence_at_entry = confidence_at_entry;

   m_head = (m_head + 1) % m_window_size;
   RecalcStats();
}

//+------------------------------------------------------------------+
double CAdaptiveLearning::GetAdaptedThreshold(const int signal_type)
{
   int st = MathMin(signal_type, 15);
   double wr = m_win_rate[st];

   //--- If win rate is above 60% → lower the threshold (take more trades)
   //--- If win rate is below 45% → raise the threshold (be more selective)
   double adjustment = (wr - 0.50) * 0.3;  // ±15% max swing
   double threshold  = m_base_threshold - adjustment;

   return MathMax(m_confidence_floor, MathMin(m_confidence_ceil, threshold));
}

//+------------------------------------------------------------------+
double CAdaptiveLearning::GetOverallWinRate()
{
   if(m_count == 0) return 0.5;
   int wins = 0;
   for(int i = 0; i < m_count; i++)
      if(m_history[i].was_winner) wins++;
   return (double)wins / m_count;
}

//+------------------------------------------------------------------+
double CAdaptiveLearning::GetLotScaleFactor()
{
   double wr = GetOverallWinRate();
   //--- Scale between 0.5 (cold streak) and 1.5 (hot streak)
   //--- Neutral at 50% win rate → factor 1.0
   double factor = 1.0 + (wr - 0.50) * 2.0;
   return MathMax(0.5, MathMin(1.5, factor));
}

//+------------------------------------------------------------------+
bool CAdaptiveLearning::SaveToFile(const string filename)
{
   int fh = FileOpen(filename, FILE_WRITE | FILE_BIN | FILE_COMMON);
   if(fh == INVALID_HANDLE) { Print("AdaptiveLearning: Cannot save to ", filename); return false; }
   FileWriteInteger(fh, m_count);
   FileWriteInteger(fh, m_head);
   for(int i = 0; i < m_window_size; i++)
      FileWriteStruct(fh, m_history[i]);
   FileClose(fh);
   return true;
}

//+------------------------------------------------------------------+
bool CAdaptiveLearning::LoadFromFile(const string filename)
{
   if(!FileIsExist(filename, FILE_COMMON)) return false;
   int fh = FileOpen(filename, FILE_READ | FILE_BIN | FILE_COMMON);
   if(fh == INVALID_HANDLE) return false;
   m_count = FileReadInteger(fh);
   m_head  = FileReadInteger(fh);
   for(int i = 0; i < m_window_size; i++)
      FileReadStruct(fh, m_history[i]);
   FileClose(fh);
   RecalcStats();
   Print("AdaptiveLearning: Loaded ", m_count, " trade records from ", filename);
   return true;
}

#endif // ADAPTIVE_LEARNING_MQH
