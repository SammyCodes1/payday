/**
 * The ONLY configuration the browser bundle may see. Every value here must be public.
 * The bundle check (scripts/check-bundle.mjs) fails the build if any server secret leaks.
 */
export type PublicChain = "arcTestnet" | "anvil";

export const publicConfig = {
  chain: (process.env.NEXT_PUBLIC_CHAIN === "arcTestnet" ? "arcTestnet" : "anvil") as PublicChain,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "",
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL || "https://explorer.testnet.arc.io",
};
