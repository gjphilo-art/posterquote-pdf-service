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
const LOG_REQUEST_BODIES = /^(1|true|yes)$/i.test(process.env.LOG_REQUEST_BODIES || 'false');

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

function short(value, max = 120) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function log(...parts) {
  console.log(nowIso(), ...parts);
}

app.use((req, res, next) => {
  const started = Date.now();
  log('[REQ]', req.method, req.originalUrl, 'ip=', req.ip);
  if (LOG_REQUEST_BODIES && req.body && Object.keys(req.body).length) {
    const body = { ...req.body };
    if (typeof body.svg === 'string') body.svg = `[svg length ${body.svg.length}]`;
    if (typeof body.callback_token === 'string') body.callback_token = '[redacted]';
    log('[REQ BODY]', JSON.stringify(body));
  }
  res.on('finish', () => {
    log('[RES]', req.method, req.originalUrl, 'status=', res.statusCode, 'ms=', Date.now() - started);
  });
  next();
});

function requireAuth(req, res, next) {
  if (!CONVERT_TOKEN) {
    log('[AUTH]', 'failed: server token missing');
    return res.status(500).json({ status: 'failed', message: 'Server token is not configured' });
  }
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${CONVERT_TOKEN}`;
  if (auth !== expected) {
    log('[AUTH]', 'failed: bearer token mismatch', 'header_present=', Boolean(auth));
    return res.status(401).json({ status: 'failed', message: 'Unauthorized' });
  }
  log('[AUTH]', 'passed');
  next();
}

async function getBrowser() {
  if (!browserPromise) {
    log('[BROWSER]', 'launching chromium');
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

    log('[PDF]', 'svg size', `${svgSize.width}x${svgSize.height}`);

    const pdf = await page.pdf({
      width: `${svgSize.width}px`,
      height: `${svgSize.height}px`,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      preferCSSPageSize: false,
      pageRanges: '1'
    });

    log('[PDF]', 'buffer created', `bytes=${pdf.length}`);
    return pdf;
  } finally {
    await page.close();
  }
}

async function postCallback(job, extra = {}) {
  if (!job.callback_url || !job.callback_token) {
    log('[CALLBACK]', job.job_id, 'skipped: missing callback_url or callback_token');
    return;
  }
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
    log('[CALLBACK]', job.job_id, 'POST', short(job.callback_url, 200), 'status=', job.status);
    const resp = await fetch(job.callback_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x_pqfsc_token': job.callback_token,
      },
      body: JSON.stringify(payload),
    });
    const text = await resp.text().catch(() => '');
    log('[CALLBACK]', job.job_id, 'response', resp.status, short(text, 300));
    if (!resp.ok) {
      throw new Error(`Callback HTTP ${resp.status}${text ? `: ${text}` : ''}`);
    }
  } catch (err) {
    job.callback_attempts = (job.callback_attempts || 0) + 1;
    job.message = `Callback failed: ${err.message}`;
    saveJob(job);
    log('[CALLBACK]', job.job_id, 'failed', err.message);
  }
}

async function processJob(job) {
  job.status = 'processing';
  job.started_at = job.started_at || nowIso();
  saveJob(job);
  log('[JOB]', job.job_id, 'started', `order=${job.order_id}`, `item=${job.item_id}`, short(job.product_name, 120));

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
    log('[JOB]', job.job_id, 'ready', short(job.pdf_url, 200));

    await postCallback(job);
    return job;
  } catch (err) {
    job.status = 'failed';
    job.completed_at = nowIso();
    job.message = err && err.message ? err.message : 'Conversion failed';
    saveJob(job);
    log('[JOB]', job.job_id, 'failed', job.message);
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
    log('[CONVERT]', 'invalid payload', errors.join('; '));
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

  log('[CONVERT]', 'job queued', job.job_id, `order=${job.order_id}`, `item=${job.item_id}`, `svg_len=${job.svg.length}`);
  saveJob(job);

  const processPromise = processJob(job);

  try {
    const readyJob = await Promise.race([
      processPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), FAST_RESPONSE_TIMEOUT_MS)),
    ]);

    if (readyJob && readyJob.status === 'ready' && readyJob.pdf_url) {
      log('[CONVERT]', 'returning ready immediately', readyJob.job_id);
      return res.status(200).json({
        status: 'ready',
        job_id: readyJob.job_id,
        pdf_url: readyJob.pdf_url,
      });
    }

    log('[CONVERT]', 'returning pending', job.job_id);
    return res.status(202).json({
      status: 'pending',
      job_id: job.job_id,
      message: 'PDF is being prepared',
    });
  } catch (err) {
    log('[CONVERT]', 'returning failure', job.job_id, err && err.message ? err.message : 'Conversion failed');
    return res.status(500).json({
      status: 'failed',
      job_id: job.job_id,
      message: err && err.message ? err.message : 'Conversion failed',
    });
  }
});

const server = app.listen(PORT, HOST, () => {
  log(`PosterQuote PDF service listening on ${HOST}:${PORT}`);
  log(`Public base URL: ${BASE_URL}`);
});

async function shutdown(signal) {
  log(`Received ${signal}, shutting down...`);
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
