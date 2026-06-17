//+------------------------------------------------------------------+
//|  ICT_GoldTrader.mq5 — ICT Method Expert Advisor for XAU/USD      |
//|  Components: HTF bias → ICT signal engine → news filter →         |
//|              risk manager → adaptive learning → order execution    |
//+------------------------------------------------------------------+
#property copyright "FK Bot Distribution"
#property version   "1.00"
#property description "ICT methodology EA: Order Blocks, FVGs, Liquidity Sweeps"
#property strict

#include "ICT_SignalEngine.mqh"
#include "../Shared/NewsAPI/NewsConnector.mqh"
#include "../Shared/RiskManagement/RiskManager.mqh"
#include "../Shared/Utils/AdaptiveLearning.mqh"

//=== Input Parameters =================================================

//--- Symbol & Timeframes
input string     InpSymbol        = "XAUUSD";    // Symbol
input ENUM_TIMEFRAMES InpExecTF   = PERIOD_M15;  // Execution timeframe
input ENUM_TIMEFRAMES InpHTF      = PERIOD_H4;   // HTF bias timeframe

//--- Risk Management
input double     InpRiskPct       = 1.0;          // Risk % per trade
input double     InpMaxDailyLoss  = 3.0;          // Max daily loss %
input double     InpMaxDrawdown   = 8.0;          // Max drawdown % (equity)
input double     InpMaxOpenRisk   = 5.0;          // Max total open risk %
input int        InpATRPeriod     = 14;           // ATR period
input double     InpATR_SL        = 1.2;          // SL = ATR * N
input double     InpATR_TP1       = 2.0;          // TP1 = ATR * N
input double     InpATR_TP2       = 4.0;          // TP2 = ATR * N
input double     InpPartialClose  = 50.0;         // % to close at TP1
input double     InpBEtrigger     = 1.0;          // Breakeven trigger (ATR)
input double     InpTrailATR      = 1.5;          // Trailing stop (ATR)
input double     InpMaxSpread     = 35.0;         // Max spread (points)
input int        InpMaxPositions  = 2;            // Max concurrent positions

//--- News API
input string     InpNewsAPIKey    = "";           // NewsAPI.org key
input string     InpFREDKey       = "";           // FRED API key
input bool       InpUseNewsFilter = true;         // Enable news filter
input int        InpNewsBlkBefore = 20;           // Blackout min before event
input int        InpNewsBlkAfter  = 15;           // Blackout min after event
input double     InpMinSentiment  = -1;           // Min sentiment (−2 to +2)

//--- Sessions
input bool       InpAllowLondon   = true;         // Trade London Open killzone
input bool       InpAllowNYOpen   = true;         // Trade NY Open killzone
input bool       InpAllowNYPM     = false;        // Trade NY PM killzone
input int        InpGMToffset     = 0;            // Broker server GMT offset

//--- Adaptive learning
input bool       InpAdaptive      = true;         // Enable adaptive thresholds
input double     InpMinConfidence = 0.55;         // Minimum signal confidence
input int        InpAdaptWindow   = 50;           // Rolling trade window

//--- Magic
input ulong      InpMagic         = 10001;        // EA Magic Number

//=== Globals ===========================================================
CICTSignalEngine  g_signal;
CNewsConnector    g_news;
CRiskManager      g_risk;
CAdaptiveLearning g_adapt;
CTrade            g_trade;

datetime g_last_bar  = 0;
ulong    g_open_tickets[];  // track tickets for TP1 partial close

