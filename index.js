const express = require('express');
const { chromium } = require('playwright');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const RENDERS_DIR = path.join(__dirname, 'renders');
if (!fs.existsSync(RENDERS_DIR)) fs.mkdirSync(RENDERS_DIR);

// --- Advertiser matching (only used when scrape-meta-ads is called with
// match_name). A keyword search on the Ad Library returns ads from ANY company
// containing those words, so we read each ad's real advertiser and keep only the
// ones that genuinely belong to the searched business. Leaves the default
// (no match_name) behaviour untouched for existing callers. ---
const AD_GENERIC = new Set(['roofing','roofers','roofer','roof','maintenance','services','service','building','builders','build','property','guttering','gutter','ltd','limited','co','company','and','the','solutions','contractors','contractor','specialist','specialists','group','uk','repairs','repair','leadwork','flat','pitched','works','llp','driveways','driveway','resin','landscaping','landscapes','landscape','gardens','garden','kitchens','kitchen','bathrooms','bathroom','painters','painting','decorating','decorators','plastering']);
const AD_LOC = new Set(['cumbria','cumbrian','lakeland','lakes','kendal','windermere','bowness','ambleside','keswick','penrith','carlisle','ulverston','barrow','workington','whitehaven','cockermouth','grange','kirkby','lonsdale','south','north','west','east','local']);

function adTokens(name) {
  return (name || '').toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(Boolean);
}
function adStrongTokens(ts) {
  return ts.filter((t) => !AD_GENERIC.has(t) && !AD_LOC.has(t));
}
// True only when every identifying word of the business appears in the
// advertiser name AND the advertiser adds no other identifying word. This
// rejects shared-word collisions (e.g. "Cumberland Roofing" vs "Cumberland News").
function advertiserMatches(business, advertiser) {
  const b = adStrongTokens(adTokens(business));
  const a = adStrongTokens(adTokens(advertiser));
  if (!b.length || !a.length) return false;
  const aset = new Set(a), bset = new Set(b);
  const bAllInA = b.every((t) => aset.has(t));
  const aExtraStrong = a.filter((t) => !bset.has(t));
  return bAllInA && aExtraStrong.length === 0;
}

// Reads the advertiser name from every ad card currently in the DOM.
function extractAdvertisersInPage() {
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (/Library ID/i.test(node.nodeValue || '')) {
      let el = node.parentElement, card = null;
      while (el && el.parentElement) {
        const r = el.getBoundingClientRect();
        if (r.height >= 260 && r.height <= 1400 && r.width >= 240 && r.width <= 600) { card = el; break; }
        el = el.parentElement;
      }
      if (card) {
        const link = Array.from(card.querySelectorAll('a')).find(
          (x) => /facebook\.com\/(\d+|[A-Za-z0-9.\-]+)\/?$/.test(x.getAttribute('href') || '') && (x.innerText || '').trim(),
        );
        const libId = (node.nodeValue.match(/\d{6,}/) || [''])[0];
        if (link && libId && !seen.has(libId)) {
          seen.add(libId);
          out.push({
            advertiser: (link.innerText || '').trim().split('\n')[0],
            pageId: (link.getAttribute('href').match(/facebook\.com\/(\d+)/) || [])[1] || null,
          });
        }
      }
    }
  }
  return out;
}

// Concurrency queue — max 5 simultaneous renders
let activeRenders = 0;
const MAX_CONCURRENT = 5;
const queue = [];

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeRenders++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally {
        activeRenders--;
        if (queue.length > 0) queue.shift()();
      }
    };
    if (activeRenders < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

// Clean up renders older than 24 hours — runs every hour
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  fs.readdirSync(RENDERS_DIR).forEach(file => {
    const filepath = path.join(RENDERS_DIR, file);
    try {
      const stat = fs.statSync(filepath);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(filepath);
    } catch (e) {}
  });
}, 60 * 60 * 1000);

// Browser instance — reuse across requests
let browser = null;
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  }
  return browser;
}

// Health check
app.get('/api/healthz', (req, res) => {
  res.json({ ok: true });
});

// Serve rendered images
app.use('/api/renders', express.static(RENDERS_DIR));

