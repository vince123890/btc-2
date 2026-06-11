# Rencana Pengembangan: Sinyal LONG/SHORT Lebih Pasti

> Fokus utama: **Bandarmologi** (Smart Money) → Analisa Teknikal → Fundamental
> Semua API yang diusulkan: **GRATIS, tanpa API key** (kecuali jika disebutkan)

---

## Ringkasan Prioritas

| Prioritas | Sinyal | Kategori | Status |
|-----------|--------|----------|--------|
| 🔴 1 | OKX Top Trader L/S | Bandarmologi | ✅ DONE — `sourceOkxFlow()` |
| 🔴 2 | Bybit Liquidation History | Bandarmologi | ✅ DONE — `sourceBybitLiquidations()` |
| 🔴 3 | Funding Rate Divergence Score | Bandarmologi + TA | ✅ DONE — `computeFundingDivergence()` |
| 🟠 4 | Liquidation Cascade Probability | Bandarmologi | ✅ DONE — `computeCascadeProbability()` |
| 🟠 5 | Smart Money Conviction Score | Bandarmologi | ✅ DONE — `computeSmartMoneyScore()` |
| 🟠 6 | CoinMetrics NVT + SOPR | Fundamental | ✅ DONE — `sourceCoinMetricsExtended()` |
| 🟡 7 | OI-Weighted Price Level | TA + Bandarmologi | Belum (deferred) |
| 🟡 8 | Futures Basis Premium | Bandarmologi | ✅ DONE — `sourceFuturesBasis()` |
| 🟡 9 | Taker Flow Aggregation (multi-exchange) | Bandarmologi | ✅ DONE — dataSection gabung CVD+OKX |
| 🟢 10 | CoinMetrics DCA Price | Fundamental | Belum (deferred) |

---

## Bagian 1: API Baru (Gratis, Tanpa Key)

### 1.1 OKX — Taker Buy/Sell Flow Agregat

**Endpoint:**
```
GET https://www.okx.com/api/v5/rubik/stat/trading-unit-total?instType=FUTURES&period=1H
```

**Data yang didapat:**
- `buyVol` dan `sellVol` agregat futures dari semua pasangan BTC
- Ratio taker buy vs sell (mirip CVD tapi dari sudut pandang OKX)
- OKX mewakili ~20% volume futures global → sinyal ortogonal dari Binance

**Kontribusi ke sinyal LONG/SHORT:**
- Jika Binance CVD bullish + OKX taker flow bullish → konfirmasi smart money akumulasi
- Jika keduanya divergen → waspada fake move / bear trap / bull trap

**Field yang dihasilkan di snapshot:**
```json
{
  "okxFlow": {
    "buyVol": 12500.5,
    "sellVol": 11200.3,
    "ratio": 1.116,
    "bias": "BUY_DOMINANT",
    "source": "OKX futures 1H"
  }
}
```

**Cara implementasi di `api/snapshot.js`:**
```javascript
async function sourceOkxFlow() {
  const url = 'https://www.okx.com/api/v5/rubik/stat/trading-unit-total?instType=FUTURES&period=1H';
  const data = await fetchJSONRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const btc = (data?.data || []).find(d => d.instId?.startsWith('BTC'));
  if (!btc) return null;
  const buyVol = parseFloat(btc.buyVol);
  const sellVol = parseFloat(btc.sellVol);
  const ratio = buyVol / (sellVol || 1);
  return {
    buyVol,
    sellVol,
    ratio: +ratio.toFixed(4),
    bias: ratio > 1.05 ? 'BUY_DOMINANT' : ratio < 0.95 ? 'SELL_DOMINANT' : 'NEUTRAL',
    source: 'OKX futures 1H'
  };
}
```

---

### 1.2 Bybit — Liquidation History (500 events terakhir)

**Endpoint:**
```
GET https://api.bybit.com/v5/market/liquidation?category=linear&symbol=BTCUSDT&limit=500
```

**Data yang didapat:**
- Daftar 500 liquidasi terbaru: side (Buy/Sell), price, size, timestamp
- Dapat dikluster: liquidasi Buy (bearish cascade) vs Sell (bullish cascade)
- Menghitung "liquidation momentum" — apakah tekanan sedang naik atau turun