//=======================================================================
int OnInit()
{
   Print("ICT_GoldTrader: Initialising...");

   //--- Signal engine
   if(!g_signal.Init(InpSymbol, InpExecTF, InpHTF))
   {
      Print("ERROR: SignalEngine init failed"); return INIT_FAILED;
   }

   //--- News connector
   if(InpUseNewsFilter)
      g_news.Init(InpNewsAPIKey, InpFREDKey);

   //--- Session filter (configured inside signal engine, replicated here)
   // (SessionFilter is owned by ICTSignalEngine — values passed at init)

   //--- Risk manager
   RiskParams rp;
   rp.risk_pct_per_trade   = InpRiskPct;
   rp.max_daily_loss_pct   = InpMaxDailyLoss;
   rp.max_drawdown_pct     = InpMaxDrawdown;
   rp.max_open_risk_pct    = InpMaxOpenRisk;
   rp.atr_period           = InpATRPeriod;
   rp.atr_sl_multiplier    = InpATR_SL;
   rp.atr_tp1_multiplier   = InpATR_TP1;
   rp.atr_tp2_multiplier   = InpATR_TP2;
   rp.partial_close_pct    = InpPartialClose;
   rp.breakeven_trigger_atr= InpBEtrigger;
   rp.max_spread_pts       = InpMaxSpread;
   rp.max_positions        = InpMaxPositions;
   rp.trailing_step_atr    = InpTrailATR;
   rp.use_news_filter      = InpUseNewsFilter;

   if(!g_risk.Init(InpSymbol, rp))
   {
      Print("ERROR: RiskManager init failed"); return INIT_FAILED;
   }
   g_risk.SetMagic(InpMagic);

   //--- Adaptive learning
   g_adapt.Init(InpAdaptWindow, InpMinConfidence);
   g_adapt.LoadFromFile("ICT_AdaptData.bin");

   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(20);
   g_trade.SetTypeFillingBySymbol(InpSymbol);

   Print("ICT_GoldTrader: Ready. Magic=", InpMagic);
   return INIT_SUCCEEDED;
}

//=======================================================================
void OnDeinit(const int reason)
{
   g_adapt.SaveToFile("ICT_AdaptData.bin");
   Print("ICT_GoldTrader: Deinitialised. Reason=", reason);
}

//=======================================================================
void OnTick()
{
   //--- Only process on new bar (M15/H1 bars, not every tick)
   datetime current_bar = iTime(InpSymbol, InpExecTF, 0);
   if(current_bar == g_last_bar) return;
   g_last_bar = current_bar;

   //--- Manage open positions (breakeven, trailing)
   g_risk.ManageOpenPositions(InpMagic);

   //--- Check TP1 partial closes
   ProcessPartialCloses();

   //--- Check closed trades for adaptive learning
   ScanClosedTrades();

   //--- Guard checks
   if(!g_risk.IsTradingAllowed())      return;
   if(!g_risk.IsSpreadAcceptable())    return;
   if(g_risk.IsMaxPositionsReached(InpMagic)) return;

   //--- News blackout
   if(InpUseNewsFilter &&
      g_news.IsNewsBlackout(InpNewsBlkBefore, InpNewsBlkAfter))
   {
      Print("ICT: News blackout — skipping entry");
      return;
   }

   //--- News sentiment check
   if(InpUseNewsFilter && InpNewsAPIKey != "")
   {
      NewsSentimentResult sent;
      if(g_news.GetGoldSentiment(sent))
      {
         if((double)sent.sentiment < InpMinSentiment)
         {
            Print("ICT: Sentiment=", g_news.SentimentToString(sent.sentiment),
                  " below threshold — skipping");
            return;
         }
      }
   }

   //--- Update market context
   g_signal.UpdateContext();

   //--- Get best signal
   ICTSignal sig;
   if(!g_signal.GetBestSignal(sig)) return;

   //--- Adaptive confidence gate
   double min_conf = InpAdaptive
                     ? g_adapt.GetAdaptedThreshold(sig.type)
                     : InpMinConfidence;
   if(sig.confidence < min_conf)
   {
      Print("ICT: Signal conf=", DoubleToString(sig.confidence, 3),
            " < threshold ", DoubleToString(min_conf, 3), " — skipped");
      return;
   }

   //--- Open risk check
   if(g_risk.GetTotalOpenRiskPct(InpMagic) >= InpMaxOpenRisk) return;

   //--- Position sizing
   double lots = g_risk.CalcLotSize(sig.entry_price, sig.stop_loss);
   if(InpAdaptive) lots *= g_adapt.GetLotScaleFactor();
   lots = NormalizeDouble(lots, 2);

   //--- Execute
   bool ok = false;
   if(sig.is_long)
      ok = g_trade.Buy(lots, InpSymbol, sig.entry_price,
                       sig.stop_loss, sig.take_profit_2, sig.description);
   else
      ok = g_trade.Sell(lots, InpSymbol, sig.entry_price,
                        sig.stop_loss, sig.take_profit_2, sig.description);

   if(ok)
   {
      ulong ticket = g_trade.ResultOrder();
      Print("ICT: ", (sig.is_long ? "BUY" : "SELL"),
            " lots=", lots, " | conf=", DoubleToString(sig.confidence, 3),
            " | SL=", sig.stop_loss,
            " | TP=", sig.take_profit_2,
            " | ", sig.description);
      AddTrackedTicket(ticket);
   }
   else
   {
      Print("ICT: Order failed: ", g_trade.ResultRetcodeDescription());
   }
}

