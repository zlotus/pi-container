#!/usr/bin/env bash
set -euo pipefail

python --version
python3 --version
uv --version
node --version
pnpm --version
rustc --version
cargo --version
rustup --version
gcc --version
g++ --version
make --version
cmake --version
pkg-config --version
ffmpeg -version
ffprobe -version
pdftotext -v
pandoc --version
libreoffice --headless --version

for command in \
  bash curl dig fd file free git ip jq less lsof nc nslookup ping ps rg ss ssh \
  tar tree unzip wget xz zip; do
  command -v "${command}"
done

pi --version
pi-web --help

# pi-web / Pi pins and the downstream patches (specs.md Phase 18.3).
pi_web_root=/opt/agent-runtime/lib/node_modules/@agegr/pi-web
node -e '
  const root = "/opt/agent-runtime/lib/node_modules";
  const web = require(`${root}/@agegr/pi-web/package.json`);
  const cli = require(`${root}/@earendil-works/pi-coding-agent/package.json`);
  if (cli.version !== web.dependencies["@earendil-works/pi-coding-agent"]) {
    throw new Error(`pi ${cli.version} differs from pi-web dependency`);
  }
  console.log(`pi-web ${web.version}, Pi ${cli.version}`);
'
grep -q 'process.env.PI_WEB_DEFAULT_CWD' "${pi_web_root}/.next/server/app/api/default-cwd/route.js"
grep -q 'fs.realpathSync(manifestPath)' "${pi_web_root}/bin/rotate-preview-secrets.js"
test -L "${pi_web_root}/.next/prerender-manifest.json"
test "$(readlink "${pi_web_root}/.next/prerender-manifest.json")" = /var/tmp/pi-web/prerender-manifest.json
test -f "${pi_web_root}/.next/prerender-manifest.template.json"
test -x /usr/local/bin/pi-web-launch
test "${PI_TELEMETRY}" = 0
node /usr/local/lib/agent-runtime/browser-smoke.mjs
/usr/local/bin/runtime-capability-probe
bash -lc 'cargo --version && rustc --version && rustup --version && pnpm --version && uv --version'
