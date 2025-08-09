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

async function extractMubasher(page, url){
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  // Try to read main price and change
  const priceSel = 'div.price-big, .box-overview .last-price, .price';
  const changeSel = 'span.change, .change-percent, .box-overview .change';
  const map = {};
  try {
    await page.waitForSelector(priceSel, {timeout: 15000});
    const price = await page.$eval(priceSel, el => el.textContent);
    map.price = toNumber(price);
  } catch{}

  try {
    const change = await page.$eval(changeSel, el => el.textContent);
    map.change_pct = (()=>{
      const m = clean(change).match(/([\-+]?\d+(?:\.\d+)?)%/);
      return m ? Number(m[1]) : null;
    })();
  } catch{}

  // Grab table stats labels (Open, High, Low, Volume, Turnover, P/E, EPS, Market Cap)
  const possibleLabels = ['Open','High','Low','Volume','Turnover','P/E Ratio','EPS','Market Cap','Par Value','Book Value','P/B Ratio'];
  const rows = await page.$$eval('table, .stock-statistics, .company-statistics, .table', tables => {
    const res = [];
    const getText = (el) => (el?.innerText || '').trim();
    for(const t of tables){
      const trs = t.querySelectorAll('tr');
      for(const tr of trs){
        const cells = Array.from(tr.querySelectorAll('th,td')).map(getText);
        if(cells.length>=2) res.push(cells);
      }
    }
    return res;
  });

  for(const [k,v] of rows){
    const key = clean(k);
    const val = clean(v);
    if(/Open/i.test(key)) map.open = toNumber(val);
    if(/High/i.test(key)) map.high = toNumber(val);
    if(/Low/i.test(key)) map.low = toNumber(val);
    if(/Volume/i.test(key)) map.volume = toNumber(val);
    if(/Turnover/i.test(key) || /Value/i.test(key)) map.turnover = toNumber(val);
    if(/P\/E/i.test(key)) map.pe_ttm = toNumber(val);
    if(/EPS/i.test(key)) map.eps_ttm = toNumber(val);
    if(/Market Cap/i.test(key)) map.market_cap = toNumber(val);
  }
  return map;
}

async function extractDFMTradingSummary(page, url){
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  // The summary page often has labeled entries we can read by text
  const fields = ['Open Price','Closing Price','High','Low','Best Bid','Bid Vol','Last Price','Value','Market Cap','Last Traded'];
  const data = {};
  // Try all spans/divs and map nearest label/value pairs
  const pairs = await page.$$eval('body *', nodes => nodes.map(n => n.textContent?.trim()).filter(Boolean));
  const get = (label) => {
    const idx = pairs.findIndex(t => t.toLowerCase().includes(label.toLowerCase()));
    if(idx>=0){
      // next non-empty value
      for(let j=idx+1;j<Math.min(idx+6, pairs.length);j++){
        const v = pairs[j];
        if(v && !/[a-zA-Z]+/.test(v) || /\d/.test(v)) return v;
      }
    }
    return null;
  };
  data.open = toNumber(get('Open'));
  data.high = toNumber(get('High'));
  data.low = toNumber(get('Low'));
  data.price = toNumber(get('Last Price')) || toNumber(get('Closing Price'));
  data.turnover = toNumber(get('Value'));
  data.market_cap = toNumber(get('Market Cap'));
  return data;
}

async function extractADX(page, symbol="NMDCENR"){
  const url = `https://www.adx.ae/en/main-market/company-profile/overview?secCode=${symbol}&symbols=${symbol}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  const data = {};
  // Try to capture Last Price, High, Low, Volume, Turnover
  const text = await page.evaluate(()=>document.body.innerText);
  const val = (label)=>{
    const re = new RegExp(label + "\\s*:?\\s*([0-9.,]+)", "i");
    const m = text.match(re);
    return m ? m[1] : null;
  };
  data.price = toNumber(val('Last Price'));
  data.high = toNumber(val('High'));
  data.low = toNumber(val('Low'));
  data.volume = toNumber(val('Volume'));
  data.turnover = toNumber(val('Turnover'));
  return data;
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