# 🚀 Gumball Machine NFT — Deployment Checklist

---

## BEFORE YOU START

### Local Machine
- [ ] All code pushed to GitHub (`git push origin main`)
- [ ] Oracle wallet keypair file backed up securely (NOT in GitHub)
- [ ] Know your oracle wallet public key: `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy`

---

## STEP 1 — Get a Server

- [ ] Sign up at [hetzner.com](https://hetzner.com)
- [ ] Create server: **CX22** → **Ubuntu 24.04** → add your SSH public key
- [ ] Note the server IP address
- [ ] SSH in to confirm access: `ssh root@YOUR_SERVER_IP`

---

## STEP 2 — Get a Domain

- [ ] Buy domain from Namecheap or Cloudflare (~$10/year)
- [ ] Go to DNS settings → add **A record**: `@ → YOUR_SERVER_IP`
- [ ] Add **A record**: `www → YOUR_SERVER_IP`
- [ ] Wait 5–10 min for DNS to propagate
- [ ] Confirm: `ping yourdomain.com` should return your server IP

---

## STEP 3 — Configure the Setup Script

Edit `setup.sh` before running — change the top 3 lines:

```bash
DOMAIN="yourdomain.com"           # ← your actual domain
GITHUB_REPO="https://github.com/Lokoweb3/gumball_nft"
ORACLE_WALLET_PATH="/home/gumball/oracle-wallet.json"
```

---

## STEP 4 — Copy Files to Server

```bash
# Copy setup script to server
scp setup.sh root@YOUR_SERVER_IP:~/

# Copy oracle wallet (NEVER commit this to GitHub)
scp ~/.config/solana/id.json root@YOUR_SERVER_IP:/tmp/oracle-wallet.json
```

---

## STEP 5 — Run Setup Script

```bash
ssh root@YOUR_SERVER_IP
bash setup.sh
```

This installs: Node.js, Nginx, PM2, Certbot (SSL), UFW firewall, clones repo.

---

## STEP 6 — Move Oracle Wallet Securely

```bash
# On the server
mkdir -p /home/gumball
mv /tmp/oracle-wallet.json /home/gumball/oracle-wallet.json
chmod 600 /home/gumball/oracle-wallet.json
chown gumball:gumball /home/gumball/oracle-wallet.json

# Confirm it's readable
cat /home/gumball/oracle-wallet.json | head -c 20
```

---

## STEP 7 — Create .env File (Optional but Recommended)

Instead of hardcoding paths in `ecosystem.config.cjs`, create a `.env` file:

```bash
cat > /var/www/gumball/.env << 'EOF'
ORACLE_WALLET=/home/gumball/oracle-wallet.json
SECRETS_FILE=/var/www/gumball/oracle-secrets.json
EOF

chmod 600 /var/www/gumball/.env
```

Make sure `.env` is in `.gitignore`:
```bash
echo ".env" >> /var/www/gumball/.gitignore
```

---

## STEP 8 — Start the Oracle

```bash
cd /var/www/gumball
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # run the command it outputs to auto-start on reboot
```

Verify it's working:
```bash
pm2 status
pm2 logs gumball-oracle --lines 30
```

You should see:
```
✅ Commitment submitted!
   PDA: ...
Watching for mint requests...
```

---

## STEP 9 — Verify Everything

- [ ] Visit `https://yourdomain.com` — site loads
- [ ] SSL padlock shows in browser
- [ ] Connect wallet — works
- [ ] Mint 1 gumball — oracle fulfills it
- [ ] Check `pm2 status` — oracle shows `online`
- [ ] Check `pm2 logs gumball-oracle` — no errors

---

## STEP 10 — Security Hardening

```bash
# Disable root SSH login (after adding a non-root user)
sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload sshd

# Confirm firewall is active
ufw status

# Set up automatic security updates
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

---

## FILES CHECKLIST

| File | GitHub | Server | Notes |
|---|---|---|---|
| `index.html` | ✅ | ✅ auto via git | Served by Nginx |
| `leaderboard.html` | ✅ | ✅ auto via git | Served by Nginx |
| `scripts/oracle.cjs` | ✅ | ✅ auto via git | Run by PM2 |
| `ecosystem.config.cjs` | ✅ | ✅ auto via git | PM2 config |
| `README.md` | ✅ | ✅ auto via git | |
| `NOTES.md` | ✅ | ✅ auto via git | |
| `oracle-wallet.json` | ❌ NEVER | ✅ copy manually | Private key! |
| `oracle-secrets.json` | ❌ NEVER | ✅ generated at runtime | Auto-created |
| `.env` | ❌ NEVER | ✅ create manually | Env vars |
| `localhost.pem` | ❌ NEVER | ❌ not needed | Local dev only |
| `localhost-key.pem` | ❌ NEVER | ❌ not needed | Local dev only |
| `target/` | ❌ NEVER | ❌ not needed | Build artifacts |
| `node_modules/` | ❌ NEVER | ✅ via npm install | |

---

## .gitignore — Confirm These Are Excluded

```
oracle-secrets.json
oracle-wallet.json
*.pem
.env
logs/
node_modules/
target/
.anchor/
```

---

## UPDATING THE SITE LATER

```bash
ssh root@YOUR_SERVER_IP
cd /var/www/gumball
git pull origin main
pm2 restart gumball-oracle
```

---

## MONITORING

```bash
pm2 status                          # oracle health
pm2 logs gumball-oracle --lines 50  # recent logs
pm2 monit                           # live dashboard
tail -f logs/oracle-error.log       # error log
nginx -t && systemctl reload nginx  # reload nginx config
certbot renew --dry-run             # test SSL renewal
```

---

## EMERGENCY

```bash
# Oracle stuck / not minting
pm2 restart gumball-oracle

# Oracle keeps crashing
pm2 logs gumball-oracle --lines 100

# Site down
systemctl status nginx
systemctl restart nginx

# SSL expired
certbot renew
```
