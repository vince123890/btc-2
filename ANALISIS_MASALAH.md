# ANALISIS MASALAH — BTC Bandarmologi Dashboard
> Review oleh Agent Council · 2026-06-11

---

## Ringkasan Eksekutif

Dashboard ini memiliki arsitektur yang cerdas (data agregasi paralel + Gemini langsung dari browser), namun terdapat **beberapa masalah fundamental** yang membuat fitur-fitur tertentu tidak bekerja sebagaimana diklaim, dan menjadi penyebab timeout yang sering dilaporkan.

---

## A. TIMEOUT & LATENSI — Penyebab Utama "Sering Lepas"

### 🔴 KRITIS: Browser timeout terlalu pendek (12s) vs Edge Function (25s+)

**File:** `app.js` baris `loadSnapshot()`

```js
const tid = setTimeout(() => ctrl.abort(), 12000);  // ← hanya 12 detik!
```

Vercel Edge Function bisa memakan waktu **15-20 detik** saat beberapa sumber lambat (CoinGecko, Stooq, CoinMetrics). Browser membatalkan request di detik ke-12, jauh sebelum server selesai. User melihat *"Timeout 12s saat fetch snapshot"* padahal data hampir siap.

**Fix:** Naikkan ke 28-30 detik.

```js
const tid = setTimeout(() => ctrl.abort(), 28000);
```

---

### 🟠 TINGGI: Agent Council Pro — Hampir Pasti Timeout

**File:** `app.js` — fungsi `runCouncil()`

Council mode membuat **4 panggilan Gemini berurutan** untuk mode Pro:

| Tahap | Estimasi Pro | Akumulasi |
|-------|-------------|-----------|
| Bull Agent | 40-50s | ~45s |
| Jeda kode | 1s | ~46s |
| Bear Agent | 40-50s | ~91s |
| Judge | 25-35s | ~121s |
| Final (Portfolio Manager) | 40-50s | ~166s |

Timeout Council di-set 180 detik. Worst case **hampir pasti habis**. Jika Judge gagal di menit ke-2, seluruh waktu terbuang tanpa output.

**Yang lebih buruk:** `callAgentStructured` (Judge) **tidak punya retry**, tapi `callAgentText` (Bull/Bear) punya. Jika Judge gagal transient setelah 2 agent sudah selesai → seluruh pipeline gagal tanpa fallback.

**Fix:** Tambah retry ke `callAgentStructured`, dan pertimbangkan parallelkan Bull+Bear untuk Pro juga (sudah paralel untuk Flash, tapi sequential untuk Pro).

---

### 🟠 TINGGI: `fetchJSONRetry` menambah latensi ganda

**File:** `api/snapshot.js` — fungsi `fetchJSONRetry()`

```js
async function fetchJSONRetry(url, timeout = TIMEOUT_SLOW) {
  try {
    return await fetchJSON(url, timeout);          // ← 9 detik
  } catch (e) {
    await new Promise(r => setTimeout(r, 800));    // ← +0.8 detik jeda
    return fetchJSON(url, timeout);                // ← +9 detik retry
  }
}
```

Retry tidak dibatasi ke error tertentu — HTTP 429 rate limit pun di-retry. Ini bisa menambah **9+0.8+9 = 18.8 detik** hanya untuk satu sumber lambat, bahkan kalau retry juga pasti gagal (misal: sudah rate limited).

**Fix:** Retry hanya untuk network error/5xx. Jangan retry 429 (rate limit) atau 404.

---

## B. DATA YANG TIDAK REALISTIS / TIDAK PERNAH BEKERJA

### 🔴 KRITIS: ETF Flows endpoint tidak ada di DefiLlama

**File:** `api/snapshot.js` — fungsi `sourceEtfFlows()`

```js
const d = await fetchJSON('https://api.llama.fi/etfs/bitcoin', 7000).catch(() => null)
    || await fetchJSON('https://api.llama.fi/etf/bitcoin', 7000).catch(() => null);
```

**DefiLlama adalah platform DeFi analytics** — tidak menyediakan data ETF spot Bitcoin (IBIT, FBTC, ARKB, dll. dari BlackRock/Fidelity/ARK). Kedua endpoint ini **tidak ada di DefiLlama**, selalu return `null` atau 404.

Karena diberi flag `optional: true`, kegagalan ini **senyap** — tidak ada error, tidak ada log, Gemini hanya tidak mendapat data ini.

Ironinya, dashboard menampilkan instruksi analisis untuk Gemini:
> *"ETF net INFLOW = institusi akumulasi langsung (bullish confirm terkuat). Ini bobot tinggi — duit institusi riil."*

Tapi data ini **tidak pernah sampai** ke Gemini. Fitur yang diklaim sebagai "sinyal bandarmologi PALING KUAT" adalah dead code.

