const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CONVERT_TOKEN = (process.env.CONVERT_TOKEN || '').trim();
const FAST_RESPONSE_TIMEOUT_MS = parseInt(process.env.FAST_RESPONSE_TIMEOUT_MS || '7000', 10);
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || './storage/public');
const JOBS_DIR = path.resolve(process.env.JOBS_DIR || './storage/jobs');

for (const dir of [PUBLIC_DIR, JOBS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/files', express.static(PUBLIC_DIR, { maxAge: '7d' }));

const jobs = new Map();
let browserPromise = null;

function nowIso() {
  return new Date().toISOString();
}

function makeJobId() {
  return crypto.randomBytes(16).toString('hex');
}

function sanitizeFilename(name) {
  const raw = (name || 'posterquote-print.pdf').toString();
  const cleaned = raw
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned || 'posterquote-print'}.pdf`;
}

function buildOutputName(payload) {
  const explicit = sanitizeFilename(payload.filename || '');
  if (explicit && explicit !== '.pdf') return explicit;
  const orderId = Number(payload.order_id || 0);
  const itemId = Number(payload.item_id || 0);
  return `order-${orderId || 'x'}-item-${itemId || 'x'}.pdf`;
}

function jobFile(jobId) {
  return path.join(JOBS_DIR, `${jobId}.json`);
}

function saveJob(job) {
  jobs.set(job.job_id, job);
  fs.writeFileSync(jobFile(job.job_id), JSON.stringify(job, null, 2));
}

function loadJob(jobId) {
  if (jobs.has(jobId)) return jobs.get(jobId);
  const file = jobFile(jobId);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  jobs.set(jobId, parsed);
  return parsed;
}

function requireAuth(req, res, next) {
  if (!CONVERT_TOKEN) {
    return res.status(500).json({ status: 'failed', message: 'Server token is not configured' });
  }
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${CONVERT_TOKEN}`;
  if (auth !== expected) {
    return res.status(401).json({ status: 'failed', message: 'Unauthorized' });
  }
  next();
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

async function convertSvgToPdfBuffer(svg) {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1700 }, deviceScaleFactor: 1 });
  try {
    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: white; }
  body { display: block; }
  .wrap { width: fit-content; margin: 0; padding: 0; }
  svg { display: block; width: 100%; height: auto; }
</style>
</head>
<body>
  <div class="wrap">${svg}</div>
</body>
</html>`;

    await page.setContent(html, { waitUntil: 'load' });

    const svgSize = await page.evaluate(() => {
      const svg = document.querySelector('svg');
      if (!svg) return null;
      const vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : null;
      const widthAttr = parseFloat(svg.getAttribute('width') || '0');
      const heightAttr = parseFloat(svg.getAttribute('height') || '0');
      let width = 0;
      let height = 0;
      if (vb && vb.width && vb.height) {
        width = vb.width;
        height = vb.height;
      } else if (widthAttr && heightAttr) {
        width = widthAttr;
        height = heightAttr;
      } else {
        const box = svg.getBoundingClientRect();
        width = box.width;
        height = box.height;
      }
      return { width, height };
    });

    if (!svgSize || !svgSize.width || !svgSize.height) {
      throw new Error('Could not determine SVG size');
    }

    const pdf = await page.pdf({
      width: `${svgSize.width}px`,
      height: `${svgSize.height}px`,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      preferCSSPageSize: false,
      pageRanges: '1'
    });

    return pdf;
  } finally {
    await page.close();
  }
}

async function postCallback(job, extra = {}) {
  if (!job.callback_url || !job.callback_token) return;
  const payload = {
    order_id: job.order_id,
    item_id: job.item_id,
    job_id: job.job_id,
    status: job.status,
    pdf_url: job.pdf_url || '',
    message: job.message || '',
    token: job.callback_token,
    ...extra,
  };

  try {
    const resp = await fetch(job.callback_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x_pqfsc_token': job.callback_token,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Callback HTTP ${resp.status}${text ? `: ${text}` : ''}`);
    }
  } catch (err) {
    job.callback_attempts = (job.callback_attempts || 0) + 1;
    job.message = `Callback failed: ${err.message}`;
    saveJob(job);
  }
}

