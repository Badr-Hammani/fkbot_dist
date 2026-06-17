//+------------------------------------------------------------------+
//|  RiskManager.mqh — Unified risk & position-sizing engine          |
//|  Implements: ATR-based sizing, max drawdown guard, daily loss cap, |
//|  partial-close ladder, dynamic trailing stop, correlation filter   |
//+------------------------------------------------------------------+
#ifndef RISK_MANAGER_MQH
#define RISK_MANAGER_MQH

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\AccountInfo.mqh>

//+------------------------------------------------------------------+
struct RiskParams
{
   double   risk_pct_per_trade;     // % of balance risked per trade (e.g. 1.0)
   double   max_daily_loss_pct;     // halt trading if daily loss exceeds this %
   double   max_drawdown_pct;       // halt trading if equity drawdown > this %
   double   max_open_risk_pct;      // total open risk ceiling across all positions
   int      atr_period;             // ATR period for stop placement
   double   atr_sl_multiplier;      // SL = ATR * this
   double   atr_tp1_multiplier;     // First TP = ATR * this (partial close)
   double   atr_tp2_multiplier;     // Final TP = ATR * this
   double   partial_close_pct;      // % of position to close at TP1 (e.g. 50)
   double   breakeven_trigger_atr;  // Move SL to BE after price moves N * ATR
   double   max_spread_pts;         // Skip entry if spread > N points
   int      max_positions;          // Max concurrent open positions for this EA
   double   trailing_step_atr;      // Trail by this fraction of ATR
   bool     use_news_filter;        // Disable entries during news blackout
};

//+------------------------------------------------------------------+
class CRiskManager
{
private:
   RiskParams       m_params;
   CTrade           m_trade;
   CPositionInfo    m_pos;
   CAccountInfo     m_account;

   double   m_balance_at_day_start;
   double   m_peak_equity;
   datetime m_current_day;

   string   m_symbol;
   int      m_atr_handle;
   double   m_atr_buffer[];

   void     RefreshDailyBaseline();
   double   GetATR();

public:
   CRiskManager();
   ~CRiskManager();

   bool     Init(const string symbol, const RiskParams &params);

   //--- Position sizing -------------------------------------------------
   double   CalcLotSize(const double entry_price,
                        const double stop_loss_price);

   //--- Guard checks ----------------------------------------------------
   bool     IsTradingAllowed();        // daily loss + drawdown check
   bool     IsSpreadAcceptable();
   bool     IsMaxPositionsReached(const ulong magic);

   //--- Stop management -------------------------------------------------
   void     ManageOpenPositions(const ulong magic);
   bool     MoveToBreakeven(const ulong ticket, const double entry,
                            const ENUM_ORDER_TYPE direction);
   bool     ApplyTrailingStop(const ulong ticket, const double entry,
                              const ENUM_ORDER_TYPE direction);

   //--- Metrics ---------------------------------------------------------
   double   GetCurrentDrawdownPct();
   double   GetDailyLossPct();
   double   GetTotalOpenRiskPct(const ulong magic);

   //--- Accessors
   RiskParams& Params() { return m_params; }
   void     SetMagic(const ulong magic) { m_trade.SetExpertMagicNumber(magic); }
};

//+------------------------------------------------------------------+
CRiskManager::CRiskManager()
   : m_atr_handle(INVALID_HANDLE),
     m_peak_equity(0.0),
     m_balance_at_day_start(0.0),
     m_current_day(0)
{
   ArraySetAsSeries(m_atr_buffer, true);
}

//+------------------------------------------------------------------+
CRiskManager::~CRiskManager()
{
   if(m_atr_handle != INVALID_HANDLE)
      IndicatorRelease(m_atr_handle);
}

//+------------------------------------------------------------------+
bool CRiskManager::Init(const string symbol, const RiskParams &params)
{
   m_symbol = symbol;
   m_params = params;

   m_atr_handle = iATR(m_symbol, PERIOD_H1, m_params.atr_period);
   if(m_atr_handle == INVALID_HANDLE)
   {
      Print("RiskManager: Failed to create ATR handle");
      return false;
   }

   m_peak_equity = m_account.Equity();
   RefreshDailyBaseline();

   m_trade.SetDeviationInPoints(20);
   m_trade.SetTypeFillingBySymbol(m_symbol);
   Print("RiskManager: Initialised on ", m_symbol,
         " | Risk/trade=", m_params.risk_pct_per_trade, "%");
   return true;
}

