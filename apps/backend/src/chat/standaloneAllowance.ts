import {
  getAiUsageMonthWindow,
  loadAiUsageMessagesForMonth,
  type AiUsageAllowance,
} from "../aiUsage";
import type { AccountKind } from "../billing/limits";
import { freeEntitlementTier } from "../billing/tiers";
import { HttpError } from "../shared/errors";
import { readStandaloneAiMonthlyMessages } from "./deployment";

export const standaloneAiLimitReachedCode = "AI_STANDALONE_LIMIT_REACHED";

/**
 * The standalone allowance (see `readStandaloneAiMonthlyMessages`). The tier is only the label usage
 * facts carry; it is the tier everybody holds without a purchase, so no paid subscription is implied.
 */
export async function resolveStandaloneAiUsageAllowance(
  _userId: string,
  accountKind: AccountKind,
  _now: Date,
): Promise<AiUsageAllowance> {
  return {
    tier: freeEntitlementTier,
    accountKind,
    monthlyMessages: readStandaloneAiMonthlyMessages(),
  };
}

/**
 * Same count as the hosted cap (platform-key chat turns this UTC month, from `ai.usage_events`), but the
 * refusal names the operator's limit instead of the hosted Premium upgrade, which does not exist here.
 */
export async function assertStandaloneAiUsageAllowanceNotReached(
  allowance: AiUsageAllowance,
  userId: string,
  now: Date,
): Promise<void> {
  const monthlyMessages = allowance.monthlyMessages;
  if (monthlyMessages === null) {
    throw new Error("A standalone AI allowance is always bounded");
  }
  const messages = await loadAiUsageMessagesForMonth(userId, getAiUsageMonthWindow(now));
  if (messages.platformKeyMessages >= monthlyMessages) {
    throw new HttpError(
      429,
      `You've used this month's ${monthlyMessages} AI messages allowed by this self-hosted server. The limit resets at the start of next month (UTC); the server operator can change it.`,
      standaloneAiLimitReachedCode,
    );
  }
}