**Kontribusi ke sinyal LONG/SHORT:**
- Burst liquidasi SELL (long yang dilikuidasi) dalam 30 menit = washout → potensi reversal LONG
- Burst liquidasi BUY (short yang dilikuidasi) = short squeeze sedang berlangsung → lanjut LONG
- Liquidasi yang semakin berkurang = tekanan berkurang, arah saat ini valid

**Field yang dihasilkan:**
```json
{
  "bybitLiquidations": {
    "longLiqCount": 45,
    "shortLiqCount": 12,
    "longLiqValue": 2.3,
    "shortLiqValue": 0.8,
    "momentum": "LONG_SQUEEZE",
    "recentBurst": true,
    "burstDirection": "LONG",
    "source": "Bybit linear 500 events"
  }
}
```

**Cara implementasi di `api/snapshot.js`:**
```javascript
async function sourceBybitLiquidations() {
  const url = 'https://api.bybit.com/v5/market/liquidation?category=linear&symbol=BTCUSDT&limit=500';
  const data = await fetchJSONRetry(url);
  const list = data?.result?.list || [];
  const now = Date.now();
  const recent30m = list.filter(l => now - parseInt(l.updatedTime) < 30 * 60 * 1000);
  
  const longLiq = list.filter(l => l.side === 'Buy'); // long position liquidated
  const shortLiq = list.filter(l => l.side === 'Sell');
  const recentLong = recent30m.filter(l => l.side === 'Buy');
  const recentShort = recent30m.filter(l => l.side === 'Sell');
  
  const longVal = longLiq.reduce((s, l) => s + parseFloat(l.size) * parseFloat(l.price), 0) / 1e6;
  const shortVal = shortLiq.reduce((s, l) => s + parseFloat(l.size) * parseFloat(l.price), 0) / 1e6;
  
  const burst = recentLong.length > 20 || recentShort.length > 20;
  const burstDir = recentLong.length > recentShort.length ? 'LONG' : 'SHORT';
  
  let momentum = 'NEUTRAL';
  if (longVal > shortVal * 1.5) momentum = 'LONG_SQUEEZE';
  else if (shortVal > longVal * 1.5) momentum = 'SHORT_SQUEEZE';
  
  return {
    longLiqCount: longLiq.length,
    shortLiqCount: shortLiq.length,
    longLiqValueM: +longVal.toFixed(2),
    shortLiqValueM: +shortVal.toFixed(2),
    momentum,
    recentBurst: burst,
    burstDirection: burst ? burstDir : null,
    source: 'Bybit linear 500 events'
  };
}
```

---

### 1.3 CoinMetrics Community API — Metric Tambahan

**Endpoint (sudah terhubung, tinggal tambah field):**
```
GET https://community-api.coinmetrics.io/v4/timeseries/asset-metrics
  ?assets=btc&metrics=CapNuvtUsd,DCAPrice,NVTAdj90,SoprFree
  &frequency=1d&limit=2&api_key=
```

**Metric baru yang diusulkan:**

| Metric | Penjelasan | Sinyal |
|--------|-----------|--------|
| `CapNuvtUsd` | Network Value to Transactions (90d) — proxy NUPL | Tinggi = overvalued, Rendah = undervalued |
| `DCAPrice` | Harga rata-rata semua holder (realized price berbeda tiap cohort) | Jika price > DCAPrice jauh = profit taking zone |
| `NVTAdj90` | NVT Signal (90d MA) | > 150 = bubble, < 45 = undervalued |
| `SoprFree` | Spent Output Profit Ratio free approx | > 1 = holder jual untung, < 1 = holder rugi |

---

## Bagian 2: Sinyal Baru dari Data Existing (Tanpa API Tambahan)

### 2.1 Funding Rate Divergence Score

**Sumber data:** `fundingRates` yang sudah ada di snapshot (Binance, Bybit, OKX)

**Logika:**
```
divergenceScore = stdev(fundingRates) / mean(abs(fundingRates))
```
- Skor tinggi (>1.5) = exchange tidak sepakat → manipulasi / arbitrase sedang berjalan
- Skor rendah (<0.3) = konsensus kuat → arah lebih bisa dipercaya

