export type CaptchaProviderName = "none" | "capsolver";

export type CaptchaPolicy = {
  provider: CaptchaProviderName;
  apiKeyConfigured: boolean;
  solvingEnabled: boolean;
};

export function getCaptchaPolicy(): CaptchaPolicy {
  const rawProvider = String(process.env.CAPTCHA_PROVIDER ?? "").trim().toLowerCase();
  const hasCapSolverKey = Boolean(String(process.env.CAPSOLVER_API_KEY ?? "").trim());
  const provider: CaptchaProviderName =
    rawProvider === "capsolver" || (!rawProvider && hasCapSolverKey) ? "capsolver" : "none";

  return {
    provider,
    apiKeyConfigured: hasCapSolverKey,
    solvingEnabled: process.env.CAPTCHA_SOLVING_ENABLED === "1",
  };
}

export function captchaAutomationUnavailable(scope: string): { ok: false; provider: CaptchaProviderName; error: string } {
  const policy = getCaptchaPolicy();
  const prefix = policy.provider === "capsolver"
    ? "CapSolver is configured"
    : "No CAPTCHA provider is configured";
  const enabled = policy.solvingEnabled ? "enabled" : "disabled";
  const key = policy.apiKeyConfigured ? "key present" : "key missing";

  return {
    ok: false,
    provider: policy.provider,
    error: `${prefix} (${key}, automation ${enabled}), but automatic CAPTCHA solving is not enabled for ${scope}. The provider run should surface a blocked status and continue/rotate according to provider policy.`,
  };
}
