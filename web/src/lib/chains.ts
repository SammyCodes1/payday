import { defineChain } from "viem";
import { arcTestnet as viemArcTestnet, foundry } from "viem/chains";

/** Arc Testnet RPC per https://docs.arc.io/arc/references/connect-to-arc (viem's built-in still lists the older arc.network host). */
export const ARC_TESTNET_RPC = "https://rpc.testnet.arc.io";
/** USDC ERC-20 interface on Arc, 6 decimals. https://docs.arc.io/arc/references/contract-addresses */
export const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;

export const arcTestnet = defineChain({
  ...viemArcTestnet,
  rpcUrls: { default: { http: [ARC_TESTNET_RPC] } },
});

export const anvil = foundry; // chain id 31337

export function chainFor(name: "arcTestnet" | "anvil") {
  return name === "arcTestnet" ? arcTestnet : anvil;
}