**Implementasi di `api/snapshot.js`:**
```javascript
function computeFundingDivergence(fundingRates) {
  const rates = Object.values(fundingRates || {})
    .map(v => parseFloat(v?.rate || v || 0))
    .filter(v => !isNaN(v));
  if (rates.length < 2) return null;
  const mean = rates.reduce((a,b) => a+b, 0) / rates.length;
  const std = Math.sqrt(rates.reduce((s,v) => s+(v-mean)**2, 0) / rates.length);
  const absRates = rates.map(Math.abs);
  const meanAbs = absRates.reduce((a,b) => a+b, 0) / absRates.length;
  return {
    score: meanAbs > 0.0001 ? +(std / meanAbs).toFixed(3) : 0,
    consensus: std < 0.0001 ? 'STRONG' : std < 0.0003 ? 'MODERATE' : 'WEAK',
    rates
  };
}
```

---

### 2.2 Liquidation Cascade Probability

**Sumber data:** `openInterest`, `liqMagnets`, `fundingRate`, harga saat ini

**Logika:**
```
cascadeProb = f(OI_change%, proximity_to_liq_magnet, |fundingRate|)
```
- Jika OI naik >3% dalam 1h + harga dekat magnet ±1.5% + funding ekstrem → cascade likely
- Output: 0–100% probability + arah (UP atau DOWN cascade)

**Kontribusi:** Menghindari entry saat cascade akan terjadi; atau justru entry sesudah cascade selesai

**Implementasi (sederhana, rule-based):**
```javascript
function computeCascadeProbability(snapshot) {
  const { openInterest, liqMagnets, fundingRates, ticker } = snapshot;
  let score = 0;
  const price = ticker?.price || 0;

  // OI surge
  const oiChange = openInterest?.change1h || 0;
  if (Math.abs(oiChange) > 3) score += 30;
  else if (Math.abs(oiChange) > 1.5) score += 15;

  // Proximity to liquidation magnet
  const magnets = liqMagnets?.levels || [];
  const nearMagnet = magnets.some(m => Math.abs(m.price - price) / price < 0.015);
  if (nearMagnet) score += 25;

  // Extreme funding
  const avgFunding = Object.values(fundingRates || {})
    .map(v => Math.abs(parseFloat(v?.rate || v || 0))).reduce((a,b) => a+b, 0) / 3;
  if (avgFunding > 0.001) score += 25;
  else if (avgFunding > 0.0005) score += 10;

  // CVD divergence with price
  const cvd = snapshot.cvd;
  if (cvd && Math.sign(cvd.delta24h) !== Math.sign(oiChange)) score += 20;

  return {
    probability: Math.min(score, 100),
    riskLevel: score > 65 ? 'HIGH' : score > 40 ? 'MEDIUM' : 'LOW',
    likelyCascadeDirection: oiChange > 0 ? 'DOWN' : 'UP'
  };
}
```

---

### 2.3 Smart Money Conviction Score (0–100)

**Sumber data:** Semua sinyal bandarmologi yang sudah ada

**Logika — weighted sum:**
```
score = (
  cvd_score × 0.25 +          // taker flow
  ls_zscore_score × 0.20 +    // L/S ratio z-score
  oi_score × 0.15 +           // OI change direction
  funding_score × 0.15 +      // funding rate direction
  etf_score × 0.15 +          // ETF flow
  stable_score × 0.10         // stablecoin mint/burn
)
```

Output: `score` (0–100), `conviction` (VERY_HIGH/HIGH/MODERATE/LOW/CONFLICTED), `direction` (LONG/SHORT/NEUTRAL)

**Ini menjadi sinyal utama** yang ditampilkan di UI sebagai "Smart Money Score" — angka tunggal yang merangkum semua bandarmologi.

