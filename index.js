const express = require('express');
const { chromium } = require('playwright');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const RENDERS_DIR = path.join(__dirname, 'renders');
if (!fs.existsSync(RENDERS_DIR)) fs.mkdirSync(RENDERS_DIR);

// Concurrency queue — max 3 simultaneous renders
let activeRenders = 0;
const MAX_CONCURRENT = 3;
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
    const { company_name, country } = req.body;
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
        }, { timeout: 12000 });
      } catch (e) {
        // Fallback — no signal detected, give React a little more time
        await page.waitForTimeout(4000);
      }

      // Small extra settle for any lazy-rendered ads
      await page.waitForTimeout(1500);

      const content = await page.content();
      await page.close();

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

      return {
        noAds,
        adCount: uniqueIds.length,
        resultsCount,
        htmlLength: content.length
      };
    });

    const isRunningAds = !result.noAds && (result.adCount > 0 || result.resultsCount > 0);

    res.json({
      isRunningAds,
      adCount: Math.max(result.adCount, result.resultsCount),
      adLibraryUrl: url,
      debug: { htmlLength: result.htmlLength, noAds: result.noAds, libIds: result.adCount, resultsCount: result.resultsCount }
    });

  } catch (err) {
    res.status(500).json({ error: 'Scrape failed', details: err.message });
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
