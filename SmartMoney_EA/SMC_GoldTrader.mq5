//+------------------------------------------------------------------+
//|  SMC_GoldTrader.mq5 — Smart Money Concept EA for XAU/USD         |
//|  v1.2 — Profitability pass: TradeFilter (D1 EMA + RSI + ATR       |
//|          regime + day-of-week), confidence bonus from environment, |
//|          time-based exit, performance CSV logger, DXY/TIPS veto   |
//+------------------------------------------------------------------+
#property copyright "FK Bot Distribution"
#property version   "1.20"
#property description "SMC EA v1.2: Liquidity pools, stop hunts, displacement"
#property strict

#include "SMC_SignalEngine.mqh"
#include "../Shared/NewsAPI/NewsConnector.mqh"
#include "../Shared/RiskManagement/RiskManager.mqh"
#include "../Shared/Utils/AdaptiveLearning.mqh"
#include "../Shared/Utils/TradeFilter.mqh"
#include "../Shared/Utils/PerformanceLogger.mqh"
#include "../Backtesting/BacktestFramework.mqh"

//=== Inputs ===========================================================
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
input double     InpBEbuffer      = 5.0;
input double     InpTrailATR      = 1.8;
input double     InpMaxSpread     = 35.0;
input int        InpMaxPositions  = 2;

//--- Time-based exit: close losing position after N bars if not at TP1
input int        InpMaxBarsHeld   = 96;       // e.g. 96 x M15 = 24 hours
input bool       InpUseTimeExit   = true;

//--- Trade filter
input int        InpD1EmaPeriod   = 50;       // D1 EMA for macro trend
input int        InpRSIPeriod     = 14;
input double     InpRSI_OB        = 70.0;     // overbought → no long
input double     InpRSI_OS        = 30.0;     // oversold → no short
input double     InpATRRegimePct  = 0.90;     // suppress above 90th ATR percentile
input bool       InpAllowMonday   = true;
input bool       InpAllowFridayPM = false;
input bool       InpUseTrendFilter= true;     // require D1 EMA alignment

//--- News
input string     InpNewsAPIKey    = "";
input string     InpFREDKey       = "";
input bool       InpUseNewsFilter = true;
input int        InpNewsBlkBefore = 25;
input int        InpNewsBlkAfter  = 20;
input double     InpMinSentiment  = -1;
input bool       InpUseDXYFilter  = true;
input double     InpDXYBullThresh = 0.3;
input bool       InpUseYieldFilter= true;
input double     InpYieldThresh   = 2.0;   // suppress longs if TIPS yield > this

//--- Sessions
input bool       InpAllowAsian    = false;
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
CTradeFilter      g_filter;
CPerformanceLogger g_logger;
CTrade            g_trade;

datetime g_last_bar            = 0;
bool     g_dxy_suppress_longs  = false;
bool     g_yield_suppress_longs = false;

struct TicketState
{
   ulong    ticket;
   bool     tp1_done;
   int      signal_type;
   double   confidence;
   double   env_score;
   datetime open_time;
   bool     is_long;
   double   entry_price;
   double   stop_loss;
   double   take_profit;
   string   description;
   int      bars_held;
};
TicketState g_positions[];
int         g_pos_count = 0;

//=======================================================================
int OnInit()
{
   Print("SMC_GoldTrader v1.2: Initialising...");

   if(!g_signal.Init(InpSymbol, InpExecTF, InpHTF))
   { Print("ERROR: SMCSignalEngine init failed"); return INIT_FAILED; }

   g_signal.ConfigureSession(InpAllowAsian, InpAllowLondon,
                              InpAllowNYOpen, InpAllowNYPM, InpGMToffset);

   if(InpUseNewsFilter)
      g_news.Init(InpNewsAPIKey, InpFREDKey, InpSymbol);

   if(!g_filter.Init(InpSymbol, InpExecTF,
                     InpD1EmaPeriod, InpRSIPeriod,
                     InpRSI_OB, InpRSI_OS, InpATRRegimePct,
                     InpAllowMonday, InpAllowFridayPM))
   { Print("ERROR: TradeFilter init failed"); return INIT_FAILED; }

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
   { Print("ERROR: RiskManager init failed"); return INIT_FAILED; }
   g_risk.SetMagic(InpMagic);

   g_adapt.Init(InpAdaptWindow, InpMinConfidence);
   g_adapt.LoadFromFile("SMC_" + InpSymbol + "_AdaptData.bin");

   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(20);
   g_trade.SetTypeFillingBySymbol(InpSymbol);

   g_logger.Init("SMC", InpSymbol);

   ArrayResize(g_positions, 20);
   Print("SMC_GoldTrader v1.2: Ready. Magic=", InpMagic);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   g_adapt.SaveToFile("SMC_" + InpSymbol + "_AdaptData.bin");
   g_logger.Close();
   Print("SMC_GoldTrader: Deinit reason=", reason);
}