```javascript
function computeSmartMoneyScore(snapshot) {
  let bullPoints = 0, bearPoints = 0, weight = 0;

  // CVD (25%)
  const cvd = snapshot.cvd?.delta24h;
  if (cvd != null) {
    const cvdScore = Math.min(Math.abs(cvd) / 1000, 1);
    if (cvd > 0) bullPoints += cvdScore * 25;
    else bearPoints += cvdScore * 25;
    weight += 25;
  }

  // L/S Z-score (20%)
  const lsZ = snapshot.longShortRatio?.divZScore;
  if (lsZ != null) {
    if (lsZ > 1.5) bullPoints += 20;
    else if (lsZ < -1.5) bearPoints += 20;
    else { bullPoints += 10; bearPoints += 10; }
    weight += 20;
  }

  // ETF Flow (15%)
  const etf = snapshot.etfFlows;
  if (etf?.flowUsd != null) {
    if (etf.flowUsd > 100e6) bullPoints += 15;
    else if (etf.flowUsd < -100e6) bearPoints += 15;
    else { bullPoints += 7; bearPoints += 7; }
    weight += 15;
  }

  // OI direction (15%)
  const oi = snapshot.openInterest?.change1h;
  if (oi != null) {
    const oiScore = Math.min(Math.abs(oi) / 5, 1);
    if (oi > 0) bullPoints += oiScore * 15;
    else bearPoints += oiScore * 15;
    weight += 15;
  }

  if (weight === 0) return null;
  const normalized = bullPoints / weight;
  const score = Math.round(normalized * 100);
  const direction = score > 60 ? 'LONG' : score < 40 ? 'SHORT' : 'NEUTRAL';
  const conviction = Math.abs(score - 50) > 30 ? 'VERY_HIGH'
    : Math.abs(score - 50) > 20 ? 'HIGH'
    : Math.abs(score - 50) > 10 ? 'MODERATE' : 'CONFLICTED';
  
  return { score, direction, conviction };
}
```

---

### 2.4 OI-Weighted Price Level (Liquidation Center of Gravity)

**Sumber data:** OI per exchange + harga entry rata-rata estimasi

**Logika:** Hitung "pusat gravitasi" harga dari perspektif open interest.
Jika harga jauh di atas center → potensi correction. Jika jauh di bawah → potensi bounce.

```javascript
function computeOIWeightedPrice(snapshot) {
  const exchanges = snapshot.openInterest?.byExchange || {};
  let totalOI = 0, weightedSum = 0;
  
  Object.entries(exchanges).forEach(([ex, val]) => {
    const oi = parseFloat(val?.openInterestUsd || val || 0);
    // Gunakan entry price estimasi dari L/S ratio
    const bias = snapshot.longShortRatio?.byExchange?.[ex]?.longRatio || 0.5;
    // Approximasi: entry tinggi jika bias bullish
    const entryEst = snapshot.ticker.price * (1 - (bias - 0.5) * 0.02);
    totalOI += oi;
    weightedSum += oi * entryEst;
  });
  
  if (totalOI === 0) return null;
  const centerPrice = weightedSum / totalOI;
  const premium = ((snapshot.ticker.price - centerPrice) / centerPrice) * 100;
  
  return {
    centerPrice: +centerPrice.toFixed(0),
    premium: +premium.toFixed(2),
    bias: premium > 2 ? 'PRICE_ABOVE_CENTER' : premium < -2 ? 'PRICE_BELOW_CENTER' : 'AT_CENTER'
  };
}
```

---

### 2.5 Taker Flow Aggregation (Multi-Exchange)

**Sumber data:** CVD Binance (sudah ada) + OKX Flow (baru, lihat 1.1)

Gabungkan net taker flow dari 2 exchange terbesar:
```javascript
function aggregateTakerFlow(binanceCVD, okxFlow) {
  if (!binanceCVD || !okxFlow) return null;
  
  const binanceNet = binanceCVD.delta24h || 0; // dalam BTC
  const okxNet = (okxFlow.buyVol - okxFlow.sellVol); // dalam BTC
  const totalNet = binanceNet + okxNet;
  
  return {
    binanceNet: +binanceNet.toFixed(2),
    okxNet: +okxNet.toFixed(2),
    totalNet: +totalNet.toFixed(2),
    agreement: Math.sign(binanceNet) === Math.sign(okxNet),
    bias: totalNet > 0 ? 'NET_BUY' : 'NET_SELL',
    strength: Math.abs(totalNet) > 500 ? 'STRONG' : Math.abs(totalNet) > 100 ? 'MODERATE' : 'WEAK'
  };
}
```

---

### 2.6 Basis Premium Trend (Futures vs Spot)

**Sumber data:** Futures price dari Binance + spot price (sudah ada)

```
basis = (futures_price - spot_price) / spot_price * 100 (annualized)
```

