'use strict';
const http  = require('http');
const https = require('https');
const url   = require('url');

const PORT = process.env.PORT || 3000;

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function getCached(k){ const e=cache.get(k); if(!e||Date.now()-e.ts>CACHE_TTL){cache.delete(k);return null;} return e.data; }
function setCached(k,d){ cache.set(k,{data:d,ts:Date.now()}); }

// ── Feed builder ──────────────────────────────────────────────────────────────
function buildFeeds(ticker) {
  const e = s => encodeURIComponent(s);
  const t = ticker;
  return [
    // Primary: Google News — multiple query angles to maximise coverage
    `https://news.google.com/rss/search?q=${e(t+' stock news')}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('"'+t+'" stock')}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e(t+' shares earnings')}&hl=en-GB&gl=GB&ceid=GB:en`,
    // Yahoo Finance direct ticker feed
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${e(t)}&region=US&lang=en-US`,
    // Nasdaq
    `https://www.nasdaq.com/feed/rssoutbound?symbol=${e(t)}`,
    // Source-specific via Google News
    `https://news.google.com/rss/search?q=${e('site:reuters.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:cnbc.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:ft.com '+t)}&hl=en-GB&gl=GB&ceid=GB:en`,
    `https://news.google.com/rss/search?q=${e('site:marketwatch.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:seekingalpha.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:bloomberg.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:barrons.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:wsj.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    // European sources (returns native language — will be translated)
    `https://news.google.com/rss/search?q=${e(t+' Aktie')}&hl=de-DE&gl=DE&ceid=DE:de`,
    `https://news.google.com/rss/search?q=${e('site:handelsblatt.com '+t)}&hl=de-DE&gl=DE&ceid=DE:de`,
    `https://news.google.com/rss/search?q=${e(t+' action bourse')}&hl=fr-FR&gl=FR&ceid=FR:fr`,
    `https://news.google.com/rss/search?q=${e('site:lesechos.fr '+t)}&hl=fr-FR&gl=FR&ceid=FR:fr`,
    `https://news.google.com/rss/search?q=${e(t+' azioni borsa')}&hl=it-IT&gl=IT&ceid=IT:it`,
    // Asian sources
    `https://news.google.com/rss/search?q=${e(t+' 株価')}&hl=ja-JP&gl=JP&ceid=JP:ja`,
    `https://news.google.com/rss/search?q=${e('site:nikkei.com '+t)}&hl=ja-JP&gl=JP&ceid=JP:ja`,
    `https://news.google.com/rss/search?q=${e(t+' 股票')}&hl=zh-HK&gl=HK&ceid=HK:zh-Hant`,
    `https://news.google.com/rss/search?q=${e('site:scmp.com '+t)}&hl=en-HK&gl=HK&ceid=HK:en`,
    // General feeds
    `https://feeds.bbci.co.uk/news/business/rss.xml`,
    `https://www.cnbc.com/id/100003114/device/rss/rss.html`,
    `https://feeds.marketwatch.com/marketwatch/topstories/`,
  ];
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────
function fetchURL(targetUrl,ms){
  ms=ms||9000;
  return new Promise((resolve,reject)=>{
    let redirects=0;
    function go(u){
      const p=url.parse(u);
      const lib=p.protocol==='https:'?https:http;
      const req=lib.request({
        hostname:p.hostname,port:p.port,path:p.path||'/',method:'GET',
        headers:{
          'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept':'application/rss+xml,application/xml,text/xml,*/*',
          'Accept-Language':'en-US,en;q=0.9','Cache-Control':'no-cache',
        },timeout:ms,
      },res=>{
        if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location&&redirects++<3){
          const next=res.headers.location.startsWith('http')?res.headers.location:`${p.protocol}//${p.hostname}${res.headers.location}`;
          res.resume();go(next);return;
        }
        if(res.statusCode!==200){reject(new Error('HTTP '+res.statusCode));return;}
        const chunks=[];
        res.on('data',c=>chunks.push(c));
        res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error',reject);
      });
      req.on('error',reject);
      req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'));});
      req.end();
    }
    go(targetUrl);
  });
}

