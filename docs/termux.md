# 📱 GhostWire sur Android (Termux)

GhostWire fonctionne sur Android **sans root** : le tunnel WireGuard tourne en
userspace (wireproxy) et expose des proxys SOCKS5/HTTP locaux.

## 1. Prérequis

Depuis **F-Droid** (recommandé) ou Play Store, installez **Termux**, puis :

```bash
pkg update && pkg upgrade
pkg install nodejs-lts git openssh
termux-setup-storage        # accès au stockage (optionnel)
```

## 2. Installation

```bash
git clone https://github.com/OWNER/ghostwire.git
cd ghostwire
npm install --omit=dev
node bin/ghostwire.js setup   # télécharge wireproxy linux_arm64
node bin/ghostwire.js doctor  # vérification
```

## 3. Empêcher Android de tuer Termux

```bash
pkg install termux-services termux-api
termux-wake-lock              # CPU maintenu actif
```

Dans les réglages Android : *Paramètres → Applications → Termux → Batterie →
Sans restriction* (désactivez l'optimisation de batterie).

## 4. Démarrer le panneau

```bash
GW_TOKEN=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n') \
  node bin/ghostwire.js start
```

Ouvrez `http://127.0.0.1:8080` dans le navigateur du téléphone
(ou `http://<IP-WiFi-du-téléphone>:8080` depuis un PC du même réseau).

## 5. Router le trafic du téléphone dans le tunnel

GhostWire expose `socks5://127.0.0.1:1080`. Pour que **tout Android** passe
dedans, trois options :

| Option | Principe |
|---|---|
| **App WireGuard officielle + proxy** | Certaines configurations supportent *Include proxies* — importez le QR depuis l'UI |
| **Every Proxy** (Play Store/F-Droid) | Expose le SOCKS5 de Termux au système ; à coupler avec le paramètre *proxy Wi-Fi* d'Android |
| **SocksDroid / ProxyDroid** (root) | Tunnel SOCKS5 → interface VPN complète |

Simple et fiable sans root : **proxy Wi-Fi** — *Paramètres → Wi-Fi → modifier le
réseau → Proxy → manuel* avec `127.0.0.1:1080` ne fonctionne que pour le
navigateur ; pour un vrai VPN système utilisez l'app WireGuard officielle avec
le fichier `.conf` (QR code de l'UI) si vous avez un serveur WireGuard, et
GhostWire sert alors de panneau de gestion/génération de configs.

## 6. Service en arrière-plan (sv-enable)

Avec `termux-services` :

```bash
mkdir -p $PREFIX/var/service/ghostwire/log
cat > $PREFIX/var/service/ghostwire/run <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
cd $HOME/ghostwire
exec node bin/ghostwire.js start 2>&1
EOF
chmod +x $PREFIX/var/service/ghostwire/run
sv-enable ghostwire
sv up ghostwire
```

Commandes : `sv up|down|restart|status ghostwire`.

## 7. Dépannage

| Problème | Solution |
|---|---|
| `wireproxy` non exécutable | Certains FS ignorent chmod → `bash bin/wireproxy` marche toujours via `GW_WIREPROXY` |
| Le tunnel meurt en arrière-plan | `termux-wake-lock` + désactiver l'optimisation batterie |
| Port 8080 occupé | `node bin/ghostwire.js start --port 9090` |
| Test débit impossible | Le réseau bloqué bloque speed.cloudflare.com → normal dans certains pays, utilisez Latence |
| Stockage inaccessible | Relancez `termux-setup-storage` |
