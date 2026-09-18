#!/usr/bin/env bash
# GhostWire — installateur Linux / macOS / Termux
# Usage : curl -fsSL <raw-url>/install.sh | bash
set -euo pipefail

REPO_URL="${GW_REPO_URL:-https://github.com/OWNER/ghostwire}"
BRANCH="${GW_BRANCH:-main}"
INSTALL_DIR="${GW_INSTALL_DIR:-$HOME/ghostwire}"

say()  { printf '\033[36m[ghostwire]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[ghostwire] ✔\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[ghostwire] ⚠\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[ghostwire] ✖ %s\033[0m\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git requis (Termux : pkg install git)"
command -v node >/dev/null 2>&1 || die "Node.js >= 18 requis (Termux : pkg install nodejs)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node >= 18 requis, trouvé : $(node -v)"

if [ -d "$INSTALL_DIR/.git" ]; then
  say "Mise à jour de $INSTALL_DIR…"
  git -C "$INSTALL_DIR" pull --ff-only || warn "pull échoué — version conservée"
else
  say "Clonage dans $INSTALL_DIR…"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR" \
    || die "clone échoué — vérifiez REPO_URL ($REPO_URL)"
fi

cd "$INSTALL_DIR"
say "Installation des dépendances npm…"
npm install --omit=dev --no-audit --no-fund

say "Téléchargement de wireproxy…"
node bin/ghostwire.js setup

ok "Installé dans $INSTALL_DIR"
say "Démarrage :   node bin/ghostwire.js start"
say "Avec token :  GW_TOKEN=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n') node bin/ghostwire.js start"

# ── Service systemd optionnel (pas sur Termux) ──
if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ] && [ -z "${TERMUX_VERSION:-}" ]; then
  say "Installer un service systemd ? [y/N]"
  read -r ANSWER
  if [ "${ANSWER:-n}" = "y" ]; then
    sudo tee /etc/systemd/system/ghostwire.service >/dev/null <<EOF
[Unit]
Description=GhostWire VPN panel
After=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
Environment=GW_TOKEN=change-me
ExecStart=$(command -v node) $INSTALL_DIR/bin/ghostwire.js start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now ghostwire
    ok "Service systemd activé : systemctl status ghostwire"
  fi
fi