// ── RSS parser ────────────────────────────────────────────────────────────────
function parseRSS(xml,feedUrl){
  const items=[];
  const re=/<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m;
  while((m=re.exec(xml))!==null){
    const b=m[1];
    const title=clean(tag(b,'title'));
    const link=clean(tag(b,'link')||tag(b,'guid')||attr(b,'link','href'));
    const pubDate=clean(tag(b,'pubDate')||tag(b,'published')||tag(b,'updated'));
    const srcTag=clean(tag(b,'source'));
    const desc=h2t(clean(tag(b,'description')||tag(b,'summary')||'')).slice(0,350);
    const source=srcTag||domainOf(feedUrl);
    if(title&&title.length>6) items.push({title,link:googleLink(link),pubDate,source,description:desc,feedUrl});
  }
  return items;
}
function tag(x,n){const m=x.match(new RegExp('<'+n+'[^>]*>([\\s\\S]*?)</'+n+'>','i'));return m?m[1].trim():'';}
function attr(x,n,a){const m=x.match(new RegExp('<'+n+'[^>]*'+a+'="([^"]*)"','i'));return m?m[1]:'';}
function clean(s){return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,'').trim();}
function h2t(s){return s.replace(/<br\s*\/?>/gi,' ').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();}
function googleLink(l){if(!l)return '';const m=l.match(/(?:url|q)=([^&]+)/i);if(m){try{return decodeURIComponent(m[1]);}catch(e){}}return l;}
function domainOf(u){
  try{
    const h=url.parse(u).hostname||'';
    const map={'news.google.com':'Google News','feeds.finance.yahoo.com':'Yahoo Finance','finance.yahoo.com':'Yahoo Finance','www.nasdaq.com':'Nasdaq','feeds.bbci.co.uk':'BBC Business','www.cnbc.com':'CNBC','feeds.marketwatch.com':'MarketWatch'};
    for(const[k,v] of Object.entries(map)) if(h.includes(k)) return v;
    return h.replace('www.','').replace('feeds.','').split('.')[0];
  }catch(e){return 'News';}
}
function dedup(items){
  const seen=new Set();
  return items.filter(a=>{const k=a.title.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,55);if(seen.has(k))return false;seen.add(k);return true;});
}
function isRelevant(item,ticker){
  const text=(item.title+' '+item.description+' '+(item.link||'')).toLowerCase();
  return text.includes(ticker.toLowerCase());
}

// ── Language detection ────────────────────────────────────────────────────────
function detectLang(text){
  // Detect non-English by character sets and common words
  if(/[\u3040-\u30ff\u4e00-\u9fff]/.test(text)) return 'ja-zh';
  if(/[ÄäÖöÜüß]/.test(text)||/\b(Aktie|Kurs|Gewinn|Verlust|Anleger|Börse)\b/i.test(text)) return 'de';
  if(/[àâçéèêëîïôùûüÿ]/.test(text)||/\b(bourse|actions|hausse|baisse|bénéfice)\b/i.test(text)) return 'fr';
  if(/[àèéìòù]/.test(text)||/\b(azioni|borsa|guadagni|perdite)\b/i.test(text)) return 'it';
  if(/[áéíóúñ]/.test(text)||/\b(bolsa|acciones|ganancias|pérdidas)\b/i.test(text)) return 'es';
  return 'en';
}

// ── Translation (rule-based for common financial terms, no API needed) ─────────
const DE_TRANSLATIONS = {
  'Aktie':'stock','Kursanstieg':'price rise','Kursrückgang':'price decline','Gewinn':'profit',
  'Verlust':'loss','Anleger':'investors','Börse':'stock market','Kaufempfehlung':'buy recommendation',
  'Verkaufsempfehlung':'sell recommendation','Rekord':'record','Bewertung':'valuation',
  'Unterbewertung':'undervaluation','Überbewertung':'overvaluation','Quartal':'quarter',
  'Umsatz':'revenue','Jahresergebnis':'annual result','Prognose':'forecast',
  'Nachrichten':'news','Bericht':'report','Analyse':'analysis',
};
const FR_TRANSLATIONS = {
  'hausse':'rise','baisse':'decline','bénéfice':'profit','perte':'loss',
  'bourse':'stock market','action':'stock','actions':'stocks','achat':'buy',
  'vente':'sell','résultats':'results','prévisions':'forecast',
};

