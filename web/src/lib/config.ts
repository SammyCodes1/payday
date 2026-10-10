import "server-only";
import { z } from "zod";
import { getAddress, isAddress, type Address } from "viem";

/**
 * Server-side configuration, read lazily from process.env on every call so tests can
 * change it. NOTHING in here may be imported by a client component ("server-only").
 * Secret values are never logged or returned by any route.
 */
const addr = z
  .string()
  .refine((v) => isAddress(v), "must be a 0x address")
  .transform((v) => getAddress(v) as Address);

const schema = z.object({
  PAYDAY_CHAIN: z.enum(["arcTestnet", "anvil"]).default("anvil"),
  PAYDAY_RPC_URL: z.string().url().optional(),
  PAYDAY_POLICY_ADDRESS: addr,
  PAYDAY_POLICY_DEPLOY_BLOCK: z.coerce.bigint().default(0n),
  /** SpendPolicyFactory (multi-tenant onboarding). Unset until the factory is deployed. */
  PAYDAY_FACTORY_ADDRESS: z.preprocess((v) => (v === "" ? undefined : v), addr.optional()),
  PAYDAY_STATS_POLICIES: z.string().optional(), // "0xabc:123,0xdef:456"
  PAYDAY_LOG_CHUNK: z.coerce.bigint().default(10_000n),
  PAYDAY_EXECUTOR: z.enum(["circle", "local", "none"]).default("none"),
  PAYDAY_LOCAL_AGENT_INDEX: z.coerce.number().int().min(0).max(19).default(2),
  CIRCLE_API_KEY: z.string().optional(),
  CIRCLE_ENTITY_SECRET: z.string().optional(),
  CIRCLE_AGENT_WALLET_ID: z.string().uuid().optional(),
  CIRCLE_AGENT_WALLET_ADDRESS: addr.optional(),
  PAYDAY_LLM_PROVIDER: z.enum(["mock", "openai", "anthropic", "google"]).default("mock"),
  PAYDAY_LLM_MODEL: z.string().optional(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  CRON_SECRET: z.string().min(32).optional(),
  PAYDAY_DB_PATH: z.string().default("./data/payday.sqlite"),
  PAYDAY_APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  PAYDAY_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  PAYDAY_SCHEDULE_LEAD_DAYS: z.coerce.number().int().min(0).max(30).default(1),
  PAYDAY_RUNWAY_BUFFER_USDC: z.string().regex(/^\d+(\.\d{1,6})?$/).default("0"),
});

export type ServerConfig = z.infer<typeof schema>;

export function serverConfig(): ServerConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Report variable NAMES only, never values.
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid server configuration: ${names}`);
  }
  return parsed.data;
}

export interface StatsPolicy {
  address: Address;
  fromBlock: bigint;
}

export function statsPolicies(cfg = serverConfig()): StatsPolicy[] {
  if (!cfg.PAYDAY_STATS_POLICIES) return [{ address: cfg.PAYDAY_POLICY_ADDRESS, fromBlock: cfg.PAYDAY_POLICY_DEPLOY_BLOCK }];
  return cfg.PAYDAY_STATS_POLICIES.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [a, b] = entry.split(":");
      if (!a || !isAddress(a)) throw new Error("PAYDAY_STATS_POLICIES has an invalid address");
      return { address: getAddress(a), fromBlock: BigInt(b ?? "0") };
    });
}
