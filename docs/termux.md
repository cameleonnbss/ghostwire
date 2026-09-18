# GhostWire on Android (Termux)

GhostWire runs on Android **without root**: the WireGuard tunnel runs in
userspace (wireproxy) and exposes local SOCKS5/HTTP proxies.

## 1. Prerequisites

Install **Termux** from F-Droid (recommended) or Play Store, then:

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts git openssh
termux-setup-storage        # optional: storage access
```

## 2. Install — copy-paste block

```bash
git clone https://github.com/cameleonnbss/ghostwire.git ~/ghostwire
cd ~/ghostwire
npm install --omit=dev --no-audit --no-fund
node bin/ghostwire.js setup
node bin/ghostwire.js doctor
node bin/ghostwire.js useradd admin mypassword
node bin/ghostwire.js start
```

The panel is now on `http://127.0.0.1:8080` (phone browser) or
`http://<phone-wifi-ip>:8080` from any device on the same network.

## 3. Keep Android from killing Termux

```bash
pkg install -y termux-services termux-api
termux-wake-lock
```

Android settings: *Apps -> Termux -> Battery -> Unrestricted*
(disable battery optimization).

## 4. Run as a background service (survives terminal close)

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

Commands: `sv up|down|restart|status ghostwire`.

## 5. Route the phone's traffic through the tunnel

GhostWire exposes `socks5://127.0.0.1:1080`. Options:

| Option | How |
|---|---|
| **GhostWire Android app** (recommended) | Install `GhostWire.apk` from Releases, point it at the panel, control everything from the phone |
| **Official WireGuard app** | Import the QR code from the panel (works when you have a real WireGuard server; GhostWire then serves as config manager) |
| **Every Proxy / SocksDroid** | Expose Termux's SOCKS5 to Android's Wi-Fi proxy setting (browser-level only) |
| **Root only** | ProxyDroid turns the SOCKS5 into a full system VPN |

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| `wireproxy` not executable | Some filesystems ignore chmod; check `GW_WIREPROXY` env var points at the right path |
| Tunnel dies in background | `termux-wake-lock` + disable battery optimization |
| Port 8080 busy | `node bin/ghostwire.js start --port 9090` |
| Speed test fails | speed.cloudflare.com may be blocked on your network; use *Latency* instead |
| Storage inaccessible | Run `termux-setup-storage` again |
| Forgot panel password | `node bin/ghostwire.js passwd admin newpassword` |
