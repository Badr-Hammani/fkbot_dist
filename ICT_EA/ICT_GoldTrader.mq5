//+------------------------------------------------------------------+
//|  ICT_GoldTrader.mq5 — ICT Method Expert Advisor for XAU/USD      |
//|  v1.1 Fixes: session wired, partial-close done-flag, ticket prune,|
//|              signal type capture, OnTradeTransaction precedence,  |
//|              BacktestFramework included                           |
//+------------------------------------------------------------------+
#property copyright "FK Bot Distribution"
#property version   "1.10"
#property description "ICT EA v1.1: OBs, FVGs, Liquidity Sweeps, Silver Bullet"
#property strict

#include "ICT_SignalEngine.mqh"
#include "../Shared/NewsAPI/NewsConnector.mqh"
#include "../Shared/RiskManagement/RiskManager.mqh"
#include "../Shared/Utils/AdaptiveLearning.mqh"
#include "../Backtesting/BacktestFramework.mqh"   // FIX A2: now included

//=== Inputs ===========================================================
input string     InpSymbol        = "XAUUSD";
input ENUM_TIMEFRAMES InpExecTF   = PERIOD_M15;
input ENUM_TIMEFRAMES InpHTF      = PERIOD_H4;

input double     InpRiskPct       = 1.0;
input double     InpMaxDailyLoss  = 3.0;
input double     InpMaxDrawdown   = 8.0;
input double     InpMaxOpenRisk   = 5.0;
input int        InpATRPeriod     = 14;
input double     InpATR_SL        = 1.2;
input double     InpATR_TP1       = 2.0;
input double     InpATR_TP2       = 4.0;
input double     InpPartialClose  = 50.0;
input double     InpBEtrigger     = 1.0;
input double     InpBEbuffer      = 5.0;     // FIX M1: BE buffer in points
input double     InpTrailATR      = 1.5;
input double     InpMaxSpread     = 35.0;
input int        InpMaxPositions  = 2;

input string     InpNewsAPIKey    = "";
input string     InpFREDKey       = "";
input bool       InpUseNewsFilter = true;
input int        InpNewsBlkBefore = 20;
input int        InpNewsBlkAfter  = 15;
input double     InpMinSentiment  = -1;

// FIX A4: session inputs now wired into signal engine
input bool       InpAllowAsian    = false;
input bool       InpAllowLondon   = true;
input bool       InpAllowNYOpen   = true;
input bool       InpAllowNYPM     = false;
input int        InpGMToffset     = 0;

input bool       InpAdaptive      = true;
input double     InpMinConfidence = 0.55;
input int        InpAdaptWindow   = 50;

input ulong      InpMagic         = 10001;

//=== Globals ===========================================================
CICTSignalEngine  g_signal;
CNewsConnector    g_news;
CRiskManager      g_risk;
CAdaptiveLearning g_adapt;
CTrade            g_trade;

datetime g_last_bar = 0;

struct TicketState
{
   ulong ticket;
   bool  tp1_done;    // FIX B1: flag prevents repeated partial closes
   int   signal_type; // FIX A4: store the signal type for adaptive learning
   double confidence;
   datetime open_time;
};
TicketState g_open_positions[];
int         g_pos_count = 0;