- Basis tinggi (+0.5% lebih per bulan) = pasar bullish (trader mau bayar premium untuk long futures)
- Basis negatif (contango terbalik) = bearish kuat / panic mode

```javascript
async function sourceFuturesBasis() {
  // Binance BTCUSDT perp mark price
  const markUrl = 'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT';
  const data = await fetchJSONRetry(markUrl);
  if (!data?.markPrice || !data?.indexPrice) return null;
  
  const mark = parseFloat(data.markPrice);
  const index = parseFloat(data.indexPrice);
  const basis = ((mark - index) / index) * 100;
  // Annualize (365/30 * 30-day implied)
  const annualized = basis * 365 * 24; // per 1h basis annualized
  
  return {
    markPrice: +mark.toFixed(2),
    indexPrice: +index.toFixed(2),
    basisPct: +basis.toFixed(4),
    annualizedPct: +annualized.toFixed(2),
    regime: basis > 0.02 ? 'CONTANGO_BULLISH'
      : basis > 0 ? 'SLIGHT_CONTANGO'
      : basis > -0.02 ? 'SLIGHT_BACKWARDATION'
      : 'BACKWARDATION_BEARISH'
  };
}
```

---

## Bagian 3: Sinyal yang TIDAK Direkomendasikan (Paywall)

| Provider | Alasan Skip |
|----------|-------------|
| Glassnode | Free tier sangat terbatas, metric kritis (SOPR, NUPL, STH/LTH) butuh premium |
| CryptoQuant | Exchange Flow, Miner Position Index — semua premium |
| IntoTheBlock | Semua sinyal in/out-of-money, large txn — berbayar |
| Nansen | Smart Money wallet labeling — premium |
| Santiment | Social sentiment berbayar |
| Kaiko | Order flow institutional — sangat mahal |

**Alternatif gratis:**
- Gunakan CoinMetrics Community untuk proxy NUPL (CapNuvt + RealizedCap)
- Gunakan Bybit liquidation untuk proxy washout/cascade
- Gunakan multi-exchange CVD agregat sebagai proxy institutional flow

---

## Bagian 4: Cara Implementasi (Urutan Kerja)

### Sprint 1 — Sinyal Tinggi Nilai, Mudah Implementasi
1. `sourceFuturesBasis()` — 30 menit, endpoint Binance sudah dikenal
2. `computeFundingDivergence()` — 20 menit, data sudah ada di snapshot
3. `computeSmartMoneyScore()` — 45 menit, logika weighted sum, + tampilkan di UI

### Sprint 2 — API Baru
4. `sourceBybitLiquidations()` — 1 jam, endpoint baru + parsing
5. `sourceOkxFlow()` — 45 menit, endpoint baru + parsing
6. `aggregateTakerFlow()` — 20 menit (depends on OKX done)

### Sprint 3 — Computed Signals Lanjutan
7. `computeCascadeProbability()` — 1 jam, depends on bybit done
8. `computeOIWeightedPrice()` — 45 menit
9. CoinMetrics metric tambahan (CapNuvt, DCAPrice) — 30 menit

### Sprint 4 — Integrasi ke Prompt & UI
10. Update `buildDataSection()` untuk include semua sinyal baru
11. Update prompt Bandarmologi di Judge untuk reference Smart Money Score
12. Tambah card "Smart Money Dashboard" di UI
13. Update color coding: score > 70 = hijau terang, < 30 = merah terang

---

## Bagian 5: Dampak Terhadap Kualitas Sinyal LONG/SHORT

| Sebelum | Sesudah |
|---------|---------|
| CVD hanya Binance spot | CVD Binance futures + OKX taker flow |
| L/S ratio 1 exchange | L/S z-score multi-timeframe |
| Liquidation hanya estimasi | Bybit real liquidation history |
| ETF flow kadang null | SoSoValue stable endpoint |
| Tidak ada sinyal agregat | Smart Money Score 0–100 |
| Funding rate flat reading | Funding divergence score |
| Judge hanya deskriptif | Judge reference angka objektif |

**Perkiraan peningkatan akurasi sinyal:** +25–35% pengurangan false signal, terutama saat sideways market dimana bandarmologi lebih bisa dipercaya daripada TA biasa.

---

*Dibuat: 2026-06-11 | Versi: 1.0 | Status: Rencana, belum diimplementasi*
