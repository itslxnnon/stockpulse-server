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
function clean(s) { return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim(); }
function h2t(s) { return s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
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
  const d = (desc && desc.length > 40) ? desc : null;
  const context = d ? d : title;
  const prefix = sent === 'bullish' ? `Bullish for ${ticker}: ` : sent === 'bearish' ? `Bearish for ${ticker}: ` : `Neutral update for ${ticker}: `;
  const cleaned = context.replace(/\s+/g, ' ').trim();
  const sentence = cleaned.length > 160 ? cleaned.slice(0, 157) + '…' : cleaned;
  return prefix + sentence;
}

function relTime(str) {
  if (!str) return '';
  try {
    const d = new Date(str); if (isNaN(d)) return str.slice(0, 16);
    const s = (Date.now() - d) / 1000;
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 172800) return '1d ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch (e) { return ''; }
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
  const src = relevant.length >= 3 ? relevant : all;
  src.sort((a, b) => { try { return new Date(b.pubDate) - new Date(a.pubDate); } catch (e) { return 0; } });

  const articles = src.slice(0, 15).map(item => {
    const lang = detectLang(item.title);
    const { translatedTitle } = translateTitle(item.title, lang);
    const titleForAnalysis = translatedTitle || item.title;
    const sent = sentiment(titleForAnalysis, item.description);
    const summary = makeSummary(titleForAnalysis, item.description, sent, ticker);
    return {
      title: item.title,                        // always original
      translatedTitle: translatedTitle || null, // English version if foreign, else null
      lang,
      source: item.source,
      url: item.link || '',
      publishedAt: relTime(item.pubDate),
      sentiment: sent,
      summary,
    };
  });

  console.log('[DONE]', ticker, '—', articles.length, 'articles');
  setCached(ticker, articles);
  return articles;
}

// ── Thesis generation ────────────────────────────────────────────────────────
function generateThesis(ticker, articles) {
  if (!articles || !articles.length) return 'Insufficient news data to generate a thesis.';
  const bull = articles.filter(a => a.sentiment === 'bullish');
  const bear = articles.filter(a => a.sentiment === 'bearish');
  const bullTitles = bull.slice(0, 3).map(a => a.translatedTitle || a.title).join('; ');
  const bearTitles = bear.slice(0, 3).map(a => a.translatedTitle || a.title).join('; ');
  const tot = articles.length;
  const dominance = bull.length > bear.length ? 'bullish' : bear.length > bull.length ? 'bearish' : 'mixed';
  let thesis = '';

  if (dominance === 'bullish') {
    thesis += `Current picture: ${ticker} is generating predominantly positive news flow, with ${bull.length} out of ${tot} recent articles carrying bullish signals. Key themes include: ${bullTitles.slice(0, 180)}. This suggests improving fundamentals, positive market perception, or strong operational momentum that the market has yet to fully price in.`;
  } else if (dominance === 'bearish') {
    thesis += `Current picture: ${ticker} faces a challenging news environment, with ${bear.length} out of ${tot} recent articles carrying bearish signals. Headwinds include: ${bearTitles.slice(0, 180)}. This pattern of negative news can indicate deteriorating fundamentals, sector-level pressure, or company-specific issues requiring close monitoring.`;
  } else {
    thesis += `Current picture: News flow for ${ticker} is balanced, with ${bull.length} bullish and ${bear.length} bearish signals across ${tot} articles. This mixed environment suggests the market is at a pivotal decision point — watching upcoming catalysts such as earnings, guidance updates, or macro developments will be critical to establishing directional conviction.`;
  }

  thesis += `\n\nChain-effect outlook: ${dominance === 'bullish'
    ? `If the current bullish momentum for ${ticker} is sustained, several compounding effects could follow. Positive earnings or analyst upgrades typically trigger institutional buying, which in turn improves short-term liquidity and reduces bid-ask spreads. Revenue growth, if confirmed, could support margin expansion as fixed costs are spread over a larger revenue base, creating a virtuous cycle of improving profitability.`
    : dominance === 'bearish'
    ? `Sustained negative news for ${ticker} risks creating a self-reinforcing downward spiral. Analyst downgrades often follow negative news cycles, triggering institutional de-risking. Deteriorating sentiment can increase the cost of capital — equity issuances become dilutive, debt financing becomes expensive — which constrains operational flexibility.`
    : `In a mixed news environment, the key driver for ${ticker} will be which narrative gains dominance. If the bullish catalysts prove structural rather than transient, the market's current hesitation could represent an accumulation opportunity. Conversely, if bearish signals reflect underlying operational weakness, current valuations may not adequately reflect risk.`
  }`;

  thesis += `\n\nKey risks to monitor: ${dominance === 'bullish'
    ? `The primary risk to the bullish case is execution — the gap between positive news and delivered results is where most stories break down. Watch for: (1) whether revenue growth translates to margin improvement; (2) sector rotation risk if macro conditions shift; (3) valuation stretch making the name vulnerable to any negative surprise.`
    : dominance === 'bearish'
    ? `The primary risk of being overly bearish is overshooting — markets often punish stocks more than fundamentals warrant. Watch for: (1) signs of stabilisation in key metrics indicating the worst is priced in; (2) management restructuring or asset disposals resetting the earnings base; (3) sector-wide recovery catalysts that could lift all boats.`
    : `Key watchpoints: (1) the next scheduled earnings release and management guidance tone; (2) whether bullish news items reflect one-time events or structural improvements; (3) macro sector tailwinds and headwinds; (4) insider trading activity and institutional position changes as forward-looking sentiment indicators.`
  }`;

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
