//+------------------------------------------------------------------+
//|  RiskManager.mqh — Unified risk & position-sizing engine          |
//|  v1.1 — Fixed: daily loss uses equity; BE buffer; CopyBuffer guard|
//+------------------------------------------------------------------+
#ifndef RISK_MANAGER_MQH
#define RISK_MANAGER_MQH

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\AccountInfo.mqh>

struct RiskParams
{
   double   risk_pct_per_trade;
   double   max_daily_loss_pct;
   double   max_drawdown_pct;
   double   max_open_risk_pct;
   int      atr_period;
   double   atr_sl_multiplier;
   double   atr_tp1_multiplier;
   double   atr_tp2_multiplier;
   double   partial_close_pct;
   double   breakeven_trigger_atr;
   double   breakeven_buffer_pts;    // buffer above/below entry at BE (prevents spread stop-out)
   double   max_spread_pts;
   int      max_positions;
   double   trailing_step_atr;
   bool     use_news_filter;
};

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

   double   CalcLotSize(const double entry_price, const double stop_loss_price);

   bool     IsTradingAllowed();
   bool     IsSpreadAcceptable();
   bool     IsMaxPositionsReached(const ulong magic);

   void     ManageOpenPositions(const ulong magic);
   bool     MoveToBreakeven(const ulong ticket, const double entry,
                            const ENUM_ORDER_TYPE direction);
   bool     ApplyTrailingStop(const ulong ticket, const double entry,
                              const ENUM_ORDER_TYPE direction);

   double   GetCurrentDrawdownPct();
   double   GetDailyLossPct();          // FIX B2: now uses equity
   double   GetTotalOpenRiskPct(const ulong magic);

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

CRiskManager::~CRiskManager()
{
   if(m_atr_handle != INVALID_HANDLE)
      IndicatorRelease(m_atr_handle);
}

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
         " | Risk/trade=", m_params.risk_pct_per_trade, "%",
         " | BE buffer=", m_params.breakeven_buffer_pts, "pts");
   return true;
}

void CRiskManager::RefreshDailyBaseline()
{
   datetime today = (datetime)(TimeCurrent() / 86400 * 86400);
   if(today != m_current_day)
   {
      m_current_day          = today;
      m_balance_at_day_start = m_account.Balance();
      Print("RiskManager: New day baseline balance=", m_balance_at_day_start);
   }
}

double CRiskManager::GetATR()
{
   // FIX H8: guard requires at least 2 elements before accessing [1]
   if(CopyBuffer(m_atr_handle, 0, 0, 3, m_atr_buffer) < 2) return 0.0;
   return m_atr_buffer[1];
}

double CRiskManager::CalcLotSize(const double entry_price,
                                 const double stop_loss_price)
{
   double balance  = m_account.Balance();
   double risk_amt = balance * m_params.risk_pct_per_trade / 100.0;
   double sl_dist  = MathAbs(entry_price - stop_loss_price);

   if(sl_dist <= 0.0)
   {
      Print("RiskManager: SL distance is zero — defaulting to min lot");
      return SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_MIN);
   }

   double tick_value = SymbolInfoDouble(m_symbol, SYMBOL_TRADE_TICK_VALUE);
   double tick_size  = SymbolInfoDouble(m_symbol, SYMBOL_TRADE_TICK_SIZE);
   double lot_step   = SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_STEP);
   double min_lot    = SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_MIN);
   double max_lot    = SymbolInfoDouble(m_symbol, SYMBOL_VOLUME_MAX);

   if(tick_size <= 0.0 || tick_value <= 0.0) return min_lot;

   double lots = risk_amt / ((sl_dist / tick_size) * tick_value);
   lots = MathFloor(lots / lot_step) * lot_step;
   lots = MathMax(min_lot, MathMin(max_lot, lots));
   return NormalizeDouble(lots, 2);
}

bool CRiskManager::IsTradingAllowed()
{
   RefreshDailyBaseline();

   double equity = m_account.Equity();
   if(equity > m_peak_equity) m_peak_equity = equity;

   double dd_pct = (m_peak_equity - equity) / m_peak_equity * 100.0;
   if(dd_pct >= m_params.max_drawdown_pct)
   {
      Print("RiskManager: MAX DRAWDOWN BREACH (", DoubleToString(dd_pct, 2),
            "%) — trading halted");
      return false;
   }

   // FIX B2: daily loss now checks equity (catches floating losses)
   double daily_loss = GetDailyLossPct();
   if(daily_loss >= m_params.max_daily_loss_pct)
   {
      Print("RiskManager: DAILY LOSS LIMIT (", DoubleToString(daily_loss, 2),
            "%) — no new entries today");
      return false;
   }

   return true;
}

bool CRiskManager::IsSpreadAcceptable()
{
   double spread = (double)SymbolInfoInteger(m_symbol, SYMBOL_SPREAD);
   return (spread <= m_params.max_spread_pts);
}

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

