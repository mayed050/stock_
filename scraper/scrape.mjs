// @ts-check
import fs from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer';

const OUT_DIR = path.resolve('data');

/** Robust text cleanup */
const clean = (t) => (t||'').replace(/[\n\t]+/g,' ').replace(/\s+/g,' ').trim();
const toNumber = (t) => {
  if(t==null) return null;
  const n = clean(t).replace(/[,\s]/g,'').replace('د.إ','').replace('AED','');
  const m = n.match(/([\-]?[0-9]*\.?[0-9]+)/);
  return m ? Number(m[1]) : null;
};

async function extractMubasher(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  const map = {};

  // Extract price and change percentage
  try {
    await page.waitForSelector('div.market-summary__last-price', { timeout: 15000 });
    const price = await page.$eval('div.market-summary__last-price', el => el.textContent);
    map.price = toNumber(price);
  } catch (e) {
    console.error('Could not extract Mubasher price');
  }

  try {
    const change = await page.$eval('div.market-summary__change-percentage', el => el.textContent);
    map.change_pct = (() => {
      const m = clean(change).match(/([\-+]?\d+(?:\.\d+)?)%/);
      return m ? Number(m[1]) : null;
    })();
  } catch (e) {
    console.error('Could not extract Mubasher change %');
  }

  // Extract key-value stats from the page
  const stats = await page.evaluate(() => {
    const data = [];
    const rows = document.querySelectorAll('.market-summary__block-row, .stock-overview__text-and-value-item');

    rows.forEach(row => {
      const labelEl = row.querySelector('.market-summary__block-text, .stock-overview__text');
      const valueEl = row.querySelector('.market-summary__block-number, .stock-overview__value');

      if (labelEl && valueEl) {
        const key = labelEl.innerText.trim();
        const value = valueEl.innerText.trim();
        data.push([key, value]);
      }
    });
    return data;
  });

  // Map extracted stats to our data structure
  for (const [k, v] of stats) {
    const key = clean(k);
    const val = clean(v);
    if (/Open/i.test(key)) map.open = toNumber(val);
    if (/High/i.test(key)) map.high = toNumber(val);
    if (/Low/i.test(key)) map.low = toNumber(val);
    if (/Volume/i.test(key)) map.volume = toNumber(val);
    if (/Turnover/i.test(key)) map.turnover = toNumber(val);
    if (/P\/E Ratio/i.test(key)) map.pe_ttm = toNumber(val);
    if (/EPS/i.test(key)) map.eps_ttm = toNumber(val);
    if (/Market Cap/i.test(key)) map.market_cap = toNumber(val);
  }

  return map;
}

async function extractDFMTradingSummary(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  const data = {};

  try {
    await page.waitForSelector('.table-flex', { timeout: 15000 });

    const stats = await page.evaluate(() => {
      const extracted = {};
      const cols = document.querySelectorAll('.table-flex .t-col');
      cols.forEach(col => {
        const headEl = col.querySelector('.t-head');
        const valueEl = headEl ? headEl.nextElementSibling : null;
        if (headEl && valueEl) {
          const key = headEl.innerText.trim();
          const value = valueEl.innerText.trim();
          extracted[key] = value;
        }
      });
      return extracted;
    });

    data.open = toNumber(stats['Open Price']);
    data.high = toNumber(stats['High']);
    data.low = toNumber(stats['Low']);
    data.price = toNumber(stats['Closing Price']) || toNumber(stats['Last Price']);
    data.turnover = toNumber(stats['Value']);
    data.market_cap = toNumber(stats['Market Cap']);
    data.volume = toNumber(stats['Volume']);

  } catch (e) {
    console.error('Could not extract DFM summary', e);
  }

  return data;
}

