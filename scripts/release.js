/**
 * GhostWire — build de release locale.
 * Crée dist/ghostwire-<version>.zip et .tar.gz (code + scripts d'install,
 * sans node_modules ni données runtime).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, ensureDir } from '../src/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Copie récursive fichier par fichier (cpSync est instable sur certains FS Windows). */
function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

export async function buildRelease(version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const v = version || pkg.version;
  const name = `ghostwire-${v}`;
  const dist = path.join(ROOT, 'dist');
  const stage = path.join(dist, name);
  ensureDir(stage);

  log.info(`Construction de la release ${name}…`);

  // Fichiers à embarquer
  const include = [
    'bin/ghostwire.js',
    'src',
    'scripts/release.js',
    'package.json',
    'README.md',
    'LICENSE',
    '.env.example',
    'install.sh',
    'install.ps1',
  ];
  for (const f of include) {
    const src = path.join(ROOT, f);
    const dst = path.join(stage, f);
    if (!fs.existsSync(src)) { log.warn(`absent, ignoré : ${f}`); continue; }
    copyRecursive(src, dst);
  }

  // Archives (chemins relatifs : GNU tar sur Windows lit "C:\…" comme un hôte)
  const makeTar = () => execSync(`tar -czf "${name}.tar.gz" "${name}"`, { cwd: dist, stdio: 'pipe' });
  const makeZip = () => {
    const zipPath = path.join(dist, `${name}.zip`);
    try {
      execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${stage.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`, { stdio: 'pipe' });
    } catch {
      try { execSync(`zip -qr "${zipPath}" "${name}"`, { cwd: dist, stdio: 'pipe' }); }
      catch { log.warn('zip indisponible (ni PowerShell ni zip) — archive .tar.gz seule'); }
    }
  };
  makeTar();
  makeZip();

  // Checksums (uniquement les fichiers d'archive, pas le dossier de staging)
  const crypto = await import('node:crypto');
  const files = fs.readdirSync(dist)
    .filter((f) => f.startsWith(name) && /\.(tar\.gz|zip)$/.test(f));
  const lines = files.map((f) => {
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(path.join(dist, f)));
    return `${h.digest('hex')}  ${f}`;
  });
  fs.writeFileSync(path.join(dist, 'checksums.txt'), lines.join('\n') + '\n');

  log.ok(`Release prête dans dist/ : ${files.join(', ')}`);
  return { dist, files };
}

// CLI direct
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  buildRelease(process.argv[2]).catch((e) => { log.err(e.message); process.exit(1); });
}
