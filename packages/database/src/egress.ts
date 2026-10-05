import { randomUUID } from "node:crypto";

import type { EgressProtocol, WorkerEgressStatus } from "@agent-runtime/protocol";
import type { TransactionSql } from "postgres";

import type { DatabaseClient } from "./index.js";

type Transaction = TransactionSql;

export type EgressRuleAction = "allow" | "deny";

export interface EgressRuleRecord {
  id: string;
  action: EgressRuleAction;
  /** Canonical IPv4 CIDR. */
  network: string;
  protocol: EgressProtocol | null;
  portMin: number | null;
  portMax: number | null;
  description: string;
  createdBy: string;
  createdAt: Date;
}

export interface EgressPolicyRecord {
  revision: number;
  rules: EgressRuleRecord[];
}

export interface EgressAuditMetadata {
  actorUserId: string;
  requestId: string;
  ipAddress: string;
  userAgent: string | null;
}

/** Returns an error code when the change would make the policy invalid, else null. */
export type EgressPolicyValidator = (rules: readonly EgressRuleRecord[]) => string | null;

export type CreateEgressRuleResult =
  | { outcome: "CREATED"; rule: EgressRuleRecord; revision: number }
  | { outcome: "DUPLICATE" }
  | { outcome: "REJECTED"; code: string };

export type DeleteEgressRuleResult =
  | { outcome: "DELETED"; revision: number }
  | { outcome: "NOT_FOUND" }
  | { outcome: "REJECTED"; code: string };

interface EgressRuleRow {
  id: string;
  action: EgressRuleAction;
  network: string;
  protocol: EgressProtocol | null;
  port_min: number | null;
  port_max: number | null;
  description: string;
  created_by: string;
  created_at: Date;
}