//=======================================================================
void ProcessPartialCloses()
{
   for(int i = ArraySize(g_open_tickets) - 1; i >= 0; i--)
   {
      if(!PositionSelectByTicket(g_open_tickets[i])) continue;

      double entry  = PositionGetDouble(POSITION_PRICE_OPEN);
      double price  = PositionGetDouble(POSITION_PRICE_CURRENT);
      double tp     = PositionGetDouble(POSITION_TP);
      double sl     = PositionGetDouble(POSITION_SL);
      double volume = PositionGetDouble(POSITION_VOLUME);
      ENUM_POSITION_TYPE pt = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

      double half_way_target;
      if(pt == POSITION_TYPE_BUY)
         half_way_target = entry + (tp - entry) * 0.5;
      else
         half_way_target = entry - (entry - tp) * 0.5;

      bool at_tp1 = (pt == POSITION_TYPE_BUY  && price >= half_way_target) ||
                    (pt == POSITION_TYPE_SELL && price <= half_way_target);

      if(at_tp1 && volume > SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MIN))
      {
         double close_lots = NormalizeDouble(volume * InpPartialClose / 100.0, 2);
         double min_lot    = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MIN);
         if(close_lots >= min_lot)
         {
            g_trade.PositionClosePartial(g_open_tickets[i], close_lots);
            Print("ICT: Partial close ", close_lots, " lots on ticket ", g_open_tickets[i]);
         }
      }
   }
}

//=======================================================================
void AddTrackedTicket(const ulong ticket)
{
   int n = ArraySize(g_open_tickets);
   ArrayResize(g_open_tickets, n + 1);
   g_open_tickets[n] = ticket;
}

//=======================================================================
void ScanClosedTrades()
{
   HistorySelect(TimeCurrent() - 86400, TimeCurrent());
   int deals = HistoryDealsTotal();
   static int last_deal_count = 0;
   if(deals == last_deal_count) return;

   for(int i = last_deal_count; i < deals; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(HistoryDealGetInteger(ticket, DEAL_MAGIC) != (long)InpMagic) continue;
      if(HistoryDealGetInteger(ticket, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;

      double profit = HistoryDealGetDouble(ticket, DEAL_PROFIT);
      datetime ot   = (datetime)HistoryDealGetInteger(ticket, DEAL_TIME);

      g_adapt.RecordTrade(ot, TimeCurrent(),
                          profit / SymbolInfoDouble(InpSymbol, SYMBOL_TRADE_TICK_VALUE),
                          ICT_OB_BULLISH,   // simplified: real impl maps comment → type
                          InpMinConfidence);
   }
   last_deal_count = deals;
}

//=======================================================================
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   // Capture fill confirmations for logging
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD &&
      trans.deal_type == DEAL_TYPE_BUY || trans.deal_type == DEAL_TYPE_SELL)
   {
      Print("ICT: Trade transaction — deal=", trans.deal,
            " order=", trans.order, " price=", trans.price);
   }
}
