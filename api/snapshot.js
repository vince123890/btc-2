// /api/snapshot.js
// =============================================================================
//  BTC Live Snapshot v3 · Vercel Edge Function
// =============================================================================
//  Penambahan vs v2:
//   • Multi-timeframe klines (1h/4h/1d) untuk confluence higher-TF
//   • Open Interest history (24 candle 1h)
//   • Long/Short ratio (top trader + global retail) → smart money divergence
//   • Taker buy/sell volume (aggressor pressure)
//   • Pre-computed TA indicators: RSI, MACD, Bollinger, EMA, trend
//
//  Total endpoint fetch: 16 (semua paralel via Promise.allSettled)
//  Target latency: < 3 detik di Vercel Edge
// =============================================================================

export const config = { runtime: 'edge' };

// ─────────────────────────────────────────────────────────────────────────────
//  Fetch helpers (with timeout)
// ─────────────────────────────────────────────────────────────────────────────
const TIMEOUT_DEFAULT = 5000;
const TIMEOUT_SLOW    = 9000;   // ← untuk CoinGecko & sumber yang sering lambat

// ── Retry sekali untuk sumber yang sering transient-fail ─────────────────────
// Hanya retry untuk network error atau 5xx. Tidak retry 429 (rate limit sudah
// pasti gagal lagi) atau 404 (tidak ada data, retry sia-sia).
async function fetchJSONRetry(url, timeout = TIMEOUT_SLOW) {
  try {
    return await fetchJSON(url, timeout);
  } catch (e) {
    // Jangan retry kalau rate limited atau not found — buang waktu saja
    const status = e.message?.match(/HTTP (\d+)/)?.[1];
    if (status === '429' || status === '404' || status === '403') throw e;
    await new Promise(r => setTimeout(r, 800));
    return fetchJSON(url, timeout);
  }
}

async function fetchJSON(url, timeout = TIMEOUT_DEFAULT) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'accept': 'application/json', 'user-agent': 'btc-bandarmologi/3.0' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} · ${url.slice(0, 80)}`);
    return await r.json();
  } finally {
    clearTimeout(tid);
  }
}

async function fetchText(url, timeout = TIMEOUT_DEFAULT) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} · ${url.slice(0, 80)}`);
    return await r.text();
  } finally {
    clearTimeout(tid);
  }
}

// =============================================================================
//  TA INDICATOR COMPUTATIONS (pure functions)
// =============================================================================

/** Exponential Moving Average — array result */
function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  let e = values[0];
  const out = [e];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

/** EMA last value only */
function ema(values, period) {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
}

/** Relative Strength Index (Wilder's smoothing) */
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  // Initial averages from first `period` diffs
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += -d;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  // Wilder smoothing for remaining
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - (100 / (1 + rs));
}

/** MACD(12,26,9) → { macd, signal, histogram, bullish } */
function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const sigSeries = emaSeries(macdLine.slice(slow - 1), signalPeriod);
  const macdNow = macdLine[macdLine.length - 1];
  const sigNow = sigSeries[sigSeries.length - 1];
  const hist = macdNow - sigNow;
  // Previous hist untuk lihat momentum direction
  const prevSig = sigSeries[sigSeries.length - 2];
  const prevMacd = macdLine[macdLine.length - 2];
  const prevHist = prevMacd - prevSig;
  return {
    macd: macdNow,
    signal: sigNow,
    histogram: hist,
    bullish: hist > 0,
    momentum: hist > prevHist ? 'RISING' : 'FALLING',
  };
}

/** Bollinger Bands(20, 2σ) */
function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mean + mult * sd;
  const lower = mean - mult * sd;
  const current = closes[closes.length - 1];
  return {
    upper, middle: mean, lower,
    widthPct: ((upper - lower) / mean) * 100,  // squeeze: < 4% = sangat sempit
    position: (current - lower) / (upper - lower),  // 0 = at lower, 1 = at upper
  };
}

/** Trend classification dari EMA21/55/200 alignment */
function trendFromEMA(price, ema21, ema55, ema200) {
  if (ema21 == null || ema55 == null) return 'NEUTRAL';
  const bullStack = ema21 > ema55 && (ema200 == null || ema55 > ema200);
  const bearStack = ema21 < ema55 && (ema200 == null || ema55 < ema200);
  if (bullStack && price > ema21) return 'BULLISH';
  if (bearStack && price < ema21) return 'BEARISH';
  return 'NEUTRAL';
}

/** Compute semua indicator untuk satu timeframe (closes only — backward compat) */
function computeIndicators(closes) {
  if (!closes || closes.length < 30) return null;
  const last = closes[closes.length - 1];
  const ema21v = ema(closes, 21);
  const ema55v = ema(closes, 55);
  const ema200v = closes.length >= 200 ? ema(closes, 200) : null;
  return {
    rsi: rsi(closes, 14),
    macd: macd(closes),
    bb: bollinger(closes),
    ema21: ema21v,
    ema55: ema55v,
    ema200: ema200v,
    trend: trendFromEMA(last, ema21v, ema55v, ema200v),
  };
}

// =============================================================================
//  ADVANCED METRICS (v5.3) — ATR, VWAP, Volume, Swing S/R
//  Semua dihitung dari OHLCV Binance — no extra API, no rate limit
// =============================================================================

/** Average True Range — ukuran volatilitas untuk grounding SL/TP */
function atr(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  // Wilder smoothing
  let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
  }
  return a;
}

/** Rolling VWAP atas N candle terakhir (typical price × volume) */
function vwap(highs, lows, closes, volumes, period = 24) {
  const n = Math.min(period, closes.length);
  if (n < 2) return null;
  let pv = 0, vol = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const typical = (highs[i] + lows[i] + closes[i]) / 3;
    pv += typical * volumes[i];
    vol += volumes[i];
  }
  return vol > 0 ? pv / vol : null;
}

/** Analisis volume: tren naik/turun + spike detection */
function volumeAnalysis(volumes) {
  if (volumes.length < 20) return null;
  const recent = volumes.slice(-6);
  const earlier = volumes.slice(-24, -6);
  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
  const earlierAvg = earlier.reduce((s, v) => s + v, 0) / (earlier.length || 1);
  const lastVol = volumes[volumes.length - 1];
  const baseAvg = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
  return {
    trend: recentAvg > earlierAvg * 1.15 ? 'RISING'
         : recentAvg < earlierAvg * 0.85 ? 'FALLING' : 'STABLE',
    spike: lastVol > baseAvg * 1.8,           // candle terakhir volume spike?
    relativeToAvg: baseAvg > 0 ? lastVol / baseAvg : 1,
  };
}

/** Swing high/low (pivot points) untuk support/resistance riil dari price action */
function swingLevels(highs, lows, lookback = 2) {
  const resistances = [], supports = [];
  for (let i = lookback; i < highs.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) isHigh = false;
      if (lows[i]  >= lows[i - j]  || lows[i]  >= lows[i + j])  isLow = false;
    }
    if (isHigh) resistances.push(highs[i]);
    if (isLow) supports.push(lows[i]);
  }
  const lastPrice = lows[lows.length - 1];
  // Resistance terdekat di ATAS harga, support terdekat di BAWAH harga
  const nearestRes = resistances.filter(r => r > highs[highs.length - 1]).sort((a, b) => a - b)[0] || null;
  const nearestSup = supports.filter(s => s < lows[lows.length - 1]).sort((a, b) => b - a)[0] || null;
  return {
    nearestResistance: nearestRes,
    nearestSupport: nearestSup,
    recentHigh: Math.max(...highs),
    recentLow: Math.min(...lows),
  };
}

