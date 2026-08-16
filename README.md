# One Among Us payment backend

Small Node.js service behind `donate.oau.app`. It validates donation requests
and creates one-time, card-only Stripe Checkout Sessions. Card details never
pass through this service. Webhook support is optional.

## Configure

1. Copy `.env.example` to `.env` and replace every secret.
2. Create a Cloudflare Turnstile widget for `www.oneamongus.ca` and
   `oneamongus.ca` with action `donate`.
3. Optional: in Stripe Workbench, add an event destination pointing to
   `https://donate.oau.app/webhooks/stripe`. Subscribe to
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   and `checkout.session.async_payment_failed`, then put its signing secret in
   `STRIPE_WEBHOOK_SECRET`. Without this variable, the webhook endpoint remains
   disabled and the return page checks the Checkout Session directly.
4. Keep Stripe in test mode until the complete flow and webhook signature
   validation have been tested.
5. Build the VitePress frontend with its public Turnstile site key set as
   `VITE_TURNSTILE_SITE_KEY`. This differs from the secret key stored here.

`DONATION_MIN_CAD` and `DONATION_MAX_CAD` define the accepted range in Canadian
dollars. The browser submits a decimal CAD amount; the server parses it into
integer cents and rejects malformed values or amounts outside this range.

## Run

```sh
docker compose up -d --build
curl --fail http://127.0.0.1:3000/healthz
```

Place an HTTPS reverse proxy in front of `127.0.0.1:3000`. Preserve the original
`Origin` header and set `X-Forwarded-For`; only set `TRUST_PROXY=true` when the
service is unreachable except through that trusted proxy.

Example nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
}
```

For more than one backend process, replace the in-memory IP limiter with a
shared limiter such as Redis or enforce the same limits at the reverse proxy.

## Endpoints

- `POST /session`: validates a form submission and redirects with HTTP 303 to a
  new Stripe Checkout Session.
- `GET /session-status?id=cs_...`: returns only payment status, amount, and
  currency for a donation Session. It never returns donor details.
- `POST /webhooks/stripe`: optional; enabled only when
  `STRIPE_WEBHOOK_SECRET` is configured.
- `GET /healthz`: health check.

Never commit `.env`, expose `STRIPE_SECRET_KEY`, or accept arbitrary prices from
the browser.

## Nix flake

The repository exports:

- `packages.<system>.default`: the immutable backend source package.
- `nixosModules.default`: a hardened systemd service intended to sit behind a
  reverse proxy.

Example NixOS configuration:

```nix
{
  inputs.payment-backend.url = "github:one-among-us/payment-backend";
  inputs.payment-backend.inputs.nixpkgs.follows = "nixpkgs";

  # Add payment-backend.nixosModules.default to the host's modules, then:
  services.oau-payment-backend = {
    enable = true;
    environmentFile = "/var/lib/secrets/payment-backend.env";
  };
}
```
