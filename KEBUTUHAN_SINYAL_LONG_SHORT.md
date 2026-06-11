# KEBUTUHAN SINYAL LONG/SHORT — Riset Sumber Data & Pendekatan

> Dokumen kebutuhan (requirements) hasil riset · 2026-06-11
> Konteks: BTC Bandarmologi Dashboard v7 (Vercel Edge + Gemini, BYOK)
> **Aturan keras: semua integrasi API harus GRATIS.** "Gratis" dibagi 2 kelas:
> - **TANPA KEY** — langsung pakai, prioritas utama
> - **FREE KEY** — daftar gratis, key dipegang user (pola BYOK seperti Coinalyze via header, sudah ada di codebase)
>
> Sumber berbayar (Glassnode, CryptoQuant, CoinGlass API, Nansen, Kaiko, Velo, Amberdata) **di-skip total** — lihat Bagian 8.

---

## 0. Ringkasan Eksekutif

Dashboard v7 sudah punya ~20 sumber gratis, tapi [ANALISIS_MASALAH.md](ANALISIS_MASALAH.md) membuktikan ada **lubang fundamental**: ETF flow mati total (endpoint DefiLlama tidak ada), CVD tidak representatif, macro Stooq sering throttle. Dokumen ini mendefinisikan kebutuhan dalam 3 lapis:

1. **PERBAIKI** — sinyal yang diklaim ada tapi rusak (Bagian 2)
2. **TAMBAH** — sumber positioning baru yang belum ada di folder, semuanya gratis (Bagian 3–5)
3. **HITUNG** — sinyal komposit baru dari data yang sudah/akan ada, tanpa API tambahan (Bagian 6)

Tema besar penambahan: dashboard saat ini hampir 100% bertumpu pada **Binance + Bybit + OKX retail derivatives**. Yang hilang adalah **positioning institusi & whale dari venue lain**: CME (via CFTC COT), Bitfinex margin, Hyperliquid (perp DEX terbesar), Coinbase premium (institusi US), dan options market (DVOL). Ini justru inti "bandarmologi" — melihat posisi uang besar, bukan retail.

---

## 1. Peta Kondisi Saat Ini (v7)

| Kategori | Sinyal | Sumber | Status |
|---|---|---|---|
| Harga & TA | ticker, klines multi-TF, ATR, VWAP, swing S/R | Binance | ✅ Sehat |
| Derivatif | funding, OI history, top-trader L/S, taker volume | Binance futures | ✅ Sehat |
| Derivatif | multi-funding | Bybit + OKX | ✅ Sehat |
| Derivatif | basis perp (mark vs index) | Binance premiumIndex | ✅ Sehat |
| Order flow | CVD | Binance aggTrades | ⚠️ Spot, ~30 detik data — tidak representatif |
| Likuidasi | Bybit liq history, magnet computed, Coinalyze (free key) | Bybit / computed / Coinalyze | ✅ / ⚠️ magnet pakai MM flat 0.4% |
| Institusi | **ETF flows** | DefiLlama | 🔴 **MATI — endpoint tidak pernah ada** |
| Likuiditas | stablecoin supply | DefiLlama | ✅ (threshold perlu tuning) |
| On-chain | MVRV, NVT, SOPR | CoinMetrics Community | ⚠️ Harian, harga stale 24 jam |
| Options | PCR, max pain | Deribit | ✅ Sehat |
| Macro | DXY, Gold, SPX | Stooq CSV | ⚠️ Throttle di shared IP Vercel |
| Sentimen | Fear & Greed | alternative.me | ✅ Sehat |
| News | CryptoCompare → CoinDesk RSS | — | ⚠️ Regex parsing fragile |

---

## 2. KEBUTUHAN PERBAIKAN (sinyal rusak/lemah yang sudah ada)

### 2.1 🔴 ETF Flows — ganti sumber (prioritas tertinggi)

Kebutuhan: data net inflow/outflow harian ETF spot BTC US (IBIT, FBTC, dst). Ini sinyal institusi terkuat dan saat ini **dead code**.