function translateTitle(title, lang){
  if(lang==='en') return {title, translated:false};
  let t=title;
  if(lang==='de') for(const[k,v] of Object.entries(DE_TRANSLATIONS)) t=t.replace(new RegExp('\\b'+k+'\\b','gi'),v);
  if(lang==='fr') for(const[k,v] of Object.entries(FR_TRANSLATIONS)) t=t.replace(new RegExp('\\b'+k+'\\b','gi'),v);
  const changed=t!==title;
  return {title:t, translated:changed};
}

// ── Sentiment analysis ────────────────────────────────────────────────────────
const BULL=['beat','beats','record','surge','surged','rally','rallied','gain','gained','rise','rose','soar','soared','jump','jumped','upgrade','upgraded','outperform','buy rating','strong buy','profit','earnings beat','guidance raised','raises guidance','dividend','buyback','acquisition','merger','deal','partnership','launch','approval','approved','growth','grew','expansion','positive','bullish','price target raised','above expectations','exceeded','new high','all-time high','recovery','rebound','52-week high','breakthrough','wins contract','awarded','strong results','record revenue','record profit','raised forecast','margin expansion','cash flow','beat estimates','gewinn','kursanstieg','kaufempfehlung','bénéfice','croissance','hausse','增收','増益','最高益','上昇','增长','盈利','上涨'].map(w=>w.toLowerCase());
const BEAR=['miss','missed','fall','fell','drop','dropped','decline','declined','tumble','tumbled','slump','slumped','plunge','plunged','crash','crashed','loss','losses','cut','cuts','downgrade','downgraded','underperform','sell rating','guidance cut','lowered guidance','below expectations','disappointing','weak','bearish','price target cut','layoff','layoffs','restructuring','bankruptcy','default','lawsuit','fine','penalty','recall','shortage','tariff','ban','blocked','rejected','failed','fraud','investigation','warning','warns','verlust','kursrückgang','perte','baisse','avertissement','減収','減益','下落','損失','下滑','亏损','下跌','警告'].map(w=>w.toLowerCase());
function sentiment(title,desc){
  const full=(title+' '+desc).toLowerCase(),tl=title.toLowerCase();
  let b=0,r=0;
  for(const w of BULL){if(full.includes(w))b++;if(tl.includes(w))b+=2;}
  for(const w of BEAR){if(full.includes(w))r++;if(tl.includes(w))r+=2;}
  if(b===0&&r===0)return 'neutral';
  return b>r?'bullish':r>b?'bearish':'neutral';
}

// ── Summary generation ────────────────────────────────────────────────────────
function makeSummary(title, desc, sent, ticker){
  // Use the description if it's meaningful, otherwise construct from title
  const d = (desc && desc.length > 40) ? desc : null;
  const context = d ? d : title;

  const prefix = sent==='bullish'
    ? `Bullish for ${ticker}: `
    : sent==='bearish'
    ? `Bearish for ${ticker}: `
    : `Neutral update for ${ticker}: `;

  // Construct a readable summary sentence
  const cleaned = context.replace(/\s+/g,' ').trim();
  const sentence = cleaned.length > 160 ? cleaned.slice(0,157)+'…' : cleaned;

  return prefix + sentence;
}

function relTime(str){
  if(!str)return '';
  try{
    const d=new Date(str);if(isNaN(d))return str.slice(0,16);
    const s=(Date.now()-d)/1000;
    if(s<3600)return Math.max(1,Math.floor(s/60))+'m ago';
    if(s<86400)return Math.floor(s/3600)+'h ago';
    if(s<172800)return '1d ago';
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  }catch(e){return '';}
}

