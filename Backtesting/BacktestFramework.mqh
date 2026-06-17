//+------------------------------------------------------------------+
//|  BacktestFramework.mqh — OnTester / custom metric for both EAs   |
//|  Include in either EA's .mq5 file to enable rich backtest stats  |
//+------------------------------------------------------------------+
#ifndef BACKTEST_FRAMEWORK_MQH
#define BACKTEST_FRAMEWORK_MQH

//--- Include in the EA's .mq5 when compiling for backtesting
//    #define BACKTEST_MODE
//    #include "../Backtesting/BacktestFramework.mqh"

struct BacktestStats
{
   int     total_trades;
   int     winning_trades;
   int     losing_trades;
   double  gross_profit;
   double  gross_loss;
   double  net_profit;
   double  profit_factor;
   double  win_rate;
   double  avg_win;
   double  avg_loss;
   double  max_drawdown;
   double  max_drawdown_pct;
   double  sharpe_ratio;
   double  sortino_ratio;
   double  calmar_ratio;
   double  expectancy;         // (WR * avg_win) - (LR * avg_loss) in $
   double  recovery_factor;    // net_profit / max_drawdown
   int     max_consecutive_losses;
   int     max_consecutive_wins;
};

//--- Computes the custom optimization criterion returned to Strategy Tester
//--- Higher = better. Penalizes drawdown heavily.
double ComputeCustomCriterion()
{
   double profit_factor = TesterStatistics(STAT_PROFIT_FACTOR);
   double net_profit    = TesterStatistics(STAT_PROFIT);
   double max_dd_pct    = TesterStatistics(STAT_EQUITY_DDREL_PERCENT);
   double sharpe        = TesterStatistics(STAT_SHARPE_RATIO);
   int    total_trades  = (int)TesterStatistics(STAT_TRADES);

   if(total_trades < 30)   return -999.0;  // reject under-traded runs
   if(profit_factor < 1.0) return -999.0;  // reject losing systems
   if(max_dd_pct   > 15.0) return -999.0;  // reject high-DD runs

   //--- Custom score: PF weighted by Sharpe, penalised by DD
   double score = (profit_factor * 0.4 + MathMax(0.0, sharpe) * 0.4) *
                  (1.0 - max_dd_pct / 100.0) *
                  MathLog(MathMax(1.0, (double)total_trades));

   return score;
}

//--- Called automatically by MT5 tester at end of each backtest pass
double OnTester()
{
   return ComputeCustomCriterion();
}

//--- Print full stats to Expert log
void PrintBacktestReport(const string ea_name)
{
   BacktestStats s;
   s.total_trades   = (int)TesterStatistics(STAT_TRADES);
   s.winning_trades = (int)TesterStatistics(STAT_PROFIT_TRADES);
   s.losing_trades  = (int)TesterStatistics(STAT_LOSS_TRADES);
   s.gross_profit   = TesterStatistics(STAT_GROSS_PROFIT);
   s.gross_loss     = TesterStatistics(STAT_GROSS_LOSS);
   s.net_profit     = TesterStatistics(STAT_PROFIT);
   s.profit_factor  = TesterStatistics(STAT_PROFIT_FACTOR);
   s.win_rate       = s.total_trades > 0
                      ? (double)s.winning_trades / s.total_trades * 100.0 : 0.0;
   s.avg_win        = s.winning_trades > 0
                      ? s.gross_profit / s.winning_trades : 0.0;
   s.avg_loss       = s.losing_trades  > 0
                      ? MathAbs(s.gross_loss) / s.losing_trades : 0.0;
   s.max_drawdown   = TesterStatistics(STAT_EQUITY_DD);
   s.max_drawdown_pct= TesterStatistics(STAT_EQUITY_DDREL_PERCENT);
   s.sharpe_ratio   = TesterStatistics(STAT_SHARPE_RATIO);
   s.recovery_factor= s.max_drawdown > 0 ? s.net_profit / s.max_drawdown : 0.0;
   s.expectancy     = (s.win_rate / 100.0) * s.avg_win -
                      (1.0 - s.win_rate / 100.0) * s.avg_loss;

   Print("==========================================================");
   Print("  BACKTEST REPORT — ", ea_name);
   Print("==========================================================");
   Print("  Total Trades       : ", s.total_trades);
   Print("  Win Rate           : ", DoubleToString(s.win_rate,    2), " %");
   Print("  Profit Factor      : ", DoubleToString(s.profit_factor, 3));
   Print("  Net Profit         : $", DoubleToString(s.net_profit,  2));
   Print("  Gross Profit       : $", DoubleToString(s.gross_profit,2));
   Print("  Gross Loss         : $", DoubleToString(MathAbs(s.gross_loss), 2));
   Print("  Avg Win            : $", DoubleToString(s.avg_win,     2));
   Print("  Avg Loss           : $", DoubleToString(s.avg_loss,    2));
   Print("  Expectancy/trade   : $", DoubleToString(s.expectancy,  2));
   Print("  Max Drawdown       : $", DoubleToString(s.max_drawdown,2),
                              " (", DoubleToString(s.max_drawdown_pct, 2), "%)");
   Print("  Sharpe Ratio       : ", DoubleToString(s.sharpe_ratio,  3));
   Print("  Recovery Factor    : ", DoubleToString(s.recovery_factor, 2));
   Print("  Custom Score       : ", DoubleToString(ComputeCustomCriterion(), 4));
   Print("==========================================================");
}

//--- Walk-forward validation helpers -----------------------------------
struct WalkForwardResult
{
   datetime in_sample_start;
   datetime in_sample_end;
   datetime oos_start;
   datetime oos_end;
   double   is_profit_factor;
   double   oos_profit_factor;
   double   degradation;   // (IS_PF - OOS_PF) / IS_PF  — ideal < 0.30
};

//--- Minimum acceptance criteria for live deployment
bool MeetsDeploymentCriteria(const BacktestStats &s,
                              const WalkForwardResult &wf)
{
   if(s.win_rate        < 40.0)  return false;
   if(s.profit_factor   < 1.30)  return false;
   if(s.max_drawdown_pct > 12.0) return false;
   if(s.sharpe_ratio     < 0.5)  return false;
   if(s.total_trades     < 50)   return false;
   if(wf.degradation     > 0.35) return false;  // OOS degrades > 35% = overfit
   return true;
}

#endif // BACKTEST_FRAMEWORK_MQH