| Opsi | Tipe | Catatan |
|---|---|---|
| **SoSoValue Open API** | FREE KEY | Daftar gratis di sosovalue.com → API key. `POST https://openapi.sosovalue.com/openapi/v2/etf/historicalInflowChart` header `x-soso-api-key`. Data resmi harian per-ETF + agregat. **Rekomendasi utama** — pakai pola BYOK header seperti `x-coinalyze-key`. |
| Farside Investors | TANPA KEY (scrape) | `https://farside.co.uk/bitcoin-etf-flow-all-data/` — HTML table scrape. Akurat tapi fragile; jadikan fallback saja. |
| CoinGlass ETF API | ❌ BERBAYAR | Skip. |

Kebutuhan teknis: field `etfFlows.flowUsd` (harian terakhir), `flow5dSum`, `streak` (hari berturut inflow/outflow). Sinyal: inflow > $100M = bias LONG institusi; outflow streak ≥ 3 hari = bias SHORT.

### 2.2 🔴 CVD — pindah ke futures

Ganti `api.binance.com/api/v3/aggTrades` → `https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT&limit=1000` (TANPA KEY), atau hapus dan andalkan `takerVolume` futures 24h yang sudah benar. Jangan kirim dua sinyal kontradiktif ke Gemini.

### 2.3 🟠 Realized price premium — pakai harga real-time

`currentPremium` dihitung ulang di handler memakai `snapshot.ticker.price` (Binance real-time), bukan harga harian CoinMetrics yang stale 24 jam.

### 2.4 🟠 Macro — ganti Stooq

| Opsi | Tipe | Catatan |
|---|---|---|
| **FRED API** | FREE KEY (gratis permanen) | `https://api.stlouisfed.org/fred/series/observations?series_id=DTWEXBGS&api_key=KEY&file_type=json&sort_order=desc&limit=5` — DXY broad (DTWEXBGS), VIX (VIXCLS), 10Y yield (DGS10), M2 (M2SL). Resmi, stabil, rate limit longgar. |
| Yahoo Finance chart API | TANPA KEY (unofficial) | `https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB` (DXY), `GC=F` (gold), `%5EGSPC` (SPX), `BTC=F` (CME futures). Tidak resmi tapi jauh lebih stabil dari Stooq; jadikan fallback. |

### 2.5 🟡 Tuning threshold (tanpa API)

- Stablecoin `EXPANDING/CONTRACTING`: 1.0% → **0.4%** per 7 hari.
- Smart money bias: ganti threshold absolut (1.5/0.7) → **z-score** terhadap history 24 jam yang sudah tersedia di snapshot.
- Liquidation magnets: tambahkan label "ESTIMASI ±2-10%" di prompt (maintenance margin Binance bertingkat, bukan flat 0.4%).

---

## 3. KEBUTUHAN BARU — Positioning Whale & Institusi (inti bandarmologi)

Ini lapisan yang **belum ada sama sekali** di folder. Semua gratis.

### 3.1 CFTC COT — posisi CME Bitcoin Futures ✅ TERVERIFIKASI HIDUP

Satu-satunya data **posisi institusi riil yang diaudit regulator**, gratis tanpa key, via Socrata API:

```
GET https://publicreporting.cftc.gov/resource/gpe5-46if.json
    ?$limit=1
    &$order=report_date_as_yyyy_mm_dd DESC
    &$where=market_and_exchange_names like 'BITCOIN - CHICAGO MERCANTILE EXCHANGE%'
```

Field kunci (Traders in Financial Futures):

| Field | Arti | Sinyal |
|---|---|---|
| `lev_money_positions_long/short` | Hedge funds / leveraged funds | Net short ekstrem = **bahan bakar short squeeze** (sering basis trade, tapi perubahan mingguan tetap informatif) |
| `asset_mgr_positions_long/short` | Asset managers (institusi long-only) | Net long naik = akumulasi institusi → bias LONG |
| `other_rept_positions_*` | Reportable lain | Pelengkap |
| `open_interest_all` | Total OI CME | Konteks ukuran |

Sifat data: mingguan (snapshot Selasa, rilis Jumat) → **sinyal lambat, bobot untuk swing/posisi, bukan scalp**. Simpan 4-8 minggu terakhir untuk hitung delta. Tested 2026-06-11: respons valid, tanpa key. (Opsional: app token Socrata gratis untuk rate limit lebih tinggi.)

### 3.2 Hyperliquid — perp DEX terbesar ✅ TERVERIFIKASI HIDUP

Volume perp Hyperliquid sekarang menyaingi CEX besar dan penuh whale on-chain. Sinyal **ortogonal** dari Binance/Bybit/OKX. Gratis, tanpa key:

