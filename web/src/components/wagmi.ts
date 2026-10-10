"use client";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { anvil, arcTestnet, chainFor } from "@/lib/chains";
import { publicConfig } from "@/lib/public-config";

export const appChain = chainFor(publicConfig.chain);
const rpcFor = (id: number, fallback: string) => (id === appChain.id && publicConfig.rpcUrl ? publicConfig.rpcUrl : fallback);

export const wagmiConfig = createConfig({
  // The configured chain first, so wallets are asked to switch to it.
  chains: appChain.id === anvil.id ? [anvil, arcTestnet] : [arcTestnet, anvil],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http(rpcFor(arcTestnet.id, arcTestnet.rpcUrls.default.http[0])),
    [anvil.id]: http(rpcFor(anvil.id, anvil.rpcUrls.default.http[0])),
  },
  ssr: true,
});