// Render endpoint
app.post('/api/render', async (req, res) => {
  try {
    const { html, css, google_fonts, viewport_width, viewport_height, device_scale } = req.body;

    if (!html) {
      return res.status(400).json({ error: 'html field is required' });
    }

    const width = viewport_width || 1080;
    const height = viewport_height || 1080;
    const scale = device_scale || 1;

    // Build Google Fonts link if provided
    let fontsLink = '';
    if (google_fonts) {
      const families = google_fonts.split('|').map(f => {
        const [name, weights] = f.split(':');
        const encoded = name.trim().replace(/\s+/g, '+');
        if (weights) {
          return `family=${encoded}:wght@${weights.split(',').join(';')}`;
        }
        return `family=${encoded}`;
      }).join('&');
      fontsLink = `<link href="https://fonts.googleapis.com/css2?${families}&display=swap" rel="stylesheet">`;
    }

    // Build full HTML document
    let fullHtml;
    if (html.trim().startsWith('<!DOCTYPE') || html.trim().startsWith('<html')) {
      // Already a full document — inject fonts link and optional CSS
      fullHtml = html;
      if (fontsLink) {
        fullHtml = fullHtml.replace('<head>', `<head>${fontsLink}`);
      }
      if (css) {
        fullHtml = fullHtml.replace('</head>', `<style>${css}</style></head>`);
      }
    } else {
      // Partial HTML — wrap it
      fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">${fontsLink}${css ? `<style>${css}</style>` : ''}</head><body>${html}</body></html>`;
    }

    const result = await enqueue(async () => {
      const b = await getBrowser();
      const page = await b.newPage();
      await page.setViewportSize({ width, height });
      if (scale !== 1) {
        await page.evaluate((s) => {
          document.documentElement.style.transform = `scale(${s})`;
          document.documentElement.style.transformOrigin = 'top left';
        }, scale);
      }
      await page.setContent(fullHtml, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      // Extra wait for font rendering
      await page.waitForTimeout(500);
      const screenshot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
      await page.close();
      return screenshot;
    });

    // Save to file
    const id = uuidv4();
    const filename = `${id}.png`;
    fs.writeFileSync(path.join(RENDERS_DIR, filename), result);

    // Build hosted URL
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const hostedUrl = `${protocol}://${host}/api/renders/${filename}`;

    // Base64
    const base64 = `data:image/png;base64,${result.toString('base64')}`;

    res.json({
      url: base64,
      hosted_url: hostedUrl
    });

  } catch (err) {
    res.status(500).json({
      error: 'Render failed',
      details: err.message
    });
  }
});

// Video render endpoint — injects staggered CSS animations and captures as video
app.post('/api/render-video', async (req, res) => {
  try {
    const { html, css, google_fonts, viewport_width, viewport_height, duration } = req.body;

    if (!html) {
      return res.status(400).json({ error: 'html field is required' });
    }

    const width = viewport_width || 1080;
    const height = viewport_height || 1080;
    const animDuration = duration || 4000;

    // Staggered reveal animations — injected server-side so Build HTML stays clean
    const animationCss = `
      @keyframes fadeUp {
        from { opacity: 0; transform: translateY(28px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes ctaPulse {
        0% { opacity: 0; transform: scale(0.9); }
        60% { opacity: 1; transform: scale(1.03); }
        100% { opacity: 1; transform: scale(1); }
      }
      /* Tag / category — first to appear */
      .tag, .lga, .lga-hero, .category { opacity: 0; animation: fadeUp 0.5s ease both; animation-delay: 0.3s; }
      /* Headline */
      .h, .header, .stat { opacity: 0; animation: fadeUp 0.6s ease both; animation-delay: 0.7s; }
      /* Accent / highlight line */
      .hi, .stat-label { opacity: 0; animation: fadeUp 0.5s ease both; animation-delay: 1.1s; }
      /* Body text */
      .bt, .subheader, .body { opacity: 0; animation: fadeUp 0.5s ease both; animation-delay: 1.5s; }
      /* Checklist items — stagger each one */
      .checklist li { opacity: 0; animation: fadeUp 0.4s ease both; }
      .checklist li:nth-child(1) { animation-delay: 0.8s; }
      .checklist li:nth-child(2) { animation-delay: 1.0s; }
      .checklist li:nth-child(3) { animation-delay: 1.2s; }
      .checklist li:nth-child(4) { animation-delay: 1.4s; }
      .checklist li:nth-child(5) { animation-delay: 1.6s; }
      /* CTA button — last, with a subtle scale pop */
      .btn, .cta { opacity: 0; animation: ctaPulse 0.5s ease both; animation-delay: 2.0s; }
      /* Decorative elements fade in early and gently */
      .holes, .fold, .frame-inner { opacity: 0; animation: fadeIn 0.8s ease both; animation-delay: 0.1s; }
    `;

    // Build Google Fonts link
    let fontsLink = '';
    if (google_fonts) {
      const families = google_fonts.split('|').map(f => {
        const [name, weights] = f.split(':');
        const encoded = name.trim().replace(/\s+/g, '+');
        if (weights) {
          return `family=${encoded}:wght@${weights.split(',').join(';')}`;
        }
        return `family=${encoded}`;
      }).join('&');
      fontsLink = `<link href="https://fonts.googleapis.com/css2?${families}&display=swap" rel="stylesheet">`;
    }

    // Build full HTML with animation CSS injected
    const allCss = animationCss + (css || '');
    let fullHtml;
    if (html.trim().startsWith('<!DOCTYPE') || html.trim().startsWith('<html')) {
      fullHtml = html;
      if (fontsLink) fullHtml = fullHtml.replace('<head>', `<head>${fontsLink}`);
      fullHtml = fullHtml.replace('</head>', `<style>${allCss}</style></head>`);
    } else {
      fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">${fontsLink}<style>${allCss}</style></head><body>${html}</body></html>`;
    }

    const result = await enqueue(async () => {
      const b = await getBrowser();
      const context = await b.newContext({
        viewport: { width, height },
        recordVideo: { dir: RENDERS_DIR, size: { width, height } }
      });
      const page = await context.newPage();
      await page.setContent(fullHtml, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      // Wait for all animations to complete + a brief hold at the end
      await page.waitForTimeout(animDuration);
      // Close page + context to finalize the video
      await page.close();
      const videoPath = await page.video().path();
      await context.close();
      return videoPath;
    });

    const id = uuidv4();
    const filename = `${id}.webm`;
    const dest = path.join(RENDERS_DIR, filename);
    fs.renameSync(result, dest);

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const hostedUrl = `${protocol}://${host}/api/renders/${filename}`;

    res.json({
      hosted_url: hostedUrl,
      format: 'webm',
      duration_ms: animDuration
    });

  } catch (err) {
    res.status(500).json({
      error: 'Video render failed',
      details: err.message
    });
  }
});

// PDF render endpoint
app.post('/api/render-pdf', async (req, res) => {
  try {
    const { html, css, google_fonts, page_format, margin } = req.body;

    if (!html) {
      return res.status(400).json({ error: 'html field is required' });
    }

    const format = page_format || 'A4';
    const pdfMargin = margin || {
      top: '15mm', bottom: '15mm', left: '15mm', right: '15mm'
    };

    let fontsLink = '';
    if (google_fonts) {
      const families = google_fonts.split('|').map(f => {
        const [name, weights] = f.split(':');
        const encoded = name.trim().replace(/\s+/g, '+');
        if (weights) return `family=${encoded}:wght@${weights.split(',').join(';')}`;
        return `family=${encoded}`;
      }).join('&');
      fontsLink = `<link href="https://fonts.googleapis.com/css2?${families}&display=swap" rel="stylesheet">`;
    }

    let fullHtml;
    if (html.trim().startsWith('<!DOCTYPE') || html.trim().startsWith('<html')) {
      fullHtml = html;
      if (fontsLink) fullHtml = fullHtml.replace('<head>', `<head>${fontsLink}`);
      if (css) fullHtml = fullHtml.replace('</head>', `<style>${css}</style></head>`);
    } else {
      fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">${fontsLink}${css ? `<style>${css}</style>` : ''}</head><body>${html}</body></html>`;
    }

    const result = await enqueue(async () => {
      const b = await getBrowser();
      const page = await b.newPage();
      await page.setContent(fullHtml, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      const pdfBuffer = await page.pdf({
        format,
        margin: pdfMargin,
        printBackground: true
      });
      await page.close();
      return pdfBuffer;
    });

    const id = uuidv4();
    const filename = `${id}.pdf`;
    fs.writeFileSync(path.join(RENDERS_DIR, filename), result);

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const hostedUrl = `${protocol}://${host}/api/renders/${filename}`;

    res.json({
      hosted_url: hostedUrl,
      format: 'pdf'
    });

  } catch (err) {
    res.status(500).json({
      error: 'PDF render failed',
      details: err.message
    });
  }
});

// Scrape Meta Ad Library for a company name — returns ad count + URL.
// Uses Playwright so FB's JS-rendered ad cards actually load (plain HTTP returns an empty shell).
app.post('/api/scrape-meta-ads', async (req, res) => {
  try {
    const { company_name, country, capture_screenshots, match_name } = req.body;
    if (!company_name) return res.status(400).json({ error: 'company_name required' });

    const c = (country || 'AU').toUpperCase();
    const q = encodeURIComponent(company_name);
    const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${c}&q=${q}`;

    const result = await enqueue(async () => {
      const b = await getBrowser();
      const page = await b.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-AU,en;q=0.9'
      });

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (e) {
        await page.close();
        throw new Error('Navigation failed: ' + e.message);
      }

      // Wait for EITHER the ad cards OR an explicit "no ads" message, whichever first.
      // Falls back to a fixed wait if neither selector resolves in time.
      try {
        await page.waitForFunction(() => {
          const html = document.body ? document.body.innerText : '';
          return /Library ID:?\s*\d/.test(html) || /No ads match/i.test(html) || /\d+\s+results?/i.test(html);
        }, { timeout: 7000 });
      } catch (e) {
        // Fallback — no signal detected, short extra wait
        await page.waitForTimeout(1500);
      }

      // Small settle for any lazy-rendered ads
      await page.waitForTimeout(800);

      const content = await page.content();

      // Signal: explicit "no ads" messaging
      const noAds = /No ads match/i.test(content) ||
                    /no results/i.test(content) ||
                    /0 results/i.test(content);

      // Count Library IDs — one per active ad group
      const libIds = content.match(/Library ID:?\s*\d{6,}/gi) || [];
      const uniqueIds = Array.from(new Set(libIds.map(s => s.replace(/\D+/g, ''))));

      // Also try to read the "N results" count if present
      let resultsCount = 0;
      const rc = content.match(/(\d{1,5})\s+results?/i);
      if (rc) resultsCount = parseInt(rc[1], 10) || 0;

      // When a match_name is supplied, scroll to load more cards then read the
      // real advertiser on each one, so the caller can filter to this business.
      let advertisers = [];
      if (match_name) {
        for (let i = 0; i < 4; i++) {
          await page.mouse.wheel(0, 3000);
          await page.waitForTimeout(800);
        }
        try {
          advertisers = await page.evaluate(extractAdvertisersInPage);
        } catch (e) {
          advertisers = [];
        }
      }

      // Optionally capture screenshots of the first 3 ad cards.
      // Fragile by nature (FB obfuscates class names) — fails gracefully.
      let screenshotFilenames = [];
      if (capture_screenshots && uniqueIds.length > 0) {
        try {
          // Walk up from each "Library ID" text node to the first
          // reasonably-sized ancestor (the ad card wrapper).
          const cardHandles = await page.evaluateHandle(() => {
            const results = [];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            const seen = new Set();
            while ((node = walker.nextNode()) && results.length < 5) {
              if (/Library ID/i.test(node.nodeValue || '')) {
                let el = node.parentElement;
                while (el && el.parentElement) {
                  const r = el.getBoundingClientRect();
                  if (r.height >= 320 && r.height <= 1200 && r.width >= 260 && r.width <= 520) {
                    if (!seen.has(el)) {
                      seen.add(el);
                      results.push(el);
                    }
                    break;
                  }
                  el = el.parentElement;
                }
              }
            }
            return results;
          });
          const props = await cardHandles.getProperties();
          const elements = [];
          for (const prop of props.values()) {
            const el = prop.asElement();
            if (el) elements.push(el);
          }
          const maxShots = Math.min(3, elements.length);
          for (let i = 0; i < maxShots; i++) {
            try {
              const id = uuidv4();
              const filename = `ad-${id}.png`;
              const filepath = path.join(RENDERS_DIR, filename);
              await elements[i].scrollIntoViewIfNeeded();
              await page.waitForTimeout(300);
              await elements[i].screenshot({ path: filepath, timeout: 5000 });
              screenshotFilenames.push(filename);
            } catch (shotErr) {
              // Individual screenshot failed — keep going with the rest
            }
          }
        } catch (capErr) {
          // Whole capture failed — return empty array, main scrape still succeeds
        }
      }

      await page.close();

      return {
        noAds,
        adCount: uniqueIds.length,
        resultsCount,
        htmlLength: content.length,
        screenshotFilenames,
        advertisers
      };
    });

    // Default (no match_name): trust Library IDs over stray "No ads match" text —
    // that message often appears in sidebar filter states on pages that DO have
    // main-result ads. Require at least 3 unique Library IDs to filter noise.
    const hasSolidLibIds = result.adCount >= 3;
    const hasResultsCount = result.resultsCount > 0;
    let isRunningAds = hasSolidLibIds || (!result.noAds && hasResultsCount);
    let adCount = Math.max(result.adCount, result.resultsCount);
    let matchedAdvertiser = null;
    let matchedPageId = null;

    // With match_name: count ONLY the ads whose advertiser is genuinely this
    // business. Kills the keyword-search false positives.
    if (match_name) {
      const mine = (result.advertisers || []).filter((a) =>
        advertiserMatches(match_name, a.advertiser),
      );
      adCount = mine.length;
      isRunningAds = mine.length > 0;
      if (mine.length) {
        matchedAdvertiser = mine[0].advertiser;
        matchedPageId = mine.find((m) => m.pageId)?.pageId || null;
      }
    }

    // Build public URLs for any captured screenshots
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const adScreenshots = (result.screenshotFilenames || []).map(
      fn => `${protocol}://${host}/api/renders/${fn}`
    );

    res.json({
      isRunningAds,
      adCount,
      adLibraryUrl: url,
      adScreenshots,
      matchedAdvertiser,
      matchedPageId,
      debug: { htmlLength: result.htmlLength, noAds: result.noAds, libIds: result.adCount, resultsCount: result.resultsCount, screenshotsCaptured: (result.screenshotFilenames || []).length, advertisersSeen: (result.advertisers || []).length }
    });

  } catch (err) {
    res.status(500).json({ error: 'Scrape failed', details: err.message });
  }
});

// Proxy MillionVerifier email verification. n8n Cloud's egress IPs
// are flagged by MV as "Free account abuse" — proxying through Railway
// works around the IP reputation block.
app.post('/api/verify-email', async (req, res) => {
  try {
    const { api_key, email } = req.body;
    if (!api_key) return res.status(400).json({ error: 'api_key required' });
    if (!email)   return res.status(400).json({ error: 'email required' });

    const url = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(api_key)}&email=${encodeURIComponent(email)}&timeout=10`;

    const mvResp = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept':     'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });

    const text = await mvResp.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (e) {
      return res.status(502).json({ error: 'Non-JSON response from MV', status: mvResp.status, body: text.substring(0, 300) });
    }

    res.json(body);

  } catch (err) {
    res.status(500).json({ error: 'Proxy failed', details: err.message });
  }
});

// Serve rendered files (png + webm + pdf)
app.use('/api/renders', express.static(RENDERS_DIR));

// Docs page
app.get('/', (req, res) => {
  res.json({
    name: 'Page Renderer API',
    endpoints: {
      'GET /api/healthz': 'Health check',
      'POST /api/render': 'Render HTML to PNG',
      'POST /api/render-video': 'Render HTML animation to WebM video',
      'POST /api/render-pdf': 'Render HTML to PDF (A4 default)',
      'POST /api/scrape-meta-ads': 'Scrape Meta Ad Library via Playwright (body: company_name, country=AU)',
      'POST /api/verify-email': 'Proxy MillionVerifier v3 (body: api_key, email) — works around IP reputation blocks',
      'GET /api/renders/:id': 'Serve rendered files'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Page renderer listening on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