```
POST https://api.hyperliquid.xyz/info
Content-Type: application/json
{"type":"metaAndAssetCtxs"}
```

Respons per-aset (cari `name: "BTC"`): `funding` (per JAM — kalikan 8 untuk dibanding funding 8h CEX), `openInterest`, `markPx`, `oraclePx`, `premium`, `dayNtlVlm`.

Sinyal yang dibutuhkan:
- **Funding divergence CEX vs DEX**: HL funding (×8) vs rata-rata Binance/Bybit/OKX. Divergen besar = positioning crowd berbeda antara retail CEX dan whale DEX → sinyal kontrarian.
- **HL OI change** vs Binance OI change — konfirmasi atau divergensi build-up posisi.
- Lanjutan (opsional): `{"type":"fundingHistory","coin":"BTC","startTime":...}` untuk tren funding.

### 3.3 Bitfinex — margin long/short positions (whale klasik)

Bitfinex satu-satunya bursa besar yang mempublikasikan **jumlah posisi margin long/short aktual** (bukan rasio akun). Historis jadi acuan whale-watching bertahun-tahun. Gratis, tanpa key:

```
GET https://api-pub.bitfinex.com/v2/stats1/pos.size:1m:tBTCUSD:long/last   → [ts, value]
GET https://api-pub.bitfinex.com/v2/stats1/pos.size:1m:tBTCUSD:short/last
GET .../pos.size:1m:tBTCUSD:long/hist?limit=24                             → untuk delta 24h
```

Sinyal: `longShortDelta24h` — margin long naik tajam saat harga turun = whale akumulasi (bias LONG); short build-up ekstrem + harga naik = bahan squeeze. Hitung rasio + z-score 30 hari.

### 3.4 Deribit DVOL — implied volatility index

Endpoint publik Deribit (sudah dipakai untuk PCR/max pain, tinggal tambah satu call):

```
GET https://www.deribit.com/api/v2/public/get_volatility_index_data
    ?currency=BTC&start_timestamp={ms}&end_timestamp={ms}&resolution=3600
```

Sinyal:
- DVOL rendah ekstrem (kompresi vol) = market komplasen → breakout besar menunggu (arah dari sinyal lain).
- DVOL spike + harga turun = panik → sering dekat bottom lokal (kontrarian LONG).
- Tambahan dari data options yang sudah ada: **25-delta risk reversal** (IV call − IV put) dari instrumen Deribit = arah hedging institusi. Skew put mahal = takut downside.

### 3.5 OKX liquidation orders (pelengkap Bybit)

```
GET https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&instFamily=BTC-USDT&state=filled&limit=100
```

TANPA KEY. Gabungkan dengan Bybit liq yang sudah ada → `aggregateLiquidations` lintas bursa: burst long-liq 2 bursa serentak = washout → sinyal reversal LONG lebih kuat daripada 1 bursa.

---

## 4. KEBUTUHAN BARU — Sinyal Premium/Arbitrase (computed, TANPA KEY)

Murah diimplementasi (hanya butuh 1-2 fetch tambahan), nilai bandarmologi tinggi:

### 4.1 Coinbase Premium (institusi & retail US)

```
GET https://api.exchange.coinbase.com/products/BTC-USD/ticker
premium% = (coinbasePrice − binancePrice) / binancePrice × 100
```

Indikator klasik tekanan beli US (jam kerja US = institusi + ETF creation flow). Premium positif persisten = bias LONG; diskon dalam = distribusi US. Simpan history untuk z-score — nilai absolutnya kecil (±0.0x%), yang penting deviasinya.

### 4.2 Kimchi Premium (retail Asia)

```
GET https://api.upbit.com/v1/ticker?markets=KRW-BTC        (TANPA KEY)
GET https://open.er-api.com/v6/latest/USD                  (kurs KRW, TANPA KEY)
kimchi% = (upbitKRW / usdkrw − binanceUSD) / binanceUSD × 100
```

Kimchi premium > 3-5% = euforia retail Asia → historis sering dekat top lokal (kontrarian SHORT). Negatif = ketakutan/apatis → sering dekat bottom.

### 4.3 CME Gap (magnet harga weekend)

Dari `BTC=F` Yahoo Finance (lihat 2.4): closing Jumat vs open Senin. Gap yang belum tertutup = magnet harga yang sangat sering di-fill. Output: `cmeGap: { level, direction, ageDays }` → level TP/SL tambahan untuk trade plan.

