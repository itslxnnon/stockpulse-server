'use strict';
const http  = require('http');
const https = require('https');
const url   = require('url');

const PORT = process.env.PORT || 3000;

// ── Cache (5 min TTL) ─────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function getCached(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(k); return null; }
  return e.data;
}
function setCached(k, d) { cache.set(k, { data: d, ts: Date.now() }); }

// ── Feed URLs ─────────────────────────────────────────────────────────────────
function buildFeeds(ticker) {
  const e = s => encodeURIComponent(s);
  const t = ticker;
  return [
    `https://news.google.com/rss/search?q=${e(t + ' stock news')}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('"' + t + '" stock')}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e(t + ' shares earnings')}&hl=en-GB&gl=GB&ceid=GB:en`,
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${e(t)}&region=US&lang=en-US`,
    `https://www.nasdaq.com/feed/rssoutbound?symbol=${e(t)}`,
    `https://news.google.com/rss/search?q=${e('site:reuters.com ' + t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:cnbc.com ' + t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:ft.com ' + t)}&hl=en-GB&gl=GB&ceid=GB:en`,
    `https://news.google.com/rss/search?q=${e('site:marketwatch.com ' + t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:seekingalpha.com ' + t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:bloomberg.com ' + t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:barrons.com ' + t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:wsj.com ' + t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e(t + ' Aktie')}&hl=de-DE&gl=DE&ceid=DE:de`,
    `https://news.google.com/rss/search?q=${e(t + ' action bourse')}&hl=fr-FR&gl=FR&ceid=FR:fr`,
    `https://news.google.com/rss/search?q=${e(t + ' 株価')}&hl=ja-JP&gl=JP&ceid=JP:ja`,
    `https://news.google.com/rss/search?q=${e(t + ' 股票')}&hl=zh-HK&gl=HK&ceid=HK:zh-Hant`,
    `https://feeds.bbci.co.uk/news/business/rss.xml`,
    `https://www.cnbc.com/id/100003114/device/rss/rss.html`,
    `https://feeds.marketwatch.com/marketwatch/topstories/`,
  ];
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────
function fetchURL(targetUrl) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    function go(u) {
      const p = url.parse(u);
      const lib = p.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: p.hostname, port: p.port,
        path: p.path || '/', method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
        timeout: 8000,
      }, res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirects++ < 3) {
          const next = res.headers.location.startsWith('http') ? res.headers.location : `${p.protocol}//${p.hostname}${res.headers.location}`;
          res.resume(); go(next); return;
        }
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    }
    go(targetUrl);
  });
}

// ── RSS parser ────────────────────────────────────────────────────────────────
function parseRSS(xml, feedUrl) {
  const items = [];
  const re = /<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const title   = clean(tag(b,'title'));
    const link    = clean(tag(b,'link') || tag(b,'guid') || attr(b,'link','href'));
    const pubDate = clean(tag(b,'pubDate') || tag(b,'published') || tag(b,'updated'));
    const srcTag  = clean(tag(b,'source'));
    const desc    = h2t(clean(tag(b,'description') || tag(b,'summary') || '')).slice(0,300);
    const source  = srcTag || domainOf(feedUrl);
    if (title && title.length > 6) items.push({ title, link: googleLink(link), pubDate, source, description: desc });
  }
  return items;
}
function tag(x, n) { const m = x.match(new RegExp('<'+n+'[^>]*>([\\s\\S]*?)</'+n+'>','i')); return m?m[1].trim():''; }
function attr(x, n, a) { const m = x.match(new RegExp('<'+n+'[^>]*'+a+'="([^"]*)"','i')); return m?m[1]:''; }
function clean(s) { return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,'').trim(); }
function h2t(s) { return s.replace(/<br\s*\/?>/gi,' ').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim(); }
function googleLink(l) { if(!l) return ''; const m=l.match(/(?:url|q)=([^&]+)/i); if(m){try{return decodeURIComponent(m[1]);}catch(e){}} return l; }
function domainOf(u) {
  try {
    const h = url.parse(u).hostname||'';
    const map = {'news.google.com':'Google News','feeds.finance.yahoo.com':'Yahoo Finance','www.nasdaq.com':'Nasdaq','feeds.bbci.co.uk':'BBC Business','www.cnbc.com':'CNBC','feeds.marketwatch.com':'MarketWatch'};
    for(const[k,v] of Object.entries(map)) if(h.includes(k)) return v;
    return h.replace('www.','').replace('feeds.','').split('.')[0];
  } catch(e) { return 'News'; }
}
function dedup(items) {
  const seen = new Set();
  return items.filter(a => { const k=a.title.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,55); if(seen.has(k)) return false; seen.add(k); return true; });
}
function isRelevant(item, ticker) {
  const text = (item.title+' '+item.description+' '+(item.link||'')).toLowerCase();
  return text.includes(ticker.toLowerCase());
}