void CRiskManager::ManageOpenPositions(const ulong magic)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!m_pos.SelectByIndex(i)) continue;
      if(m_pos.Symbol() != m_symbol || m_pos.Magic() != magic) continue;

      ulong  ticket = m_pos.Ticket();
      double entry  = m_pos.PriceOpen();
      ENUM_ORDER_TYPE dir = (m_pos.PositionType() == POSITION_TYPE_BUY)
                            ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;

      MoveToBreakeven(ticket, entry, dir);
      ApplyTrailingStop(ticket, entry, dir);
   }
}

bool CRiskManager::MoveToBreakeven(const ulong ticket,
                                   const double entry,
                                   const ENUM_ORDER_TYPE direction)
{
   if(!m_pos.SelectByTicket(ticket)) return false;

   double atr     = GetATR();
   if(atr <= 0.0) return false;

   double trigger  = m_params.breakeven_trigger_atr * atr;
   double cur_sl   = m_pos.StopLoss();
   double price    = m_pos.PriceCurrent();
   // FIX M1: use configured buffer instead of 1 point to avoid spread stop-out
   double buf      = m_params.breakeven_buffer_pts * SymbolInfoDouble(m_symbol, SYMBOL_POINT);

   if(direction == ORDER_TYPE_BUY)
   {
      double be_level = entry + buf;
      if(price >= entry + trigger && (cur_sl < be_level || cur_sl == 0.0))
      {
         m_trade.PositionModify(ticket, be_level, m_pos.TakeProfit());
         Print("RiskManager: BE set ticket=", ticket, " SL=", be_level);
         return true;
      }
   }
   else
   {
      double be_level = entry - buf;
      if(price <= entry - trigger && (cur_sl > be_level || cur_sl == 0.0))
      {
         m_trade.PositionModify(ticket, be_level, m_pos.TakeProfit());
         Print("RiskManager: BE set ticket=", ticket, " SL=", be_level);
         return true;
      }
   }
   return false;
}

bool CRiskManager::ApplyTrailingStop(const ulong ticket,
                                     const double entry,
                                     const ENUM_ORDER_TYPE direction)
{
   if(!m_pos.SelectByTicket(ticket)) return false;

   double atr   = GetATR();
   if(atr <= 0.0) return false;

   double trail  = m_params.trailing_step_atr * atr;
   double price  = m_pos.PriceCurrent();
   double cur_sl = m_pos.StopLoss();
   double pt     = SymbolInfoDouble(m_symbol, SYMBOL_POINT);

   if(direction == ORDER_TYPE_BUY)
   {
      double new_sl = price - trail;
      if(new_sl > cur_sl + pt)
      {
         m_trade.PositionModify(ticket, new_sl, m_pos.TakeProfit());
         return true;
      }
   }
   else
   {
      double new_sl = price + trail;
      if(cur_sl == 0.0 || new_sl < cur_sl - pt)
      {
         m_trade.PositionModify(ticket, new_sl, m_pos.TakeProfit());
         return true;
      }
   }
   return false;
}

double CRiskManager::GetCurrentDrawdownPct()
{
   double equity = m_account.Equity();
   if(m_peak_equity <= 0.0) return 0.0;
   return MathMax(0.0, (m_peak_equity - equity) / m_peak_equity * 100.0);
}

// FIX B2: uses equity (not closed balance) so floating losses trigger the cap
double CRiskManager::GetDailyLossPct()
{
   RefreshDailyBaseline();
   double equity = m_account.Equity();
   if(m_balance_at_day_start <= 0.0) return 0.0;
   double loss = m_balance_at_day_start - equity;
   return MathMax(0.0, loss / m_balance_at_day_start * 100.0);
}

double CRiskManager::GetTotalOpenRiskPct(const ulong magic)
{
   double total_risk = 0.0;
   double balance    = m_account.Balance();
   if(balance <= 0.0) return 0.0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!m_pos.SelectByIndex(i)) continue;
      if(m_pos.Symbol() != m_symbol || m_pos.Magic() != magic) continue;

      double sl = m_pos.StopLoss();
      if(sl == 0.0)
      {
         Print("RiskManager: WARNING — position ticket=", m_pos.Ticket(),
               " has no SL; excluded from open risk calc");
         continue;
      }

      double entry     = m_pos.PriceOpen();
      double lots      = m_pos.Volume();
      double tick_val  = SymbolInfoDouble(m_symbol, SYMBOL_TRADE_TICK_VALUE);
      double tick_size = SymbolInfoDouble(m_symbol, SYMBOL_TRADE_TICK_SIZE);
      if(tick_size <= 0.0) continue;

      double sl_dist    = MathAbs(entry - sl);
      double risk_money = lots * (sl_dist / tick_size) * tick_val;
      total_risk += risk_money / balance * 100.0;
   }
   return total_risk;
}

#endif // RISK_MANAGER_MQH