async function processJob(job) {
  job.status = 'processing';
  job.started_at = job.started_at || nowIso();
  saveJob(job);

  try {
    const pdfBuffer = await convertSvgToPdfBuffer(job.svg);
    const outputName = buildOutputName(job);
    const outputPath = path.join(PUBLIC_DIR, outputName);
    fs.writeFileSync(outputPath, pdfBuffer);

    job.pdf_url = `${BASE_URL}/files/${encodeURIComponent(outputName)}`;
    job.status = 'ready';
    job.completed_at = nowIso();
    job.message = 'PDF ready';
    saveJob(job);

    await postCallback(job);
    return job;
  } catch (err) {
    job.status = 'failed';
    job.completed_at = nowIso();
    job.message = err && err.message ? err.message : 'Conversion failed';
    saveJob(job);
    await postCallback(job, { message: job.message });
    throw err;
  }
}

function validatePayload(body) {
  const errors = [];
  if (!body || typeof body !== 'object') errors.push('Invalid JSON body');
  if (!body.svg || typeof body.svg !== 'string' || !body.svg.includes('<svg')) errors.push('Missing valid svg');
  if (!body.order_id) errors.push('Missing order_id');
  if (!body.item_id) errors.push('Missing item_id');
  if (!body.callback_url || typeof body.callback_url !== 'string') errors.push('Missing callback_url');
  if (!body.callback_token || typeof body.callback_token !== 'string') errors.push('Missing callback_token');
  return errors;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'posterquote-external-pdf-service', time: nowIso() });
});

app.get('/jobs/:jobId', (req, res) => {
  const job = loadJob(req.params.jobId);
  if (!job) return res.status(404).json({ status: 'failed', message: 'Job not found' });
  const safeJob = { ...job };
  delete safeJob.svg;
  delete safeJob.callback_token;
  res.json(safeJob);
});

app.post('/convert', requireAuth, async (req, res) => {
  const errors = validatePayload(req.body);
  if (errors.length) {
    return res.status(400).json({ status: 'failed', message: errors.join('; ') });
  }

  const job = {
    job_id: makeJobId(),
    status: 'pending',
    created_at: nowIso(),
    callback_attempts: 0,
    order_id: Number(req.body.order_id || 0),
    item_id: Number(req.body.item_id || 0),
    product_id: Number(req.body.product_id || 0),
    product_name: (req.body.product_name || '').toString(),
    filename: (req.body.filename || '').toString(),
    svg: req.body.svg,
    svg_url: (req.body.svg_url || '').toString(),
    callback_url: req.body.callback_url,
    callback_token: req.body.callback_token,
    source_site: (req.body.source_site || '').toString(),
    pdf_url: '',
    message: 'Queued for conversion',
  };

  saveJob(job);

  const processPromise = processJob(job);

  try {
    const readyJob = await Promise.race([
      processPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), FAST_RESPONSE_TIMEOUT_MS)),
    ]);

    if (readyJob && readyJob.status === 'ready' && readyJob.pdf_url) {
      return res.status(200).json({
        status: 'ready',
        job_id: readyJob.job_id,
        pdf_url: readyJob.pdf_url,
      });
    }

    return res.status(202).json({
      status: 'pending',
      job_id: job.job_id,
      message: 'PDF is being prepared',
    });
  } catch (err) {
    return res.status(500).json({
      status: 'failed',
      job_id: job.job_id,
      message: err && err.message ? err.message : 'Conversion failed',
    });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`PosterQuote PDF service listening on ${HOST}:${PORT}`);
  console.log(`Public base URL: ${BASE_URL}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  server.close(async () => {
    if (browserPromise) {
      try {
        const browser = await browserPromise;
        await browser.close();
      } catch (err) {
        // ignore
      }
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
