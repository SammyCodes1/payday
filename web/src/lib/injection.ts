/**
 * Deterministic prompt-injection screening over every string the extractor returned plus
 * the raw text layer. A hit never changes what the agent CAN do (it has no tools and the
 * payee address comes from chain); it forces ESCALATE and is shown to the owner.
 */
export interface InjectionFlag {
  rule: string;
  field: string;
  match: string;
}

const RULES: { rule: string; re: RegExp }[] = [
  { rule: "ignore-instructions", re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(instructions?|prompts?|rules?|polic(y|ies)|guardrails?)\b/i },
  { rule: "role-hijack", re: /\b(you are now|act as|pretend to be|from now on you)\b/i },
  { rule: "system-prompt", re: /(\bsystem prompt\b|\bdeveloper message\b|<\|im_start\|>|\[\/?INST\]|###\s*instructions?\b)/i },
  { rule: "pay-to-address", re: /\b(pay|send|transfer|wire)\b[^.\n]{0,40}\b(to|into)\b[^.\n]{0,20}0x[0-9a-fA-F]{6,}/i },
  { rule: "move-all-funds", re: /\b(transfer|send|move|drain|withdraw)\b[^.\n]{0,20}\b(all|entire|full)\b[^.\n]{0,20}\b(funds?|balance|money)\b/i },
  { rule: "secrecy", re: /\b(do not|don't|without)\b[^.\n]{0,20}\b(tell|inform|notify|alert|ask(ing)?)\b[^.\n]{0,20}\b(owner|admin|anyone|human|manager)\b/i },
  { rule: "approval-bypass", re: /\b(auto[- ]?approve|pre[- ]?approved|skip (the )?(approval|review|checks?)|no (approval|review) (needed|required))\b/i },
  { rule: "urgency-pressure", re: /\b(urgent(ly)?|immediately|right now|within the hour)\b[^.\n]{0,40}\b(pay|transfer|wire|send|approve)\b/i },
  { rule: "tool-call", re: /\b(call|invoke|use)\b[^.\n]{0,15}\b(tool|function|requestPayment|approvePending|setPayee)\b/i },
  { rule: "evm-address", re: /0x[0-9a-fA-F]{40}\b/ },
];

export function scanForInjection(fields: Record<string, string | null | undefined>): InjectionFlag[] {
  const flags: InjectionFlag[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    for (const { rule, re } of RULES) {
      const m = re.exec(value);
      if (m) flags.push({ rule, field, match: m[0].slice(0, 160) });
    }
  }
  return flags;
}

/** Flags that indicate an actual injection attempt (an address alone is handled as a payee-detail change). */
export function isInjection(flags: InjectionFlag[]): boolean {
  return flags.some((f) => f.rule !== "evm-address");
}
