ARG NODE_IMAGE=node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e
ARG RUST_IMAGE=rust:1.90.0-slim-bookworm@sha256:64232e656c058f4468e8d024e990acff04f0fd5a5c0a88a574dc37773d7325c9

FROM ${RUST_IMAGE} AS rust-toolchain

FROM ${NODE_IMAGE} AS runtime-packages

ARG PI_WEB_VERSION=0.9.0
ARG PI_VERSION=0.85.1
ARG PLAYWRIGHT_VERSION=1.63.0
ARG PNPM_VERSION=11.24.0

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential python3 \
    && npm install --global --prefix /opt/agent-runtime \
      "@agegr/pi-web@${PI_WEB_VERSION}" \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" \
      "playwright@${PLAYWRIGHT_VERSION}" \
      "pnpm@${PNPM_VERSION}" \
    && rm -rf /var/lib/apt/lists/* /root/.npm

COPY patches/pi-web-0.9.0-default-cwd.mjs /tmp/pi-web-0.9.0-default-cwd.mjs

RUN node /tmp/pi-web-0.9.0-default-cwd.mjs \
      /opt/agent-runtime/lib/node_modules/@agegr/pi-web \
    && rm /tmp/pi-web-0.9.0-default-cwd.mjs

FROM ${NODE_IMAGE}

ARG UV_VERSION=0.12.13

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      cmake \
      coreutils \
      curl \
      dnsutils \
      fd-find \
      ffmpeg \
      file \
      findutils \
      fonts-dejavu-core \
      fonts-liberation \
      fonts-noto-cjk \
      git \
      iproute2 \
      iputils-ping \
      jq \
      less \
      libreoffice \
      lsof \
      make \
      netcat-openbsd \
      openssh-client \
      pandoc \
      pkg-config \
      poppler-utils \
      procps \
      python-is-python3 \
      python3 \
      python3-pip \
      ripgrep \
      tar \
      tini \
      tree \
      unzip \
      wget \
      xz-utils \
      zip \
    && python3 -m pip install \
      --break-system-packages \
      --disable-pip-version-check \
      --no-cache-dir \
      "uv==${UV_VERSION}" \
    && rm -rf /var/lib/apt/lists/* /root/.cache /root/.local

COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup
COPY --from=runtime-packages /opt/agent-runtime /opt/agent-runtime

ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PATH=/opt/agent-runtime/bin:/usr/local/cargo/bin:${PATH}

RUN /opt/agent-runtime/bin/playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && ln -s /opt/agent-runtime/bin/pi /usr/local/bin/pi \
    && ln -s /opt/agent-runtime/bin/pi-web /usr/local/bin/pi-web \
    && ln -s /opt/agent-runtime/bin/playwright /usr/local/bin/playwright \
    && ln -s /opt/agent-runtime/bin/pnpm /usr/local/bin/pnpm \
    && ln -s /opt/agent-runtime/bin/pnpx /usr/local/bin/pnpx \
    && ln -s /usr/local/cargo/bin/cargo /usr/local/bin/cargo \
    && ln -s /usr/local/cargo/bin/rustc /usr/local/bin/rustc \
    && ln -s /usr/local/cargo/bin/rustup /usr/local/bin/rustup \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && groupmod --new-name agent node \
    && usermod --login agent --home /home/agent --move-home --shell /bin/bash node \
    && mkdir -p /workspace /agent/pi \
    && chown -R agent:agent /workspace /agent

COPY scripts/browser-smoke.mjs /usr/local/lib/agent-runtime/browser-smoke.mjs
COPY scripts/runtime-capability-probe.mjs /usr/local/lib/agent-runtime/runtime-capability-probe.mjs
COPY scripts/runtime-smoke.sh /usr/local/bin/runtime-smoke

RUN chmod 0755 \
      /usr/local/lib/agent-runtime/browser-smoke.mjs \
      /usr/local/lib/agent-runtime/runtime-capability-probe.mjs \
      /usr/local/bin/runtime-smoke \
    && ln -s \
      /usr/local/lib/agent-runtime/runtime-capability-probe.mjs \
      /usr/local/bin/runtime-capability-probe

LABEL io.agent-runtime.phase="7" \
      io.agent-runtime.playwright.version="1.63.0" \
      io.agent-runtime.runtime.version="phase-7"

ENV HOME=/home/agent \
    PI_CODING_AGENT_DIR=/agent/pi \
    PI_WEB_DEFAULT_CWD=/workspace \
    PI_WEB_HOSTNAME=0.0.0.0 \
    PI_WEB_NO_OPEN=1 \
    PI_WEB_SKIP_VERSION_CHECK=1 \
    PI_WEB_IDLE_TIMEOUT_MS=0 \
    PORT=30141

WORKDIR /workspace
USER agent:agent
EXPOSE 30141

HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
  CMD curl --fail --silent --show-error http://127.0.0.1:30141/ >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pi-web", "--hostname", "0.0.0.0", "--port", "30141", "--no-open"]