//=======================================================================
int OnInit()
{
   Print("ICT_GoldTrader v1.1: Initialising...");

   if(!g_signal.Init(InpSymbol, InpExecTF, InpHTF))
   {
      Print("ERROR: SignalEngine init failed"); return INIT_FAILED;
   }

   // FIX A4: wire session inputs into the signal engine's session filter
   g_signal.ConfigureSession(InpAllowAsian, InpAllowLondon,
                              InpAllowNYOpen, InpAllowNYPM, InpGMToffset);

   if(InpUseNewsFilter)
      g_news.Init(InpNewsAPIKey, InpFREDKey, InpSymbol);

   RiskParams rp;
   rp.risk_pct_per_trade    = InpRiskPct;
   rp.max_daily_loss_pct    = InpMaxDailyLoss;
   rp.max_drawdown_pct      = InpMaxDrawdown;
   rp.max_open_risk_pct     = InpMaxOpenRisk;
   rp.atr_period            = InpATRPeriod;
   rp.atr_sl_multiplier     = InpATR_SL;
   rp.atr_tp1_multiplier    = InpATR_TP1;
   rp.atr_tp2_multiplier    = InpATR_TP2;
   rp.partial_close_pct     = InpPartialClose;
   rp.breakeven_trigger_atr = InpBEtrigger;
   rp.breakeven_buffer_pts  = InpBEbuffer;
   rp.max_spread_pts        = InpMaxSpread;
   rp.max_positions         = InpMaxPositions;
   rp.trailing_step_atr     = InpTrailATR;
   rp.use_news_filter       = InpUseNewsFilter;

   if(!g_risk.Init(InpSymbol, rp))
   {
      Print("ERROR: RiskManager init failed"); return INIT_FAILED;
   }
   g_risk.SetMagic(InpMagic);

   g_adapt.Init(InpAdaptWindow, InpMinConfidence);
   g_adapt.LoadFromFile("ICT_" + InpSymbol + "_AdaptData.bin");

   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(20);
   g_trade.SetTypeFillingBySymbol(InpSymbol);

   ArrayResize(g_open_positions, 20);

   Print("ICT_GoldTrader v1.1: Ready. Magic=", InpMagic);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   g_adapt.SaveToFile("ICT_" + InpSymbol + "_AdaptData.bin");
   Print("ICT_GoldTrader: Deinit reason=", reason);
}

//=======================================================================
void OnTick()
{
   datetime current_bar = iTime(InpSymbol, InpExecTF, 0);
   if(current_bar == g_last_bar) return;
   g_last_bar = current_bar;

   g_risk.ManageOpenPositions(InpMagic);
   ProcessPartialCloses();
   ScanClosedTrades();

   if(!g_risk.IsTradingAllowed())            return;
   if(!g_risk.IsSpreadAcceptable())           return;
   if(g_risk.IsMaxPositionsReached(InpMagic)) return;

   if(InpUseNewsFilter &&
      g_news.IsNewsBlackout(InpNewsBlkBefore, InpNewsBlkAfter))
   {
      Print("ICT: News blackout — skip"); return;
   }

   if(InpUseNewsFilter && InpNewsAPIKey != "")
   {
      NewsSentimentResult sent;
      if(g_news.GetGoldSentiment(sent) &&
         (double)sent.sentiment < InpMinSentiment) return;
   }

   g_signal.UpdateContext();

   ICTSignal sig;
   if(!g_signal.GetBestSignal(sig)) return;

   double min_conf = InpAdaptive
                     ? g_adapt.GetAdaptedThreshold(sig.type)
                     : InpMinConfidence;
   if(sig.confidence < min_conf) return;

   if(g_risk.GetTotalOpenRiskPct(InpMagic) >= InpMaxOpenRisk) return;

   double lots = g_risk.CalcLotSize(sig.entry_price, sig.stop_loss);
   if(InpAdaptive) lots = NormalizeDouble(lots * g_adapt.GetLotScaleFactor(), 2);
   lots = MathMax(SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MIN), lots);

   bool ok = sig.is_long
             ? g_trade.Buy (lots, InpSymbol, sig.entry_price,
                            sig.stop_loss, sig.take_profit_2, sig.description)
             : g_trade.Sell(lots, InpSymbol, sig.entry_price,
                            sig.stop_loss, sig.take_profit_2, sig.description);

   if(ok)
   {
      ulong ticket = g_trade.ResultOrder();
      if(g_pos_count < ArraySize(g_open_positions))
      {
         g_open_positions[g_pos_count].ticket      = ticket;
         g_open_positions[g_pos_count].tp1_done    = false;     // FIX B1
         g_open_positions[g_pos_count].signal_type = sig.type;  // FIX A4
         g_open_positions[g_pos_count].confidence  = sig.confidence;
         g_open_positions[g_pos_count].open_time   = TimeCurrent();
         g_pos_count++;
      }
      Print("ICT: ", (sig.is_long ? "BUY" : "SELL"),
            " lots=", lots, " conf=", DoubleToString(sig.confidence, 3),
            " SL=", sig.stop_loss, " TP=", sig.take_profit_2,
            " | ", sig.description);
   }
   else
      Print("ICT: Order failed: ", g_trade.ResultRetcodeDescription());
}

