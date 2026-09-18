# 👻 GhostWire

**Panneau VPN auto-hébergé avec interface web — WireGuard 100 % userspace.**
Un seul runtime (Node.js ≥ 18), zéro root, zéro dépendance native. Tourne sur **Android (Termux), Linux, Windows et macOS**.

> ⚠️ **Avertissement** : GhostWire est un outil réseau à des fins d'usage légitime (confidentialité, accès distant à vos propres serveurs, contournement de censures légales). Vérifiez la législation de votre pays. N'utilisez jamais un VPN pour des activités illégales.

---

## ✨ Fonctionnalités

| | |
|---|---|
| 🖥️ **Interface web néon** | dashboard temps réel : statut, orbite animée, logs, uptime |
| 🔌 **Tunnel userspace** | basé sur [wireproxy](https://github.com/pufferffish/wireproxy) — pas de root, pas de TUN |
| 🧦 **Proxys SOCKS5 + HTTP** | branchez n'importe quelle app dans le tunnel |
| 🔑 **Gestionnaire de clés** | génération X25519 (compat WireGuard), PSK, configs `.conf` |
| 📱 **QR code** | scannez la config depuis l'app mobile WireGuard |
| ⚡ **Outils réseau** | speedtest (Cloudflare), latence TCP, IP publique |
| 🛡️ **Token admin** | routes sensibles protégées, comparaison à temps constant, clé privée masquée dans l'UI |
| 📦 **1 seule dépendance** | `qrcode` — tout le reste c'est Node stdlib |
| 🐳 **Docker multi-arch** | amd64 + arm64, image GHCR à chaque release |
| 🤖 **CI/CD complète** | tests 3 OS, bundles par plateforme avec binaire embarqué, releases GitHub |

---

## 🚀 Installation

### Android (Termux)

```bash
pkg update && pkg install nodejs-lts git
git clone https://github.com/OWNER/ghostwire.git
cd ghostwire
npm install --omit=dev
node bin/ghostwire.js setup     # télécharge wireproxy (arm64)
node bin/ghostwire.js start     # panneau sur http://localhost:8080
```

> Guide détaillé (wakelock, stockage, démarrage auto) : **[docs/termux.md](docs/termux.md)**

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/OWNER/ghostwire/main/install.sh | bash
# ou manuellement :
git clone https://github.com/OWNER/ghostwire.git && cd ghostwire
npm install --omit=dev && node bin/ghostwire.js setup && node bin/ghostwire.js start
```

### Windows (PowerShell)

```powershell
git clone https://github.com/OWNER/ghostwire.git
cd ghostwire
npm install --omit=dev
node bin\ghostwire.js setup
node bin\ghostwire.js start
```

### Docker

```bash
docker run -d --name ghostwire -p 8080:8080 -v ghostwire-data:/data ghcr.io/OWNER/ghostwire:latest
```

---

## 🧭 Utilisation

```
ghostwire start              # panneau + tunnel
ghostwire setup              # télécharge wireproxy pour votre plateforme
ghostwire genkey             # paire de clés WireGuard
ghostwire import mon.conf    # importe une config .conf
ghostwire qr                 # QR code de la config courante
ghostwire status             # état JSON du tunnel
ghostwire doctor             # diagnostic environnement
```

Options de `start` : `--port 8080` `--host 0.0.0.0` `--token <secret>` `--data ./data` `--demo`

### Envoyer votre trafic dans le tunnel

1. **Importer une config** : collez votre `.conf` WireGuard (fournisseur, ou votre propre serveur) dans l'onglet *Importer* de l'interface → *Enregistrer* → *▶ Démarrer*.
2. **Utiliser les proxys** : configurez votre navigateur/app sur `socks5://127.0.0.1:1080` ou `http://127.0.0.1:8888`.
3. **Tout le téléphone (Android)** : utilisez une app du type *Every Proxy* / *SocksDroid* pointant vers `127.0.0.1:1080`, ou les apps **WireGuard + "Tunnel via proxy"**. Voir [docs/termux.md](docs/termux.md).
4. **Vérifier** : bouton *⚡ Speedtest* — l'IP affichée doit être celle du serveur VPN.

---

## 🏗️ Architecture

```
┌────────────┐   HTTP    ┌─────────────┐    spawn    ┌────────────┐
│ Navigateur │ ────────▶ │ src/server  │ ──────────▶ │ wireproxy  │
│  (UI néon) │           │  API + stat.│             │ (userspace │
└────────────┘           └─────────────┘             │  WireGuard)│
                                                     └─────┬──────┘
   src/engine.js : clés, parsing .conf, cycle de vie          │ UDP
   src/qr.js     : QR code (paquet `qrcode`)                  ▼
   src/util.js   : logs, download, plateforme              Serveur VPN
```

- **Aucune interface TUN** : wireproxy expose le tunnel en proxys locaux → compatible Android non-root, Windows sans driver, conteneurs sans `--privileged`.
- **Sécurité** : token admin (`GW_TOKEN`) requis pour toute action (start/stop/import/clés), clés privées jamais renvoyées par l'API (masquage `***`), données écrites en mode `0600`.

---

## 🧪 Développement

```bash
npm install
npm test          # tests unitaires + API (node:test natif)
npm run check     # vérif syntaxe
npm run dev       # démarrage avec rechargement
```

## 📦 Releases

- Un **tag `v*`** déclenche la construction de bundles par plateforme (`linux-amd64`, `linux-arm64`, `linux-arm`, `windows-amd64`, `macos-all`, `termux-aarch64`) avec le binaire wireproxy correspondant **embarqué**, des checksums SHA-256, et une **GitHub Release** automatique.
- L'image Docker `ghcr.io/OWNER/ghostwire:{tag,latest}` est poussée en multi-arch.

## 🗺️ Roadmap

- [ ] Mode multi-tunnels (profiles switchables depuis l'UI)
- [ ] Statistiques de trafic par proxy (compteurs octets)
- [ ] App Android (WebView wrapper APK)
- [ ] WireGuard server mode : générer les configs peers côté serveur

## 📄 Licence

MIT — voir [LICENSE](LICENSE). Le binaire [wireproxy](https://github.com/pufferffish/wireproxy) (ISC) est téléchargé séparément, jamais commité.