//=======================================================================
void OnTick()
{
   datetime current_bar = iTime(InpSymbol, InpExecTF, 0);
   if(current_bar == g_last_bar) return;
   g_last_bar = current_bar;

   // Increment bar counters for time-based exit
   for(int i = 0; i < g_pos_count; i++) g_positions[i].bars_held++;

   g_risk.ManageOpenPositions(InpMagic);
   ProcessPartialCloses();
   ProcessTimeBasedExits();
   ScanClosedTrades();

   if(!g_risk.IsTradingAllowed())            return;
   if(!g_risk.IsSpreadAcceptable())           return;
   if(g_risk.IsMaxPositionsReached(InpMagic)) return;

   if(InpUseNewsFilter &&
      g_news.IsNewsBlackout(InpNewsBlkBefore, InpNewsBlkAfter))
   { Print("SMC: News blackout — skip"); return; }

   if(InpUseNewsFilter && InpNewsAPIKey != "")
   {
      NewsSentimentResult sent;
      if(g_news.GetGoldSentiment(sent) &&
         (double)sent.sentiment < InpMinSentiment) return;
   }

   // Update macro suppression flags
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

   // Macro veto on long signals
   if(sig.is_long && (g_dxy_suppress_longs || g_yield_suppress_longs))
   {
      Print("SMC: Macro veto on long (DXY=", g_dxy_suppress_longs,
            " Yield=", g_yield_suppress_longs, ")");
      return;
   }

   // TradeFilter evaluation
   FilterResult flt = g_filter.Evaluate(sig.is_long);
   if(!flt.allowed)
   {
      Print("SMC: TradeFilter blocked — ", flt.reason); return;
   }

   // D1 trend alignment as hard gate (configurable)
   if(InpUseTrendFilter)
   {
      bool bull_d1 = g_filter.IsDailyTrendBullish();
      bool bear_d1 = g_filter.IsDailyTrendBearish();
      if(sig.is_long  && !bull_d1)
      { Print("SMC: D1 trend bearish — skip long"); return; }
      if(!sig.is_long && !bear_d1)
      { Print("SMC: D1 trend bullish — skip short"); return; }
   }

   // Boost confidence with environment quality
   double env_bonus  = g_filter.GetConfidenceBonus(sig.is_long);
   double final_conf = sig.confidence + env_bonus;

   double min_conf = InpAdaptive
                     ? g_adapt.GetAdaptedThreshold(sig.type)
                     : InpMinConfidence;
   if(final_conf < min_conf)
   {
      Print("SMC: conf=", DoubleToString(final_conf, 3),
            " < ", DoubleToString(min_conf, 3), " — skip"); return;
   }

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
      if(g_pos_count < ArraySize(g_positions))
      {
         g_positions[g_pos_count].ticket      = ticket;
         g_positions[g_pos_count].tp1_done    = false;
         g_positions[g_pos_count].signal_type = sig.type;
         g_positions[g_pos_count].confidence  = final_conf;
         g_positions[g_pos_count].env_score   = flt.quality_score;
         g_positions[g_pos_count].open_time   = TimeCurrent();
         g_positions[g_pos_count].is_long     = sig.is_long;
         g_positions[g_pos_count].entry_price = sig.entry_price;
         g_positions[g_pos_count].stop_loss   = sig.stop_loss;
         g_positions[g_pos_count].take_profit = sig.take_profit_2;
         g_positions[g_pos_count].description = sig.description;
         g_positions[g_pos_count].bars_held   = 0;
         g_pos_count++;
      }
      Print("SMC: ", (sig.is_long ? "BUY" : "SELL"),
            " lots=", lots,
            " conf=", DoubleToString(final_conf, 3),
            " env=",  DoubleToString(flt.quality_score, 2),
            " SL=", sig.stop_loss, " TP=", sig.take_profit_2,
            " | ", sig.description);
   }
   else
      Print("SMC: Order failed: ", g_trade.ResultRetcodeDescription());
}

