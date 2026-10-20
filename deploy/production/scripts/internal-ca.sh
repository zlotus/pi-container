#!/usr/bin/env bash
# A minimal internal certificate authority for deployments without an enterprise PKI
# (specs.md Phase 19.6.1, docs/tls-and-dns.md). With a PKI, use its certificates instead;
# the platform only needs PEM files at the paths below.
#
#   internal-ca.sh init
#       create the CA (EC P-256, 10 years) in $AGENT_RUNTIME_CA_DIR (/etc/agent-runtime/ca);
#       ca.key never leaves this directory, ca.crt is what browsers and hosts trust
#   internal-ca.sh issue <output prefix> <SAN>[,<SAN>...]
#       a server certificate (397 days) and key: <prefix>.crt, <prefix>.key
#       e.g. issue /etc/agent-runtime/tls/public DNS:portal.ar.internal,DNS:*.agent.ar.internal
#            issue /etc/agent-runtime/tls/internal IP:100.112.169.46
#            issue /tmp/worker-c-gateway IP:100.115.94.58
#       an existing certificate is replaced (renewal); the old pair is kept as *.old
#   internal-ca.sh show <certificate>
#       subject, SANs, issuer and expiry
#
# Run as root on the host that keeps the CA (usually the Control Plane host).
set -euo pipefail

ca_dir="${AGENT_RUNTIME_CA_DIR:-/etc/agent-runtime/ca}"
umask 077

fail() {
  echo "internal-ca.sh: $*" >&2
  exit 1
}

case "${1:-}" in
  init)
    [[ ! -e "${ca_dir}/ca.key" ]] || fail "a CA already exists in ${ca_dir}"
    mkdir -p "$ca_dir"
    chmod 0700 "$ca_dir"
    openssl req -x509 -new -nodes \
      -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
      -days 3650 \
      -subj "/CN=${AGENT_RUNTIME_CA_NAME:-Agent Runtime Internal CA}" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -keyout "${ca_dir}/ca.key" -out "${ca_dir}/ca.crt" 2>/dev/null
    chmod 0644 "${ca_dir}/ca.crt"
    echo "created ${ca_dir}/ca.crt (trust this) and ${ca_dir}/ca.key (keep private)"
    openssl x509 -in "${ca_dir}/ca.crt" -noout -subject -enddate -fingerprint -sha256
    ;;
  issue)
    prefix="${2:?usage: internal-ca.sh issue <output prefix> <SAN>[,<SAN>...]}"
    sans="${3:?usage: internal-ca.sh issue <output prefix> <SAN>[,<SAN>...]}"
    [[ -f "${ca_dir}/ca.key" ]] || fail "no CA in ${ca_dir}; run internal-ca.sh init first"
    IFS=',' read -r -a entries <<<"$sans"
    for entry in "${entries[@]}"; do
      [[ "$entry" =~ ^DNS:(\*\.)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ || "$entry" =~ ^IP:[0-9A-Fa-f.:]+$ ]] ||
        fail "invalid SAN '$entry' (use DNS:<name>, DNS:*.<name> or IP:<address>)"
    done
    first="${entries[0]#*:}"
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    cat >"${work}/ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=${sans}
EOF
    openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
      -subj "/CN=${first}" -keyout "${work}/key" -out "${work}/csr" 2>/dev/null
    openssl x509 -req -in "${work}/csr" -CA "${ca_dir}/ca.crt" -CAkey "${ca_dir}/ca.key" \
      -CAcreateserial -CAserial "${ca_dir}/ca.srl" -days 397 -sha256 \
      -extfile "${work}/ext" -out "${work}/crt" 2>/dev/null
    mkdir -p "$(dirname "$prefix")"
    for suffix in crt key; do
      if [[ -e "${prefix}.${suffix}" ]]; then mv -f "${prefix}.${suffix}" "${prefix}.${suffix}.old"; fi
    done
    install -m 0644 "${work}/crt" "${prefix}.crt"
    install -m 0600 "${work}/key" "${prefix}.key"
    echo "issued ${prefix}.crt and ${prefix}.key (0600; give the service's group read access if it needs it)"
    openssl x509 -in "${prefix}.crt" -noout -subject -ext subjectAltName -enddate
    ;;
  show)
    openssl x509 -in "${2:?usage: internal-ca.sh show <certificate>}" -noout \
      -subject -issuer -ext subjectAltName -enddate
    ;;
  *)
    sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
