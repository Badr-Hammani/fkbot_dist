//+------------------------------------------------------------------+
//|  NewsConnector.mqh — Real-time financial news + macro data layer |
//|  Supports: NewsAPI.org, ForexFactory calendar, FRED (macro)       |
//+------------------------------------------------------------------+
#ifndef NEWS_CONNECTOR_MQH
#define NEWS_CONNECTOR_MQH

#include <JAson.mqh>  // MQL5 JSON parser (place in MQL5/Include/)

//--- News sentiment polarity
enum ENUM_NEWS_SENTIMENT
{
   SENTIMENT_VERY_BEARISH = -2,
   SENTIMENT_BEARISH      = -1,
   SENTIMENT_NEUTRAL      =  0,
   SENTIMENT_BULLISH      =  1,
   SENTIMENT_VERY_BULLISH =  2
};

//--- Economic event impact
enum ENUM_EVENT_IMPACT
{
   IMPACT_NONE   = 0,
   IMPACT_LOW    = 1,
   IMPACT_MEDIUM = 2,
   IMPACT_HIGH   = 3
};

//--- Single economic calendar event
struct EconomicEvent
{
   datetime          event_time;
   string            currency;
   string            title;
   ENUM_EVENT_IMPACT impact;
   double            actual;
   double            forecast;
   double            previous;
   bool              is_released;
};

//--- Aggregated news sentiment result
struct NewsSentimentResult
{
   ENUM_NEWS_SENTIMENT sentiment;
   double              confidence;       // 0.0 – 1.0
   int                 article_count;
   datetime            last_updated;
   string              dominant_theme;   // e.g. "Fed hawkish", "recession fears"
};

//+------------------------------------------------------------------+
//|  CNewsConnector                                                   |
//+------------------------------------------------------------------+
class CNewsConnector
{
private:
   string   m_newsapi_key;
   string   m_fred_api_key;
   string   m_base_url_news;
   string   m_base_url_fred;
   string   m_base_url_calendar;

   int      m_http_timeout;        // ms
   int      m_cache_ttl;           // seconds before re-fetch
   datetime m_last_news_fetch;
   datetime m_last_calendar_fetch;

   NewsSentimentResult m_cached_sentiment;
   EconomicEvent       m_upcoming_events[];
   int                 m_event_count;

   //--- HTTP GET with retry
   bool     FetchURL(const string url, string &response);
   //--- Parse NewsAPI JSON into sentiment
   bool     ParseNewsSentiment(const string json, NewsSentimentResult &result);
   //--- Parse ForexFactory-style JSON calendar
   bool     ParseCalendar(const string json);
   //--- Score a single headline for gold-relevance
   double   ScoreHeadline(const string headline, const string description);
   //--- Keyword lists
   string   m_bullish_keywords[];
   string   m_bearish_keywords[];
   void     InitKeywords();

public:
   CNewsConnector();
   ~CNewsConnector() {}

   //--- Initialise with API keys
   bool     Init(const string newsapi_key,
                 const string fred_api_key,
                 const int    cache_ttl_seconds = 300,
                 const int    http_timeout_ms   = 8000);

   //--- Primary interface -----------------------------------------------
   //--- Fetch & return current XAU/USD sentiment (cached)
   bool     GetGoldSentiment(NewsSentimentResult &result);

   //--- Return next high-impact USD/global event within minutes_ahead
   bool     GetNextHighImpactEvent(EconomicEvent &event, const int minutes_ahead = 60);

   //--- Check if we are inside a news blackout window
   bool     IsNewsBlackout(const int minutes_before = 15,
                           const int minutes_after  = 15);

   //--- Macro indicators (via FRED)
   bool     GetDXYMomentum(double &dxy_change_pct);   // USD index 1-day change
   bool     GetRealYield(double &yield_10y);           // 10-yr TIPS yield proxy

   //--- Utility
   string   SentimentToString(const ENUM_NEWS_SENTIMENT s);
   void     InvalidateCache();
};

//+------------------------------------------------------------------+
CNewsConnector::CNewsConnector()
{
   m_base_url_news     = "https://newsapi.org/v2/everything";
   m_base_url_fred     = "https://api.stlouisfed.org/fred/series/observations";
   m_base_url_calendar = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
   m_http_timeout      = 8000;
   m_cache_ttl         = 300;
   m_last_news_fetch   = 0;
   m_last_calendar_fetch = 0;
   m_event_count       = 0;
   InitKeywords();
}

