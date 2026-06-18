//+------------------------------------------------------------------+
//|  AdaptiveLearning.mqh — Rolling performance tracker              |
//|  v1.1 — Fixed: binary file versioning to survive struct changes  |
//+------------------------------------------------------------------+
#ifndef ADAPTIVE_LEARNING_MQH
#define ADAPTIVE_LEARNING_MQH

// Increment this when TradeRecord struct layout changes
#define ADAPTIVE_FILE_VERSION 2

struct TradeRecord
{
   datetime open_time;
   datetime close_time;
   double   profit_usd;        // renamed from profit_pips (was storing USD, not pips)
   bool     was_winner;
   int      signal_type;
   double   confidence_at_entry;
};

class CAdaptiveLearning
{
private:
   TradeRecord m_history[];
   int         m_window_size;
   int         m_count;
   int         m_head;

   double   m_win_rate[16];
   int      m_signal_trades[16];
   int      m_signal_wins[16];

   double   m_confidence_floor;
   double   m_confidence_ceil;
   double   m_base_threshold;

   void     RecalcStats();

public:
   CAdaptiveLearning();

   void     Init(const int window_size       = 50,
                 const double base_threshold = 0.55,
                 const double floor          = 0.40,
                 const double ceil           = 0.85);

   void     RecordTrade(const datetime open_time,
                        const datetime close_time,
                        const double   profit_usd,
                        const int      signal_type,
                        const double   confidence_at_entry);

   double   GetAdaptedThreshold(const int signal_type);
   double   GetOverallWinRate();
   double   GetLotScaleFactor();

   // FIX: versioned binary persistence — bad file version returns false gracefully
   bool     SaveToFile(const string filename);
   bool     LoadFromFile(const string filename);
};

CAdaptiveLearning::CAdaptiveLearning()
   : m_window_size(50), m_count(0), m_head(0),
     m_confidence_floor(0.40), m_confidence_ceil(0.85),
     m_base_threshold(0.55)
{
   ArrayInitialize(m_win_rate,      0.5);
   ArrayInitialize(m_signal_trades, 0);
   ArrayInitialize(m_signal_wins,   0);
}

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
      m_win_rate[i] = (m_signal_trades[i] > 0)
                      ? (double)m_signal_wins[i] / m_signal_trades[i]
                      : 0.5;
}

void CAdaptiveLearning::RecordTrade(const datetime open_time,
                                    const datetime close_time,
                                    const double   profit_usd,
                                    const int      signal_type,
                                    const double   confidence_at_entry)
{
   if(m_count < m_window_size) m_count++;
   m_history[m_head].open_time           = open_time;
   m_history[m_head].close_time          = close_time;
   m_history[m_head].profit_usd          = profit_usd;
   m_history[m_head].was_winner          = (profit_usd > 0.0);
   m_history[m_head].signal_type         = MathMin(signal_type, 15);
   m_history[m_head].confidence_at_entry = confidence_at_entry;

   m_head = (m_head + 1) % m_window_size;
   RecalcStats();
}

double CAdaptiveLearning::GetAdaptedThreshold(const int signal_type)
{
   int st = MathMin(signal_type, 15);
   double wr = m_win_rate[st];
   double adjustment = (wr - 0.50) * 0.3;
   double threshold  = m_base_threshold - adjustment;
   return MathMax(m_confidence_floor, MathMin(m_confidence_ceil, threshold));
}

double CAdaptiveLearning::GetOverallWinRate()
{
   if(m_count == 0) return 0.5;
   int wins = 0;
   for(int i = 0; i < m_count; i++)
      if(m_history[i].was_winner) wins++;
   return (double)wins / m_count;
}

double CAdaptiveLearning::GetLotScaleFactor()
{
   double wr     = GetOverallWinRate();
   double factor = 1.0 + (wr - 0.50) * 2.0;
   return MathMax(0.5, MathMin(1.5, factor));
}

// FIX: writes magic version bytes first; rejects mismatched versions
bool CAdaptiveLearning::SaveToFile(const string filename)
{
   int fh = FileOpen(filename, FILE_WRITE | FILE_BIN | FILE_COMMON);
   if(fh == INVALID_HANDLE)
   {
      Print("AdaptiveLearning: Cannot save to ", filename); return false;
   }
   FileWriteInteger(fh, ADAPTIVE_FILE_VERSION);   // version header
   FileWriteInteger(fh, m_window_size);           // saved window size
   FileWriteInteger(fh, m_count);
   FileWriteInteger(fh, m_head);
   for(int i = 0; i < m_window_size; i++)
      FileWriteStruct(fh, m_history[i]);
   FileClose(fh);
   Print("AdaptiveLearning: Saved ", m_count, " records to ", filename,
         " (v", ADAPTIVE_FILE_VERSION, ")");
   return true;
}

bool CAdaptiveLearning::LoadFromFile(const string filename)
{
   if(!FileIsExist(filename, FILE_COMMON)) return false;

   int fh = FileOpen(filename, FILE_READ | FILE_BIN | FILE_COMMON);
   if(fh == INVALID_HANDLE) return false;

   int file_version = FileReadInteger(fh);
   if(file_version != ADAPTIVE_FILE_VERSION)
   {
      Print("AdaptiveLearning: Version mismatch (file=", file_version,
            " code=", ADAPTIVE_FILE_VERSION, ") — ignoring saved data");
      FileClose(fh);
      return false;
   }

   int saved_window = FileReadInteger(fh);
   if(saved_window != m_window_size)
   {
      Print("AdaptiveLearning: Window size mismatch (file=", saved_window,
            " current=", m_window_size, ") — ignoring saved data");
      FileClose(fh);
      return false;
   }

   m_count = FileReadInteger(fh);
   m_head  = FileReadInteger(fh);
   for(int i = 0; i < m_window_size; i++)
      FileReadStruct(fh, m_history[i]);
   FileClose(fh);
   RecalcStats();
   Print("AdaptiveLearning: Loaded ", m_count, " records from ", filename);
   return true;
}

#endif // ADAPTIVE_LEARNING_MQH