---

## 5. KEBUTUHAN BARU — On-chain & Sentimen (FREE KEY / TANPA KEY)

### 5.1 bitcoin-data.com (BGeometrics) — on-chain gratis pengganti Glassnode

FREE KEY (daftar gratis). Ratusan metrik harian: **MVRV, SOPR, NUPL, Realized Price, exchange flows, hashrate** — metrik yang di Glassnode/CryptoQuant berbayar.

⚠️ **Rate limit sangat ketat: 8 req/jam, 15 req/hari** → arsitektur wajib cache:
- JANGAN panggil per-snapshot. Fetch **client-side 1×/hari**, cache di `localStorage` dengan TTL 24 jam (data harian, tidak rugi).
- Atau: 2 metrik prioritas saja (NUPL + exchange netflow) → 2 req/hari.

NUPL adalah metrik cycle-stage paling banyak dipakai yang belum ada di dashboard (CoinMetrics Community tidak punya): > 0.75 = euphoria (bias distribusi/SHORT swing), < 0 = capitulation (akumulasi/LONG swing).

### 5.2 CryptoPanic — news dengan voting bullish/bearish

FREE KEY (developer tier gratis):

```
GET https://cryptopanic.com/api/v1/posts/?auth_token=KEY&currencies=BTC&filter=hot
```

Lebih baik dari RSS regex-parsing saat ini: JSON terstruktur + **votes bullish/bearish per berita** = sentimen news terkuantifikasi, bukan sekadar judul. Ganti `sourceNews()` dengan ini (fallback tetap CoinDesk RSS).

### 5.3 Polymarket — prediction market odds (TANPA KEY)

```
GET https://gamma-api.polymarket.com/markets?closed=false&search=bitcoin
```

Harga pasar prediksi "BTC above $X by date" = **probabilitas konsensus pasar berduit asli**. Sinyal unik: bandingkan implied probability vs posisi harga sekarang — jika market memberi 70% untuk level atas, ada conviction crowd ke atas. Eksperimental; bobot kecil, tapi gratis dan tidak ada di tool retail manapun.

### 5.4 Blockchain.info charts (TANPA KEY, pelengkap)

`https://api.blockchain.info/charts/{metric}?timespan=30days&format=json` — `miners-revenue`, `hash-rate`, `n-transactions`. Untuk **miner capitulation proxy**: hashrate turun >10% dari ATH + miner revenue turun = tekanan jual miner (bias SHORT), recovery = bottoming.

---

## 6. KEBUTUHAN SINYAL KOMPOSIT (tanpa API baru — computed)

### 6.1 Regime Matrix: Price × OI × Funding (wajib — gratis total)

Tabel klasik yang menjelaskan *siapa yang menggerakkan harga*. Input sudah ada semua di snapshot:

| ΔPrice | ΔOI | Funding | Regime | Sinyal |
|---|---|---|---|---|
| ↑ | ↑ | naik | Leveraged rally — long baru masuk | LONG valid tapi rawan squeeze jika funding ekstrem |
| ↑ | ↓ | turun | **Short covering** — rally lemah | Jangan kejar; tunggu konfirmasi OI naik |
| ↑ | ↑ | flat/negatif | **Spot-led rally** — paling sehat | LONG conviction tinggi |
| ↓ | ↑ | turun | Short baru agresif | SHORT valid; waspada crowded |
| ↓ | ↓ | naik | **Long liquidation/deleveraging** | Tunggu washout selesai → reversal LONG |
| ↓ | ↓ | flat | Posisi ditutup, minat hilang | WAIT |

Output: `marketRegime: { label, drivenBy: 'SPOT'|'LEVERAGE_LONG'|'SHORT_COVER'|'DELEVERAGING', healthScore }` → masuk prompt sebagai konteks utama. Ini menjawab pertanyaan terpenting yang AI sekarang harus tebak sendiri: *naik karena spot buying sehat, atau karena leverage rapuh?*

### 6.2 Cross-Venue Positioning Matrix

Setelah 3.1–3.3 terpasang, satu tabel agregat untuk prompt:

| Venue | Cohort | Bias |
|---|---|---|
| Binance top traders | Whale CEX retail | LONG/SHORT |
| OKX top traders | Whale CEX Asia | LONG/SHORT |
| Bitfinex margin | Whale legacy | LONG/SHORT |
| Hyperliquid | Whale DEX | LONG/SHORT (dari funding/OI) |
| CME (COT lev funds) | Hedge funds | LONG/SHORT (mingguan) |
| CME (COT asset mgr) | Institusi long-only | LONG/SHORT (mingguan) |