//=======================================================================
void ProcessPartialCloses()
{
   for(int i = 0; i < g_pos_count; i++)
   {
      if(g_positions[i].tp1_done) continue;
      if(!PositionSelectByTicket(g_positions[i].ticket)) continue;

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
         if(close_lots >= min_lot &&
            g_trade.PositionClosePartial(g_positions[i].ticket, close_lots))
         {
            g_positions[i].tp1_done = true;
            Print("SMC: TP1 partial close ", close_lots,
                  " lots ticket=", g_positions[i].ticket);
         }
      }
   }
}

//=======================================================================
// Time-based exit: close losing position if held > InpMaxBarsHeld and not at TP1
void ProcessTimeBasedExits()
{
   if(!InpUseTimeExit) return;

   for(int i = 0; i < g_pos_count; i++)
   {
      if(g_positions[i].tp1_done) continue;  // runner — don't force close
      if(g_positions[i].bars_held < InpMaxBarsHeld) continue;
      if(!PositionSelectByTicket(g_positions[i].ticket)) continue;

      double profit = PositionGetDouble(POSITION_PROFIT);
      // Only force-close if in loss — let winners run
      if(profit < 0.0)
      {
         Print("SMC: Time exit — ticket=", g_positions[i].ticket,
               " bars=", g_positions[i].bars_held,
               " P&L=", DoubleToString(profit, 2));
         g_trade.PositionClose(g_positions[i].ticket);
      }
   }
}

//=======================================================================
void ScanClosedTrades()
{
   datetime from = TimeCurrent() - 86400 * 2;
   if(!HistorySelect(from, TimeCurrent())) return;
   int deals = HistoryDealsTotal();
   static int last_deal_count = 0;
   if(deals == last_deal_count) return;

   for(int i = last_deal_count; i < deals; i++)
   {
      ulong deal_ticket = HistoryDealGetTicket(i);
      if(HistoryDealGetInteger(deal_ticket, DEAL_MAGIC) != (long)InpMagic) continue;
      if(HistoryDealGetInteger(deal_ticket, DEAL_ENTRY) != DEAL_ENTRY_OUT)  continue;

      double   profit   = HistoryDealGetDouble (deal_ticket, DEAL_PROFIT);
      double   exit_px  = HistoryDealGetDouble (deal_ticket, DEAL_PRICE);
      double   vol      = HistoryDealGetDouble (deal_ticket, DEAL_VOLUME);
      datetime close_t  = (datetime)HistoryDealGetInteger(deal_ticket, DEAL_TIME);
      ulong    pos_id   = (ulong)HistoryDealGetInteger(deal_ticket, DEAL_POSITION_ID);

      int    sig_type   = SMC_STOP_HUNT_LONG;
      double conf       = InpMinConfidence;
      double env_score  = 0.5;

      for(int j = 0; j < g_pos_count; j++)
      {
         if(g_positions[j].ticket == pos_id)
         {
            sig_type  = g_positions[j].signal_type;
            conf      = g_positions[j].confidence;
            env_score = g_positions[j].env_score;

            g_logger.LogTrade(pos_id,
                              g_positions[j].is_long,
                              g_positions[j].entry_price, exit_px,
                              g_positions[j].stop_loss,
                              g_positions[j].take_profit,
                              vol, profit,
                              g_positions[j].open_time, close_t,
                              sig_type, conf, env_score,
                              g_positions[j].description);

            for(int k = j; k < g_pos_count - 1; k++)
               g_positions[k] = g_positions[k + 1];
            g_pos_count--;
            break;
         }
      }
      g_adapt.RecordTrade(close_t, TimeCurrent(), profit, sig_type, conf);
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