//=======================================================================
// FIX B1: uses tp1_done flag — fires only ONCE per position
void ProcessPartialCloses()
{
   for(int i = 0; i < g_pos_count; i++)
   {
      if(g_open_positions[i].tp1_done) continue;
      if(!PositionSelectByTicket(g_open_positions[i].ticket)) continue;

      double entry  = PositionGetDouble(POSITION_PRICE_OPEN);
      double price  = PositionGetDouble(POSITION_PRICE_CURRENT);
      double tp     = PositionGetDouble(POSITION_TP);
      double volume = PositionGetDouble(POSITION_VOLUME);
      ENUM_POSITION_TYPE pt = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

      double half_target = (pt == POSITION_TYPE_BUY)
                          ? entry + (tp - entry) * 0.5
                          : entry - (entry - tp) * 0.5;

      bool reached = (pt == POSITION_TYPE_BUY  && price >= half_target) ||
                     (pt == POSITION_TYPE_SELL && price <= half_target);

      if(reached)
      {
         double close_lots = NormalizeDouble(volume * InpPartialClose / 100.0, 2);
         double min_lot    = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MIN);
         if(close_lots >= min_lot)
         {
            if(g_trade.PositionClosePartial(g_open_positions[i].ticket, close_lots))
            {
               g_open_positions[i].tp1_done = true;   // FIX B1: mark done
               Print("ICT: TP1 partial close ", close_lots, " lots ticket=",
                     g_open_positions[i].ticket);
            }
         }
      }
   }
}

//=======================================================================
// FIX A4: capture actual signal type from g_open_positions (not hardcoded)
// FIX: prune fully-closed tickets from the tracking array
void ScanClosedTrades()
{
   datetime from = TimeCurrent() - 86400;
   if(!HistorySelect(from, TimeCurrent())) return;
   int deals = HistoryDealsTotal();
   static int last_deal_count = 0;
   if(deals == last_deal_count) return;

   for(int i = last_deal_count; i < deals; i++)
   {
      ulong deal_ticket = HistoryDealGetTicket(i);
      if(HistoryDealGetInteger(deal_ticket, DEAL_MAGIC) != (long)InpMagic) continue;
      if(HistoryDealGetInteger(deal_ticket, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;

      double   profit   = HistoryDealGetDouble (deal_ticket, DEAL_PROFIT);
      datetime open_t   = (datetime)HistoryDealGetInteger(deal_ticket, DEAL_TIME);
      ulong    pos_id   = (ulong)HistoryDealGetInteger(deal_ticket, DEAL_POSITION_ID);

      // Find matching position state to get signal type
      int  sig_type = ICT_OB_BULLISH;  // fallback
      double conf   = InpMinConfidence;
      for(int j = 0; j < g_pos_count; j++)
      {
         if(g_open_positions[j].ticket == pos_id)
         {
            sig_type = g_open_positions[j].signal_type;
            conf     = g_open_positions[j].confidence;
            // FIX: remove closed ticket from array
            for(int k = j; k < g_pos_count - 1; k++)
               g_open_positions[k] = g_open_positions[k + 1];
            g_pos_count--;
            break;
         }
      }

      g_adapt.RecordTrade(open_t, TimeCurrent(), profit,
                          sig_type, conf);
   }
   last_deal_count = deals;
}

//=======================================================================
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   // FIX H9: correct operator precedence with explicit parentheses
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD &&
      (trans.deal_type == DEAL_TYPE_BUY || trans.deal_type == DEAL_TYPE_SELL))
   {
      Print("ICT: Transaction deal=", trans.deal, " price=", trans.price);
   }
}