function mapRule(row: EgressRuleRow): EgressRuleRecord {
  return {
    id: row.id,
    action: row.action,
    network: row.network,
    protocol: row.protocol,
    portMin: row.port_min,
    portMax: row.port_max,
    description: row.description,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

async function lockPolicy(transaction: Transaction): Promise<number> {
  const rows = await transaction<Array<{ revision: string }>>`
    select revision::text from egress_policy_state where id for update
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("egress policy state is missing");
  return Number(row.revision);
}

async function listRules(transaction: Transaction): Promise<EgressRuleRecord[]> {
  const rows = await transaction<EgressRuleRow[]>`
    select
      id, action, network::text as network, protocol, port_min, port_max,
      description, created_by, created_at
    from egress_rules
    order by
      action asc, egress_rules.network asc, protocol asc nulls first,
      port_min asc nulls first, id asc
  `;
  return rows.map(mapRule);
}

async function bumpRevision(transaction: Transaction, current: number): Promise<number> {
  const revision = current + 1;
  await transaction`update egress_policy_state set revision = ${revision} where id`;
  return revision;
}

function ruleDetails(rule: EgressRuleRecord, revision: number, audit: EgressAuditMetadata) {
  return {
    requestId: audit.requestId,
    ipAddress: audit.ipAddress,
    userAgent: audit.userAgent,
    ruleId: rule.id,
    action: rule.action,
    network: rule.network,
    protocol: rule.protocol,
    portMin: rule.portMin,
    portMax: rule.portMax,
    description: rule.description,
    revision,
  };
}

export function createEgressRepository(database: DatabaseClient) {
  /**
   * Records what a Worker reports about its egress rules. While a Worker cannot enforce
   * them it stops its running containers (specs.md Phase 14.11 Q3); the matching
   * Workspaces become ERROR here so the Portal does not show them as running.
   */
  async function recordWorkerEgressInTransaction(
    transaction: Transaction,
    input: { workerId: string; egress: WorkerEgressStatus; receivedAt: Date },
  ): Promise<void> {
    const rows = await transaction<Array<{ egress_enforced: boolean }>>`
      select egress_enforced from workers where id = ${input.workerId} for update
    `;
    const previous = rows[0];
    if (previous === undefined) return;
    await transaction`
      update workers
      set
        egress_enforced = ${input.egress.enforced},
        egress_revision = ${input.egress.revision},
        egress_checked_at = ${input.receivedAt}
      where id = ${input.workerId}
    `;
    if (previous.egress_enforced !== input.egress.enforced) {
      await transaction`
        insert into platform_audit_events (event_type, worker_id, details)
        values (
          ${input.egress.enforced ? "worker.egress_enforced" : "worker.egress_unenforced"},
          ${input.workerId},
          ${transaction.json({ revision: input.egress.revision })}
        )
      `;
    }
    if (!input.egress.enforced) {
      await transaction`
        update workspaces
        set state = 'ERROR', updated_at = now()
        where worker_id = ${input.workerId}
          and state = 'RUNNING'
      `;
    }
  }

  return {
    recordWorkerEgressInTransaction,

    async recordWorkerEgress(input: {
      workerId: string;
      egress: WorkerEgressStatus;
      receivedAt: Date;
    }): Promise<void> {
      await database.begin((transaction) =>
        recordWorkerEgressInTransaction(transaction, input),
      );
    },

    async getEgressPolicy(): Promise<EgressPolicyRecord> {
      return database.begin(async (transaction) => {
        const rows = await transaction<Array<{ revision: string }>>`
          select revision::text from egress_policy_state where id for share
        `;
        return {
          revision: Number(rows[0]?.revision ?? 0),
          rules: await listRules(transaction),
        };
      });
    },

    async createEgressRule(input: {
      action: EgressRuleAction;
      network: string;
      protocol: EgressProtocol | null;
      portMin: number | null;
      portMax: number | null;
      description: string;
      validate: EgressPolicyValidator;
      audit: EgressAuditMetadata;
    }): Promise<CreateEgressRuleResult> {
      return database.begin(async (transaction) => {
        const current = await lockPolicy(transaction);
        const existing = await listRules(transaction);
        const rule: EgressRuleRecord = {
          id: randomUUID(),
          action: input.action,
          network: input.network,
          protocol: input.protocol,
          portMin: input.portMin,
          portMax: input.portMax,
          description: input.description,
          createdBy: input.audit.actorUserId,
          createdAt: new Date(),
        };
        if (
          existing.some(
            (candidate) =>
              candidate.action === rule.action &&
              candidate.network === rule.network &&
              candidate.protocol === rule.protocol &&
              candidate.portMin === rule.portMin &&
              candidate.portMax === rule.portMax,
          )
        ) {
          return { outcome: "DUPLICATE" };
        }
        const rejected = input.validate([...existing, rule]);
        if (rejected !== null) return { outcome: "REJECTED", code: rejected };

        const inserted = await transaction<EgressRuleRow[]>`
          insert into egress_rules (
            id, action, network, protocol, port_min, port_max, description, created_by
          ) values (
            ${rule.id}, ${rule.action}, ${rule.network}::cidr, ${rule.protocol},
            ${rule.portMin}, ${rule.portMax}, ${rule.description}, ${rule.createdBy}
          )
          returning
            id, action, network::text as network, protocol, port_min, port_max,
            description, created_by, created_at
        `;
        const created = mapRule(inserted[0] as EgressRuleRow);
        const revision = await bumpRevision(transaction, current);
        await transaction`
          insert into platform_audit_events (event_type, actor_user_id, details)
          values (
            'egress.rule_created',
            ${input.audit.actorUserId},
            ${transaction.json(ruleDetails(created, revision, input.audit))}
          )
        `;
        return { outcome: "CREATED", rule: created, revision };
      });
    },

    async deleteEgressRule(input: {
      ruleId: string;
      validate: EgressPolicyValidator;
      audit: EgressAuditMetadata;
    }): Promise<DeleteEgressRuleResult> {
      return database.begin(async (transaction) => {
        const current = await lockPolicy(transaction);
        const existing = await listRules(transaction);
        const rule = existing.find((candidate) => candidate.id === input.ruleId);
        if (rule === undefined) return { outcome: "NOT_FOUND" };
        const rejected = input.validate(existing.filter((candidate) => candidate !== rule));
        if (rejected !== null) return { outcome: "REJECTED", code: rejected };

        await transaction`delete from egress_rules where id = ${rule.id}`;
        const revision = await bumpRevision(transaction, current);
        await transaction`
          insert into platform_audit_events (event_type, actor_user_id, details)
          values (
            'egress.rule_deleted',
            ${input.audit.actorUserId},
            ${transaction.json(ruleDetails(rule, revision, input.audit))}
          )
        `;
        return { outcome: "DELETED", revision };
      });
    },
  };
}
