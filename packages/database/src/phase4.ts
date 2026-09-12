import type { DatabaseClient } from "./index.js";
import { createPhase3Repository } from "./phase3.js";

export interface WorkerGatewayRoute {
  workerId: string;
  gatewayBaseUrl: string;
}

export function createPhase4Repository(database: DatabaseClient) {
  return {
    ...createPhase3Repository(database),

    async provisionWorkerWithGateway(input: {
      workerId: string;
      credentialHash: string;
      gatewayBaseUrl: string;
    }): Promise<void> {
      await database`
        insert into workers (id, credential_hash, gateway_base_url)
        values (
          ${input.workerId},
          ${input.credentialHash},
          ${input.gatewayBaseUrl}
        )
      `;
    },

    async configureWorkerGateway(input: {
      workerId: string;
      gatewayBaseUrl: string;
    }): Promise<boolean> {
      const rows = await database<{ id: string }[]>`
        update workers
        set gateway_base_url = ${input.gatewayBaseUrl}, updated_at = now()
        where id = ${input.workerId}
        returning id
      `;
      return rows.length === 1;
    },

    async findWorkerGatewayRoute(input: {
      workerId: string;
      heartbeatCutoff: Date;
    }): Promise<WorkerGatewayRoute | null> {
      const rows = await database<
        Array<{ id: string; gateway_base_url: string }>
      >`
        select id, gateway_base_url
        from workers
        where id = ${input.workerId}
          and enabled
          and status = 'ONLINE'
          and last_heartbeat_at > ${input.heartbeatCutoff}
          and gateway_base_url is not null
        limit 1
      `;
      const row = rows[0];
      return row === undefined
        ? null
        : { workerId: row.id, gatewayBaseUrl: row.gateway_base_url };
    },
  };
}

export type Phase4Repository = ReturnType<typeof createPhase4Repository>;
