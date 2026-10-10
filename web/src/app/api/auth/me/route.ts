import { handle, json, requireOwner } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";
export const GET = handle(async (req) => json(await requireOwner(req)));