// ── Main news fetch ───────────────────────────────────────────────────────────
async function fetchNews(ticker){
  const cached=getCached(ticker);
  if(cached){console.log('[CACHE]',ticker);return cached;}

  const feeds=buildFeeds(ticker);
  console.log('[FETCH]',ticker,'—',feeds.length,'feeds');

  const results=await Promise.allSettled(
    feeds.map(feedUrl=>fetchURL(feedUrl).then(xml=>parseRSS(xml,feedUrl)).catch(()=>[]))
  );

  let all=[];
  for(const r of results) if(r.status==='fulfilled') all.push(...r.value);
  all=dedup(all);

  const relevant=all.filter(item=>isRelevant(item,ticker));
  const src=relevant.length>=3?relevant:all;
  src.sort((a,b)=>{try{return new Date(b.pubDate)-new Date(a.pubDate);}catch(e){return 0;}});

  const articles=src.slice(0,15).map(item=>{
    const lang=detectLang(item.title);
    const {title:translatedTitle,translated}=translateTitle(item.title,lang);
    const sent=sentiment(translatedTitle,item.description);
    const summary=makeSummary(translatedTitle,item.description,sent,ticker);
    return {
      title:translatedTitle,
      originalTitle:translated?item.title:undefined,
      translated,
      source:item.source,
      url:item.link||'',
      publishedAt:relTime(item.pubDate),
      sentiment:sent,
      summary,
    };
  });

  console.log('[DONE]',ticker,'—',articles.length,'articles');
  setCached(ticker,articles);
  return articles;
}