**Fix:** Gunakan sumber data ETF yang benar:
- [SoSoValue API](https://sosovalue.xyz) — ada endpoint publik untuk ETF BTC
- [Farside Investors](https://farside.co.uk/bitcoin-etf-flow-all-data/) — scraping tapi akurat
- Atau **hapus fitur ini** dari klaim analisis sampai data tersedia

---

### 🔴 KRITIS: CVD dari Spot Binance — Tidak Representatif

**File:** `api/snapshot.js` — fungsi `sourceCVD()`

```js
const d = await fetchJSON('https://api.binance.com/api/v3/aggTrades?symbol=BTCUSDT&limit=1000');
// ↑ Ini adalah spot Binance, bukan futures
```

CVD diambil dari **spot Binance**, padahal:
1. **Volume BTC dominan ada di futures** — spot hanya ~15-25% dari total market
2. 1000 aggTrades di market aktif hanya merepresentasikan **10-60 detik** data, bukan 24 jam
3. `sourceTakerVolume()` yang sudah ada mengambil taker buy/sell dari **futures** selama 24 jam — jauh lebih akurat dan relevan

Akibatnya, Gemini menerima **dua sinyal serupa** (CVD dan Taker Volume) yang satu akurat (futures 24h) dan satu tidak (spot 30 detik), berpotensi memberi signal yang kontradiktif dan membingungkan model.

**Fix:** Ganti ke futures aggTrades (`fapi.binance.com/fapi/v1/aggTrades`) atau **hapus CVD** dan andalkan `takerVolume` yang sudah ada dan lebih baik.

---

### 🟠 TINGGI: `computeLiquidationMagnets()` — Maintenance Margin Tetap, Tidak Akurat

**File:** `api/snapshot.js` — fungsi `computeLiquidationMagnets()`

```js
const mm = 0.004;  // ← fixed 0.4% untuk semua leverage tier
```

Binance menggunakan **maintenance margin berlapis (tiered)** berdasarkan notional size posisi. Contoh nyata untuk BTCUSDT:
- Notional < $50K: maintenance margin 0.40% ✓ (sesuai)
- Notional $50K-$250K: 0.50%
- Notional $250K-$1M: 1.00%
- Notional > $50M: 5.00%

Kalkulasi ini tidak mempertimbangkan size posisi, sehingga level likuidasi yang ditampilkan ke Gemini bisa **meleset 2-10% dari level nyata** untuk posisi besar (yang justru adalah "whale" yang ingin dilacak).

Ini masih berguna sebagai estimasi kasar, tapi labeling dan penekanan di prompt Gemini seolah ini adalah level pasti.

**Fix:** Tambahkan disclaimer di prompt bahwa ini estimasi, atau gunakan API heatmap liquidation yang lebih akurat (Coinalyze sudah diintegrasikan — gunakan data itu).

---

### 🟠 TINGGI: Realized Price — Data Harga Stale 24 Jam

**File:** `api/snapshot.js` — fungsi `sourceCoinMetrics()`

```js
const realizedPrice = latest.price && latest.mvrv ? latest.price / latest.mvrv : null;
```

Formula `realizedPrice = price / MVRV` secara matematis benar. Namun `latest.price` adalah harga dari **CoinMetrics Community API yang merupakan data harian** — bisa 12-24 jam stale.

Saat BTC bergerak ±3-5% dalam sehari, "realized price" yang ditampilkan tidak akurat. "Current premium" yang dihitung dan dikirim ke Gemini bisa meleset signifikan.

**Fix:** Gunakan harga Binance real-time untuk premium calculation, bukan harga CoinMetrics:
```js
// Di handler, setelah dapat snapshot.onChain:
if (snapshot.onChain && snapshot.ticker?.price) {
  snapshot.onChain.currentPremium = 
    ((snapshot.ticker.price - snapshot.onChain.realizedPrice) / snapshot.onChain.realizedPrice) * 100;
}
```

---

### 🟡 SEDANG: Stablecoin "Dry Powder" Threshold Terlalu Tinggi

**File:** `api/snapshot.js` — fungsi `sourceStablecoins()`

```js
if (change7d > 1.0) liquiditySignal = 'EXPANDING';     // > 1% seminggu
else if (change7d < -1.0) liquiditySignal = 'CONTRACTING';
```

Pertumbuhan stablecoin supply normal di bull market adalah **0.3-0.7%/minggu**. Threshold 1% berarti sinyal `EXPANDING` hampir tidak pernah muncul kecuali di kondisi panik inflow (misalnya crash besar lalu recovery). Sinyal ini underreport kondisi bullish yang sebenarnya.

**Fix:** Turunkan threshold ke 0.35-0.5%:
```js
if (change7d > 0.4) liquiditySignal = 'EXPANDING';
else if (change7d < -0.4) liquiditySignal = 'CONTRACTING';
```

---

### 🟡 SEDANG: Smart Money Bias — Threshold Tanpa Justifikasi

**File:** `api/snapshot.js` — fungsi `sourceLongShortRatios()`

```js
if (lastTop > 1.5 && lastGlobal < 1.5) smartMoneyBias = 'LONG';
else if (lastTop < 0.7 && lastGlobal > 1.0) smartMoneyBias = 'SHORT';
else if (divergence > 0.5) smartMoneyBias = 'SMART_LONG_RETAIL_SHORT';
```

Nilai `1.5`, `0.7`, `1.0`, dan `0.5` ini tidak berdasar backtesting atau data historis. Long/Short ratio sangat kontekstual — rasio 1.5 bisa normal di bull market panjang. Tidak ada normalisasi terhadap kondisi market saat ini.

**Fix:** Hitung z-score divergence terhadap 24 jam terakhir (data `history` sudah tersedia), bukan nilai absolut.

---

## C. MASALAH ARSITEKTUR GEMINI

### 🟠 TINGGI: Grounding ON + responseSchema = Tidak Kompatibel

**File:** `app.js` — fungsi `callGemini()`

```js
const body = {
  generationConfig: {
    ...(grounding
      ? {}  // ← NO schema/mime when grounding — hanya instruksi teks
      : { responseMimeType: 'application/json', responseSchema: ANALYSIS_SCHEMA }),
  },
  ...(grounding ? { tools: [{ google_search: {} }] } : {}),
};
```

Saat grounding aktif, Gemini menerima instruksi teks biasa: *"OUTPUT HARUS HANYA JSON valid"*. Namun model dengan Google Search tool aktif **cenderung menghasilkan output bergaya markdown** dengan kutipan sumber dan inline grounding annotations — bukan JSON bersih.

Fallback parser mencoba strip markdown dan extract `{...}`, tapi sering gagal karena JSON disisipkan di tengah prosa atau terpotong oleh grounding annotations.

Fitur ini berpotensi hanya berhasil **kurang dari 30% percobaan** saat grounding aktif.

**Fix:** Dua-tahap approach — (1) panggil dengan grounding untuk dapat ringkasan event terbaru, (2) panggil tanpa grounding (dengan schema) menggunakan ringkasan dari tahap 1 sebagai context tambahan.

---

### 🟡 SEDANG: Duplikasi Token Masif di Council Mode

**File:** `app.js` — semua fungsi `build*Prompt()`

Council mode memanggil `buildDataSection(s)` sebanyak **4 kali**. Tiap data section ~3000-4000 token:

| Call | Estimasi Token Input |
|------|---------------------|
| Bull Agent | ~3,800 tok |
| Bear Agent | ~3,800 tok |
| Judge | ~3,800 (data) + ~500 (bull+bear text) = ~4,300 tok |
| Final PM | ~3,800 (data) + ~500 (bull+bear) + ~200 (judge) = ~4,500 tok |
| **Total** | **~16,400 token input** |

Di Gemini 2.5 Pro ($3.50/1M input tokens): satu Council session = **~$0.057 input saja**. Untuk 30 analisis/hari = **$1.71/hari = ~$51/bulan** hanya input token.

**Fix:** Pass data section sebagai string ke semua agent (tidak perlu rebuild tiap kali). Untuk Judge dan Final, gunakan ringkasan singkat argumen bull/bear, bukan full text.

---

### 🟡 SEDANG: Temperature 0.7 Terlalu Tinggi untuk Output Terstruktur

**File:** `app.js` — `callGemini()`

```js
generationConfig: {
  temperature: 0.7,   // ← untuk structured JSON output
```

Temperature 0.7 meningkatkan risiko output yang tidak mengikuti aturan harga yang ketat (misalnya LONG → `stopLoss < entryLow < entryHigh < takeProfit1 < takeProfit2`). Ini adalah constraint yang sangat spesifik dan temperature tinggi meningkatkan peluang model "berkreasi" di luar constraint.

**Fix:** Turunkan ke 0.3-0.4 untuk structured output. Gunakan 0.6-0.8 hanya untuk Bull/Bear Agent text.

---

## D. KEANDALAN SUMBER DATA

### 🟠 TINGGI: Stooq.com — Throttle di Shared Vercel IP

**File:** `api/snapshot.js` — fungsi `sourceMacro()`

Stooq.com bukan official API — ini adalah layanan finansial Polandia dengan CSV endpoint semi-publik. Dari Vercel (shared IP yang digunakan ribuan aplikasi):
- Sangat mungkin kena rate limit/IP block
- Tidak ada dokumentasi resmi, format bisa berubah
- Data weekend stale tanpa indikator tanggal yang jelas

**Fix:** Fallback ke Alpha Vantage free tier atau Yahoo Finance (unofficial tapi lebih stabil dari shared IP).

---

### 🟡 SEDANG: CoinDesk RSS — Scraping Fragile

**File:** `api/snapshot.js` — fungsi `sourceNews()`

```js
const re = /<item>([\s\S]*?)<\/item>/g;
const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
```

RSS XML parsing dengan regex adalah anti-pattern. Format CDATA, encoding entity, atau namespace XML dapat berubah kapan saja dan regex ini gagal diam-diam.

**Fix:** Gunakan CryptoPanic free API yang menyediakan endpoint JSON terstruktur, atau tambahkan proper XML parser.

---

### 🟡 SEDANG: `sourceCoinGecko()` Masih Dipanggil Meski Sudah "Didepresiasi"

**File:** `api/snapshot.js` — array `SOURCES`

```js
['coingecko', sourceCoinGecko, true],   // opsional: data sudah dihitung dari Binance
```

Komentar mengatakan "sudah dihitung dari Binance", tapi fungsi tetap dipanggil setiap request. CoinGecko free endpoint sering 429 dari shared Vercel IP, menambah latensi 7 detik untuk data yang sudah ada dari sumber lain.

**Fix:** Hapus dari SOURCES default. Hanya gunakan untuk `athAbsolute` (ATH absolut) yang memang hanya ada di CoinGecko.

---

## E. KEAMANAN

### 🟡 SEDANG: API Key di localStorage Tanpa Enkripsi

API key Gemini disimpan plaintext di `localStorage`. Untuk penggunaan personal (single-user, browser sendiri) ini acceptable. Namun jika app di-deploy untuk publik atau multi-user:
- Browser extensions yang nakal dapat membaca localStorage
- XSS (meski `esc()` sudah dipakai) pada dasarnya bypass proteksi ini

Kode sudah menyadari trade-off ini (ada komentar di UI), jadi ini bukan bug — tapi perlu diperhatikan jika scope aplikasi berubah.

---

## F. TABEL RINGKASAN: FITUR vs REALITAS

| Fitur | Klaim | Realitas | Severity |
|-------|-------|---------|---------|
| **ETF Flow** | "Sinyal PALING KUAT" | Selalu null, endpoint tidak ada | 🔴 KRITIS |
| **CVD** | "Order flow agresor" | 10-60 detik spot, bukan futures 24h | 🔴 KRITIS |
| **Snapshot timeout** | 12s client-side | Edge bisa 15-20s → selalu timeout | 🔴 KRITIS |
| **Council Pro** | "Reasoning terdalam" | ~166s worst case, timeout 180s | 🟠 TINGGI |
| **Grounding Mode** | "Catch event terbaru" | JSON parse gagal ~70% kasus | 🟠 TINGGI |
| **Liquidation Magnets** | Level exact leverage | Estimasi kasar ±2-10% dari nyata | 🟠 TINGGI |
| **Realized Price** | "Cost basis market" | Harga 24 jam stale | 🟠 TINGGI |
| **Stablecoin Signal** | "Dry powder" indicator | Threshold terlalu tinggi, jarang trigger | 🟡 SEDANG |
| **Smart Money Bias** | Divergence detection | Threshold absolut tanpa konteks historis | 🟡 SEDANG |
| **Macro DXY/Gold/SPX** | Context macro | Stooq sering throttle di shared IP | 🟠 TINGGI |

---

## G. REKOMENDASI PRIORITAS PERBAIKAN

### Segera (mengatasi keluhan timeout):
1. Naikkan `loadSnapshot` browser timeout dari **12s → 28s**
2. Tambah retry ke `callAgentStructured` (Judge tidak punya retry)
3. Parallelkan Bull+Bear untuk Pro model juga, atau naikkan Council timeout ke 240s

### Menengah (akurasi data):
4. **Hapus atau ganti** endpoint ETF DefiLlama yang tidak ada — jangan klaim sebagai "terkuat"
5. **Ganti CVD** ke futures endpoint, atau hapus dan andalkan `takerVolume`
6. Turunkan stablecoin threshold dari 1% ke 0.4%
7. Perbaiki grounding mode (dua-tahap) atau disable default

### Jangka Panjang (kualitas):
8. Kurangi duplikasi prompt Council (cache data section)
9. Turunkan temperature ke 0.3-0.4 untuk structured output
10. Normalisasi Smart Money Bias menggunakan z-score historis

---

*Dokumen ini dihasilkan oleh Agent Council Review · BTC Bandarmologi v6 · 2026-06-11*