//+------------------------------------------------------------------+
void CNewsConnector::InitKeywords()
{
   //--- Bullish gold keywords (USD weakness, risk-off, inflation)
   ArrayResize(m_bullish_keywords, 12);
   m_bullish_keywords[0]  = "inflation";
   m_bullish_keywords[1]  = "recession";
   m_bullish_keywords[2]  = "rate cut";
   m_bullish_keywords[3]  = "dovish";
   m_bullish_keywords[4]  = "geopolitical";
   m_bullish_keywords[5]  = "war";
   m_bullish_keywords[6]  = "crisis";
   m_bullish_keywords[7]  = "safe haven";
   m_bullish_keywords[8]  = "dollar weakness";
   m_bullish_keywords[9]  = "stimulus";
   m_bullish_keywords[10] = "quantitative easing";
   m_bullish_keywords[11] = "debt ceiling";

   //--- Bearish gold keywords (USD strength, risk-on, rate hikes)
   ArrayResize(m_bearish_keywords, 10);
   m_bearish_keywords[0] = "rate hike";
   m_bearish_keywords[1] = "hawkish";
   m_bearish_keywords[2] = "strong dollar";
   m_bearish_keywords[3] = "taper";
   m_bearish_keywords[4] = "risk on";
   m_bearish_keywords[5] = "dollar surge";
   m_bearish_keywords[6] = "higher for longer";
   m_bearish_keywords[7] = "fed hike";
   m_bearish_keywords[8] = "yield rise";
   m_bearish_keywords[9] = "equity rally";
}

//+------------------------------------------------------------------+
bool CNewsConnector::Init(const string newsapi_key,
                          const string fred_api_key,
                          const int    cache_ttl_seconds,
                          const int    http_timeout_ms)
{
   m_newsapi_key  = newsapi_key;
   m_fred_api_key = fred_api_key;
   m_cache_ttl    = cache_ttl_seconds;
   m_http_timeout = http_timeout_ms;

   if(m_newsapi_key == "" || m_fred_api_key == "")
   {
      Print("NewsConnector: API keys not set — news filter disabled.");
      return false;
   }
   Print("NewsConnector: Initialised. Cache TTL=", m_cache_ttl, "s");
   return true;
}

//+------------------------------------------------------------------+
bool CNewsConnector::FetchURL(const string url, string &response)
{
   char   post_data[];
   char   result_data[];
   string result_headers;

   ResetLastError();
   int res = WebRequest("GET", url, "", m_http_timeout,
                        post_data, result_data, result_headers);
   if(res != 200)
   {
      Print("NewsConnector: HTTP error ", res, " | ", GetLastError(),
            " | URL: ", url);
      return false;
   }
   response = CharArrayToString(result_data, 0, WHOLE_ARRAY, CP_UTF8);
   return true;
}

//+------------------------------------------------------------------+
double CNewsConnector::ScoreHeadline(const string headline,
                                     const string description)
{
   string combined = headline + " " + description;
   StringToLower(combined);

   double score = 0.0;
   for(int i = 0; i < ArraySize(m_bullish_keywords); i++)
      if(StringFind(combined, m_bullish_keywords[i]) >= 0)
         score += 1.0;

   for(int i = 0; i < ArraySize(m_bearish_keywords); i++)
      if(StringFind(combined, m_bearish_keywords[i]) >= 0)
         score -= 1.0;

   return score;
}

//+------------------------------------------------------------------+
bool CNewsConnector::ParseNewsSentiment(const string json,
                                        NewsSentimentResult &result)
{
   CJAVal js;
   if(!js.Deserialize(json)) { Print("NewsConnector: JSON parse error"); return false; }

   int    count  = (int)js["totalResults"].ToInt();
   double total  = 0.0;
   int    parsed = 0;
   int    articles = (int)js["articles"].Size();

   for(int i = 0; i < MathMin(articles, 50); i++)
   {
      string title = js["articles"][i]["title"].ToStr();
      string desc  = js["articles"][i]["description"].ToStr();
      total += ScoreHeadline(title, desc);
      parsed++;
   }

   if(parsed == 0) { result.sentiment = SENTIMENT_NEUTRAL; result.confidence = 0.0; return true; }

   double avg = total / parsed;
   result.article_count = parsed;
   result.last_updated  = TimeCurrent();
   result.confidence    = MathMin(1.0, (double)parsed / 30.0);

   if(avg >= 1.5)       result.sentiment = SENTIMENT_VERY_BULLISH;
   else if(avg >= 0.4)  result.sentiment = SENTIMENT_BULLISH;
   else if(avg <= -1.5) result.sentiment = SENTIMENT_VERY_BEARISH;
   else if(avg <= -0.4) result.sentiment = SENTIMENT_BEARISH;
   else                 result.sentiment = SENTIMENT_NEUTRAL;

   return true;
}

//+------------------------------------------------------------------+
bool CNewsConnector::GetGoldSentiment(NewsSentimentResult &result)
{
   //--- Return cached if still fresh
   if(m_last_news_fetch > 0 &&
      (TimeCurrent() - m_last_news_fetch) < m_cache_ttl)
   {
      result = m_cached_sentiment;
      return true;
   }

   string url = m_base_url_news +
                "?q=gold+XAU+USD+federal+reserve&language=en&sortBy=publishedAt&pageSize=50"
                "&apiKey=" + m_newsapi_key;
   string response;
   if(!FetchURL(url, response)) return false;
   if(!ParseNewsSentiment(response, m_cached_sentiment)) return false;

   m_last_news_fetch = TimeCurrent();
   result = m_cached_sentiment;
   return true;
}

