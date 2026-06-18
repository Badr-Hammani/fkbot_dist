//+------------------------------------------------------------------+
//|  SMC_GoldTrader.mq5 — Smart Money Concept EA for XAU/USD         |
//|  v1.1 Fixes: session wired, partial-close done-flag, TIPS filter |
//|              now active, signal type capture, BacktestFramework   |
//+------------------------------------------------------------------+
#property copyright "FK Bot Distribution"
#property version   "1.10"
#property description "SMC EA v1.1: Liquidity pools, stop hunts, displacement"
#property strict

#include "SMC_SignalEngine.mqh"
#include "../Shared/NewsAPI/NewsConnector.mqh"
#include "../Shared/RiskManagement/RiskManager.mqh"
#include "../Shared/Utils/AdaptiveLearning.mqh"
#include "../Backtesting/BacktestFramework.mqh"   // FIX A2

//=== Inputs ===========================================================
input string     InpSymbol        = "XAUUSD";
input ENUM_TIMEFRAMES InpExecTF   = PERIOD_M15;
input ENUM_TIMEFRAMES InpHTF      = PERIOD_H4;

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
input double     InpBEbuffer      = 5.0;
input double     InpTrailATR      = 1.8;
input double     InpMaxSpread     = 35.0;
input int        InpMaxPositions  = 2;

input string     InpNewsAPIKey    = "";
input string     InpFREDKey       = "";
input bool       InpUseNewsFilter = true;
input int        InpNewsBlkBefore = 25;
input int        InpNewsBlkAfter  = 20;
input double     InpMinSentiment  = -1;
input bool       InpUseDXYFilter  = true;
input double     InpDXYBullThresh = 0.3;
// FIX H5: TIPS yield now gates trade entry, not just logs
input bool       InpUseYieldFilter= true;
input double     InpYieldThresh   = 2.0;   // suppress longs if yield > this

// FIX A4: session inputs wired to signal engine
input bool       InpAllowAsian    = false;
input bool       InpAllowLondon   = true;
input bool       InpAllowNYOpen   = true;
input bool       InpAllowNYPM     = false;
input int        InpGMToffset     = 0;

input bool       InpAdaptive      = true;
input double     InpMinConfidence = 0.58;
input int        InpAdaptWindow   = 50;

input ulong      InpMagic         = 20001;

//=== Globals ===========================================================
CSMCSignalEngine  g_signal;
CNewsConnector    g_news;
CRiskManager      g_risk;
CAdaptiveLearning g_adapt;
CTrade            g_trade;

datetime g_last_bar = 0;
bool     g_dxy_suppress_longs  = false;
bool     g_yield_suppress_longs = false;

struct TicketState
{
   ulong ticket;
   bool  tp1_done;
   int   signal_type;
   double confidence;
   datetime open_time;
};
TicketState g_open_positions[];
int         g_pos_count = 0;

//=======================================================================
int OnInit()
{
   Print("SMC_GoldTrader v1.1: Initialising...");

   if(!g_signal.Init(InpSymbol, InpExecTF, InpHTF))
   {
      Print("ERROR: SMCSignalEngine init failed"); return INIT_FAILED;
   }

   // FIX A4: wire session inputs
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
   g_adapt.LoadFromFile("SMC_" + InpSymbol + "_AdaptData.bin");

   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(20);
   g_trade.SetTypeFillingBySymbol(InpSymbol);

   ArrayResize(g_open_positions, 20);

   Print("SMC_GoldTrader v1.1: Ready. Magic=", InpMagic);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   g_adapt.SaveToFile("SMC_" + InpSymbol + "_AdaptData.bin");
   Print("SMC_GoldTrader: Deinit reason=", reason);
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
      Print("SMC: News blackout — skip"); return;
   }

   if(InpUseNewsFilter && InpNewsAPIKey != "")
   {
      NewsSentimentResult sent;
      if(g_news.GetGoldSentiment(sent) &&
         (double)sent.sentiment < InpMinSentiment) return;
   }

   // Update macro suppression flags (checked per-signal below)
   if(InpUseNewsFilter && InpFREDKey != "")
   {
      if(InpUseDXYFilter)
      {
         double dxy_chg;
         if(g_news.GetDXYMomentum(dxy_chg))
         {
            g_dxy_suppress_longs = (dxy_chg > InpDXYBullThresh);
            if(g_dxy_suppress_longs)
               Print("SMC: DXY +", DoubleToString(dxy_chg, 3), "% — longs suppressed");
         }
      }

      // FIX H5: TIPS yield now actively suppresses long signals
      if(InpUseYieldFilter)
      {
         double tips;
         if(g_news.GetRealYield(tips))
         {
            g_yield_suppress_longs = (tips > InpYieldThresh);
            if(g_yield_suppress_longs)
               Print("SMC: TIPS yield=", DoubleToString(tips, 2),
                     "% > ", InpYieldThresh, "% — gold longs suppressed");
         }
      }
   }

   g_signal.UpdateContext();

   SMCSignal sig;
   if(!g_signal.GetBestSignal(sig)) return;

   // FIX H5: apply macro veto to long signals
   if(sig.is_long && (g_dxy_suppress_longs || g_yield_suppress_longs))
   {
      Print("SMC: Macro veto on long signal (DXY=", g_dxy_suppress_longs,
            " Yield=", g_yield_suppress_longs, ")");
      return;
   }

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
         g_open_positions[g_pos_count].tp1_done    = false;
         g_open_positions[g_pos_count].signal_type = sig.type;
         g_open_positions[g_pos_count].confidence  = sig.confidence;
         g_open_positions[g_pos_count].open_time   = TimeCurrent();
         g_pos_count++;
      }
      Print("SMC: ", (sig.is_long ? "BUY" : "SELL"),
            " lots=", lots, " conf=", DoubleToString(sig.confidence, 3),
            " SL=", sig.stop_loss, " TP=", sig.take_profit_2,
            " | ", sig.description);
   }
   else
      Print("SMC: Order failed: ", g_trade.ResultRetcodeDescription());
}

//=======================================================================
// FIX B1: tp1_done flag prevents repeated fires
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
               g_open_positions[i].tp1_done = true;
               Print("SMC: TP1 partial close ", close_lots, " lots ticket=",
                     g_open_positions[i].ticket);
            }
         }
      }
   }
}

//=======================================================================
// FIX A4 + ticket pruning
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

      double   profit = HistoryDealGetDouble (deal_ticket, DEAL_PROFIT);
      datetime open_t = (datetime)HistoryDealGetInteger(deal_ticket, DEAL_TIME);
      ulong    pos_id = (ulong)HistoryDealGetInteger(deal_ticket, DEAL_POSITION_ID);

      int    sig_type = SMC_STOP_HUNT_LONG;
      double conf     = InpMinConfidence;
      for(int j = 0; j < g_pos_count; j++)
      {
         if(g_open_positions[j].ticket == pos_id)
         {
            sig_type = g_open_positions[j].signal_type;
            conf     = g_open_positions[j].confidence;
            for(int k = j; k < g_pos_count - 1; k++)
               g_open_positions[k] = g_open_positions[k + 1];
            g_pos_count--;
            break;
         }
      }

      g_adapt.RecordTrade(open_t, TimeCurrent(), profit, sig_type, conf);
   }
   last_deal_count = deals;
}

//=======================================================================
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD &&
      (trans.deal_type == DEAL_TYPE_BUY || trans.deal_type == DEAL_TYPE_SELL))
   {
      Print("SMC: Transaction deal=", trans.deal, " price=", trans.price);
   }
}