async function extractADX(page, symbol = "NMDCENR") {
    const url = `https://www.adx.ae/en/main-market/company-profile/overview?secCode=${symbol}&symbols=${symbol}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });

    try {
        await page.waitForSelector('.adx-financials-chart_details', { timeout: 20000 });

        const stats = await page.evaluate(() => {
            const data = {};

            const findStat = (label) => {
                const allHeadings = document.querySelectorAll('h3');
                for (const h3 of allHeadings) {
                    if (h3.innerText.trim().toLowerCase() === label.toLowerCase()) {
                        const valueEl = h3.nextElementSibling;
                        return valueEl ? valueEl.innerText.trim() : null;
                    }
                }
                return null;
            };

            const priceEl = document.querySelector('.price-info_count');
            if (priceEl) {
                data['Last Price'] = priceEl.childNodes[0].nodeValue.trim();
                const changeEl = priceEl.querySelector('.price-info_change');
                if (changeEl) data['Change %'] = changeEl.innerText.trim();
            }

            data['Market Cap'] = findStat('MARKET CAP.');
            data['Open Price'] = findStat('OPEN PRICE');
            data['Prev. Close'] = findStat('PREV CLOSE');

            const firstRow = document.querySelector('.adx-recent-trades_table tbody tr');
            if (firstRow) {
                const cells = firstRow.querySelectorAll('td');
                if (cells.length >= 8) {
                    data['High'] = cells[3].innerText.trim();
                    data['Low'] = cells[2].innerText.trim();
                    data['Volume'] = cells[6].innerText.trim();
                    data['Turnover'] = cells[5].innerText.trim();
                }
            }

            return data;
        });

        const finalData = {};
        finalData.price = toNumber(stats['Last Price']) || toNumber(stats['Prev. Close']);
        if (stats['Change %']) {
            const m = clean(stats['Change %']).match(/([\-+]?\d+(?:\.\d+)?)%/);
            finalData.change_pct = m ? Number(m[1]) : null;
        }
        finalData.open = toNumber(stats['Open Price']);
        finalData.high = toNumber(stats['High']);
        finalData.low = toNumber(stats['Low']);
        finalData.volume = toNumber(stats['Volume']);
        finalData.turnover = toNumber(stats['Turnover']);
        finalData.market_cap = toNumber(stats['Market Cap']);

        return finalData;

    } catch (e) {
        console.error(`Could not extract ADX data for ${symbol}`, e);
        return {};
    }
}

async function main(){
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  const out = JSON.parse(await fs.readFile(path.resolve('data/latest.json'),'utf-8'));
  const now = new Date().toISOString();
  out.as_of = now;

  // DEWA
  try{
    const m = await extractMubasher(page, 'https://english.mubasher.info/markets/DFM/stocks/DEWA');
    const d = await extractDFMTradingSummary(page, 'https://www.dfm.ae/the-exchange/market-information/company/DEWA/trading/trading-summary');
    out.stocks.DEWA = { ...out.stocks.DEWA, ...m, ...d };
  }catch(e){ console.error('DEWA scrape error', e); }

  // SALIK
  try{
    const m = await extractMubasher(page, 'https://english.mubasher.info/markets/DFM/stocks/SALIK');
    out.stocks.SALIK = { ...out.stocks.SALIK, ...m };
  }catch(e){ console.error('SALIK scrape error', e); }

  // TALABAT
  try{
    const m = await extractMubasher(page, 'https://english.mubasher.info/markets/DFM/stocks/TALABAT');
    const d = await extractDFMTradingSummary(page, 'https://www.dfm.ae/the-exchange/market-information/company/TALABAT/trading/trading-summary');
    out.stocks.TALABAT = { ...out.stocks.TALABAT, ...m, ...d };
  }catch(e){ console.error('TALABAT scrape error', e); }

  // NMDC Energy (ADX)
  try{
    const a = await extractADX(page, 'NMDCENR');
    out.stocks.NMDCENR = { ...out.stocks.NMDCENR, ...a };
  }catch(e){ console.error('NMDCENR scrape error', e); }

  // Ensure directory
  await fs.mkdir(OUT_DIR, { recursive: true });
  // Write latest and dated snapshot
  await fs.writeFile(path.join(OUT_DIR,'latest.json'), JSON.stringify(out, null, 2), 'utf-8');
  const dstr = new Date(now).toISOString().slice(0,10);
  await fs.writeFile(path.join(OUT_DIR, `${dstr}.json`), JSON.stringify(out, null, 2), 'utf-8');

  await browser.close();
  console.log('Done. Data updated:', now);
}

main().catch(err=>{ console.error(err); process.exit(1); });