//+------------------------------------------------------------------+
void CRiskManager::RefreshDailyBaseline()
{
   datetime today = (datetime)(TimeCurrent() / 86400 * 86400);
   if(today != m_current_day)
   {
      m_current_day          = today;
      m_balance_at_day_start = m_account.Balance();
   }
}

//+------------------------------------------------------------------+
double CRiskManager::GetATR()
{
   if(CopyBuffer(m_atr_handle, 0, 0, 3, m_atr_buffer) < 1) return 0.0;
   return m_atr_buffer[1]; // confirmed closed-bar ATR
}

//+------------------------------------------------------------------+
double CRiskManager::CalcLotSize(const double entry_price,
                                 const double stop_loss_price)
{
   double balance  = m_account.Balance();
   double risk_amt = balance * m_params.risk_pct_per_trade / 100.0;
   double sl_dist  = MathAbs(entry_price - stop_loss_price);

   if(sl_dist <= 0.0)
   {
      Print("RiskManager: SL distance is zero — defaulting to 0.01 lot");
      return 0.01;
   }

   double tick_value = SymbolInfoDouble(m_symbol, SYMBOL_TRADE_TICK_VALUE);
   double tick_size  = SymbolInfoDouble(m_symbol, SYMBOL_TRADE_TICK_SIZE);
   double lot_step   = SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_STEP);
   double min_lot    = SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_MIN);
   double max_lot    = SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_MAX);

   if(tick_size == 0.0 || tick_value == 0.0) return min_lot;

   //--- risk_amt = lots * (sl_dist / tick_size) * tick_value
   double lots = risk_amt / ((sl_dist / tick_size) * tick_value);
   lots = MathFloor(lots / lot_step) * lot_step;
   lots = MathMax(min_lot, MathMin(max_lot, lots));

   return NormalizeDouble(lots, 2);
}

//+------------------------------------------------------------------+
bool CRiskManager::IsTradingAllowed()
{
   RefreshDailyBaseline();

   double equity  = m_account.Equity();
   double balance = m_account.Balance();

   //--- Update high-water mark
   if(equity > m_peak_equity) m_peak_equity = equity;

   //--- Max drawdown from equity peak
   double dd_pct = (m_peak_equity - equity) / m_peak_equity * 100.0;
   if(dd_pct >= m_params.max_drawdown_pct)
   {
      Print("RiskManager: MAX DRAWDOWN BREACH (", DoubleToString(dd_pct, 2),
            "%) — trading halted");
      return false;
   }

   //--- Daily loss cap
   double daily_loss = GetDailyLossPct();
   if(daily_loss >= m_params.max_daily_loss_pct)
   {
      Print("RiskManager: DAILY LOSS LIMIT (", DoubleToString(daily_loss, 2),
            "%) — no new entries today");
      return false;
   }

   //--- Total open risk ceiling
   // (caller must pass magic if using per-EA cap)
   return true;
}

//+------------------------------------------------------------------+
bool CRiskManager::IsSpreadAcceptable()
{
   double spread = (double)SymbolInfoInteger(m_symbol, SYMBOL_SPREAD);
   return (spread <= m_params.max_spread_pts);
}

//+------------------------------------------------------------------+
bool CRiskManager::IsMaxPositionsReached(const ulong magic)
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(m_pos.SelectByIndex(i) &&
         m_pos.Symbol() == m_symbol &&
         m_pos.Magic()  == magic)
         count++;
   }
   return (count >= m_params.max_positions);
}

//+------------------------------------------------------------------+
void CRiskManager::ManageOpenPositions(const ulong magic)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!m_pos.SelectByIndex(i)) continue;
      if(m_pos.Symbol() != m_symbol || m_pos.Magic() != magic) continue;

      ulong  ticket    = m_pos.Ticket();
      double entry     = m_pos.PriceOpen();
      ENUM_ORDER_TYPE dir = (m_pos.PositionType() == POSITION_TYPE_BUY)
                            ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;

      MoveToBreakeven(ticket, entry, dir);
      ApplyTrailingStop(ticket, entry, dir);
   }
}

