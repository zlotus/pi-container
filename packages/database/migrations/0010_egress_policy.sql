-- Phase 14: Workspace egress control. The Control Plane stores the administrator's
-- whitelist and extra deny ranges; every change bumps one global revision that Workers
-- report back once they have applied it. RFC1918 and the Worker host itself are denied
-- by the Workers unconditionally and are not stored here.
CREATE TABLE egress_rules (
  id uuid PRIMARY KEY,
  action text NOT NULL,
  network cidr NOT NULL,
  protocol text,
  port_min integer,
  port_max integer,
  description text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT egress_rules_action CHECK (action IN ('allow', 'deny')),
  CONSTRAINT egress_rules_ipv4 CHECK (family(network) = 4 AND masklen(network) >= 8),
  CONSTRAINT egress_rules_protocol CHECK (protocol IS NULL OR protocol IN ('tcp', 'udp')),
  CONSTRAINT egress_rules_deny_has_no_service CHECK (
    action = 'allow' OR (protocol IS NULL AND port_min IS NULL AND port_max IS NULL)
  ),
  CONSTRAINT egress_rules_ports CHECK (
    (port_min IS NULL AND port_max IS NULL)
    OR (
      protocol IS NOT NULL
      AND port_min BETWEEN 1 AND 65535
      AND port_max BETWEEN 1 AND 65535
      AND port_min <= port_max
    )
  ),
  CONSTRAINT egress_rules_description_length CHECK (char_length(description) <= 200),
  CONSTRAINT egress_rules_unique UNIQUE NULLS NOT DISTINCT (
    action, network, protocol, port_min, port_max
  )
);

CREATE TABLE egress_policy_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision bigint NOT NULL CHECK (revision >= 0)
);

INSERT INTO egress_policy_state (id, revision) VALUES (true, 0);

-- What each Worker last reported: whether its local rules are verified and which
-- policy revision they contain. A new Worker is not enforcing until it says so.
ALTER TABLE workers
  ADD COLUMN egress_enforced boolean NOT NULL DEFAULT false,
  ADD COLUMN egress_revision bigint,
  ADD COLUMN egress_checked_at timestamptz;
