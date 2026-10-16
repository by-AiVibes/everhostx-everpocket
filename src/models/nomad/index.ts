import { InstanceConfig } from "../evernode";

export interface NomadOptions {
  targetNodeCount: number;
  lifeIncrMomentMinLimit: number;
  maxLifeMomentLimit?: number;
  preferredHosts?: string[];
  instanceCfg?: InstanceConfig;
  parallelGrow?: boolean;
  inactivePruneLcl?: number;
  immaturePruneLcl?: number;
  expirePruneTsMs?: number;
}