FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e AS runtime-packages

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential python3 \
    && npm install --global --prefix /opt/agent-runtime \
      @agegr/pi-web@0.9.0 \
      @earendil-works/pi-coding-agent@0.85.1 \
      pnpm@11.24.0 \
    && rm -rf /var/lib/apt/lists/* /root/.npm

FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      bash \
      ca-certificates \
      coreutils \
      curl \
      git \
      openssh-client \
      python3 \
      tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupmod --new-name agent node \
    && usermod --login agent --home /home/agent --move-home --shell /bin/bash node \
    && mkdir -p /workspace /agent/pi \
    && chown -R agent:agent /workspace /agent

COPY --from=runtime-packages /opt/agent-runtime /opt/agent-runtime

RUN ln -s /opt/agent-runtime/bin/pi /usr/local/bin/pi \
    && ln -s /opt/agent-runtime/bin/pi-web /usr/local/bin/pi-web \
    && ln -s /opt/agent-runtime/bin/pnpm /usr/local/bin/pnpm \
    && ln -s /opt/agent-runtime/bin/pnpx /usr/local/bin/pnpx

ENV HOME=/home/agent \
    PATH=/opt/agent-runtime/bin:${PATH} \
    PI_CODING_AGENT_DIR=/agent/pi \
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