/** Compute indikator lanjutan dari OHLCV */
function computeAdvanced(ohlcv) {
  if (!ohlcv || ohlcv.closes.length < 20) return null;
  const { highs, lows, closes, volumes } = ohlcv;
  const atrVal = atr(highs, lows, closes);
  const last = closes[closes.length - 1];
  return {
    atr: atrVal,
    atrPct: atrVal && last ? (atrVal / last) * 100 : null,  // ATR sebagai % harga
    vwap: vwap(highs, lows, closes, volumes),
    volume: volumeAnalysis(volumes),
    swing: swingLevels(highs, lows),
  };
}

/**
 * Derive market stats dari daily klines (PENGGANTI CoinGecko coins endpoint
 * yang sering kena 429 di shared IP Vercel).
 */
function deriveMarketStats(d1ohlcv, currentPrice, circulatingSupply) {
  if (!d1ohlcv || d1ohlcv.closes.length < 8) return null;
  const closes = d1ohlcv.closes;
  const highs = d1ohlcv.highs;
  const n = closes.length;
  const price = currentPrice || closes[n - 1];

  const change7d = n >= 8 ? ((price - closes[n - 8]) / closes[n - 8]) * 100 : null;
  const change30d = n >= 31 ? ((price - closes[n - 31]) / closes[n - 31]) * 100 : null;

  // ATH proxy: high tertinggi dalam data yang ada (~100 hari = cycle high terkini)
  const cycleHigh = Math.max(...highs);
  const athDistance = cycleHigh ? ((price - cycleHigh) / cycleHigh) * 100 : null;

  // Market cap = harga × circulating supply (dari blockchain.info)
  const marketCap = circulatingSupply ? price * circulatingSupply : null;

  return {
    change7d, change30d,
    cycleHigh,
    athDistance,          // distance dari cycle high (proxy ATH untuk trading)
    marketCap,
    source: 'computed',   // tanda: dihitung lokal, bukan dari CoinGecko
  };
}


// =============================================================================
//  DATA SOURCES
// =============================================================================

async function sourceTicker() {
  const d = await fetchJSON('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');
  return {
    price: +d.lastPrice,
    change24h: +d.priceChangePercent,
    volume24h: +d.quoteVolume,
    high24h: +d.highPrice,
    low24h: +d.lowPrice,
  };
}