// ── Thesis generation (rule-based, no external AI API) ────────────────────────
function generateThesis(ticker, articles){
  if(!articles||!articles.length) return 'Insufficient news data to generate a thesis.';

  const bull=articles.filter(a=>a.sentiment==='bullish');
  const bear=articles.filter(a=>a.sentiment==='bearish');
  const bullTitles=bull.slice(0,3).map(a=>a.title).join('; ');
  const bearTitles=bear.slice(0,3).map(a=>a.title).join('; ');
  const tot=articles.length;
  const dominance=bull.length>bear.length?'bullish':bear.length>bull.length?'bearish':'mixed';

  let thesis='';

  // Paragraph 1: Current state
  if(dominance==='bullish'){
    thesis+=`Current picture: ${ticker} is generating predominantly positive news flow, with ${bull.length} out of ${tot} recent articles carrying bullish signals. Key themes include: ${bullTitles.slice(0,180)}. This suggests improving fundamentals, positive market perception, or strong operational momentum that the market has yet to fully price in.`;
  } else if(dominance==='bearish'){
    thesis+=`Current picture: ${ticker} faces a challenging news environment, with ${bear.length} out of ${tot} recent articles carrying bearish signals. Headwinds include: ${bearTitles.slice(0,180)}. This pattern of negative news can indicate deteriorating fundamentals, sector-level pressure, or company-specific issues requiring close monitoring.`;
  } else {
    thesis+=`Current picture: News flow for ${ticker} is balanced, with ${bull.length} bullish and ${bear.length} bearish signals across ${tot} articles. This mixed environment suggests the market is at a pivotal decision point — watching upcoming catalysts such as earnings, guidance updates, or macro developments will be critical to establishing directional conviction.`;
  }

  // Paragraph 2: Chain-effect / snowball
  thesis+=`\n\nChain-effect outlook: ${dominance==='bullish'
    ? `If the current bullish momentum for ${ticker} is sustained, several compounding effects could follow. Positive earnings or analyst upgrades typically trigger institutional buying, which in turn improves short-term liquidity and reduces bid-ask spreads. For smaller-cap names, this snowball effect is particularly powerful — improved visibility attracts index inclusion consideration, which drives passive fund inflows. Revenue growth, if confirmed, could support margin expansion as fixed costs are spread over a larger revenue base, creating a virtuous cycle of improving profitability. This could also attract strategic partnerships or M&A interest, as larger players seek exposure to the growth story.`
    : dominance==='bearish'
    ? `Sustained negative news for ${ticker} risks creating a self-reinforcing downward spiral. Analyst downgrades often follow negative news cycles, triggering institutional de-risking. Deteriorating sentiment can increase the cost of capital — equity issuances become dilutive, debt financing becomes expensive — which constrains operational flexibility. For smaller-cap names, reduced liquidity can amplify price moves, creating overshooting that diverges significantly from intrinsic value. Watch for management commentary on guidance: a reduction in forward outlook is often the catalyst that accelerates a de-rating.`
    : `In a mixed news environment, the key driver for ${ticker} will be which narrative gains dominance. If the bullish catalysts prove structural rather than transient, the market's current hesitation could represent an accumulation opportunity. Conversely, if bearish signals reflect underlying operational weakness, current valuations may not adequately reflect risk. The resolution of this divergence typically occurs around earnings releases, major product launches, or macro inflection points.`
  }`;

  // Paragraph 3: Risks
  thesis+=`\n\nKey risks to monitor: ${dominance==='bullish'
    ? `The primary risk to the bullish case is execution — the gap between positive news and delivered financial results is where most stories break down. Watch for: (1) whether revenue growth translates to margin improvement or is being bought at the expense of profitability; (2) sector rotation risk if macro conditions shift; (3) valuation stretch — high-momentum names can become vulnerable to any negative surprise.`
    : dominance==='bearish'
    ? `The primary risk of being overly bearish on ${ticker} is overshooting — markets often punish stocks more than fundamentals warrant. Watch for: (1) signs of stabilisation in key metrics that could indicate the worst is priced in; (2) management actions such as cost restructuring or asset disposals that could reset the earnings base; (3) sector-wide recovery catalysts that could lift all boats regardless of company-specific issues.`
    : `Key watchpoints include: (1) the next scheduled earnings release and management guidance tone; (2) whether bullish news items reflect one-time events or structural improvements; (3) macro sector tailwinds and headwinds that could tip the balance; (4) insider trading activity and institutional position changes as forward-looking sentiment indicators.`
  }`;

  return thesis;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server=http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}

  const {pathname,query}=url.parse(req.url,true);

  // Root / health — responds immediately so Render health check passes
  if(pathname==='/'||pathname==='/health'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok',service:'StockPulse News Proxy',uptime:Math.floor(process.uptime()),time:new Date().toISOString()}));
    return;
  }

  // GET /news?ticker=AAPL,TSLA,...
  if(pathname==='/news'){
    const raw=(query.ticker||'').trim().toUpperCase();
    if(!raw){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Missing ?ticker='}));return;}
    const tickers=raw.split(',').map(t=>t.replace(/[^A-Z0-9.\-]/g,'').slice(0,12)).filter(Boolean).slice(0,10);
    try{
      const groups=await Promise.all(tickers.map(async t=>{
        try{return{ticker:t,articles:await fetchNews(t),error:null};}
        catch(e){return{ticker:t,articles:[],error:e.message};}
      }));
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({groups,fetchedAt:Date.now()}));
    }catch(e){
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Server error: '+e.message}));
    }
    return;
  }

  // GET /thesis?ticker=AAPL — generate deep-dive thesis from cached articles
  if(pathname==='/thesis'){
    const ticker=(query.ticker||'').toUpperCase().replace(/[^A-Z0-9.\-]/g,'').slice(0,12);
    if(!ticker){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Missing ?ticker='}));return;}
    const cached=getCached(ticker);
    if(!cached||!cached.length){
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({thesis:'No cached news data found for '+ticker+'. Please search for news first.'}));
      return;
    }
    const thesis=generateThesis(ticker,cached);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ticker,thesis}));
    return;
  }

  res.writeHead(404);res.end(JSON.stringify({error:'Not found'}));
});

server.listen(PORT,'0.0.0.0',()=>{
  console.log('StockPulse proxy running on port',PORT);
  // Keepalive: ping self every 14 min so Render free tier never sleeps
  const selfUrl=process.env.RENDER_EXTERNAL_URL;
  if(selfUrl){
    setInterval(()=>{
      https.get(selfUrl+'/health',res=>{console.log('[KEEPALIVE]',res.statusCode);res.resume();})
        .on('error',e=>console.log('[KEEPALIVE error]',e.message));
    },14*60*1000);
    console.log('Keepalive enabled —',selfUrl);
  }
});
