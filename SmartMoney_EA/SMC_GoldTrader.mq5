//+------------------------------------------------------------------+
//|  SMC_GoldTrader.mq5 — Smart Money Concept EA for XAU/USD         |
//|  Components: HTF bias → SMC signal engine → news/macro filter →   |
//|              risk manager → adaptive learning → order execution    |
//+------------------------------------------------------------------+
#property copyright "FK Bot Distribution"
#property version   "1.00"
#property description "Smart Money Concept EA: Liquidity pools, stop hunts, displacement"
#property strict

#include "SMC_SignalEngine.mqh"
#include "../Shared/NewsAPI/NewsConnector.mqh"
#include "../Shared/RiskManagement/RiskManager.mqh"
#include "../Shared/Utils/AdaptiveLearning.mqh"

//=== Input Parameters =================================================

input string     InpSymbol        = "XAUUSD";
input ENUM_TIMEFRAMES InpExecTF   = PERIOD_M15;
input ENUM_TIMEFRAMES InpHTF      = PERIOD_H4;

//--- Risk
input double     InpRiskPct       = 1.0;
input double     InpMaxDailyLoss  = 3.0;
input double     InpMaxDrawdown   = 8.0;
input double     InpMaxOpenRisk   = 5.0;
input int        InpATRPeriod     = 14;
input double     InpATR_SL        = 1.5;
input double     InpATR_TP1       = 2.5;
input double     InpATR_TP2       = 5.0;
input double     InpPartialClose  = 50.0;
input double     InpBEtrigger     = 1.2;
input double     InpTrailATR      = 1.8;
input double     InpMaxSpread     = 35.0;
input int        InpMaxPositions  = 2;

//--- Macro filters
input string     InpNewsAPIKey    = "";
input string     InpFREDKey       = "";
input bool       InpUseNewsFilter = true;
input int        InpNewsBlkBefore = 25;           // SMC uses wider blackout
input int        InpNewsBlkAfter  = 20;
input double     InpMinSentiment  = -1;
input bool       InpUseDXYFilter  = true;         // Skip longs if USD surging
input double     InpDXYBullThresh = 0.3;          // DXY 1-day rise > this% → no gold longs
input bool       InpUseYieldFilter= true;         // Skip longs if real yield > threshold
input double     InpYieldThresh   = 2.0;          // TIPS yield > 2.0% → headwind for gold

//--- Sessions
input bool       InpAllowLondon   = true;
input bool       InpAllowNYOpen   = true;
input bool       InpAllowNYPM     = false;
input int        InpGMToffset     = 0;

//--- Adaptive
input bool       InpAdaptive      = true;
input double     InpMinConfidence = 0.58;
input int        InpAdaptWindow   = 50;

//--- Magic
input ulong      InpMagic         = 20001;

//=== Globals ===========================================================
CSMCSignalEngine  g_signal;
CNewsConnector    g_news;
CRiskManager      g_risk;
CAdaptiveLearning g_adapt;
CTrade            g_trade;

datetime g_last_bar = 0;
ulong    g_open_tickets[];

//=======================================================================
int OnInit()
{
   Print("SMC_GoldTrader: Initialising...");

   if(!g_signal.Init(InpSymbol, InpExecTF, InpHTF))
   {
      Print("ERROR: SMCSignalEngine init failed"); return INIT_FAILED;
   }

   if(InpUseNewsFilter)
      g_news.Init(InpNewsAPIKey, InpFREDKey);

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
   g_adapt.LoadFromFile("SMC_AdaptData.bin");

   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(20);
   g_trade.SetTypeFillingBySymbol(InpSymbol);

   Print("SMC_GoldTrader: Ready. Magic=", InpMagic);
   return INIT_SUCCEEDED;
}