async function sourceOrderBook() {
  const d = await fetchJSON('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=500');
  const toWall = arr => arr
    .map(r => ({ price: +r[0], qty: +r[1], total: +r[0] * +r[1] }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  const bids = toWall(d.bids);
  const asks = toWall(d.asks);
  const bidWall = bids.reduce((s, b) => s + b.total, 0);
  const askWall = asks.reduce((s, a) => s + a.total, 0);
  return { bids, asks, bidWall, askWall, ratio: bidWall / (bidWall + askWall) };
}

async function sourceFunding() {
  const d = await fetchJSON('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
  return {
    fundingRate: +d.lastFundingRate * 100,
    markPrice: +d.markPrice,
    nextFundingTime: d.nextFundingTime,
  };
}

async function sourceKlinesMulti() {
  // Fetch 3 timeframe paralel
  const [r1h, r4h, r1d] = await Promise.all([
    fetchJSON('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=200'),
    fetchJSON('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=100'),
    fetchJSON('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=100'),
  ]);
  // Binance kline format: [openTime, open, high, low, close, volume, ...]
  const parse = r => ({
    opens:   r.map(k => +k[1]),
    highs:   r.map(k => +k[2]),
    lows:    r.map(k => +k[3]),
    closes:  r.map(k => +k[4]),
    volumes: r.map(k => +k[5]),
  });
  return {
    h1: parse(r1h),
    h4: parse(r4h),
    d1: parse(r1d),
  };
}

/** Circulating supply BTC dari blockchain.info (free, no rate limit shared IP) */
async function sourceSupply() {
  const txt = await fetchText('https://blockchain.info/q/totalbc');  // dalam satoshi
  const sats = +txt;
  return sats > 0 ? sats / 1e8 : null;  // konversi ke BTC
}

// ──────────────────────────────────────────────────────────────
//  NEW v3: Derivatives intelligence (Binance Futures public API)
// ──────────────────────────────────────────────────────────────

async function sourceOpenInterestHist() {
  const d = await fetchJSON(
    'https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=24'
  );
  if (!d || !d.length) return null;
  // d[i] = { timestamp, sumOpenInterest, sumOpenInterestValue }
  const oiValues = d.map(x => +x.sumOpenInterestValue); // dalam USD
  const oiNow = oiValues[oiValues.length - 1];
  const oi24hAgo = oiValues[0];
  const changePct = ((oiNow - oi24hAgo) / oi24hAgo) * 100;
  return {
    current: oiNow,
    change24h: changePct,
    history: oiValues,                          // untuk visual nanti
    timestamps: d.map(x => +x.timestamp),
  };
}

async function sourceLongShortRatios() {
  // Dua endpoint paralel: top trader vs global retail
  const [top, global] = await Promise.all([
    fetchJSON('https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=BTCUSDT&period=1h&limit=24'),
    fetchJSON('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1h&limit=24'),
  ]);
  if (!top?.length || !global?.length) return null;
  const lastTop    = +top[top.length - 1].longShortRatio;
  const lastGlobal = +global[global.length - 1].longShortRatio;
  const prevTop    = +top[0].longShortRatio;
  const prevGlobal = +global[0].longShortRatio;

  // Divergence absolut (untuk kompatibilitas)
  const divergence = lastTop - lastGlobal;

  // Z-score divergence: lebih robust dari threshold absolut.
  // Bandingkan divergence sekarang vs distribusi 24 jam terakhir.
  const topHistory    = top.map(x => +x.longShortRatio);
  const globalHistory = global.map(x => +x.longShortRatio);
  const divHistory    = topHistory.map((v, i) => v - (globalHistory[i] || v));
  const divMean = divHistory.reduce((a, b) => a + b, 0) / divHistory.length;
  const divStd  = Math.sqrt(divHistory.reduce((s, v) => s + (v - divMean) ** 2, 0) / divHistory.length) || 0.01;
  const divZScore = (divergence - divMean) / divStd;

  // Bias berbasis z-score (>1.5 sigma lebih reliable dari threshold absolut)
  let smartMoneyBias = 'NEUTRAL';
  if (divZScore > 1.5)       smartMoneyBias = 'SMART_LONG_RETAIL_SHORT';
  else if (divZScore < -1.5) smartMoneyBias = 'SMART_SHORT_RETAIL_LONG';
  else if (lastTop > lastGlobal * 1.3 && lastTop > 1.2) smartMoneyBias = 'LONG';
  else if (lastTop < lastGlobal * 0.75 && lastGlobal > 1.0) smartMoneyBias = 'SHORT';

  return {
    topTrader: { current: lastTop, prev24h: prevTop, trend: lastTop > prevTop ? 'RISING' : 'FALLING' },
    global:    { current: lastGlobal, prev24h: prevGlobal, trend: lastGlobal > prevGlobal ? 'RISING' : 'FALLING' },
    divergence,
    divZScore: +divZScore.toFixed(2),
    smartMoneyBias,
    topHistory,
    globalHistory,
  };
}

async function sourceTakerVolume() {
  const d = await fetchJSON(
    'https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=1h&limit=24'
  );
  if (!d || !d.length) return null;
  // d[i] = { buySellRatio, buyVol, sellVol, timestamp }
  const ratios = d.map(x => +x.buySellRatio);
  const ratioNow = ratios[ratios.length - 1];
  const avg24h = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  // Trend: rata-rata 6 jam terakhir vs 18 jam sebelumnya
  const recent6 = ratios.slice(-6).reduce((a, b) => a + b, 0) / 6;
  const earlier18 = ratios.slice(0, -6).reduce((a, b) => a + b, 0) / Math.max(ratios.length - 6, 1);
  let trend = 'NEUTRAL';
  if (recent6 > earlier18 * 1.05 && recent6 > 1) trend = 'RISING_BUY';
  else if (recent6 < earlier18 * 0.95 && recent6 < 1) trend = 'RISING_SELL';
  return {
    current: ratioNow,
    avg24h,
    trend,
    history: ratios,
  };
}

async function sourceFearGreed() {
  const d = await fetchJSON('https://api.alternative.me/fng/?limit=30');
  return {
    value: +d.data[0].value,
    label: d.data[0].value_classification,
    history: d.data.slice().reverse().map(x => ({ ts: +x.timestamp * 1000, v: +x.value })),
  };
}

// CoinGecko coins endpoint sering 429 di shared IP — kita TIDAK lagi bergantung
// padanya untuk change7d/30d/marketCap/ath (sudah dihitung dari Binance).
// Endpoint ini sekarang OPSIONAL (best-effort), hanya untuk cross-check & ATH absolut.
async function sourceCoinGecko() {
  const d = await fetchJSON(
    'https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false',
    7000
  );
  const m = d.market_data;
  return {
    change7d: m.price_change_percentage_7d,
    change30d: m.price_change_percentage_30d,
    marketCap: m.market_cap.usd,
    ath: m.ath.usd,
    athDistance: m.ath_change_percentage.usd,
  };
}

// CoinGecko global — best effort untuk BTC dominance (non-kritis).
async function sourceGlobal() {
  const d = await fetchJSON('https://api.coingecko.com/api/v3/global', 7000);
  return {
    btcDominance: d.data.market_cap_percentage.btc,
    totalMcap: d.data.total_market_cap.usd,
  };
}

async function sourceMempool() {
  return fetchJSON('https://mempool.space/api/v1/fees/recommended');
}

async function sourceNetwork() {
  const [hashrate, difficulty, height] = await Promise.all([
    fetchText('https://blockchain.info/q/hashrate'),
    fetchText('https://blockchain.info/q/getdifficulty'),
    fetchText('https://blockchain.info/q/getblockcount'),
  ]);
  return { hashrate: +hashrate, difficulty: +difficulty, blockHeight: +height };
}

// News: CryptoCompare tanpa key makin di-throttle di shared IP.
// Strategi: coba CryptoCompare dulu, fallback ke CoinDesk RSS kalau gagal.
async function sourceNews() {
  // Primary: CryptoCompare
  try {
    const d = await fetchJSON(
      'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=BTC&sortOrder=popular&limit=8',
      6000
    );
    if (d?.Data?.length) {
      return d.Data.slice(0, 8).map(n => ({
        title: n.title,
        source: n.source_info?.name || n.source || 'unknown',
        ts: n.published_on * 1000,
        url: n.url,
      }));
    }
    throw new Error('empty');
  } catch (_) {
    // Fallback: CoinDesk RSS (gratis, no key, no rate limit)
    const xml = await fetchText('https://www.coindesk.com/arc/outboundfeeds/rss/', 6000);
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) && items.length < 8) {
      const block = m[1];
      const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
      const link  = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const date  = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      if (title) {
        items.push({
          title: title.trim(),
          source: 'CoinDesk',
          ts: date ? new Date(date).getTime() : Date.now(),
          url: link.trim(),
        });
      }
    }
    return items;
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  NEW v4: Options flow (Deribit public API)
// ──────────────────────────────────────────────────────────────────────────

async function sourceDeribitOptions() {
  // Deribit returns ALL BTC options summary in one call (~300 instruments)
  const d = await fetchJSON(
    'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option',
    6000
  );
  if (!d?.result?.length) return null;
  const opts = d.result;

  // Parse instrument_name: "BTC-25APR25-90000-C" → expiry, strike, type
  const parsed = opts.map(o => {
    const parts = o.instrument_name.split('-');
    if (parts.length !== 4) return null;
    const [, expiryStr, strikeStr, typeChar] = parts;
    const strike = +strikeStr;
    const type = typeChar; // 'C' or 'P'
    // Parse expiry like "25APR25" → date
    const m = expiryStr.match(/^(\d+)([A-Z]+)(\d+)$/);
    if (!m) return null;
    const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
    const monthNum = months[m[2]];
    if (monthNum === undefined) return null;
    const day = +m[1];
    const year = 2000 + +m[3];
    const expiry = new Date(Date.UTC(year, monthNum, day, 8, 0, 0)).getTime();
    return {
      strike,
      type,
      expiry,
      volume: +o.volume || 0,             // 24h volume
      openInterest: +o.open_interest || 0,// OI in contracts
      markPrice: +o.mark_price || 0,
      underlying: +o.underlying_price || 0,
    };
  }).filter(Boolean);

  if (!parsed.length) return null;
  const underlying = parsed[0].underlying;

  // ── Aggregate PCR (volume + OI) ───────────────────────────────────────
  let callVol = 0, putVol = 0, callOI = 0, putOI = 0;
  for (const o of parsed) {
    if (o.type === 'C') { callVol += o.volume; callOI += o.openInterest; }
    else                { putVol  += o.volume; putOI  += o.openInterest; }
  }
  const pcrVolume = callVol > 0 ? putVol / callVol : null;
  const pcrOI     = callOI > 0 ? putOI / callOI : null;

  // ── Max pain untuk expiry terdekat ────────────────────────────────────
  // Group by expiry, ambil expiry terdekat dari now
  const now = Date.now();
  const futureExpiries = [...new Set(parsed.map(o => o.expiry))].filter(e => e > now).sort();
  const nearestExpiry = futureExpiries[0];
  const nearExpiryOpts = parsed.filter(o => o.expiry === nearestExpiry && o.openInterest > 0);

  let maxPain = null, maxPainStrikes = null;
  if (nearExpiryOpts.length > 5) {
    const strikes = [...new Set(nearExpiryOpts.map(o => o.strike))].sort((a, b) => a - b);
    // Untuk tiap strike candidate, hitung total dollar loss ke option holders
    // (= total cash payout dari penjual ke pembeli kalau settle di strike itu)
    let bestStrike = strikes[0], minLoss = Infinity;
    for (const s of strikes) {
      let loss = 0;
      for (const o of nearExpiryOpts) {
        if (o.type === 'C' && s > o.strike) loss += (s - o.strike) * o.openInterest;
        else if (o.type === 'P' && s < o.strike) loss += (o.strike - s) * o.openInterest;
      }
      if (loss < minLoss) { minLoss = loss; bestStrike = s; }
    }
    maxPain = bestStrike;
    maxPainStrikes = strikes.length;
  }

  // ── Bias signals ──────────────────────────────────────────────────────
  let pcrSignal = 'NEUTRAL';
  if (pcrOI != null) {
    if (pcrOI > 1.0) pcrSignal = 'BEARISH_HEAVY';   // too many puts vs calls
    else if (pcrOI > 0.7) pcrSignal = 'BEARISH';
    else if (pcrOI < 0.5) pcrSignal = 'BULLISH';    // calls dominant
    else if (pcrOI < 0.35) pcrSignal = 'BULLISH_HEAVY'; // extreme bullish (contrarian)
  }

  // Max pain magnetism: berapa % jarak harga sekarang vs max pain
  const maxPainGap = maxPain && underlying
    ? ((maxPain - underlying) / underlying) * 100
    : null;

  return {
    pcrVolume,
    pcrOI,
    pcrSignal,
    maxPain,
    maxPainGap,            // % gap dari spot
    nearestExpiry,
    callVol, putVol,
    callOI, putOI,
    underlying,
    optionsCount: parsed.length,
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  NEW v4: On-chain metrics (CoinMetrics Community API - free, no key)
// ──────────────────────────────────────────────────────────────────────────

async function sourceCoinMetrics() {
  // Free Community API — daily data, last 30 days for context
  const url = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics'
    + '?assets=btc'
    + '&metrics=CapMVRVCur,SplyCur,PriceUSD'
    + '&page_size=30&pretty=false';
  const d = await fetchJSON(url, 6000);
  if (!d?.data?.length) return null;

  const rows = d.data.map(r => ({
    date: r.time,
    mvrv: r.CapMVRVCur ? +r.CapMVRVCur : null,
    price: r.PriceUSD ? +r.PriceUSD : null,
    supply: r.SplyCur ? +r.SplyCur : null,
  })).filter(r => r.mvrv != null);

  if (!rows.length) return null;

  const latest = rows[rows.length - 1];
  // Realized price approximation: market price / MVRV
  const realizedPrice = latest.price && latest.mvrv ? latest.price / latest.mvrv : null;

  // Historical context: persentil current MVRV terhadap last 30 days
  const mvrvValues = rows.map(r => r.mvrv).sort((a, b) => a - b);
  const idx = mvrvValues.findIndex(v => v >= latest.mvrv);
  const mvrvPercentile = idx === -1 ? 100 : (idx / mvrvValues.length) * 100;

  // MVRV signal classification (berdasarkan historical thresholds)
  let mvrvSignal = 'NEUTRAL';
  if (latest.mvrv >= 3.5)       mvrvSignal = 'CYCLE_TOP';     // historically overvalued
  else if (latest.mvrv >= 2.5)  mvrvSignal = 'OVERVALUED';
  else if (latest.mvrv >= 1.5)  mvrvSignal = 'BULLISH';
  else if (latest.mvrv >= 1.0)  mvrvSignal = 'FAIR_VALUE';
  else if (latest.mvrv >= 0.8)  mvrvSignal = 'UNDERVALUED';
  else                          mvrvSignal = 'CYCLE_BOTTOM';  // historically rare buy zone

  return {
    mvrv: latest.mvrv,
    realizedPrice,
    mvrvSignal,
    mvrvPercentile30d: mvrvPercentile,
    history: rows.map(r => ({ date: r.date, mvrv: r.mvrv, price: r.price })),
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  NEW v4: Macro context (Stooq CSV - free, no key)
// ──────────────────────────────────────────────────────────────────────────

function parseStooqCsv(text) {
  // Format: "Symbol,Date,Time,Open,High,Low,Close,Volume"
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;
  const row = lines[1].split(',');
  if (row.length < 7) return null;
  return {
    date: row[1],
    open: +row[3],
    close: +row[6],
    changePct: row[3] && row[6] ? ((+row[6] - +row[3]) / +row[3]) * 100 : null,
  };
}

async function sourceMacro() {
  const [dxyTxt, goldTxt, spxTxt] = await Promise.all([
    fetchText('https://stooq.com/q/l/?s=dx.f&f=sd2t2ohlcv&h&e=csv', 5000).catch(() => null),
    fetchText('https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv', 5000).catch(() => null),
    fetchText('https://stooq.com/q/l/?s=^spx&f=sd2t2ohlcv&h&e=csv',   5000).catch(() => null),
  ]);
  const dxy  = dxyTxt  ? parseStooqCsv(dxyTxt)  : null;
  const gold = goldTxt ? parseStooqCsv(goldTxt) : null;
  const spx  = spxTxt  ? parseStooqCsv(spxTxt)  : null;
  if (!dxy && !gold && !spx) return null;

  // Risk environment classification
  // - DXY naik tajam (>0.5%) + SPX turun = risk-off (BTC tends to drop)
  // - DXY turun + SPX naik = risk-on (BTC tends to pump)
  let riskRegime = 'NEUTRAL';
  if (dxy && spx) {
    if (dxy.changePct > 0.3 && spx.changePct < -0.3)      riskRegime = 'RISK_OFF';
    else if (dxy.changePct < -0.3 && spx.changePct > 0.3) riskRegime = 'RISK_ON';
    else if (dxy.changePct > 0.5)                          riskRegime = 'DOLLAR_STRENGTH';
    else if (dxy.changePct < -0.5)                         riskRegime = 'DOLLAR_WEAKNESS';
  }

  return {
    dxy,
    gold,
    spx,
    riskRegime,
  };
}

// =============================================================================
//  NEW v6: Institutional & cross-exchange flow (bandarmologi penguat)
// =============================================================================

// ── Stablecoin supply (DefiLlama, free no key) — "dry powder" likuiditas ────
async function sourceStablecoins() {
  const d = await fetchJSON('https://stablecoins.llama.fi/stablecoins?includePrices=false', 7000);
  if (!d?.peggedAssets?.length) return null;
  // Ambil USD-pegged terbesar (USDT, USDC, DAI, dst)
  let totalNow = 0, totalPrevDay = 0, totalPrevWeek = 0;
  const top = [];
  for (const a of d.peggedAssets) {
    const circ = a.circulating?.peggedUSD || 0;
    const prevDay = a.circulatingPrevDay?.peggedUSD || circ;
    const prevWeek = a.circulatingPrevWeek?.peggedUSD || circ;
    if (circ > 0) {
      totalNow += circ;
      totalPrevDay += prevDay;
      totalPrevWeek += prevWeek;
      if (top.length < 4) top.push({ symbol: a.symbol, circulating: circ });
    }
  }
  if (totalNow === 0) return null;
  const change24h = totalPrevDay ? ((totalNow - totalPrevDay) / totalPrevDay) * 100 : null;
  const change7d  = totalPrevWeek ? ((totalNow - totalPrevWeek) / totalPrevWeek) * 100 : null;
  // Interpretasi: supply naik = dry powder bertambah (bullish liquidity)
  let liquiditySignal = 'NEUTRAL';
  if (change7d != null) {
    // Threshold diturunkan dari 1% ke 0.4% — pertumbuhan stablecoin normal 0.3-0.7%/minggu
    if (change7d > 0.4) liquiditySignal = 'EXPANDING';
    else if (change7d < -0.4) liquiditySignal = 'CONTRACTING';
  }
  return { total: totalNow, change24h, change7d, liquiditySignal, top };
}

// ── Bitcoin ETF flows (SoSoValue, free no key) ──────────────────────────────
// SoSoValue melacak ETF BTC spot (IBIT/FBTC/ARKB/dll) — sumber data yang benar.
// Endpoint: /api/etf/bitcoin/fund/flow/summary (tidak butuh API key)
async function sourceEtfFlows() {
  // Primary: SoSoValue summary endpoint
  const d = await fetchJSON(
    'https://sosovalue.xyz/api/etf/bitcoin/fund/flow/summary',
    7000
  ).catch(() => null);

  if (d) {
    // Struktur SoSoValue: { date, totalNetFlow, totalAum, ... }
    const netFlow = d.totalNetFlow ?? d.netFlow ?? d.flow ?? null;
    const aum     = d.totalAum    ?? d.aum     ?? null;
    if (typeof netFlow === 'number') {
      return {
        netFlow24h: netFlow,
        aum: typeof aum === 'number' ? aum : null,
        signal: netFlow > 0 ? 'INFLOW' : netFlow < 0 ? 'OUTFLOW' : 'FLAT',
        source: 'sosovalue',
      };
    }
    // Fallback: cari field numerik dari array
    const arr = Array.isArray(d) ? d : (d.data || d.list || []);
    if (Array.isArray(arr) && arr.length) {
      let totalFlow = 0, totalAum = 0, count = 0;
      for (const e of arr) {
        const f = e.netFlow ?? e.flow ?? e.dailyFlow ?? null;
        const a = e.aum ?? e.totalAssets ?? null;
        if (typeof f === 'number') { totalFlow += f; count++; }
        if (typeof a === 'number') totalAum += a;
      }
      if (count > 0) {
        return {
          netFlow24h: totalFlow,
          aum: totalAum || null,
          signal: totalFlow > 0 ? 'INFLOW' : totalFlow < 0 ? 'OUTFLOW' : 'FLAT',
          source: 'sosovalue',
        };
      }
    }
  }

  return null;
}

// ── CVD (Cumulative Volume Delta) dari Binance FUTURES aggTrades — order flow ─
// Menggunakan futures (fapi) bukan spot, karena 75-85% volume BTC ada di futures.
// Ambil 1000 trade terakhir dari FUTURES untuk sinyal order flow yang representatif.
async function sourceCVD() {
  const d = await fetchJSON('https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT&limit=1000');
  if (!Array.isArray(d) || !d.length) return null;
  let buyVol = 0, sellVol = 0;
  for (const t of d) {
    const qty = +t.q;
    // m=true → maker adalah buyer → trade ini adalah SELL aggressor
    if (t.m) sellVol += qty; else buyVol += qty;
  }
  const cvd = buyVol - sellVol;
  const total = buyVol + sellVol;
  const delta = total > 0 ? (cvd / total) * 100 : 0;
  return {
    buyVol, sellVol,
    cvd,
    deltaPct: delta,
    signal: delta > 10 ? 'STRONG_BUY' : delta > 3 ? 'BUY' : delta < -10 ? 'STRONG_SELL' : delta < -3 ? 'SELL' : 'BALANCED',
    source: 'futures',  // bukan spot — lebih representatif
  };
}

// ── Spot-Perp basis dihitung di handler (butuh ticker + funding markPrice) ──

// =============================================================================
//  NEW v7: Bandarmologi lanjutan — OKX Flow, Bybit Liquidations, Basis Premium
// =============================================================================

// ── OKX Taker Buy/Sell Flow Agregat (free, no key) ──────────────────────────
// OKX = ~20% volume futures global → konfirmasi sinyal Binance CVD secara ortogonal.
async function sourceOkxFlow() {
  const d = await fetchJSON(
    'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader?instId=BTC-USDT-SWAP&period=1H',
    7000
  ).catch(() => null);
  // Jika endpoint contracts gagal, coba taker volume proxy dari mark price endpoint
  if (!d?.data?.length) return null;
  // Endpoint ini mengembalikan array [{ts, longShortRatio}]
  // Ambil 2 item terakhir untuk trend direction
  const arr = d.data;
  const latest = arr[arr.length - 1];
  const prev   = arr.length > 1 ? arr[arr.length - 2] : null;
  const ratio  = parseFloat(latest?.[1] || latest?.longShortRatio || 1);
  const prevRatio = prev ? parseFloat(prev?.[1] || prev?.longShortRatio || ratio) : ratio;
  if (!ratio || isNaN(ratio)) return null;
  return {
    longShortRatio: +ratio.toFixed(4),
    trend: ratio > prevRatio ? 'RISING_LONG' : ratio < prevRatio ? 'FALLING_LONG' : 'STABLE',
    bias: ratio > 1.05 ? 'LONG_DOMINANT' : ratio < 0.95 ? 'SHORT_DOMINANT' : 'NEUTRAL',
    source: 'OKX top trader L/S 1H',
  };
}

// ── Bybit Liquidation History — real cascade data (free, no key) ─────────────
// Lebih akurat dari estimasi: menunjukkan liquidasi yang sudah terjadi.
async function sourceBybitLiquidations() {
  const d = await fetchJSON(
    'https://api.bybit.com/v5/market/liquidation?category=linear&symbol=BTCUSDT&limit=200',
    7000
  ).catch(() => null);
  const list = d?.result?.list || [];
  if (!list.length) return null;

  const now = Date.now();
  const recent30m = list.filter(l => now - parseInt(l.updatedTime || l.time || 0) < 30 * 60 * 1000);

  // side=Buy → posisi LONG yang dilikuidasi (harga turun → long kena)
  // side=Sell → posisi SHORT yang dilikuidasi (harga naik → short kena)
  const longLiq  = list.filter(l => l.side === 'Buy');
  const shortLiq = list.filter(l => l.side === 'Sell');
  const recLong  = recent30m.filter(l => l.side === 'Buy');
  const recShort = recent30m.filter(l => l.side === 'Sell');

  const longValM  = longLiq.reduce((s, l)  => s + parseFloat(l.size || 0) * parseFloat(l.price || 0), 0) / 1e6;
  const shortValM = shortLiq.reduce((s, l) => s + parseFloat(l.size || 0) * parseFloat(l.price || 0), 0) / 1e6;

  const burst = recLong.length > 15 || recShort.length > 15;
  const burstDir = recLong.length > recShort.length ? 'LONG_LIQUIDATED' : 'SHORT_LIQUIDATED';

  let momentum = 'NEUTRAL';
  if (longValM > shortValM * 1.5)  momentum = 'LONGS_DOMINATED';   // banyak long kena → bearish
  else if (shortValM > longValM * 1.5) momentum = 'SHORTS_DOMINATED'; // banyak short kena → bullish

  // Washout signal: burst long liquidation = kapitulasi → potensi reversal bullish
  let washoutSignal = 'NONE';
  if (burst && burstDir === 'LONG_LIQUIDATED' && recLong.length > recShort.length * 2) {
    washoutSignal = 'LONG_WASHOUT'; // capitulation — bullish contrarian
  } else if (burst && burstDir === 'SHORT_LIQUIDATED') {
    washoutSignal = 'SHORT_SQUEEZE'; // short squeeze sedang berlangsung
  }

  return {
    longLiqCount:  longLiq.length,
    shortLiqCount: shortLiq.length,
    longLiqValueM:  +longValM.toFixed(2),
    shortLiqValueM: +shortValM.toFixed(2),
    momentum,
    recentBurst: burst,
    burstDirection: burst ? burstDir : null,
    washoutSignal,
    source: 'Bybit linear 200 events',
  };
}

// ── Futures Basis Premium (Binance perp mark vs index) ───────────────────────
// Basis = premium/discount perp terhadap index. Basis tinggi = long crowded (bearish).
async function sourceFuturesBasis() {
  const d = await fetchJSON('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', 5000);
  if (!d?.markPrice || !d?.indexPrice) return null;

  const mark  = parseFloat(d.markPrice);
  const index = parseFloat(d.indexPrice);
  if (!mark || !index) return null;

  const basisPct = ((mark - index) / index) * 100;
  // Annualize: basis 1h * 24h * 365d (simple annualization proxy)
  const annualizedPct = basisPct * 24 * 365;

  let regime = 'NEUTRAL';
  if (basisPct > 0.05)       regime = 'CONTANGO_BULLISH';
  else if (basisPct > 0.01)  regime = 'SLIGHT_CONTANGO';
  else if (basisPct > -0.01) regime = 'FLAT';
  else if (basisPct > -0.05) regime = 'SLIGHT_BACKWARDATION';
  else                       regime = 'BACKWARDATION_BEARISH';

  return {
    markPrice:     +mark.toFixed(2),
    indexPrice:    +index.toFixed(2),
    basisPct:      +basisPct.toFixed(4),
    annualizedPct: +annualizedPct.toFixed(1),
    regime,
  };
}

// ── CoinMetrics Extended — CapNuvt, NVT, SOPR proxy (free community API) ─────
async function sourceCoinMetricsExtended() {
  const url = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics'
    + '?assets=btc'
    + '&metrics=NVTAdj90,SoprFree,CapNuvtUsd'
    + '&page_size=3&pretty=false';
  const d = await fetchJSON(url, 8000).catch(() => null);
  if (!d?.data?.length) return null;

  const rows = d.data.filter(r => r.NVTAdj90 != null || r.SoprFree != null || r.CapNuvtUsd != null);
  if (!rows.length) return null;
  const latest = rows[rows.length - 1];

  const nvt  = latest.NVTAdj90 ? +parseFloat(latest.NVTAdj90).toFixed(2) : null;
  const sopr = latest.SoprFree  ? +parseFloat(latest.SoprFree).toFixed(4)  : null;
  const nuvt = latest.CapNuvtUsd ? +parseFloat(latest.CapNuvtUsd).toFixed(0) : null;

  let nvtSignal = null;
  if (nvt != null) {
    nvtSignal = nvt > 150 ? 'BUBBLE_ZONE'
      : nvt > 90  ? 'OVERVALUED'
      : nvt > 45  ? 'FAIR_VALUE'
      : 'UNDERVALUED';
  }

  let soprSignal = null;
  if (sopr != null) {
    soprSignal = sopr > 1.05 ? 'PROFIT_TAKING'    // holder jual untung — distribusi
      : sopr > 1.0  ? 'SLIGHT_PROFIT'
      : sopr > 0.95 ? 'SLIGHT_LOSS'
      : 'CAPITULATION';                             // holder jual rugi — akumulasi zone
  }

  return { nvt, nvtSignal, sopr, soprSignal, nuvtUsd: nuvt, date: latest.time };
}

// ── Multi-exchange funding (Bybit + OKX, free no key) ───────────────────────
async function sourceMultiFunding() {
  const [bybit, okx] = await Promise.all([
    fetchJSON('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT', 6000).catch(() => null),
    fetchJSON('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP', 6000).catch(() => null),
  ]);
  const result = {};
  if (bybit?.result?.list?.[0]?.fundingRate != null) {
    result.bybit = +bybit.result.list[0].fundingRate * 100;
  }
  if (okx?.data?.[0]?.fundingRate != null) {
    result.okx = +okx.data[0].fundingRate * 100;
  }
  if (!Object.keys(result).length) return null;
  return result;
}

// ── Coinalyze (BUTUH API KEY GRATIS — daftar di coinalyze.net) ──────────────
//    Alternatif GRATIS untuk CoinGlass. Liquidation + OI agregat lintas bursa.
//    Key dikirim browser via header 'x-coinalyze-key'. Kalau tidak ada → skip.
//    Rate limit 40 call/menit. Symbol BTC perp aggregate: 'BTCUSDT_PERP.A'
async function sourceCoinalyze(apiKey) {
  if (!apiKey) return null;
  const base = 'https://api.coinalyze.net/v1';
  const headers = { 'api_key': apiKey, 'accept': 'application/json' };
  const get = async (path) => {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 7000);
    try {
      const r = await fetch(`${base}${path}`, { signal: ctrl.signal, headers });
      if (!r.ok) throw new Error(`Coinalyze HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(tid); }
  };
  // Liquidation history 24h (1 candle harian) + current OI agregat
  const now = Math.floor(Date.now() / 1000);
  const from = now - 26 * 3600;
  const sym = 'BTCUSDT_PERP.A';   // .A = aggregated across exchanges
  const [liq, oi] = await Promise.all([
    get(`/liquidation-history?symbols=${sym}&interval=daily&from=${from}&to=${now}&convert_to_usd=true`).catch(() => null),
    get(`/open-interest?symbols=${sym}&convert_to_usd=true`).catch(() => null),
  ]);
  const out = {};
  // Liquidation history: array of { symbol, history: [{ t, l (long liq), s (short liq) }] }
  const liqHist = liq?.[0]?.history;
  if (liqHist?.length) {
    const last = liqHist[liqHist.length - 1];
    out.longLiquidation = +last.l || 0;   // long liquidated (USD)
    out.shortLiquidation = +last.s || 0;  // short liquidated (USD)
    if (out.longLiquidation || out.shortLiquidation) {
      out.liqBias = out.longLiquidation > out.shortLiquidation * 1.3 ? 'LONGS_REKT'
                  : out.shortLiquidation > out.longLiquidation * 1.3 ? 'SHORTS_REKT'
                  : 'BALANCED';
    }
  }
  // Open interest agregat lintas bursa
  const oiVal = oi?.[0]?.value;
  if (oiVal != null) out.aggregatedOI = +oiVal;
  return Object.keys(out).length ? out : null;
}

// =============================================================================
//  COMPUTED SIGNALS — dihitung dari data existing, tanpa API tambahan
// =============================================================================

/** Funding Rate Divergence Score: seberapa "tidak kompak" exchange soal arah funding */
function computeFundingDivergence(binanceFunding, multiFunding) {
  const rates = [];
  if (binanceFunding?.fundingRate != null) rates.push(binanceFunding.fundingRate);
  if (multiFunding?.bybit != null) rates.push(multiFunding.bybit);
  if (multiFunding?.okx  != null) rates.push(multiFunding.okx);
  if (rates.length < 2) return null;

  const mean    = rates.reduce((a, b) => a + b, 0) / rates.length;
  const std     = Math.sqrt(rates.reduce((s, v) => s + (v - mean) ** 2, 0) / rates.length);
  const meanAbs = rates.map(Math.abs).reduce((a, b) => a + b, 0) / rates.length;
  const score   = meanAbs > 0.0001 ? +(std / meanAbs).toFixed(3) : 0;

  return {
    score,
    consensus: score < 0.3 ? 'STRONG' : score < 1.0 ? 'MODERATE' : 'WEAK',
    rates: { binance: rates[0], bybit: multiFunding?.bybit ?? null, okx: multiFunding?.okx ?? null },
    interpretation: score > 1.5
      ? 'Divergensi tinggi — kemungkinan manipulasi/arbitrase aktif, sinyal arah tidak reliable'
      : score < 0.3
      ? 'Konsensus kuat — semua exchange sepakat, sinyal funding lebih bisa dipercaya'
      : 'Divergensi moderat',
  };
}

/** Smart Money Conviction Score 0–100: agregat semua bandarmologi signal */
function computeSmartMoneyScore(snapshot) {
  let bullPts = 0, bearPts = 0, totalWeight = 0;

  // CVD taker flow (bobot 25%)
  const cvd = snapshot.cvd;
  if (cvd?.deltaPct != null) {
    const w = 25;
    const strength = Math.min(Math.abs(cvd.deltaPct) / 15, 1); // normalize 0-15% → 0-1
    if (cvd.deltaPct > 0) bullPts += strength * w; else bearPts += strength * w;
    totalWeight += w;
  }

  // L/S Z-score divergence (bobot 20%)
  const ls = snapshot.longShort;
  if (ls?.divZScore != null) {
    const w = 20;
    const z = ls.divZScore;
    if (z > 1.5)       { bullPts += w; }
    else if (z < -1.5) { bearPts += w; }
    else               { bullPts += w * 0.5; bearPts += w * 0.5; }
    totalWeight += w;
  }

  // OI change direction (bobot 15%)
  const oi = snapshot.openInterest;
  if (oi?.change24h != null) {
    const w = 15;
    const strength = Math.min(Math.abs(oi.change24h) / 5, 1);
    if (oi.change24h > 0 && (snapshot.ticker?.change24h ?? 0) > 0) bullPts += strength * w;
    else if (oi.change24h < 0 && (snapshot.ticker?.change24h ?? 0) < 0) bearPts += strength * w;
    else { bullPts += w * 0.3; bearPts += w * 0.3; }
    totalWeight += w;
  }

  // ETF flows (bobot 15%)
  const etf = snapshot.etfFlows;
  if (etf?.netFlow24h != null) {
    const w = 15;
    if      (etf.netFlow24h > 200e6)  bullPts += w;
    else if (etf.netFlow24h > 50e6)   bullPts += w * 0.7;
    else if (etf.netFlow24h < -200e6) bearPts += w;
    else if (etf.netFlow24h < -50e6)  bearPts += w * 0.7;
    else { bullPts += w * 0.4; bearPts += w * 0.4; }
    totalWeight += w;
  }

  // Bybit washout signal (bobot 10%) — contrarian: long washout = buy signal
  const bbl = snapshot.bybitLiquidations;
  if (bbl?.washoutSignal) {
    const w = 10;
    if (bbl.washoutSignal === 'LONG_WASHOUT')   bullPts += w;  // kapitulasi → contrarian bullish
    else if (bbl.washoutSignal === 'SHORT_SQUEEZE') bullPts += w * 0.8;
    else if (bbl.momentum === 'SHORTS_DOMINATED') bearPts += w * 0.5; // short squeeze done?
    totalWeight += w;
  }

  // OKX L/S (bobot 10%)
  const okxF = snapshot.okxFlow;
  if (okxF?.longShortRatio != null) {
    const w = 10;
    const r = okxF.longShortRatio;
    if (r > 1.1)      bullPts += w;
    else if (r < 0.9) bearPts += w;
    else              { bullPts += w * 0.5; bearPts += w * 0.5; }
    totalWeight += w;
  }

  // Stablecoin liquidity (bobot 5%)
  const sc = snapshot.stablecoins;
  if (sc?.liquiditySignal) {
    const w = 5;
    if (sc.liquiditySignal === 'EXPANDING')   bullPts += w;
    else if (sc.liquiditySignal === 'CONTRACTING') bearPts += w;
    else { bullPts += w * 0.5; bearPts += w * 0.5; }
    totalWeight += w;
  }

  if (totalWeight === 0) return null;

  const score = Math.round((bullPts / totalWeight) * 100);
  const delta = Math.abs(score - 50);

  return {
    score,
    direction:  score > 60 ? 'LONG' : score < 40 ? 'SHORT' : 'NEUTRAL',
    conviction: delta > 30 ? 'VERY_HIGH' : delta > 20 ? 'HIGH' : delta > 10 ? 'MODERATE' : 'CONFLICTED',
    bullPts: +bullPts.toFixed(1),
    bearPts: +bearPts.toFixed(1),
    totalWeight,
  };
}

/** Liquidation Cascade Probability: seberapa tinggi risiko cascade likuidasi */
function computeCascadeProbability(snapshot) {
  let score = 0;

  const oiChange = snapshot.openInterest?.change24h || 0;
  const change1h = snapshot.openInterest?.change1h  || 0;
  const price    = snapshot.ticker?.price || 0;

  // OI surge dalam 1 jam
  if (Math.abs(change1h) > 3)   score += 30;
  else if (Math.abs(change1h) > 1.5) score += 15;

  // Proximity ke liquidation magnet
  const lm = snapshot.liqMagnets;
  if (lm && price) {
    const nearDown = Math.abs(price - lm.downMagnet.to)   / price < 0.015;
    const nearUp   = Math.abs(price - lm.upMagnet.from)   / price < 0.015;
    if (nearDown || nearUp) score += 25;
  }

  // Extreme funding (semua exchange searah ekstrem)
  const fd = snapshot.fundingDivergence;
  const binFr = Math.abs(snapshot.funding?.fundingRate || 0);
  if (binFr > 0.1)      score += 25;
  else if (binFr > 0.05) score += 12;
  // Konsensus kuat + funding ekstrem = lebih berbahaya
  if (fd?.consensus === 'STRONG' && binFr > 0.05) score += 10;

  // CVD vs OI diverge = posisi tidak ter-cover → cascade lebih mudah terpicu
  const cvdDelta = snapshot.cvd?.deltaPct || 0;
  if (Math.sign(cvdDelta) !== Math.sign(oiChange) && Math.abs(oiChange) > 1) score += 15;

  // Bybit burst sudah terjadi → cascade mungkin sudah mulai
  if (snapshot.bybitLiquidations?.recentBurst) score += 10;

  return {
    probability: Math.min(score, 100),
    riskLevel: score > 65 ? 'HIGH' : score > 35 ? 'MEDIUM' : 'LOW',
    likelyCascadeDirection: change1h > 0 ? 'DOWN' : 'UP',
    note: score > 65
      ? 'Kondisi berisiko tinggi untuk cascade — hindari posisi terbuka besar sementara ini'
      : score > 35
      ? 'Risiko moderat — gunakan SL lebih ketat dari biasa'
      : 'Risiko cascade rendah saat ini',
  };
}

/**
 * Estimasi LEVEL MAGNET LIKUIDASI (computed, no key).
 * Liquidation heatmap intinya menunjukkan di mana posisi leverage akan
 * terlikuidasi = level yang sering "diburu" harga (magnet). Kita hitung dari
 * harga current + tier leverage umum. Long liq di BAWAH, short liq di ATAS.
 */
function computeLiquidationMagnets(price) {
  if (!price) return null;
  // Maintenance margin buffer ~0.4% (likuidasi terjadi sedikit sebelum 1/L penuh)
  const mm = 0.004;
  const tiers = [100, 50, 25, 10];
  const longLiqs = tiers.map(lev => ({
    leverage: lev + 'x',
    price: Math.round(price * (1 - (1 / lev) + mm)),
    distancePct: -(((1 / lev) - mm) * 100),
  }));
  const shortLiqs = tiers.map(lev => ({
    leverage: lev + 'x',
    price: Math.round(price * (1 + (1 / lev) - mm)),
    distancePct: ((1 / lev) - mm) * 100,
  }));
  // Zona magnet utama = klaster leverage tinggi (25x-100x) yang paling ramai & sering kena
  return {
    longLiqs,    // di bawah harga — kalau tembus, cascade TURUN
    shortLiqs,   // di atas harga — kalau tembus, cascade NAIK (squeeze)
    downMagnet: { from: Math.round(price * (1 - 0.04)), to: Math.round(price * (1 - 0.01)) },
    upMagnet:   { from: Math.round(price * (1 + 0.01)), to: Math.round(price * (1 + 0.04)) },
  };
}

// Format: [label, fn, optional]
// optional=true → kalau gagal, TIDAK dianggap error (datanya sudah dihitung dari
// sumber lain, atau memang non-kritis). Tidak ditampilkan sebagai error menakutkan.
const SOURCES = [
  ['ticker',           sourceTicker,               false],
  ['orderBook',        sourceOrderBook,            false],
  ['funding',          sourceFunding,              false],
  ['klinesMulti',      sourceKlinesMulti,          false],  // inti TA + market stats
  ['supply',           sourceSupply,               true],
  ['openInterest',     sourceOpenInterestHist,     false],
  ['longShort',        sourceLongShortRatios,      false],
  ['takerVolume',      sourceTakerVolume,          false],
  ['cvd',              sourceCVD,                  true],   // v6: Binance futures order flow
  ['options',          sourceDeribitOptions,       true],   // PCR/max pain
  ['onChain',          sourceCoinMetrics,          true],   // MVRV
  ['onChainExt',       sourceCoinMetricsExtended,  true],   // v7: NVT, SOPR, CapNuvt
  ['stablecoins',      sourceStablecoins,          true],   // v6: dry powder
  ['etfFlows',         sourceEtfFlows,             true],   // v6: ETF institutional flow
  ['multiFunding',     sourceMultiFunding,         true],   // v6: cross-exchange funding
  ['okxFlow',          sourceOkxFlow,              true],   // v7: OKX top trader L/S
  ['bybitLiquidations',sourceBybitLiquidations,    true],   // v7: real liquidation events
  ['futuresBasis',     sourceFuturesBasis,         true],   // v7: perp mark vs index basis
  ['macro',            sourceMacro,                true],
  ['fearGreed',        sourceFearGreed,            false],
  // ['coingecko',     sourceCoinGecko,            true],   // dihapus — sering 429
  ['global',           sourceGlobal,               true],
  ['mempool',          sourceMempool,              true],
  ['network',          sourceNetwork,              true],
  ['news',             sourceNews,                 true],
];

export default async function handler(request) {
  const t0 = Date.now();

  // Coinalyze key dikirim browser via header (opsional, key gratis dari coinalyze.net)
  let coinalyzeKey = '';
  try {
    coinalyzeKey = request?.headers?.get?.('x-coinalyze-key') || '';
  } catch (_) {}

  // Jalankan semua source + Coinalyze (kalau ada key) paralel
  const sourcePromises = SOURCES.map(([, fn]) => fn());
  sourcePromises.push(coinalyzeKey ? sourceCoinalyze(coinalyzeKey) : Promise.resolve(null));

  const results = await Promise.allSettled(sourcePromises);

  const snapshot = { ts: Date.now(), version: 7 };
  const errors = [];      // sumber KRITIS yang gagal (perlu perhatian)
  const degraded = [];    // sumber OPSIONAL yang gagal (tidak masalah)

  // Proses source utama
  SOURCES.forEach(([label, , optional], i) => {
    const r = results[i];
    if (r.status === 'fulfilled') {
      if (r.value != null) snapshot[label] = r.value;
    } else {
      const msg = String(r.reason?.message || r.reason || 'unknown').slice(0, 200);
      if (optional) degraded.push({ source: label, msg });
      else          errors.push({ source: label, msg });
    }
  });

  // Proses Coinalyze (entry terakhir)
  const czResult = results[results.length - 1];
  if (coinalyzeKey) {
    if (czResult.status === 'fulfilled' && czResult.value) {
      snapshot.coinalyze = czResult.value;
    } else {
      degraded.push({ source: 'coinalyze', msg: String(czResult.reason?.message || 'no data / key invalid').slice(0, 150) });
    }
  }

  // ─── v7: Fix realized price — gunakan harga Binance realtime (bukan harga CoinMetrics stale 24h)
  if (snapshot.onChain?.realizedPrice && snapshot.ticker?.price) {
    snapshot.onChain.currentPremium =
      ((snapshot.ticker.price - snapshot.onChain.realizedPrice) / snapshot.onChain.realizedPrice) * 100;
  }

  // ─── v7: Computed bandarmologi signals (from data already fetched) ────────
  snapshot.fundingDivergence  = computeFundingDivergence(snapshot.funding, snapshot.multiFunding);
  snapshot.smartMoneyScore    = computeSmartMoneyScore(snapshot);
  // cascadeProbability dihitung setelah liqMagnets siap (lihat bawah)

  // ─── v6: Estimasi level magnet likuidasi (computed, selalu ada) ──────────
  if (snapshot.ticker?.price) {
    snapshot.liqMagnets = computeLiquidationMagnets(snapshot.ticker.price);
  }

  // ─── v7: Cascade probability (butuh liqMagnets dari atas) ────────────────
  snapshot.cascadeProbability = computeCascadeProbability(snapshot);

  // ─── v6: Spot-Perp basis (dari ticker spot + funding markPrice) ──────────
  if (snapshot.ticker?.price && snapshot.funding?.markPrice) {
    const spot = snapshot.ticker.price;
    const perp = snapshot.funding.markPrice;
    const basisPct = ((perp - spot) / spot) * 100;
    snapshot.basis = {
      spot, perp,
      basisPct,
      // Perp premium tinggi = leverage long crowded (potensi long squeeze)
      // Perp discount = bearish/hedging
      signal: basisPct > 0.1 ? 'PERP_PREMIUM' : basisPct < -0.1 ? 'PERP_DISCOUNT' : 'NEUTRAL',
    };
  }

  // ─── Backwards compat: simpan klines lama (sparkline pakai closes array) ──
  if (snapshot.klinesMulti?.h1?.closes) {
    snapshot.klines = snapshot.klinesMulti.h1.closes.slice(-168);
  }

  // ─── Compute TA indicators per timeframe ─────────────────────────────────
  if (snapshot.klinesMulti) {
    const km = snapshot.klinesMulti;
    snapshot.indicators = {
      h1: computeIndicators(km.h1.closes),
      h4: computeIndicators(km.h4.closes),
      d1: computeIndicators(km.d1.closes),
    };

    // v5.3: Advanced metrics (ATR, VWAP, volume, swing S/R) per TF
    snapshot.advanced = {
      h1: computeAdvanced(km.h1),
      h4: computeAdvanced(km.h4),
      d1: computeAdvanced(km.d1),
    };

    // Higher-timeframe confluence
    const trends = ['h1', 'h4', 'd1'].map(k => snapshot.indicators[k]?.trend).filter(Boolean);
    const bullCount = trends.filter(t => t === 'BULLISH').length;
    const bearCount = trends.filter(t => t === 'BEARISH').length;
    snapshot.confluence = {
      bullish: bullCount,
      bearish: bearCount,
      neutral: 3 - bullCount - bearCount,
      alignment: bullCount === 3 ? 'STRONG_BULL'
              : bearCount === 3 ? 'STRONG_BEAR'
              : bullCount === 2 ? 'BULL'
              : bearCount === 2 ? 'BEAR'
              : 'MIXED',
    };

    // v5.3: Derive market stats dari d1 klines (PENGGANTI CoinGecko coins)
    const computed = deriveMarketStats(km.d1, snapshot.ticker?.price, snapshot.supply);
    if (computed) {
      // Merge: pakai computed sebagai sumber utama, CoinGecko sebagai cross-check
      snapshot.marketStats = {
        change7d:    computed.change7d  ?? snapshot.coingecko?.change7d,
        change30d:   computed.change30d ?? snapshot.coingecko?.change30d,
        marketCap:   computed.marketCap ?? snapshot.coingecko?.marketCap,
        athDistance: computed.athDistance,         // distance dari cycle high
        cycleHigh:   computed.cycleHigh,
        athAbsolute: snapshot.coingecko?.ath,      // ATH absolut (kalau CoinGecko ok)
        btcDominance: snapshot.global?.btcDominance,
        source: snapshot.coingecko ? 'computed+coingecko' : 'computed',
      };
    }
  }

  // ─── Trim klinesMulti payload (keep secukupnya untuk visual) ─────────────
  if (snapshot.klinesMulti) {
    const trim = (tf, n) => {
      const k = snapshot.klinesMulti[tf];
      if (!k) return;
      ['opens', 'highs', 'lows', 'closes', 'volumes'].forEach(key => {
        if (k[key]) k[key] = k[key].slice(-n);
      });
    };
    trim('h1', 50); trim('h4', 50); trim('d1', 30);
  }

  snapshot.errors = errors;
  snapshot.degraded = degraded;
  snapshot.fetchMs = Date.now() - t0;

  return new Response(JSON.stringify(snapshot), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 's-maxage=10, stale-while-revalidate=30',
      'access-control-allow-origin': '*',
    },
  });
}
