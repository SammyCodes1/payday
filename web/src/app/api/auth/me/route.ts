import { handle, json, requireOwner } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";
/** Signed-in owner and the policy this session controls. */
export const GET = handle(async (req) => json(await requireOwner(req)));
