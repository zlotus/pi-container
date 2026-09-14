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
node /usr/local/lib/agent-runtime/browser-smoke.mjs
/usr/local/bin/runtime-capability-probe
bash -lc 'cargo --version && rustc --version && rustup --version && pnpm --version && uv --version'
