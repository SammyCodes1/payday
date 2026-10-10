import "server-only";
import { serverConfig } from "../config";
import { chainFor } from "../chains";
import { CircleExecutor, createCircleClient } from "./circle";
import { LocalAnvilExecutor } from "./local";
import type { AgentExecutor } from "./types";
import { activePolicy } from "../tenant";

let override: AgentExecutor | null = null;
export function setExecutorForTests(e: AgentExecutor | null) {
  override = e;
}

export async function getExecutor(): Promise<AgentExecutor | null> {
  if (override) return override;
  const cfg = serverConfig();
  switch (cfg.PAYDAY_EXECUTOR) {
    case "none":
      return null;
    case "local": {
      if (cfg.PAYDAY_CHAIN !== "anvil") throw new Error("PAYDAY_EXECUTOR=local is only allowed with PAYDAY_CHAIN=anvil");
      const rpc = cfg.PAYDAY_RPC_URL ?? chainFor("anvil").rpcUrls.default.http[0]!;
      return new LocalAnvilExecutor(rpc, activePolicy(), cfg.PAYDAY_LOCAL_AGENT_INDEX);
    }
    case "circle": {
      const { CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_AGENT_WALLET_ID, CIRCLE_AGENT_WALLET_ADDRESS } = cfg;
      if (!CIRCLE_API_KEY || !CIRCLE_ENTITY_SECRET || !CIRCLE_AGENT_WALLET_ID || !CIRCLE_AGENT_WALLET_ADDRESS) {
        throw new Error("Circle executor needs CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_AGENT_WALLET_ID, CIRCLE_AGENT_WALLET_ADDRESS");
      }
      return new CircleExecutor({
        client: await createCircleClient(CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET),
        walletId: CIRCLE_AGENT_WALLET_ID,
        walletAddress: CIRCLE_AGENT_WALLET_ADDRESS,
        policy: activePolicy(),
      });
    }
  }
}
