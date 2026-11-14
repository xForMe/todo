// Read-only screenshot capture using an isolated browser; no business writes.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    await page.goto(process.argv[2] || 'http://127.0.0.1:8000');
    await page.waitForLoadState('networkidle');
    const output = path.resolve(__dirname,'../../runtime/ui-redesign');
    fs.mkdirSync(output,{recursive:true});
    await page.screenshot({path:path.join(output,(process.argv[3] || 'before')+'.png'),fullPage:true});
    console.log(JSON.stringify({title:await page.title(),headings:await page.locator('h1,h2').allTextContents(),screenshot:output}));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
