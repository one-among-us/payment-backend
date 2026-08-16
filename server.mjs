import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const requiredEnv = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'TURNSTILE_SECRET_KEY',
];

for (const name of requiredEnv) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY,
  turnstileHostnames: new Set(
    (process.env.TURNSTILE_HOSTNAMES || 'www.oneamongus.ca,oneamongus.ca')
      .split(',')
      .map((hostname) => hostname.trim())
      .filter(Boolean),
  ),
  allowedOrigins: new Set(
    (process.env.ALLOWED_ORIGINS || 'https://www.oneamongus.ca,https://oneamongus.ca')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
  allowedAmounts: new Set(
    (process.env.DONATION_AMOUNTS_CAD || '10,25,50,100,250')
      .split(',')
      .map((amount) => Math.round(Number(amount) * 100))
      .filter((amount) => Number.isSafeInteger(amount) && amount > 0),
  ),
  successUrls: {
    en: process.env.SUCCESS_URL || 'https://www.oneamongus.ca/donate/success',
    'zh-Hans': process.env.ZH_HANS_SUCCESS_URL || 'https://www.oneamongus.ca/zh-Hans/donate/success',
  },
  cancelUrls: {
    en: process.env.CANCEL_URL || 'https://www.oneamongus.ca/contact',
    'zh-Hans': process.env.ZH_HANS_CANCEL_URL || 'https://www.oneamongus.ca/zh-Hans/contact',
  },
  trustProxy: process.env.TRUST_PROXY === 'true',
};

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

const rateLimits = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 10;
const MAX_BODY_BYTES = 16 * 1024;

const send = (response, status, body, headers = {}) => {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(body);
};

const clientIp = (request) => {
  if (config.trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  }
  return request.socket.remoteAddress || 'unknown';
};

const consumeRateLimit = (ip) => {
  const now = Date.now();
  const current = rateLimits.get(ip);
  if (!current || current.resetAt <= now) {
    rateLimits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (current.count >= RATE_MAX) return false;
  current.count += 1;
  return true;
};

setInterval(() => {
  const now = Date.now();
  for (const [ip, limit] of rateLimits) {
    if (limit.resetAt <= now) rateLimits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

const readBody = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const parseForm = (request, body) => {
  const contentType = request.headers['content-type'] || '';
  if (contentType.startsWith('application/json')) {
    return JSON.parse(body.toString('utf8'));
  }
  if (contentType.startsWith('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(body.toString('utf8')));
  }
  throw new Error('UNSUPPORTED_CONTENT_TYPE');
};

const verifyTurnstile = async (token, ip) => {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;

  const verification = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: config.turnstileSecretKey,
      response: token,
      remoteip: ip,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!verification.ok) return false;
  const result = await verification.json();
  return result.success === true &&
    config.turnstileHostnames.has(result.hostname) &&
    (!result.action || result.action === 'donate');
};

const createCheckoutSession = async ({ amount, email, locale }) => {
  const params = new URLSearchParams({
    mode: 'payment',
    success_url: `${config.successUrls[locale]}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: config.cancelUrls[locale],
    billing_address_collection: 'required',
    'line_items[0][price_data][currency]': 'cad',
    'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][price_data][product_data][name]': 'Donation to One Among Us',
    'line_items[0][quantity]': '1',
    'metadata[purpose]': 'donation',
    'payment_intent_data[metadata][purpose]': 'donation',
  });

  if (email) params.set('customer_email', email);

  const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': randomUUID(),
    },
    body: params,
    signal: AbortSignal.timeout(15_000),
  });

  const result = await stripeResponse.json();
  if (!stripeResponse.ok || typeof result.url !== 'string') {
    console.error('Stripe session creation failed', result?.error?.type, result?.error?.code);
    throw new Error('STRIPE_ERROR');
  }
  return result.url;
};

const secureEqual = (left, right) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const verifyStripeSignature = (body, signatureHeader) => {
  if (typeof signatureHeader !== 'string') return false;
  const parts = signatureHeader.split(',').map((part) => part.split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || signatures.length === 0) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
    return false;
  }

  const expected = createHmac('sha256', config.stripeWebhookSecret)
    .update(`${timestamp}.${body.toString('utf8')}`)
    .digest('hex');
  return signatures.some((signature) => secureEqual(expected, signature));
};

const handleSession = async (request, response) => {
  const origin = request.headers.origin;
  if (!origin || !config.allowedOrigins.has(origin)) {
    return send(response, 403, 'Request origin is not allowed.');
  }

  const ip = clientIp(request);
  if (!consumeRateLimit(ip)) return send(response, 429, 'Too many donation attempts. Please try later.');

  const body = parseForm(request, await readBody(request));
  const amount = Number(body.amount);
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const locale = body.locale === 'zh-Hans' ? 'zh-Hans' : 'en';
  const token = body['cf-turnstile-response'] || body.turnstileToken;

  if (!config.allowedAmounts.has(amount)) return send(response, 400, 'Invalid donation amount.');
  if (email && (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254)) {
    return send(response, 400, 'Invalid email address.');
  }
  if (!(await verifyTurnstile(token, ip))) return send(response, 400, 'Human verification failed.');

  const checkoutUrl = await createCheckoutSession({ amount, email, locale });
  response.writeHead(303, {
    Location: checkoutUrl,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  response.end();
};

const handleWebhook = async (request, response) => {
  const body = await readBody(request);
  if (!verifyStripeSignature(body, request.headers['stripe-signature'])) {
    return send(response, 400, 'Invalid webhook signature.');
  }

  const event = JSON.parse(body.toString('utf8'));
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data?.object;
    console.info(JSON.stringify({
      event: event.type,
      eventId: event.id,
      sessionId: session?.id,
      amountTotal: session?.amount_total,
      currency: session?.currency,
      paymentStatus: session?.payment_status,
    }));
  }

  send(response, 200, 'ok');
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/healthz') return send(response, 200, 'ok');
    if (request.method === 'POST' && url.pathname === '/session') return await handleSession(request, response);
    if (request.method === 'POST' && url.pathname === '/webhooks/stripe') return await handleWebhook(request, response);
    send(response, 404, 'Not found.');
  } catch (error) {
    if (error?.message === 'REQUEST_TOO_LARGE') return send(response, 413, 'Request is too large.');
    if (error?.message === 'UNSUPPORTED_CONTENT_TYPE') return send(response, 415, 'Unsupported content type.');
    console.error(error);
    send(response, 500, 'Unable to start the donation. Please try again later.');
  }
});

server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
server.listen(config.port, config.host, () => {
  console.info(`Donation backend listening on ${config.host}:${config.port}`);
});
