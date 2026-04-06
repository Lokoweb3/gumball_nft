#!/bin/bash
# =============================================================================
# Gumball Machine NFT — Server Setup Script
# Ubuntu 24.04 LTS | Hetzner CX22 (or any VPS)
# Run as root: bash setup.sh
# =============================================================================

set -e

# ── CONFIG — edit these before running ───────────────────────────────────────
DOMAIN="yourdomain.com"           # e.g. gumball.xnt.io
GITHUB_REPO="https://github.com/Lokoweb3/gumball_nft"
APP_DIR="/var/www/gumball"
ORACLE_WALLET_PATH="/home/gumball/oracle-wallet.json"
NODE_VERSION="20"
# ─────────────────────────────────────────────────────────────────────────────

echo "=== 1. System update ==="
apt update && apt upgrade -y
apt install -y curl git nginx certbot python3-certbot-nginx ufw

echo "=== 2. Create app user ==="
useradd -m -s /bin/bash gumball || true
mkdir -p /home/gumball
chown gumball:gumball /home/gumball

echo "=== 3. Install Node.js $NODE_VERSION ==="
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt install -y nodejs
node --version
npm --version

echo "=== 4. Install PM2 globally ==="
npm install -g pm2

echo "=== 5. Clone repo ==="
mkdir -p $APP_DIR
git clone $GITHUB_REPO $APP_DIR
chown -R gumball:gumball $APP_DIR

echo "=== 6. Install Node dependencies ==="
cd $APP_DIR
npm install

echo "=== 7. Create logs directory ==="
mkdir -p $APP_DIR/logs
chown gumball:gumball $APP_DIR/logs

echo "=== 8. Configure Nginx ==="
cat > /etc/nginx/sites-available/gumball << NGINX
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;

    root $APP_DIR;
    index index.html;

    # Serve frontend files
    location / {
        try_files \$uri \$uri/ =404;
    }

    # Cache static assets
    location ~* \.(svg|png|jpg|ico|css|js)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";
    add_header Referrer-Policy "strict-origin-when-cross-origin";
}
NGINX

ln -sf /etc/nginx/sites-available/gumball /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "=== 9. SSL with Let's Encrypt ==="
certbot --nginx -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos -m admin@$DOMAIN
systemctl enable certbot.timer

echo "=== 10. Firewall ==="
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
ufw status

echo "=== 11. PM2 ecosystem config ==="
cat > $APP_DIR/ecosystem.config.cjs << PM2
module.exports = {
  apps: [{
    name: 'gumball-oracle',
    script: 'scripts/oracle.cjs',
    cwd: '$APP_DIR',
    env: {
      ORACLE_WALLET: '$ORACLE_WALLET_PATH',
      SECRETS_FILE: '$APP_DIR/oracle-secrets.json',
    },
    watch: false,
    max_restarts: 50,
    restart_delay: 3000,
    max_memory_restart: '200M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '$APP_DIR/logs/oracle-error.log',
    out_file: '$APP_DIR/logs/oracle-out.log',
  }]
};
PM2

echo ""
echo "============================================================"
echo "  SETUP COMPLETE — manual steps remaining:"
echo "============================================================"
echo ""
echo "1. Copy your oracle wallet to the server:"
echo "   scp oracle-wallet.json root@$DOMAIN:$ORACLE_WALLET_PATH"
echo "   chmod 600 $ORACLE_WALLET_PATH"
echo "   chown gumball:gumball $ORACLE_WALLET_PATH"
echo ""
echo "2. Start the oracle:"
echo "   cd $APP_DIR"
echo "   pm2 start ecosystem.config.cjs"
echo "   pm2 save"
echo "   pm2 startup"
echo "   # Run the command that pm2 startup outputs"
echo ""
echo "3. Verify oracle is running:"
echo "   pm2 status"
echo "   pm2 logs gumball-oracle --lines 20"
echo ""
echo "4. Visit your site:"
echo "   https://$DOMAIN"
echo ""
echo "5. To update the site later:"
echo "   cd $APP_DIR && git pull && pm2 restart gumball-oracle"
echo "============================================================"