// ── Sentiment ─────────────────────────────────────────────────────────────────
const BULL = ['beat','beats','record','surge','surged','rally','rallied','gain','gained','rise','rose','soar','soared','jump','jumped','upgrade','upgraded','outperform','buy rating','strong buy','profit','revenue','earnings beat','guidance raised','raises guidance','dividend','buyback','acquisition','merger','deal','partnership','launch','approval','approved','growth','grew','expansion','positive','bullish','higher','price target raised','above expectations','exceeded','new high','all-time high','52-week high','recovery','rebound','turnaround','gewinn','wachstum','rekord','bénéfice','croissance','hausse','増収','増益','最高益','上昇','增长','盈利','上涨'].map(w=>w.toLowerCase());
const BEAR = ['miss','missed','fall','fell','drop','dropped','decline','declined','tumble','tumbled','slump','slumped','plunge','plunged','crash','crashed','loss','losses','cut','cuts','downgrade','downgraded','underperform','sell rating','guidance cut','lowered guidance','miss expectations','below expectations','disappointing','weak','bearish','lower','price target cut','layoff','layoffs','restructuring','bankruptcy','default','lawsuit','fine','penalty','recall','shortage','tariff','ban','blocked','rejected','failed','fraud','investigation','warning','warns','verlust','rückgang','warnung','perte','baisse','avertissement','減収','減益','下落','損失','下滑','亏损','下跌','警告'].map(w=>w.toLowerCase());

function sentiment(title, desc) {
  const full = (title+' '+desc).toLowerCase();
  const tl = title.toLowerCase();
  let b=0, r=0;
  for(const w of BULL){ if(full.includes(w)) b++; if(tl.includes(w)) b+=2; }
  for(const w of BEAR){ if(full.includes(w)) r++; if(tl.includes(w)) r+=2; }
  if(b===0&&r===0) return 'neutral';
  if(b>r) return 'bullish';
  if(r>b) return 'bearish';
  return 'neutral';
}
function summary(title, desc, sent, ticker) {
  const d = (desc&&desc.length>30)?desc:title;
  const prefix = sent==='bullish'?`Positive for ${ticker}: `:sent==='bearish'?`Headwind for ${ticker}: `:`Update on ${ticker}: `;
  return (prefix+d).replace(/\s+/g,' ').slice(0,180);
}
function relTime(str) {
  if(!str) return '';
  try {
    const d=new Date(str); if(isNaN(d)) return str.slice(0,16);
    const s=(Date.now()-d)/1000;
    if(s<3600) return Math.max(1,Math.floor(s/60))+'m ago';
    if(s<86400) return Math.floor(s/3600)+'h ago';
    if(s<172800) return '1d ago';
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  } catch(e){ return ''; }
}

// ── Main fetch ────────────────────────────────────────────────────────────────
async function fetchNews(ticker) {
  const cached = getCached(ticker);
  if (cached) { console.log('[CACHE]', ticker); return cached; }

  const feeds = buildFeeds(ticker);
  console.log('[FETCH]', ticker, '—', feeds.length, 'feeds');

  const results = await Promise.allSettled(
    feeds.map(feedUrl =>
      fetchURL(feedUrl)
        .then(xml => parseRSS(xml, feedUrl))
        .catch(() => [])
    )
  );

  let all = [];
  for(const r of results) if(r.status==='fulfilled') all.push(...r.value);
  all = dedup(all);

  const relevant = all.filter(item => isRelevant(item, ticker));
  const src = relevant.length >= 3 ? relevant : all;
  src.sort((a,b) => { try{ return new Date(b.pubDate)-new Date(a.pubDate); }catch(e){ return 0; } });

  const articles = src.slice(0, 15).map(item => {
    const sent = sentiment(item.title, item.description);
    return { title:item.title, source:item.source, url:item.link||'', publishedAt:relTime(item.pubDate), sentiment:sent, summary:summary(item.title,item.description,sent,ticker) };
  });

  console.log('[DONE]', ticker, '—', articles.length, 'articles');
  setCached(ticker, articles);
  return articles;
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname, query } = url.parse(req.url, true);

  // Root — also acts as health check so Render knows it's alive
  if (pathname === '/' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'StockPulse News Proxy', uptime: Math.floor(process.uptime()), time: new Date().toISOString() }));
    return;
  }

  if (pathname === '/news') {
    const raw = (query.ticker || '').trim().toUpperCase();
    if (!raw) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Missing ?ticker='})); return; }

    const tickers = raw.split(',').map(t => t.replace(/[^A-Z0-9.\-]/g,'').slice(0,12)).filter(Boolean).slice(0,10);

    try {
      const groups = await Promise.all(tickers.map(async t => {
        try { return { ticker:t, articles: await fetchNews(t), error:null }; }
        catch(e) { return { ticker:t, articles:[], error:e.message }; }
      }));
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ groups, fetchedAt: Date.now() }));
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: 'Server error: ' + e.message }));
    }
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('StockPulse proxy running on port', PORT);

  // ── Keepalive: ping self every 14 min to prevent Render free tier sleep ──
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl) {
    setInterval(() => {
      https.get(selfUrl + '/health', res => {
        console.log('[KEEPALIVE] ping', res.statusCode);
        res.resume();
      }).on('error', e => console.log('[KEEPALIVE] error:', e.message));
    }, 14 * 60 * 1000);
    console.log('Keepalive enabled —', selfUrl);
  }
});
