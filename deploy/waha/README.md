# Deploying WAHA for thrift-unique

This stands up the WAHA server the Cloudflare Worker talks to — see
`worker/lib/waha.js`, `worker/routes/waha.js` and the "WAHA" section of
`.env.example` at the repo root for how the app uses it. Nothing here runs
on Cloudflare; this is a small separate box because WAHA needs a persistent
process and disk, which Workers don't give you.

These are the commands to run on the server. Wherever a value needs to
match something on the Worker, it's called out.

## 1. Provision the VPS

Any provider works (Hetzner, DigitalOcean, etc.). Sizing, per the space
estimate above: **1 vCPU / 2GB RAM / 20GB disk** covers the platform session
plus hundreds of tenant sessions on the NOWEB engine this compose file uses.

Point a DNS A record at the box before starting anything — Caddy requests a
real TLS certificate for that hostname on first start and needs it resolvable
to succeed (e.g. `waha.yourdomain.com` → the VPS's IP).

Open only 22 (SSH), 80 and 443 in the firewall. WAHA's own port 3000 is never
published to the host in this compose file (`expose`, not `ports`) — only
Caddy reaches it, over the internal Docker network.

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
```

(Or follow your distro's Docker Engine + Compose plugin install docs —
anything with `docker compose` as a subcommand works.)

Check the architecture while you're at it:

```bash
uname -m
```

`x86_64` → skip to step 3. `aarch64` (arm64) → read the next section first;
`docker pull devlikeapro/waha` fails outright on it (`no matching manifest`).

### ARM64 hosts

The published `devlikeapro/waha` image is amd64-only. Its Dockerfile builds
cleanly on arm64 too, though — the browser it installs is Debian's own
`chromium` package (arch-agnostic via apt), not Google Chrome's amd64-only
`.deb`, and its Go component already branches on target architecture — so
build it locally instead of pulling:

```bash
git clone --branch core --depth 1 https://github.com/devlikeapro/waha.git ~/waha-src
cd ~/waha-src
sudo docker build -t waha-local:latest .
```

This takes a few minutes and needs the VPS's normal internet access (pulling
base images, an npm/yarn install, apt packages) — nothing to do with
Cloudflare or this repo. Once it finishes, set in `.env` (step 4 below):

```
WAHA_IMAGE=waha-local:latest
```

`docker-compose.yml` reads `WAHA_IMAGE` with `devlikeapro/waha` as the
default, so this is the only change an arm64 host needs — everything else in
this README is identical. Re-run the `docker build` after a `git pull` in
`~/waha-src` when you want to pick up a WAHA update; the image won't update
itself the way a Docker Hub pull would.

## 3. Copy this folder to the server

Easiest from the VPS itself, since it just needs GitHub over HTTPS:

```bash
git clone https://github.com/prodeegeek9-creator/thrift-unique.git
cd thrift-unique/deploy/waha
```

(Or `scp -r deploy/waha your-user@your-vps-ip:~/waha` from your own machine
if you'd rather not put the whole repo on the box.)

## 4. Configure

```bash
cp .env.example .env
openssl rand -hex 32   # paste the output in as WAHA_API_KEY below
```

Edit `.env`:

```
WAHA_DOMAIN=waha.yourdomain.com
WAHA_API_KEY=<the value openssl just printed>
```

Keep that `WAHA_API_KEY` — it's the exact value you'll set as `WAHA_API_KEY`
on the Cloudflare Worker in step 7.

## 5. Start it

```bash
docker compose up -d
docker compose logs -f caddy   # watch for the certificate to be issued
```

Once Caddy has its certificate, confirm WAHA answers:

```bash
curl -s https://waha.yourdomain.com/api/sessions -H "X-Api-Key: $WAHA_API_KEY"
```

An empty array (`[]`) means it's up with no sessions yet — expected on a
fresh install.

### Hosts that already run nginx on 80/443

Check first with `sudo ss -tlnp | grep -E ':80 |:443 '`. If nginx (or anything
else) already owns those ports, don't start Caddy — run only WAHA, bound to
localhost, and add it to the existing nginx like any other site:

```bash
cat > docker-compose.override.yml <<'EOF'
services:
  waha:
    image: waha-local:latest        # or devlikeapro/waha on x86_64
    ports:
      - "127.0.0.1:3000:3000"
EOF
sudo docker compose up -d waha      # naming the service keeps Caddy off

sudo tee /etc/nginx/sites-available/waha > /dev/null <<'EOF'
server {
    listen 80;
    server_name waha.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
sudo ln -s /etc/nginx/sites-available/waha /etc/nginx/sites-enabled/waha
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d waha.yourdomain.com
```

If the domain is proxied through Cloudflare (orange cloud), set its SSL/TLS
mode to **Full (strict)**. "Flexible" loops forever against certbot's
HTTP→HTTPS redirect.

## 6. Create the platform session

This is the one number every seller messages to list an item — the app
creates a session per *tenant* on its own when a seller links their WhatsApp
(`worker/routes/waha.js` → `linkSession`), but the platform session has no
tenant behind it, so it's created once, by hand, here.

Pick a webhook secret (different from the API key — this is what the
`X-Thrift-Secret` header on every webhook delivery is checked against), and
add it plus the app's origin to `.env`:

```bash
echo "WAHA_WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env
echo "PUBLIC_ORIGIN=https://thrift-unique.<subdomain>.workers.dev" >> .env
```

`WAHA_WEBHOOK_SECRET` is also set on the Worker in step 8, with the same
value.

## 7. Link the platform's WhatsApp number

```bash
./pair.sh
```

It creates the `ut-platform` session (with its webhook pointed at
`$PUBLIC_ORIGIN/api/waha/webhook`) if it doesn't exist yet, starts it, and
draws the QR **in the terminal**. On the phone whose number sellers will
message (a dedicated number/SIM, not a personal one), open WhatsApp →
Settings → Linked devices → Link a device and scan it.

WAHA only keeps a pairing window open for about a minute before marking the
session `FAILED`. That's why the QR is drawn in place rather than saved as a
PNG to open elsewhere. If the window closes, run `./pair.sh` again. Run it
again any time the platform number gets logged out, too.

The session is created with the **NOWEB store and full sync on**. That's
required, not a tuning choice. WhatsApp increasingly delivers a sender as a
privacy id (`…@lid`) instead of a phone number, and WAHA can only map that
back to a number (which is how the Worker finds the store) when the session
was *linked* with the store on. If `pair.sh` finds an existing session
without it, it turns the store on and asks for one more scan.

`ut-platform` is the default the Worker expects (`WAHA_SESSION` in
`worker/lib/env.js`). Only set `WAHA_SESSION` (in `.env` and on the Worker)
if you deliberately use a different name.

## 8. Hand these back to set as Worker secrets

- `WAHA_URL` = `https://waha.yourdomain.com`
- `WAHA_API_KEY` = the value from step 4
- `WAHA_WEBHOOK_SECRET` = the value from step 6
- `WAHA_SESSION` = only if you didn't use `ut-platform`
- `PUBLIC_ORIGIN` = the value you used in step 6, if not already set in
  `wrangler.jsonc`

Set them with `wrangler secret put` against the `thrift-unique` Worker.

**Check `SUPABASE_URL` while you're there.** The Worker reads the
`SUPABASE_URL` secret before `VITE_SUPABASE_URL`. A secret left over from the
old single-store site pointed at a deleted project and silently overrode the
right one. It showed up as `PostgREST 530` in `wrangler tail` and a 500 on
every webhook. `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` must both belong to
the project in `.env.production`.

## Operating notes

- **Back up the `waha_sessions` volume.** It's the login state for the
  platform number and every linked tenant. Lose it and every seller has to
  re-scan a QR code — not data loss, but real disruption. A nightly
  `docker run --rm -v waha_waha_sessions:/data -v $PWD:/backup alpine tar czf /backup/waha-sessions-$(date +%F).tar.gz -C /data .` on a cron is enough.
- **Updating:** `docker compose pull && docker compose up -d`. Sessions live
  in the named volume, not the container, so an image update doesn't log
  anyone out.
- **Swagger/dashboard are off** in this compose file (`WHATSAPP_SWAGGER_ENABLED`,
  `WAHA_DASHBOARD_ENABLED`) since only the Worker needs to reach this box. Set
  them to `true` plus `WAHA_DASHBOARD_USERNAME`/`WAHA_DASHBOARD_PASSWORD` in
  `.env` if you want to browse sessions from your own machine.
