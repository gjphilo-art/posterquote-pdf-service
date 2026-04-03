# PosterQuote External PDF Service

This service accepts SVG payloads from the PosterQuote WooCommerce plugin, converts them to PDF, and supports:

- fast path: return a `pdf_url` immediately when conversion finishes quickly
- fallback path: return `pending`, continue in the background, and call WordPress back when ready

## What it expects from WordPress

The patched plugin sends a JSON payload like:

```json
{
  "order_id": 25719,
  "item_id": 123,
  "product_id": 456,
  "product_name": "All of Me Loves All of You",
  "filename": "all-of-me-loves-all-of-you-25719-123.pdf",
  "svg": "<svg ...>...</svg>",
  "svg_url": "https://posterquote.co.uk/wp-content/uploads/.../file.svg",
  "callback_url": "https://posterquote.co.uk/wp-json/posterquote/v1/pdf-ready",
  "callback_token": "secret-token",
  "source_site": "https://posterquote.co.uk/"
}
```

## API

### `POST /convert`

Header:

```text
Authorization: Bearer YOUR_CONVERT_TOKEN
Content-Type: application/json
```

Response when the PDF is ready quickly:

```json
{
  "status": "ready",
  "job_id": "...",
  "pdf_url": "https://pdf.posterquote.co.uk/files/order-25719-item-123.pdf"
}
```

Response when still processing:

```json
{
  "status": "pending",
  "job_id": "...",
  "message": "PDF is being prepared"
}
```

### `GET /health`

Simple health check.

### `GET /jobs/:jobId`

Inspect one job state.

## Deployment notes

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Set environment variables

Copy `.env.example` to `.env` or set them in your host.

Required:

- `BASE_URL` – public base URL for this service
- `CONVERT_TOKEN` – must match `PQFSC_EXTERNAL_CONVERT_TOKEN`

### 3. Start it

```bash
npm start
```

### 4. Point WordPress at it

Add to `wp-config.php`:

```php
define('PQFSC_EXTERNAL_CONVERT_URL', 'https://pdf.posterquote.co.uk/convert');
define('PQFSC_EXTERNAL_CONVERT_TOKEN', 'replace-with-the-same-token');
define('PQFSC_CALLBACK_TOKEN', 'replace-with-a-different-long-random-token');
```

The plugin sends `callback_url` and `callback_token` automatically. This service uses those values when calling WordPress back.

## File storage

By default PDFs are written to `./storage/public` and served at `/files/...`.
That is fine for a first version.

## Important

This service trusts the callback URL provided by your own WordPress site. Do not expose the conversion token publicly.