`venueAgreement: 5/6 LONG` = confluence bandarmologi sesungguhnya. Jika 5+ venue searah → boleh HIGH confidence; jika split 3/3 → paksa WAIT/LOW. **Upgrade `computeSmartMoneyScore()` v7 memakai matrix ini** (sekarang baru Binance-sentris).

### 6.3 Squeeze Fuel Indicator

Gabungan: funding ekstrem (≥ |0.05%|/8h) + basis premium tinggi + liq magnet dekat (< 1.5%) + Bitfinex/HL short build-up → `squeezeFuel: { direction: 'SHORT_SQUEEZE'|'LONG_SQUEEZE', score 0-100 }`. Ini membedakan "SHORT karena bearish" vs "jangan SHORT karena bahan squeeze naik menumpuk".

### 6.4 Upgrade existing (dari ANALISIS_MASALAH, tetap relevan)

- L/S divergence → z-score terhadap history 24h (data sudah ada).
- `computeSmartMoneyScore` bobot ETF diaktifkan kembali setelah 2.1 hidup.

---

## 7. Prioritas Implementasi

| # | Item | Tipe | Effort | Dampak sinyal | Ketergantungan |
|---|---|---|---|---|---|
| 1 | Fix ETF flows (SoSoValue) §2.1 | FREE KEY | 1-2 jam | 🔥 Sangat tinggi — menghidupkan sinyal mati | — |
| 2 | CVD → futures §2.2 | TANPA KEY | 15 mnt | Tinggi — hapus sinyal sesat | — |
| 3 | Regime Matrix §6.1 | computed | 1 jam | 🔥 Sangat tinggi | — |
| 4 | Coinbase Premium §4.1 | TANPA KEY | 30 mnt | Tinggi | — |
| 5 | Hyperliquid §3.2 | TANPA KEY | 1 jam | Tinggi — venue ortogonal | — |
| 6 | Bitfinex margin §3.3 | TANPA KEY | 45 mnt | Tinggi | — |
| 7 | CFTC COT §3.1 | TANPA KEY | 1-2 jam | Sedang-tinggi (mingguan) | — |
| 8 | DVOL + risk reversal §3.4 | TANPA KEY | 1 jam | Sedang | Deribit sudah ada |
| 9 | Cross-Venue Matrix §6.2 | computed | 1 jam | 🔥 Sangat tinggi | #5,#6,#7 |
| 10 | Squeeze Fuel §6.3 | computed | 45 mnt | Tinggi | #6 |
| 11 | Macro → FRED/Yahoo §2.4 | FREE KEY/tanpa | 1 jam | Sedang — reliability | — |
| 12 | Kimchi premium §4.2 | TANPA KEY | 30 mnt | Sedang | — |
| 13 | CME gap §4.3 | TANPA KEY | 45 mnt | Sedang | #11 (Yahoo) |
| 14 | NUPL via bitcoin-data.com §5.1 | FREE KEY | 1-2 jam (+cache) | Sedang (swing) | — |
| 15 | CryptoPanic news §5.2 | FREE KEY | 45 mnt | Sedang | — |
| 16 | OKX liquidations §3.5 | TANPA KEY | 30 mnt | Rendah-sedang | — |
| 17 | Polymarket odds §5.3 | TANPA KEY | 1 jam | Eksperimental | — |
| 18 | Miner pressure §5.4 | TANPA KEY | 45 mnt | Rendah (lambat) | — |

Sprint yang disarankan: **Sprint A** = #1–4 (perbaikan + quick win), **Sprint B** = #5–10 (lapisan whale/institusi — nilai bandarmologi terbesar), **Sprint C** = sisanya.

---

## 8. Arsitektur & Batasan