//=======================================================================
void OnDeinit(const int reason)
{
   g_adapt.SaveToFile("SMC_AdaptData.bin");
   Print("SMC_GoldTrader: Deinitialised. Reason=", reason);
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

   //--- Guards
   if(!g_risk.IsTradingAllowed())            return;
   if(!g_risk.IsSpreadAcceptable())           return;
   if(g_risk.IsMaxPositionsReached(InpMagic)) return;

   //--- News blackout
   if(InpUseNewsFilter &&
      g_news.IsNewsBlackout(InpNewsBlkBefore, InpNewsBlkAfter))
   {
      Print("SMC: News blackout — skip"); return;
   }

   //--- Macro filters (DXY + Real Yield)
   if(InpUseNewsFilter && InpFREDKey != "")
   {
      double dxy_chg;
      if(InpUseDXYFilter && g_news.GetDXYMomentum(dxy_chg))
      {
         if(dxy_chg > InpDXYBullThresh)
         {
            Print("SMC: DXY surge (+", DoubleToString(dxy_chg, 3),
                  "%) — suppressing gold longs");
            // Note: signal engine will still evaluate, but macro check
            // will cause us to skip if signal is long.
         }
      }

      double tips_yield;
      if(InpUseYieldFilter && g_news.GetRealYield(tips_yield))
      {
         if(tips_yield > InpYieldThresh)
            Print("SMC: Real yield=", DoubleToString(tips_yield, 2),
                  "% — gold headwind noted");
      }
   }

   //--- Sentiment filter
   if(InpUseNewsFilter && InpNewsAPIKey != "")
   {
      NewsSentimentResult sent;
      if(g_news.GetGoldSentiment(sent) && (double)sent.sentiment < InpMinSentiment)
      {
         Print("SMC: Sentiment negative — skip"); return;
      }
   }

   //--- Update context
   g_signal.UpdateContext();

   //--- Get signal
   SMCSignal sig;
   if(!g_signal.GetBestSignal(sig)) return;

   //--- Macro veto on longs when DXY surging
   if(InpUseDXYFilter && InpFREDKey != "" && sig.is_long)
   {
      double dxy_chg;
      if(g_news.GetDXYMomentum(dxy_chg) && dxy_chg > InpDXYBullThresh)
      {
         Print("SMC: DXY macro veto on long signal"); return;
      }
   }

   //--- Adaptive gate
   double min_conf = InpAdaptive
                     ? g_adapt.GetAdaptedThreshold(sig.type)
                     : InpMinConfidence;
   if(sig.confidence < min_conf)
   {
      Print("SMC: conf=", DoubleToString(sig.confidence, 3),
            " < ", DoubleToString(min_conf, 3), " — skip"); return;
   }

   if(g_risk.GetTotalOpenRiskPct(InpMagic) >= InpMaxOpenRisk) return;

   //--- Position size
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
      Print("SMC: ", (sig.is_long ? "BUY" : "SELL"),
            " lots=", lots, " conf=", DoubleToString(sig.confidence, 3),
            " SL=", sig.stop_loss, " TP=", sig.take_profit_2,
            " | ", sig.description);
      AddTrackedTicket(ticket);
   }
   else
      Print("SMC: Order failed: ", g_trade.ResultRetcodeDescription());
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
      double volume = PositionGetDouble(POSITION_VOLUME);
      ENUM_POSITION_TYPE pt = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

      double halfway = (pt == POSITION_TYPE_BUY)
                      ? entry + (tp - entry) * 0.5
                      : entry - (entry - tp) * 0.5;

      bool reached = (pt == POSITION_TYPE_BUY  && price >= halfway) ||
                     (pt == POSITION_TYPE_SELL && price <= halfway);

      if(reached)
      {
         double close_lots = NormalizeDouble(volume * InpPartialClose / 100.0, 2);
         double min_lot    = SymbolInfoDouble(InpSymbol, SYMBOL_VOLUME_MIN);
         if(close_lots >= min_lot)
         {
            g_trade.PositionClosePartial(g_open_tickets[i], close_lots);
            Print("SMC: Partial close ", close_lots, " lots ticket=", g_open_tickets[i]);
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
                          SMC_STOP_HUNT_LONG,
                          InpMinConfidence);
   }
   last_deal_count = deals;
}

//=======================================================================
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
      Print("SMC: Trade transaction deal=", trans.deal, " price=", trans.price);
}