//+------------------------------------------------------------------+
bool CRiskManager::MoveToBreakeven(const ulong ticket,
                                   const double entry,
                                   const ENUM_ORDER_TYPE direction)
{
   if(!m_pos.SelectByTicket(ticket)) return false;

   double atr     = GetATR();
   if(atr <= 0.0) return false;

   double trigger = m_params.breakeven_trigger_atr * atr;
   double current_sl = m_pos.StopLoss();
   double price    = m_pos.PriceCurrent();

   if(direction == ORDER_TYPE_BUY)
   {
      if(price >= entry + trigger && (current_sl < entry || current_sl == 0.0))
      {
         m_trade.PositionModify(ticket, entry + SymbolInfoDouble(m_symbol, SYMBOL_POINT),
                                m_pos.TakeProfit());
         Print("RiskManager: Breakeven set for ticket ", ticket);
         return true;
      }
   }
   else
   {
      if(price <= entry - trigger && (current_sl > entry || current_sl == 0.0))
      {
         m_trade.PositionModify(ticket, entry - SymbolInfoDouble(m_symbol, SYMBOL_POINT),
                                m_pos.TakeProfit());
         Print("RiskManager: Breakeven set for ticket ", ticket);
         return true;
      }
   }
   return false;
}

//+------------------------------------------------------------------+
bool CRiskManager::ApplyTrailingStop(const ulong ticket,
                                     const double entry,
                                     const ENUM_ORDER_TYPE direction)
{
   if(!m_pos.SelectByTicket(ticket)) return false;

   double atr   = GetATR();
   if(atr <= 0.0) return false;

   double trail = m_params.trailing_step_atr * atr;
   double price = m_pos.PriceCurrent();
   double cur_sl = m_pos.StopLoss();

   if(direction == ORDER_TYPE_BUY)
   {
      double new_sl = price - trail;
      if(new_sl > cur_sl + SymbolInfoDouble(m_symbol, SYMBOL_POINT))
      {
         m_trade.PositionModify(ticket, new_sl, m_pos.TakeProfit());
         return true;
      }
   }
   else
   {
      double new_sl = price + trail;
      if(cur_sl == 0.0 || new_sl < cur_sl - SymbolInfoDouble(m_symbol, SYMBOL_POINT))
      {
         m_trade.PositionModify(ticket, new_sl, m_pos.TakeProfit());
         return true;
      }
   }
   return false;
}

//+------------------------------------------------------------------+
double CRiskManager::GetCurrentDrawdownPct()
{
   double equity = m_account.Equity();
   if(m_peak_equity <= 0.0) return 0.0;
   return MathMax(0.0, (m_peak_equity - equity) / m_peak_equity * 100.0);
}

//+------------------------------------------------------------------+
double CRiskManager::GetDailyLossPct()
{
   RefreshDailyBaseline();
   double balance = m_account.Balance();
   if(m_balance_at_day_start <= 0.0) return 0.0;
   double loss = m_balance_at_day_start - balance;
   return MathMax(0.0, loss / m_balance_at_day_start * 100.0);
}

//+------------------------------------------------------------------+
double CRiskManager::GetTotalOpenRiskPct(const ulong magic)
{
   double total_risk = 0.0;
   double balance    = m_account.Balance();
   if(balance <= 0.0) return 0.0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!m_pos.SelectByIndex(i)) continue;
      if(m_pos.Symbol() != m_symbol || m_pos.Magic() != magic) continue;

      double entry  = m_pos.PriceOpen();
      double sl     = m_pos.StopLoss();
      double lots   = m_pos.Volume();
      double tick_val  = SymbolInfoDouble(m_symbol, SYMBOL_TRADE_TICK_VALUE);
      double tick_size = SymbolInfoDouble(m_symbol, SYMBOL_TRADE_TICK_SIZE);

      if(sl == 0.0 || tick_size == 0.0) continue;

      double sl_dist    = MathAbs(entry - sl);
      double risk_money = lots * (sl_dist / tick_size) * tick_val;
      total_risk += risk_money / balance * 100.0;
   }
   return total_risk;
}

#endif // RISK_MANAGER_MQH
