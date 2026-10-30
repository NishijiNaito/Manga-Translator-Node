# Running on a VPS (behind nginx)

One user, one shared secret. The Node app listens on loopback only; nginx terminates HTTPS in front of it.

## 1. App

```bash
git clone <your repo> /opt/manga && cd /opt/manga
npm ci --omit=dev
cp .env.example .env && chmod 600 .env
```

`.env` (server side; the AI key stays on the server instead of in your browser):

```
APP_SECRET=<openssl rand -base64 24>     # turns on login + all protections below
TRUST_PROXY=1                            # exactly one proxy (nginx) in front
HOST=127.0.0.1
PORT=3000
GEMINI_API_KEY=...                       # or OPENROUTER_API_KEY
```

Without `APP_SECRET` the app refuses to listen on anything but loopback. With a secret shorter than 16 characters it refuses to start.

systemd (`/etc/systemd/system/manga.service`), as an unprivileged user:

```
[Unit]
Description=Manga Translator
After=network.target

[Service]
User=manga
WorkingDirectory=/opt/manga
ExecStart=/usr/bin/node server.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/manga/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

## 2. nginx

```nginx
limit_req_zone $binary_remote_addr zone=mt_login:10m rate=10r/m;

server {
    listen 443 ssl http2;
    server_name manga.example.com;
    # ssl_certificate / ssl_certificate_key: certbot or your own

    client_max_body_size 40m;          # uploaded originals / rendered pages
    proxy_read_timeout 300s;           # translating a long image can take a while
    proxy_send_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        # overwrite (not append) so a client cannot choose the address the login throttle sees
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /api/login {
        limit_req zone=mt_login burst=5 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server { listen 80; server_name manga.example.com; return 301 https://$host$request_uri; }
```

`Host` and `X-Forwarded-Proto` matter: the app uses them for the `Secure` cookie, HSTS, the same-origin (CSRF) check and the signed image links.

Firewall: allow only SSH, 80 and 443 (the Node port is loopback only anyway).

## 3. Images in Cloudflare R2 (optional)

Keeps the VPS disk small and makes the images survive losing the VPS. Create a **private** bucket and an API token with *Object Read & Write* limited to that bucket (R2 → Manage API tokens), then in `.env`:

```
STORAGE=r2
R2_ACCOUNT_ID=<your account id>
R2_BUCKET=<bucket name>
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
```

- Only the images (`orig/`, `result/`) go to R2. `project.json` (text, boxes, cost) and `page.html` stay in `data/` on the VPS: **back that folder up**, it is small. Without it the images in the bucket have no names or order.
- The bucket stays private. The app reads the files itself and serves them behind the login / signed links, so nothing about R2 is public. Do not turn on the public bucket URL: these are other people's pages.
- Projects you already have: `node scripts/migrate-to-r2.js --dry-run`, then without `--dry-run`; add `--prune` to delete each local image once it was read back from the bucket identically.
- Every image view is now a round trip VPS ↔ R2 (in the same region it is fast; from another continent the editor will feel slower).

## 4. Browser extension

Server = `https://manga.example.com`, password = the `APP_SECRET`. The extension sends it as `Authorization: Bearer …`; translated images it swaps into other sites use signed links that expire after 24 h (re-press "swap" later).

## What is protected (and what is not)

| Risk | Protection |
|---|---|
| Anyone using your API key / deleting projects | Login (cookie, `HttpOnly`, `SameSite=Strict`, `Secure`) or Bearer secret on every route except `/login`; 5 wrong secrets per IP → 15 min lockout; AI calls capped at 90/min |
| Server used to reach internal services (SSRF) | Only ports 80/443; loopback/private/link-local/cloud-metadata targets refused, checked on the actual connection (DNS rebinding) and on every redirect; 30 MB limit also after decompression |
| Other sites' HTML on your origin (`/view`) | Scripts/iframes/forms/handlers removed **and** a `sandbox` CSP (no scripts, no cookies) |
| Cross-site requests | `SameSite=Strict` + Origin check on every state-changing request |
| Images for other sites / `/view` | Signed `/files` links (6 h in `/view`, 24 h for the extension) instead of cookies |
| Disk filling up | 300 projects, 400 images per project (env: `MAX_PROJECTS`, `MAX_IMAGES_PER_PROJECT`); images can live in R2 |

Not covered: more than one user (it is one shared secret); the signed links work for anyone who has them until they expire; the rate limiters live in memory and reset on restart; keep dependencies updated (`npm audit`, especially `sharp`). Back up `data/` yourself.
