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

// ── Article scraper ───────────────────────────────────────────────────────────
async function scrapeArticle(articleUrl) {
  if (!articleUrl || !articleUrl.startsWith('http')) return '';
  const blocked = ['wsj.com','ft.com','barrons.com','bloomberg.com','seekingalpha.com','economist.com','hbr.org'];
  try {
    const host = new URL(articleUrl).hostname;
    if (blocked.some(b => host.includes(b))) return '';
  } catch(e) { return ''; }
  try {
    const html = await fetchURL(articleUrl, 10000);
    return extractBodyText(html);
  } catch(e) { return ''; }
}

function extractBodyText(html) {
  if (!html) return '';
  // Remove non-content blocks
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!(--[\s\S]*?--|\[CDATA\[[\s\S]*?\]\])>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Split on sentence-ending punctuation followed by whitespace + capital
  // Use simple split instead of lookbehind for max compatibility
  const raw = t.replace(/([.!?])\s+([A-Z"(])/g, '$1☃$2').split('☃');
  const sentences = raw.map(s => s.trim()).filter(s => {
    return s.length > 50 && s.length < 700
      && /^[A-Z"(]/.test(s)
      && !/^(Cookie|Subscribe|Sign in|Log in|Click here|All rights|Privacy Policy|Terms of|Advertisement|Read more|Share this|Follow us|Newsletter|By clicking|You may also|Related article|Loading)/i.test(s)
      && (s.split(' ').length) > 7;
  });
  return sentences.slice(0, 50).join(' ');
}

// ── Extractive summariser ─────────────────────────────────────────────────────
function extractiveSummarise(bodyText, title, ticker) {
  if (!bodyText || bodyText.length < 80) return '';
  const tickerLower = ticker.toLowerCase();
  const titleWords = title.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(' ').filter(w => w.length > 3);
  const FIN_WORDS = ['revenue','earnings','profit','loss','growth','sales','margin','guidance',
    'forecast','outlook','quarter','annual','results','beat','miss','upgrade','downgrade',
    'target','price','acquisition','merger','deal','partnership','dividend','buyback',
    'analyst','rating','shares','stock','market','invest','fund','capital','debt','cash',
    'percent','million','billion','increase','decrease','raised','cut','announced',
    'reported','posted','expects','projected','estimates'];
  // Split without lookbehind
  const sentences = bodyText.replace(/([.!?])\s+([A-Z"(])/g,'$1☃$2').split('☃')
    .map(s => s.trim()).filter(s => s.length > 40);
  if (!sentences.length) return '';
  const scored = sentences.map((s, i) => {
    const sl = s.toLowerCase();
    let score = 0;
    if (i === 0) score += 10;
    else if (i === 1) score += 6;
    else if (i === 2) score += 3;
    if (sl.includes(tickerLower)) score += 6;
    for (const w of titleWords) if (sl.includes(w)) score += 2;
    for (const w of FIN_WORDS) if (sl.includes(w)) score += 1;
    const nums = (s.match(/\d/g) || []).length;
    score += Math.min(nums, 5);
    if (/sign up|subscribe|cookie|advertisement|click here|read more|follow us/i.test(s)) score -= 30;
    return { s, score, i };
  });
  const top = scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .sort((a, b) => a.i - b.i)
    .map(x => x.s.replace(/^[^A-Z"(]+/, '').replace(/\s+/g,' ').trim())
    .filter(s => s.length > 30);
  return top.join(' ');
}



// ── Feed builder ──────────────────────────────────────────────────────────────
function buildFeeds(ticker) {
  const e = s => encodeURIComponent(s);
  const t = ticker;
  return [
    `https://news.google.com/rss/search?q=${e(t+' stock news')}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('"'+t+'" stock')}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e(t+' shares earnings')}&hl=en-GB&gl=GB&ceid=GB:en`,
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${e(t)}&region=US&lang=en-US`,
    `https://www.nasdaq.com/feed/rssoutbound?symbol=${e(t)}`,
    `https://news.google.com/rss/search?q=${e('site:reuters.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:cnbc.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:ft.com '+t)}&hl=en-GB&gl=GB&ceid=GB:en`,
    `https://news.google.com/rss/search?q=${e('site:marketwatch.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:seekingalpha.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:bloomberg.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:barrons.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e('site:wsj.com '+t)}&hl=en-US&gl=US&ceid=US:en`,
    `https://news.google.com/rss/search?q=${e(t+' Aktie')}&hl=de-DE&gl=DE&ceid=DE:de`,
    `https://news.google.com/rss/search?q=${e('site:handelsblatt.com '+t)}&hl=de-DE&gl=DE&ceid=DE:de`,
    `https://news.google.com/rss/search?q=${e(t+' action bourse')}&hl=fr-FR&gl=FR&ceid=FR:fr`,
    `https://news.google.com/rss/search?q=${e('site:lesechos.fr '+t)}&hl=fr-FR&gl=FR&ceid=FR:fr`,
    `https://news.google.com/rss/search?q=${e(t+' azioni borsa')}&hl=it-IT&gl=IT&ceid=IT:it`,
    `https://news.google.com/rss/search?q=${e(t+' 株価')}&hl=ja-JP&gl=JP&ceid=JP:ja`,
    `https://news.google.com/rss/search?q=${e('site:nikkei.com '+t)}&hl=ja-JP&gl=JP&ceid=JP:ja`,
    `https://news.google.com/rss/search?q=${e(t+' 股票')}&hl=zh-HK&gl=HK&ceid=HK:zh-Hant`,
    `https://news.google.com/rss/search?q=${e('site:scmp.com '+t)}&hl=en-HK&gl=HK&ceid=HK:en`,
    `https://feeds.bbci.co.uk/news/business/rss.xml`,
    `https://www.cnbc.com/id/100003114/device/rss/rss.html`,
    `https://feeds.marketwatch.com/marketwatch/topstories/`,
  ];
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────
function fetchURL(targetUrl, ms) {
  ms = ms || 9000;
  return new Promise((resolve, reject) => {
    let redirects = 0;
    function go(u) {
      const p = url.parse(u);
      const lib = p.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: p.hostname, port: p.port, path: p.path || '/', method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
          'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache',
        }, timeout: ms,
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
    const title = clean(tag(b, 'title'));
    const link = clean(tag(b, 'link') || tag(b, 'guid') || attr(b, 'link', 'href'));
    const pubDate = clean(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated'));
    const srcTag = clean(tag(b, 'source'));
    const desc = h2t(clean(tag(b, 'description') || tag(b, 'summary') || '')).slice(0, 350);
    const source = srcTag || domainOf(feedUrl);
    if (title && title.length > 6) items.push({ title, link: googleLink(link), pubDate, source, description: desc, feedUrl });
  }
  return items;
}
function tag(x, n) { const m = x.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>', 'i')); return m ? m[1].trim() : ''; }
function attr(x, n, a) { const m = x.match(new RegExp('<' + n + '[^>]*' + a + '="([^"]*)"', 'i')); return m ? m[1] : ''; }
function clean(s) { return decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')).trim(); }
function decodeEntities(s) {
  // Named entities
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
       .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&lsquo;/g, '\u2018')
       .replace(/&rsquo;/g, '\u2019').replace(/&ldquo;/g, '\u201C').replace(/&rdquo;/g, '\u201D')
       .replace(/&hellip;/g, '…').replace(/&bull;/g, '·').replace(/&trade;/g, '™')
       .replace(/&reg;/g, '®').replace(/&copy;/g, '©').replace(/&euro;/g, '€')
       .replace(/&pound;/g, '£').replace(/&yen;/g, '¥');
  // Hex numeric entities e.g. &#x2014; &#x2018; &#x201C;
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    try { return String.fromCodePoint(parseInt(hex, 16)); } catch(e) { return ''; }
  });
  // Decimal numeric entities e.g. &#8212; &#8216;
  s = s.replace(/&#([0-9]+);/g, (_, dec) => {
    try { return String.fromCodePoint(parseInt(dec, 10)); } catch(e) { return ''; }
  });
  return s;
}
function h2t(s) {
  return decodeEntities(
    s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
  ).trim();
}
function googleLink(l) { if (!l) return ''; const m = l.match(/(?:url|q)=([^&]+)/i); if (m) { try { return decodeURIComponent(m[1]); } catch (e) { } } return l; }
function domainOf(u) {
  try {
    const h = url.parse(u).hostname || '';
    const map = { 'news.google.com': 'Google News', 'feeds.finance.yahoo.com': 'Yahoo Finance', 'finance.yahoo.com': 'Yahoo Finance', 'www.nasdaq.com': 'Nasdaq', 'feeds.bbci.co.uk': 'BBC Business', 'www.cnbc.com': 'CNBC', 'feeds.marketwatch.com': 'MarketWatch' };
    for (const [k, v] of Object.entries(map)) if (h.includes(k)) return v;
    return h.replace('www.', '').replace('feeds.', '').split('.')[0];
  } catch (e) { return 'News'; }
}
function dedup(items) {
  const seen = new Set();
  return items.filter(a => { const k = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 55); if (seen.has(k)) return false; seen.add(k); return true; });
}
function isRelevant(item, ticker) {
  const text = (item.title + ' ' + item.description + ' ' + (item.link || '')).toLowerCase();
  return text.includes(ticker.toLowerCase());
}

// ── Language detection ────────────────────────────────────────────────────────
function detectLang(text) {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(text)) return /[\u3040-\u30ff]/.test(text) ? 'ja' : 'zh';
  if (/[ÄäÖöÜüß]/.test(text) || /\b(Aktie|Kurs|Gewinn|Verlust|Anleger|Börse|Dividende|Quartalsbericht|Umsatz|Prognose|Bilanz|Fusion|Übernahme|Marktkapitalisierung|Gewinnwarnung)\b/i.test(text)) return 'de';
  if (/[àâçéèêëîïôùûüÿœæ]/.test(text) && /\b(bourse|actions?|hausse|baisse|bénéfice|résultats?|croissance|marché|investisseurs?|dividende|prévisions?|perte|chiffre)\b/i.test(text)) return 'fr';
  if (/\b(azioni|borsa|guadagni?|perdite?|ricavi|trimestre|fatturato|utile|titolo|mercato|quotazione|rialzo|ribasso)\b/i.test(text)) return 'it';
  if (/[áéíóúñ]/.test(text) && /\b(bolsa|acciones?|ganancias?|pérdidas?|beneficio|ingresos?|mercado|trimestre|inversores?|dividendo|resultados?)\b/i.test(text)) return 'es';
  if (/\b(aandelen|koers|winst|verlies|beurs|dividend|kwartaal|omzet|fusie|overname)\b/i.test(text)) return 'nl';
  if (/[ążźćśęłóń]/i.test(text) && /\b(akcje|kurs|zysk|strata|giełda|dywidenda|przychody|wyniki)\b/i.test(text)) return 'pl';
  return 'en';
}

// ── Translation dictionaries ──────────────────────────────────────────────────
// Each entry: [foreignPhrase, englishEquivalent]
// Sorted longest-first at apply time so longer phrases match before substrings

const DE_PHRASES = [
  ['Quartalsbericht', 'quarterly report'], ['Gewinnwarnung', 'profit warning'], ['Jahresergebnis', 'annual result'],
  ['Marktkapitalisierung', 'market capitalisation'], ['Übernahme', 'acquisition'], ['Kaufempfehlung', 'buy recommendation'],
  ['Verkaufsempfehlung', 'sell recommendation'], ['Kursanstieg', 'price rise'], ['Kursrückgang', 'price decline'],
  ['Kursziel erhöht', 'price target raised'], ['Kursziel gesenkt', 'price target cut'], ['Kursziel', 'price target'],
  ['Aktienrückkauf', 'share buyback'], ['Dividendenerhöhung', 'dividend increase'], ['Dividendenkürzung', 'dividend cut'],
  ['Ergebnis übertrifft Erwartungen', 'results beat expectations'], ['starkes Wachstum', 'strong growth'],
  ['Betriebsgewinn', 'operating profit'], ['Nettoverlust', 'net loss'], ['Nettogewinn', 'net profit'],
  ['Jahresbericht', 'annual report'], ['Halbjahresbericht', 'half-year report'],
  ['Restrukturierung', 'restructuring'], ['Entlassungen', 'layoffs'], ['Stellenabbau', 'job cuts'],
  ['Aktie', 'stock'], ['Kurs', 'share price'], ['Gewinn', 'profit'], ['Verlust', 'loss'],
  ['Anleger', 'investors'], ['Börse', 'stock market'], ['Dividende', 'dividend'], ['Umsatz', 'revenue'],
  ['Prognose', 'forecast'], ['Bilanz', 'balance sheet'], ['Fusion', 'merger'], ['Bericht', 'report'],
  ['Analyse', 'analysis'], ['Nachrichten', 'news'], ['Wachstum', 'growth'], ['Markt', 'market'],
  ['Investoren', 'investors'], ['Unternehmen', 'company'], ['Quartal', 'quarter'],
  ['Klage', 'lawsuit'], ['Geldstrafe', 'fine'], ['Regulierung', 'regulation'], ['Genehmigung', 'approval'],
  ['abgestuft', 'downgraded'], ['hochgestuft', 'upgraded'], ['übertrifft', 'beats'], ['verfehlt', 'misses'],
  ['steigt', 'rises'], ['fällt', 'falls'], ['sinkt', 'declines'], ['erhöht', 'raises'], ['senkt', 'cuts'],
  ['kündigt an', 'announces'], ['gibt bekannt', 'announces'], ['meldet', 'reports'],
];

const FR_PHRASES = [
  ["chiffre d'affaires", 'revenue'], ['résultats trimestriels', 'quarterly results'], ['résultats annuels', 'annual results'],
  ['bénéfice net', 'net profit'], ['perte nette', 'net loss'], ['bénéfice opérationnel', 'operating profit'],
  ['perspectives relevées', 'raised guidance'], ['perspectives abaissées', 'lowered guidance'],
  ['objectif de cours relevé', 'price target raised'], ['objectif de cours abaissé', 'price target cut'],
  ["recommandation d'achat", 'buy recommendation'], ['recommandation de vente', 'sell recommendation'],
  ['hausse du dividende', 'dividend increase'], ['coupe du dividende', 'dividend cut'],
  ["rachat d'actions", 'share buyback'], ['fusion-acquisition', 'merger and acquisition'],
  ['surperforme', 'outperforms'], ['sous-performe', 'underperforms'], ['dépasse les attentes', 'beats expectations'],
  ['en dessous des attentes', 'below expectations'],
  ['hausse', 'rise'], ['baisse', 'decline'], ['bénéfice', 'profit'], ['perte', 'loss'],
  ['bourse', 'stock market'], ['action', 'stock'], ['actions', 'stocks'],
  ['résultats', 'results'], ['prévisions', 'forecast'], ['croissance', 'growth'], ['marché', 'market'],
  ['investisseurs', 'investors'], ['dividende', 'dividend'], ['trimestre', 'quarter'], ['entreprise', 'company'],
  ['recul', 'decline'], ['rebond', 'rebound'], ['milliards', 'billion'], ['millions', 'million'],
  ['annonce', 'announces'], ['publie', 'publishes'], ['dépasse', 'exceeds'], ['manque', 'misses'],
  ['monte', 'rises'], ['chute', 'falls'], ['grimpe', 'climbs'], ['plonge', 'plunges'], ['bondit', 'jumps'],
  ['avertissement', 'warning'], ['accord', 'deal'], ['partenariat', 'partnership'],
];

const IT_PHRASES = [
  ['utile netto', 'net profit'], ['perdita netta', 'net loss'], ['utile operativo', 'operating profit'],
  ['ricavi trimestrali', 'quarterly revenue'], ['risultati annuali', 'annual results'],
  ['obiettivo di prezzo alzato', 'price target raised'], ['obiettivo di prezzo tagliato', 'price target cut'],
  ['raccomandazione di acquisto', 'buy recommendation'], ['raccomandazione di vendita', 'sell recommendation'],
  ['riacquisto di azioni', 'share buyback'], ['aumento del dividendo', 'dividend increase'],
  ['supera le attese', 'beats expectations'], ['sotto le attese', 'below expectations'],
  ['azioni', 'stock'], ['borsa', 'stock market'], ['guadagni', 'earnings'], ['perdite', 'losses'],
  ['ricavi', 'revenue'], ['trimestre', 'quarter'], ['fatturato', 'turnover'], ['utile', 'profit'],
  ['titolo', 'stock'], ['mercato', 'market'], ['quotazione', 'share price'],
  ['rialzo', 'rise'], ['ribasso', 'decline'], ['fusione', 'merger'], ['acquisizione', 'acquisition'],
  ['dividendo', 'dividend'], ['annuncia', 'announces'], ['pubblica', 'publishes'],
  ['supera', 'exceeds'], ['manca', 'misses'], ['sale', 'rises'], ['scende', 'falls'],
  ['crolla', 'crashes'], ['balza', 'jumps'], ['rimbalza', 'rebounds'],
  ['ristrutturazione', 'restructuring'], ['licenziamenti', 'layoffs'], ['accordo', 'deal'],
];

const ES_PHRASES = [
  ['beneficio neto', 'net profit'], ['pérdida neta', 'net loss'], ['beneficio operativo', 'operating profit'],
  ['ingresos trimestrales', 'quarterly revenue'], ['resultados anuales', 'annual results'],
  ['objetivo de precio elevado', 'price target raised'], ['objetivo de precio reducido', 'price target cut'],
  ['recomendación de compra', 'buy recommendation'], ['recomendación de venta', 'sell recommendation'],
  ['recompra de acciones', 'share buyback'], ['aumento de dividendo', 'dividend increase'],
  ['supera expectativas', 'beats expectations'], ['por debajo de las expectativas', 'below expectations'],
  ['acciones', 'shares'], ['bolsa', 'stock market'], ['ganancias', 'earnings'], ['pérdidas', 'losses'],
  ['ingresos', 'revenue'], ['trimestre', 'quarter'], ['beneficio', 'profit'], ['dividendo', 'dividend'],
  ['mercado', 'market'], ['inversores', 'investors'], ['cotización', 'share price'],
  ['sube', 'rises'], ['baja', 'falls'], ['cae', 'declines'], ['salta', 'jumps'], ['se desploma', 'plunges'],
  ['anuncia', 'announces'], ['publica', 'publishes'], ['supera', 'exceeds'], ['no alcanza', 'misses'],
  ['fusión', 'merger'], ['adquisición', 'acquisition'], ['acuerdo', 'deal'], ['reestructuración', 'restructuring'],
];

const NL_PHRASES = [
  ['nettowinst', 'net profit'], ['nettoverlies', 'net loss'], ['kwartaalresultaten', 'quarterly results'],
  ['jaarresultaten', 'annual results'], ['koersdoelverhoging', 'price target raised'],
  ['koersdoelverlaging', 'price target cut'], ['aandelen', 'shares'], ['koers', 'share price'],
  ['winst', 'profit'], ['verlies', 'loss'], ['beurs', 'stock exchange'], ['dividend', 'dividend'],
  ['kwartaal', 'quarter'], ['omzet', 'revenue'], ['fusie', 'merger'], ['overname', 'acquisition'],
  ['stijgt', 'rises'], ['daalt', 'falls'], ['overtreft', 'beats'], ['mist', 'misses'],
  ['kondigt aan', 'announces'], ['meldt', 'reports'], ['verhoogt', 'raises'], ['verlaagt', 'cuts'],
];

const PL_PHRASES = [
  ['zysk netto', 'net profit'], ['strata netto', 'net loss'], ['wyniki kwartalne', 'quarterly results'],
  ['wyniki roczne', 'annual results'], ['akcje', 'shares'], ['kurs', 'share price'],
  ['zysk', 'profit'], ['strata', 'loss'], ['giełda', 'stock exchange'], ['dywidenda', 'dividend'],
  ['kwartał', 'quarter'], ['przychody', 'revenue'], ['fuzja', 'merger'], ['przejęcie', 'acquisition'],
  ['rośnie', 'rises'], ['spada', 'falls'], ['ogłasza', 'announces'], ['raportuje', 'reports'],
];

// Japanese — covers hiragana/katakana financial terms + company name transliterations
const JA_MAP = [
  ['株価上昇', 'stock price rise'], ['株価下落', 'stock price decline'], ['最高値', 'all-time high'],
  ['最安値', 'all-time low'], ['増収増益', 'revenue and profit growth'], ['減収減益', 'revenue and profit decline'],
  ['増収', 'revenue growth'], ['減収', 'revenue decline'], ['増益', 'profit growth'], ['減益', 'profit decline'],
  ['最高益', 'record profit'], ['純利益', 'net profit'], ['純損失', 'net loss'],
  ['営業利益', 'operating profit'], ['営業損失', 'operating loss'], ['売上高', 'revenue'], ['売上', 'revenue'],
  ['業績予想', 'earnings forecast'], ['業績修正', 'earnings revision'], ['上方修正', 'upward revision'],
  ['下方修正', 'downward revision'], ['配当増加', 'dividend increase'], ['配当', 'dividend'],
  ['自社株買い', 'share buyback'], ['買収', 'acquisition'], ['合併', 'merger'], ['提携', 'partnership'],
  ['株式分割', 'stock split'], ['上場廃止', 'delisting'], ['新規上場', 'IPO'],
  ['格上げ', 'upgrade'], ['格下げ', 'downgrade'],
  ['目標株価引き上げ', 'price target raised'], ['目標株価引き下げ', 'price target cut'],
  ['買い推奨', 'buy recommendation'], ['売り推奨', 'sell recommendation'],
  ['四半期決算', 'quarterly earnings'], ['年度決算', 'annual earnings'],
  ['好決算', 'strong earnings'], ['決算', 'earnings'],
  ['株価情報', 'stock price information'], ['株式情報', 'stock information'], ['株式', 'stock'],
  ['株価', 'stock price'], ['株', 'stock'], ['投資家', 'investors'], ['市場', 'market'],
  ['業績', 'performance'], ['利益', 'profit'], ['損失', 'loss'], ['収益', 'earnings'],
  ['成長', 'growth'], ['リストラ', 'restructuring'], ['解雇', 'layoffs'],
  ['訴訟', 'lawsuit'], ['罰金', 'fine'], ['規制', 'regulation'], ['承認', 'approval'],
  ['上昇', 'rise'], ['下落', 'decline'], ['急騰', 'surge'], ['急落', 'plunge'],
  ['発表', 'announces'], ['報告', 'reports'], ['計画', 'plans'],
  ['ファイナンス', 'Finance'], ['エヌビディア', 'NVIDIA'], ['アップル', 'Apple'],
  ['テスラ', 'Tesla'], ['アマゾン', 'Amazon'], ['マイクロソフト', 'Microsoft'],
  ['グーグル', 'Google'], ['メタ', 'Meta'], ['アナリスト', 'analyst'],
];

// Chinese (Traditional + Simplified)
const ZH_MAP = [
  ['股價上漲', 'stock price rise'], ['股價下跌', 'stock price decline'], ['歷史新高', 'all-time high'],
  ['歷史新低', 'all-time low'], ['股票回購', 'share buyback'], ['股息', 'dividend'], ['派息', 'dividend'],
  ['季度業績', 'quarterly results'], ['年度業績', 'annual results'], ['淨利潤', 'net profit'],
  ['淨虧損', 'net loss'], ['營業利潤', 'operating profit'], ['總收入', 'total revenue'],
  ['業績超預期', 'earnings beat'], ['業績低於預期', 'earnings miss'],
  ['上調目標價', 'price target raised'], ['下調目標價', 'price target cut'],
  ['買入評級', 'buy rating'], ['賣出評級', 'sell rating'],
  ['評級上調', 'rating upgrade'], ['評級下調', 'rating downgrade'],
  ['重組', 'restructuring'], ['裁員', 'layoffs'], ['訴訟', 'lawsuit'],
  ['罰款', 'fine'], ['監管', 'regulation'], ['批准', 'approval'], ['合作', 'partnership'],
  // Simplified
  ['股价上涨', 'stock price rise'], ['股价下跌', 'stock price decline'], ['历史新高', 'all-time high'],
  ['股票回购', 'share buyback'], ['净利润', 'net profit'], ['净亏损', 'net loss'],
  ['营业利润', 'operating profit'], ['总收入', 'total revenue'],
  ['季度业绩', 'quarterly results'], ['年度业绩', 'annual results'],
  ['业绩超预期', 'earnings beat'], ['业绩低于预期', 'earnings miss'],
  ['上调目标价', 'price target raised'], ['下调目标价', 'price target cut'],
  ['买入评级', 'buy rating'], ['卖出评级', 'sell rating'],
  // Common single terms
  ['兼并', 'merger'], ['合并', 'merger'], ['收购', 'acquisition'],
  ['增收', 'revenue growth'], ['减收', 'revenue decline'], ['盈利', 'profit'], ['亏损', 'loss'],
  ['上涨', 'rises'], ['下跌', 'falls'], ['暴涨', 'surges'], ['暴跌', 'plunges'],
  ['公告', 'announces'], ['报告', 'reports'], ['预测', 'forecast'],
  ['股票', 'stock'], ['股份', 'shares'], ['市场', 'market'], ['投资者', 'investors'],
  ['分析师', 'analyst'], ['即时新闻', 'breaking news'], ['即時新聞', 'breaking news'],
  ['輝達', 'NVIDIA'], ['英偉達', 'NVIDIA'], ['蘋果', 'Apple'], ['特斯拉', 'Tesla'],
  ['亞馬遜', 'Amazon'], ['微軟', 'Microsoft'], ['谷歌', 'Google'],
  ['高股息', 'high dividend'], ['科技股', 'tech stocks'], ['避開', 'avoiding'],
  ['引隱憂', 'raises concerns'], ['大對決', 'major showdown'], ['抗跌', 'resilient'],
  ['佔比', 'proportion'], ['投資網誌', 'investment blog'], ['網誌', 'blog'],
];

// ── Apply phrase map ──────────────────────────────────────────────────────────
function applyPhraseMap(text, phrases) {
  let result = text;
  const sorted = [...phrases].sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of sorted) {
    try {
      const regex = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      result = result.replace(regex, to);
    } catch (e) {}
  }
  return result;
}

function translateTitle(title, lang) {
  if (lang === 'en') return { translatedTitle: null };
  let translated = title;
  if (lang === 'de') translated = applyPhraseMap(translated, DE_PHRASES);
  else if (lang === 'fr') translated = applyPhraseMap(translated, FR_PHRASES);
  else if (lang === 'it') translated = applyPhraseMap(translated, IT_PHRASES);
  else if (lang === 'es') translated = applyPhraseMap(translated, ES_PHRASES);
  else if (lang === 'nl') translated = applyPhraseMap(translated, NL_PHRASES);
  else if (lang === 'pl') translated = applyPhraseMap(translated, PL_PHRASES);
  else if (lang === 'ja') translated = applyPhraseMap(translated, JA_MAP);
  else if (lang === 'zh') translated = applyPhraseMap(translated, ZH_MAP);
  if (translated.trim() === title.trim()) return { translatedTitle: null };
  return { translatedTitle: translated.trim() };
}

// ── Sentiment analysis ────────────────────────────────────────────────────────
const BULL = ['beat','beats','record','surge','surged','rally','rallied','gain','gained','rise','rose','soar','soared','jump','jumped','upgrade','upgraded','outperform','buy rating','strong buy','profit','earnings beat','guidance raised','raises guidance','dividend','buyback','acquisition','merger','deal','partnership','launch','approval','approved','growth','grew','expansion','positive','bullish','price target raised','above expectations','exceeded','new high','all-time high','recovery','rebound','52-week high','breakthrough','wins contract','awarded','strong results','record revenue','record profit','raised forecast','margin expansion','cash flow','beat estimates'].map(w => w.toLowerCase());
const BEAR = ['miss','missed','fall','fell','drop','dropped','decline','declined','tumble','tumbled','slump','slumped','plunge','plunged','crash','crashed','loss','losses','cut','cuts','downgrade','downgraded','underperform','sell rating','guidance cut','lowered guidance','below expectations','disappointing','weak','bearish','price target cut','layoff','layoffs','restructuring','bankruptcy','default','lawsuit','fine','penalty','recall','shortage','tariff','ban','blocked','rejected','failed','fraud','investigation','warning','warns'].map(w => w.toLowerCase());

function sentiment(title, desc) {
  const full = (title + ' ' + desc).toLowerCase(), tl = title.toLowerCase();
  let b = 0, r = 0;
  for (const w of BULL) { if (full.includes(w)) b++; if (tl.includes(w)) b += 2; }
  for (const w of BEAR) { if (full.includes(w)) r++; if (tl.includes(w)) r += 2; }
  if (b === 0 && r === 0) return 'neutral';
  return b > r ? 'bullish' : r > b ? 'bearish' : 'neutral';
}

// ── Summary generation ────────────────────────────────────────────────────────
function makeSummary(title, desc, sent, ticker) {
  const rawDesc = (desc || '').trim();
  const cleanDesc = decodeEntities(rawDesc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  const noUrls = cleanDesc.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  // Strip trailing source attribution suffixes
  const noSource = noUrls.replace(/\s*[-\u2013\u2014|]\s*(MarketWatch|Reuters|CNBC|Bloomberg|Yahoo Finance|Financial Times|Barron's|Nasdaq|BBC|Seeking Alpha|WSJ|FT|Forbes|Business Insider|The Guardian|AP|Associated Press|Fathom Journal|marketscreener\.com|marketscreener)\.?\s*$/i, '').trim();
  // Skip if description is just a repeat of the title
  const titleCore = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
  const descCore  = noSource.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
  const isSameAsTitle = descCore === titleCore || noSource.toLowerCase().startsWith(title.toLowerCase().slice(0, 70));
  // Return full description — no truncation
  if (noSource.length >= 80 && !isSameAsTitle) return noSource;
  return '';
}

function isoDate(str) {
  if (!str) return '';
  try { const d = new Date(str); return isNaN(d) ? '' : d.toISOString(); } catch(e) { return ''; }
}

// ── Main news fetch ───────────────────────────────────────────────────────────
async function fetchNews(ticker) {
  const cached = getCached(ticker);
  if (cached) { console.log('[CACHE]', ticker); return cached; }

  const feeds = buildFeeds(ticker);
  console.log('[FETCH]', ticker, '—', feeds.length, 'feeds');

  const results = await Promise.allSettled(
    feeds.map(feedUrl => fetchURL(feedUrl).then(xml => parseRSS(xml, feedUrl)).catch(() => []))
  );

  let all = [];
  for (const r of results) if (r.status === 'fulfilled') all.push(...r.value);
  all = dedup(all);

  const relevant = all.filter(item => isRelevant(item, ticker));
  // Never fall back to unrelated articles — only serve relevant ones
  const src = relevant.length > 0 ? relevant : [];
  src.sort((a, b) => { try { return new Date(b.pubDate) - new Date(a.pubDate); } catch (e) { return 0; } });

  // Build base article metadata synchronously
  const base = src.slice(0, 15).map(item => {
    const lang = detectLang(item.title);
    const { translatedTitle } = translateTitle(item.title, lang);
    const titleForAnalysis = translatedTitle || item.title;
    const sent = sentiment(titleForAnalysis, item.description);
    const rssSum = makeSummary(titleForAnalysis, item.description, sent, ticker);
    return {
      title: item.title,
      translatedTitle: translatedTitle || null,
      lang,
      source: item.source,
      url: item.link || '',
      pubDate: isoDate(item.pubDate),
      sentiment: sent,
      _rssSum: rssSum,
    };
  });

  // Scrape + summarise articles in parallel — free, no API needed
  // Limit concurrency to 5 at a time to avoid overwhelming the server
  const articles = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < base.length; i += CONCURRENCY) {
    const batch = base.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async item => {
      const titleEn = item.translatedTitle || item.title;
      let summary = '';
      // Always attempt to scrape the real article for a proper summary
      const bodyText = await scrapeArticle(item.url);
      if (bodyText) {
        const extracted = extractiveSummarise(bodyText, titleEn, ticker);
        if (extracted && extracted.length > 60) summary = extracted;
      }
      // Fall back to RSS description only if scrape failed or returned nothing
      if (!summary && item._rssSum && item._rssSum.length > 60) {
        summary = item._rssSum;
      }
      const { _rssSum, ...clean } = item;
      return { ...clean, summary: summary || '' };
    }));
    articles.push(...results);
  }

  console.log('[DONE]', ticker, '—', articles.length, 'articles');
  setCached(ticker, articles);
  return articles;
}

// ── Bottleneck / opportunity keyword detector ─────────────────────────────────
// Maps keywords found in headlines → sector problem + investable angle
const OPPORTUNITY_MAP = [
  // Interconnect / bandwidth
  { keys: ['copper','interconnect','bandwidth','latency','cable','wiring','signal integrity'],
    problem: 'data centre interconnect bandwidth bottleneck',
    sector: 'Silicon Photonics & Optical Interconnects',
    cos: 'Coherent Corp (COHR), II-VI / Coherent (IIVI), Lumentum (LITE), Inphi (acquired by Marvell), Ayar Labs (private), Marvell Technology (MRVL)' },
  // Photonics
  { keys: ['photon','photonic','optical','laser','lidar'],
    problem: 'optical interconnect and sensing demand surge',
    sector: 'Photonics & Optical Components',
    cos: 'Lumentum (LITE), Coherent Corp (COHR), II-VI (IIVI), IPG Photonics (IPGP), Ii-Vi Incorporated, Viavi Solutions (VIAV)' },
  // Power / energy
  { keys: ['power consumption','energy','cooling','thermal','heat','watt','electricity','grid','power usage'],
    problem: 'soaring power and cooling demands in AI/data centre infrastructure',
    sector: 'Power Management & Data Centre Cooling',
    cos: 'Vertiv Holdings (VRT), Eaton (ETN), Amphenol (APH), nVent Electric (NVT), Bloom Energy (BE), Schneider Electric (SU.PA)' },
  // Memory / HBM
  { keys: ['hbm','memory','dram','bandwidth','stacking','packaging'],
    problem: 'memory bandwidth wall constraining AI accelerator performance',
    sector: 'Advanced Memory & HBM',
    cos: 'SK Hynix (000660.KS), Micron Technology (MU), Samsung Electronics (005930.KS), Rambus (RMBS)' },
  // Advanced packaging
  { keys: ['packaging','chiplet','cowos','advanced packaging','interposer','tsmc'],
    problem: 'advanced chip packaging capacity shortage',
    sector: 'Advanced Semiconductor Packaging',
    cos: 'ASE Technology (ASX), Amkor Technology (AMKR), SPIL, Kulicke & Soffa (KLIC), Brewer Science (private)' },
  // Supply chain / shortage
  { keys: ['supply chain','shortage','supply constraint','lead time','inventory','backlog'],
    problem: 'supply chain disruption and component shortages',
    sector: 'Supply Chain Resilience & Distribution',
    cos: 'Flex Ltd (FLEX), Jabil (JBL), Celestica (CLS), Arrow Electronics (ARW), Avnet (AVT)' },
  // Cybersecurity
  { keys: ['cyber','hack','breach','security','ransomware','vulnerability','attack','malware'],
    problem: 'escalating cybersecurity threats and breach risk',
    sector: 'Cybersecurity',
    cos: 'CrowdStrike (CRWD), Palo Alto Networks (PANW), SentinelOne (S), Fortinet (FTNT), Zscaler (ZS)' },
  // AI / inference
  { keys: ['ai','artificial intelligence','inference','training','llm','large language','generative'],
    problem: 'AI infrastructure build-out demand driving component suppliers',
    sector: 'AI Infrastructure & Accelerators',
    cos: 'Nvidia (NVDA), Broadcom (AVGO), Marvell Technology (MRVL), Super Micro Computer (SMCI), Dell Technologies (DELL)' },
  // Semiconductor equipment
  { keys: ['fab','fabrication','foundry','wafer','lithography','etch','deposition','equipment'],
    problem: 'semiconductor fabrication capacity and equipment demand',
    sector: 'Semiconductor Capital Equipment',
    cos: 'ASML (ASML), Lam Research (LRCX), KLA Corp (KLAC), Applied Materials (AMAT), Tokyo Electron (8035.T)' },
  // EV / Battery
  { keys: ['battery','ev','electric vehicle','charging','cathode','anode','lithium','solid state'],
    problem: 'EV battery supply and energy density constraints',
    sector: 'EV Battery Technology & Materials',
    cos: 'QuantumScape (QS), Albemarle (ALB), Livent (LTHM), Panasonic (6752.T), CATL (300750.SZ), SQM (SQM)' },
  // Software / cloud migration
  { keys: ['cloud','migration','saas','subscription','digital transformation','software'],
    problem: 'enterprise cloud migration and SaaS platform expansion',
    sector: 'Cloud Infrastructure & SaaS',
    cos: 'Microsoft (MSFT), Amazon Web Services (AMZN), Snowflake (SNOW), Palantir (PLTR), ServiceNow (NOW)' },
  // Regulatory / compliance
  { keys: ['regulation','regulatory','compliance','antitrust','investigation','sanction','tariff','ban','export control'],
    problem: 'regulatory and geopolitical headwinds constraining growth',
    sector: 'Regulatory Compliance & Legal Tech',
    cos: 'Wolters Kluwer (WKL.AS), Dun & Bradstreet (DNB), Navex Global (private), MSCI (MSCI)' },
  // Healthcare / biotech constraints
  { keys: ['clinical trial','fda','approval','drug','therapy','biotech','pharma','patent'],
    problem: 'drug approval pipeline and patent cliff risks',
    sector: 'Contract Research & Drug Manufacturing',
    cos: 'ICON Plc (ICLR), Lonza Group (LONN.SW), Catalent (CTLT), Charles River Labs (CRL), Thermo Fisher (TMO)' },
  // Logistics / shipping
  { keys: ['shipping','freight','port','logistics','container','delivery','warehouse'],
    problem: 'logistics and freight cost pressures',
    sector: 'Freight & Logistics Technology',
    cos: 'XPO Logistics (XPO), Saia Inc (SAIA), Old Dominion (ODFL), Descartes Systems (DSGX), Flexport (private)' },
  // Listing / IPO / capital markets
  { keys: ['ipo','listing','nasdaq listing','us listing','public offering','capital raise'],
    problem: 'capital market access and US listing requirements',
    sector: 'Investment Banking & Market Infrastructure',
    cos: 'Nasdaq Inc (NDAQ), Intercontinental Exchange (ICE), Goldman Sachs (GS), Morgan Stanley (MS)' },
];

function detectOpportunities(articles) {
  const allText = articles.map(a => (a.translatedTitle || a.title) + ' ' + (a.summary || '')).join(' ').toLowerCase();
  const found = [];
  for (const opp of OPPORTUNITY_MAP) {
    const matchedKeys = opp.keys.filter(k => allText.includes(k));
    if (matchedKeys.length >= 1) {
      found.push({ ...opp, matched: matchedKeys });
    }
  }
  // Deduplicate by sector, return top 3 most-matched
  const seen = new Set();
  return found
    .sort((a, b) => b.matched.length - a.matched.length)
    .filter(o => { if (seen.has(o.sector)) return false; seen.add(o.sector); return true; })
    .slice(0, 3);
}

// ── Thesis generation ────────────────────────────────────────────────────────
function generateThesis(ticker, articles) {
  if (!articles || !articles.length) return 'Insufficient news data to generate a thesis.';
  const bull  = articles.filter(a => a.sentiment === 'bullish');
  const bear  = articles.filter(a => a.sentiment === 'bearish');
  const bullTitles = bull.slice(0, 3).map(a => a.translatedTitle || a.title).join('; ');
  const bearTitles = bear.slice(0, 3).map(a => a.translatedTitle || a.title).join('; ');
  const tot = articles.length;
  const dominance = bull.length > bear.length ? 'bullish' : bear.length > bull.length ? 'bearish' : 'mixed';
  const opps = detectOpportunities(articles);

  // ── Section 1: Current picture ──────────────────────────────
  let thesis = '';
  if (dominance === 'bullish') {
    thesis += `📊 Current Picture\n\n${ticker} is generating predominantly positive news flow — ${bull.length} of ${tot} recent articles carry bullish signals. Key themes: ${bullTitles.slice(0, 200)}. This suggests improving fundamentals or strong operational momentum not yet fully priced in by the market.`;
  } else if (dominance === 'bearish') {
    thesis += `📊 Current Picture\n\n${ticker} faces a challenging news environment — ${bear.length} of ${tot} articles carry bearish signals. Key headwinds: ${bearTitles.slice(0, 200)}. This may indicate deteriorating fundamentals, sector pressure, or company-specific issues requiring close monitoring.`;
  } else {
    thesis += `📊 Current Picture\n\nNews flow for ${ticker} is balanced: ${bull.length} bullish vs ${bear.length} bearish signals across ${tot} articles. The market appears to be at a pivotal decision point — directional conviction will likely come from the next earnings release, guidance update, or macro catalyst.`;
  }

  // ── Section 2: Chain-effect outlook ─────────────────────────
  thesis += `\n\n🔗 Chain-Effect Outlook\n\n`;
  if (dominance === 'bullish') {
    thesis += `If ${ticker}'s bullish momentum is sustained, several compounding effects could follow. Positive earnings or analyst upgrades typically trigger institutional accumulation, improving liquidity and tightening spreads. For smaller-cap names this snowball is particularly powerful — rising visibility can attract index inclusion consideration, driving passive fund inflows. Confirmed revenue growth could fuel margin expansion as fixed costs are spread over a larger base, creating a virtuous cycle that attracts M&A or strategic partnership interest from larger players.`;
  } else if (dominance === 'bearish') {
    thesis += `Sustained negative news for ${ticker} risks a self-reinforcing spiral. Analyst downgrades typically follow prolonged negative cycles, triggering institutional de-risking. Deteriorating sentiment raises the cost of capital — equity raises become dilutive, debt becomes expensive — constraining operational flexibility. For smaller-cap names, reduced liquidity amplifies price moves well beyond fundamental value. The key watchpoint is management's next guidance commentary: a downward revision is often the catalyst that accelerates a de-rating.`;
  } else {
    thesis += `The key driver for ${ticker} will be which narrative achieves dominance. If bullish catalysts are structural rather than one-off, current hesitation could represent an accumulation window. Conversely, if bearish signals reflect operational weakness, current prices may not adequately discount the risk. Resolution typically occurs around earnings releases, major contract announcements, or macro inflection points.`;
  }

  // ── Section 3: Identified bottlenecks & adjacent opportunities ──
  if (opps.length > 0) {
    thesis += `\n\n🔍 Bottleneck Analysis & Adjacent Investment Opportunities\n\nBased on the news flow for ${ticker}, the following structural challenges and adjacent investment themes have been identified:\n`;
    for (const opp of opps) {
      thesis += `\n▸ Problem identified: ${opp.problem.charAt(0).toUpperCase() + opp.problem.slice(1)}.\nThis points to opportunity in: ${opp.sector}.\nCompanies to research: ${opp.cos}.\n`;
    }
    thesis += `\nThese are not buy recommendations — they are research starting points based on thematic linkages identified in ${ticker}'s current news flow. Always conduct your own due diligence.`;
  }

  // ── Section 4: Key risks ─────────────────────────────────────
  thesis += `\n\n⚠️ Key Risks to Monitor\n\n`;
  if (dominance === 'bullish') {
    thesis += `(1) Execution risk — the gap between positive news and delivered results is where most bull cases collapse. Verify that revenue growth translates to margin improvement, not just top-line expansion.\n(2) Sector rotation — macro shifts can de-rate entire sectors regardless of individual fundamentals.\n(3) Valuation stretch — high-momentum names become disproportionately vulnerable to any negative earnings surprise.`;
  } else if (dominance === 'bearish') {
    thesis += `(1) Overshooting risk — markets regularly punish stocks beyond what fundamentals warrant; signs of stabilisation may signal a contrarian entry.\n(2) Management response — watch for restructuring plans, asset disposals, or strategic pivots that could reset the earnings base.\n(3) Sector-wide recovery — macro tailwinds or sector catalysts can lift all boats regardless of company-specific issues.`;
  } else {
    thesis += `(1) Earnings guidance tone — the next release will likely resolve the current directional ambiguity.\n(2) One-off vs structural — determine whether bullish items are recurring or episodic.\n(3) Insider activity — track director buying/selling and institutional 13F filings as leading sentiment indicators.\n(4) Macro tailwinds — monitor sector-level capital flows which can shift mixed-signal names decisively.`;
  }

  return thesis;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname, query } = url.parse(req.url, true);

  if (pathname === '/' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'StockPulse News Proxy', uptime: Math.floor(process.uptime()), time: new Date().toISOString() }));
    return;
  }

  if (pathname === '/news') {
    const raw = (query.ticker || '').trim().toUpperCase();
    if (!raw) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing ?ticker=' })); return; }
    const tickers = raw.split(',').map(t => t.replace(/[^A-Z0-9.\-]/g, '').slice(0, 12)).filter(Boolean).slice(0, 10);
    try {
      const groups = await Promise.all(tickers.map(async t => {
        try { return { ticker: t, articles: await fetchNews(t), error: null }; }
        catch (e) { return { ticker: t, articles: [], error: e.message }; }
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ groups, fetchedAt: Date.now() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server error: ' + e.message }));
    }
    return;
  }

  if (pathname === '/thesis') {
    const ticker = (query.ticker || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
    if (!ticker) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing ?ticker=' })); return; }
    const cached = getCached(ticker);
    if (!cached || !cached.length) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ thesis: 'No cached news data found for ' + ticker + '. Please search for news first.' }));
      return;
    }
    const thesis = generateThesis(ticker, cached);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ticker, thesis }));
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('StockPulse proxy running on port', PORT);
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl) {
    setInterval(() => {
      https.get(selfUrl + '/health', res => { console.log('[KEEPALIVE]', res.statusCode); res.resume(); })
        .on('error', e => console.log('[KEEPALIVE error]', e.message));
    }, 14 * 60 * 1000);
    console.log('Keepalive enabled —', selfUrl);
  }
});