- **Pola key**: semua FREE KEY mengikuti pola Coinalyze yang sudah ada — user paste key di Settings, browser kirim via header (`x-soso-key`, `x-fred-key`, `x-cryptopanic-key`, `x-btcdata-key`), Edge function fetch server-side. Key tidak pernah hardcoded di repo.
- **Cache wajib** untuk sumber lambat/limit ketat: COT (mingguan), bitcoin-data.com (8 req/jam), ETF (harian) → cache client-side `localStorage` dengan TTL (COT 24h, on-chain 24h, ETF 4h). Snapshot Edge tetap stateless.
- **Normalisasi funding**: Hyperliquid per-jam ×8 sebelum dibandingkan funding 8h CEX.
- **Timeout budget**: setiap sumber baru masuk `SOURCES` sebagai `optional: true` dengan timeout ≤ 7s — kegagalan tidak boleh memblokir snapshot (pola sudah ada).
- **Shared IP Vercel**: Yahoo/Farside berisiko throttle seperti CoinGecko dulu — selalu desain sebagai best-effort + fallback, jangan jadi dependency kritis.

## 9. Layanan yang Di-skip (berbayar — melanggar aturan gratis)

| Provider | Yang ditawarkan | Pengganti gratis di dokumen ini |
|---|---|---|
| Glassnode / CryptoQuant | SOPR, NUPL, exchange flow | bitcoin-data.com §5.1 + CoinMetrics Community |
| CoinGlass API | Liq heatmap, ETF, L/S agregat | Coinalyze (sudah ada) + Bybit/OKX liq + SoSoValue |
| Nansen / Arkham API | Smart money wallets | Cross-venue matrix §6.2 (proxy) |
| Velo / Laevitas / Amberdata | Options analytics | Deribit public §3.4 |
| Santiment / LunarCrush | Social sentiment | CryptoPanic votes §5.2 + Fear&Greed |

## 10. Status Verifikasi Endpoint (2026-06-11)

| Endpoint | Status |
|---|---|
| Hyperliquid `POST /info` | ✅ Dites langsung, hidup, tanpa key |
| CFTC Socrata `gpe5-46if.json` | ✅ Dites langsung, hidup, tanpa key |
| Bitfinex, Deribit DVOL, Coinbase, OKX liq, Yahoo, Upbit, Polymarket | 📄 Terdokumentasi resmi/publik; **tidak bisa dites dari mesin ini** (jaringan lokal memblokir SSL domain exchange) → **wajib smoke-test dari Vercel Edge saat implementasi** |
| SoSoValue, FRED, CryptoPanic, bitcoin-data.com | 📄 Butuh registrasi key gratis dulu, lalu tes |

> Pelajaran dari kasus ETF DefiLlama: **jangan tandai sumber `optional` lalu lupakan** — tambahkan panel "source health" di UI yang menampilkan sumber mana yang null pada snapshot terakhir, supaya endpoint mati ketahuan, tidak senyap.

---

## Referensi

- CFTC Public Reporting Environment: https://publicreporting.cftc.gov/stories/s/r4w3-av2u/
- Hyperliquid API docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
- Bitfinex public stats: https://docs.bitfinex.com/reference/rest-public-stats
- Deribit API: https://docs.deribit.com/ · DVOL: https://insights.deribit.com/exchange-updates/dvol-deribit-implied-volatility-index/
- SoSoValue ETF dashboard/API: https://m.sosovalue.com/assets/etf/us-btc-spot
- bitcoin-data.com (BGeometrics): https://bitcoin-data.com/ · limits: https://charts.bgeometrics.com/bitcoin_api.html
- FRED API: https://fred.stlouisfed.org/docs/api/fred/
- CryptoPanic API: https://cryptopanic.com/developers/api/
- Polymarket Gamma API: https://gamma-api.polymarket.com
- Farside ETF flows: https://farside.co.uk/bitcoin-etf-flow-all-data/
- Paper TradingAgents (dasar arsitektur council): arXiv 2412.20138

---

*Dokumen kebutuhan · dibuat 2026-06-11 · status: **DIIMPLEMENTASI di v8** (2026-06-11) — semua item §2–§6 masuk `api/snapshot.js` + `app.js`; ETF DefiLlama/sosovalue.xyz yang mati dihapus, diganti SoSoValue Open API (free key); Stooq diganti Yahoo primary + Stooq fallback + FRED opsional; panel Source Health ditambahkan di UI. Catatan smoke-test lokal: Hyperliquid, CFTC COT, CME gap (Yahoo), miner pressure, NUPL bitcoin-data.com terverifikasi hidup; sumber exchange (Bitfinex/Deribit DVOL/Coinbase/Upbit/OKX liq) wajib di-smoke-test dari Vercel Edge setelah deploy (jaringan lokal memblokir SSL-nya).*
