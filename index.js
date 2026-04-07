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

// Docs page
app.get('/', (req, res) => {
  res.json({
    name: 'Page Renderer API',
    endpoints: {
      'GET /api/healthz': 'Health check',
      'POST /api/render': 'Render HTML to PNG',
      'GET /api/renders/:id.png': 'Serve rendered images'
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