//+------------------------------------------------------------------+
bool CNewsConnector::ParseCalendar(const string json)
{
   CJAVal js;
   if(!js.Deserialize(json)) return false;

   m_event_count = 0;
   int total = (int)js.Size();
   ArrayResize(m_upcoming_events, total);

   for(int i = 0; i < total; i++)
   {
      string impact_str = js[i]["impact"].ToStr();
      ENUM_EVENT_IMPACT imp = IMPACT_NONE;
      if(impact_str == "High")   imp = IMPACT_HIGH;
      else if(impact_str == "Medium") imp = IMPACT_MEDIUM;
      else if(impact_str == "Low")    imp = IMPACT_LOW;

      string currency = js[i]["country"].ToStr();
      if(currency != "USD" && currency != "CNY" && currency != "EUR") continue;

      m_upcoming_events[m_event_count].currency    = currency;
      m_upcoming_events[m_event_count].title       = js[i]["title"].ToStr();
      m_upcoming_events[m_event_count].impact      = imp;
      m_upcoming_events[m_event_count].is_released = false;

      //--- Parse ISO datetime string to datetime
      string dt_str = js[i]["date"].ToStr();
      m_upcoming_events[m_event_count].event_time  = StringToTime(dt_str);
      m_event_count++;
   }
   ArrayResize(m_upcoming_events, m_event_count);
   return true;
}

//+------------------------------------------------------------------+
bool CNewsConnector::GetNextHighImpactEvent(EconomicEvent &event,
                                            const int minutes_ahead)
{
   if(m_last_calendar_fetch == 0 ||
      (TimeCurrent() - m_last_calendar_fetch) > 3600)
   {
      string response;
      if(!FetchURL(m_base_url_calendar, response)) return false;
      if(!ParseCalendar(response)) return false;
      m_last_calendar_fetch = TimeCurrent();
   }

   datetime now     = TimeCurrent();
   datetime horizon = now + (datetime)(minutes_ahead * 60);

   for(int i = 0; i < m_event_count; i++)
   {
      if(m_upcoming_events[i].impact == IMPACT_HIGH &&
         m_upcoming_events[i].event_time >= now &&
         m_upcoming_events[i].event_time <= horizon)
      {
         event = m_upcoming_events[i];
         return true;
      }
   }
   return false;
}

//+------------------------------------------------------------------+
bool CNewsConnector::IsNewsBlackout(const int minutes_before,
                                    const int minutes_after)
{
   EconomicEvent ev;
   if(!GetNextHighImpactEvent(ev, minutes_before + minutes_after + 5))
      return false;

   datetime now = TimeCurrent();
   return (now >= ev.event_time - (datetime)(minutes_before * 60) &&
           now <= ev.event_time + (datetime)(minutes_after  * 60));
}

//+------------------------------------------------------------------+
bool CNewsConnector::GetDXYMomentum(double &dxy_change_pct)
{
   //--- FRED series DTWEXBGS = broad USD index (daily)
   string url = m_base_url_fred +
                "?series_id=DTWEXBGS&limit=2&sort_order=desc"
                "&api_key=" + m_fred_api_key + "&file_type=json";
   string response;
   if(!FetchURL(url, response)) return false;

   CJAVal js;
   if(!js.Deserialize(response)) return false;

   double v1 = StringToDouble(js["observations"][0]["value"].ToStr());
   double v2 = StringToDouble(js["observations"][1]["value"].ToStr());
   if(v2 == 0.0) return false;
   dxy_change_pct = (v1 - v2) / v2 * 100.0;
   return true;
}

//+------------------------------------------------------------------+
bool CNewsConnector::GetRealYield(double &yield_10y)
{
   //--- FRED series DFII10 = 10-year TIPS yield
   string url = m_base_url_fred +
                "?series_id=DFII10&limit=1&sort_order=desc"
                "&api_key=" + m_fred_api_key + "&file_type=json";
   string response;
   if(!FetchURL(url, response)) return false;

   CJAVal js;
   if(!js.Deserialize(response)) return false;
   yield_10y = StringToDouble(js["observations"][0]["value"].ToStr());
   return true;
}

//+------------------------------------------------------------------+
string CNewsConnector::SentimentToString(const ENUM_NEWS_SENTIMENT s)
{
   switch(s)
   {
      case SENTIMENT_VERY_BULLISH: return "VERY_BULLISH";
      case SENTIMENT_BULLISH:      return "BULLISH";
      case SENTIMENT_NEUTRAL:      return "NEUTRAL";
      case SENTIMENT_BEARISH:      return "BEARISH";
      case SENTIMENT_VERY_BEARISH: return "VERY_BEARISH";
   }
   return "UNKNOWN";
}

//+------------------------------------------------------------------+
void CNewsConnector::InvalidateCache()
{
   m_last_news_fetch     = 0;
   m_last_calendar_fetch = 0;
}

#endif // NEWS_CONNECTOR_MQH
