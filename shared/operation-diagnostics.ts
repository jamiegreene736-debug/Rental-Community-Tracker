export type OperationDiagnosticIssue = {
  severity: "warning" | "error";
  source: string;
  summary: string;
  detail?: string;
};

export type OperationRemediation = {
  playbook: string;
  label: string;
  autoRunnable: boolean;
  description?: string;
};

export type OperationDiagnostics = {
  severity: "ok" | "warning" | "error";
  title: string;
  summary: string;
  report: string;
  generatedAt: string;
  context: Record<string, unknown>;
  issues?: OperationDiagnosticIssue[];
  remediation?: OperationRemediation[];
};

export type OperationJobType =
  | "bulk-combo-listing"
  | "combo-photo-fetch"
  | "replacement-find"
  | "preflight-photo-fetch";

export type FailureClass =
  | "transient"
  | "sidecar"
  | "address"
  | "duplicate"
  | "search-exhausted"
  | "photo-scrape"
  | "config"
  | "unknown";

export function classifyFailureText(text: string): { failureClass: FailureClass; hint: string } {
  const lower = text.toLowerCase();
  if (/502|503|504|timed out|timeout|econnreset|fetch failed|stale|heartbeat/.test(lower)) {
    return { failureClass: "transient", hint: "Temporary network or worker issue — a retry often succeeds." };
  }
  if (/sidecar|chrome lane|waiting-sidecar/.test(lower)) {
    return { failureClass: "sidecar", hint: "Chrome sidecar was busy or offline — ensure the local sidecar worker is running, then retry." };
  }
  if (/address|canonical|street|city|validatecommunity/.test(lower)) {
    return { failureClass: "address", hint: "Street or city did not match the resort’s canonical address rules." };
  }
  if (/already has|actively queueing|duplicate/.test(lower)) {
    return { failureClass: "duplicate", hint: "This combo is already queued or on the dashboard." };
  }
  if (/no eligible|no clean|0 results|rate-?limit|searchapi|unchecked/.test(lower)) {
    return { failureClass: "search-exhausted", hint: "Listing search ran out of clean candidates or hit search limits." };
  }
  if (/apify|actor|scrape|photo|zillow|fewer than 3/.test(lower)) {
    return { failureClass: "photo-scrape", hint: "Photo discovery or scraping did not return enough usable images." };
  }
  if (/searchapi_api_key|not configured|api_key/.test(lower)) {
    return { failureClass: "config", hint: "A required API key or env var is missing on the server." };
  }
  return { failureClass: "unknown", hint: "Review the event log below; retry or expand search if applicable." };
}

export function buildOperationDiagnostics(input: {
  title: string;
  severity: OperationDiagnostics["severity"];
  summary: string;
  context: Record<string, unknown>;
  issues?: OperationDiagnosticIssue[];
  eventLines?: string[];
  extraSections?: Array<{ heading: string; lines: string[] }>;
  remediation?: OperationRemediation[];
}): OperationDiagnostics {
  const lines: string[] = [
    input.title,
    `Generated: ${new Date().toISOString()}`,
    `Severity: ${input.severity}`,
    `Summary: ${input.summary}`,
    "",
  ];
  if (input.context && Object.keys(input.context).length > 0) {
    lines.push("Context:");
    for (const [key, value] of Object.entries(input.context)) {
      if (value === undefined || value === null || value === "") continue;
      lines.push(`- ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
    lines.push("");
  }
  if (input.issues?.length) {
    lines.push("Issues:");
    for (const issue of input.issues) {
      lines.push(`- [${issue.severity}] ${issue.source}: ${issue.summary}${issue.detail ? ` — ${issue.detail}` : ""}`);
    }
    lines.push("");
  }
  for (const section of input.extraSections ?? []) {
    lines.push(section.heading);
    for (const line of section.lines) lines.push(line);
    lines.push("");
  }
  if (input.eventLines?.length) {
    lines.push("Recent events:");
    for (const line of input.eventLines) lines.push(line);
    lines.push("");
  }
  if (input.remediation?.length) {
    lines.push("Suggested actions:");
    for (const r of input.remediation) {
      lines.push(`- ${r.label}${r.description ? `: ${r.description}` : ""}`);
    }
  }
  return {
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    report: lines.join("\n").trim(),
    generatedAt: new Date().toISOString(),
    context: input.context,
    issues: input.issues,
    remediation: input.remediation,
  };
}

export function suggestRemediations(args: {
  jobType: OperationJobType;
  failureClass: FailureClass;
  errorText: string;
  diagnostic?: Record<string, unknown> | null;
  itemKey?: string | null;
}): OperationRemediation[] {
  const out: OperationRemediation[] = [];
  const { jobType, failureClass, errorText, diagnostic, itemKey } = args;
  const budgetStopped = Boolean(diagnostic?.budgetStopped);
  const capExceeded = Boolean(diagnostic?.capExceeded);
  const unchecked = Array.isArray(diagnostic?.uncheckedCandidates)
    ? diagnostic!.uncheckedCandidates!.length
    : 0;

  if (jobType === "bulk-combo-listing") {
    if (failureClass === "address") {
      out.push({
        playbook: "fix-canonical-address",
        label: "Fix address & retry item",
        autoRunnable: true,
        description: "Apply canonical resort street/city, then re-queue this listing.",
      });
    }
    if (failureClass === "transient" || failureClass === "sidecar") {
      out.push({
        playbook: "retry-failed",
        label: "Retry failed listings",
        autoRunnable: true,
        description: "Re-queue all failed items in this bulk job.",
      });
    }
    if (itemKey) {
      out.push({
        playbook: "retry-item",
        label: "Retry this listing only",
        autoRunnable: true,
      });
    } else {
      out.push({
        playbook: "retry-failed",
        label: "Retry failed listings",
        autoRunnable: true,
      });
    }
  }

  if (jobType === "combo-photo-fetch") {
    out.push({
      playbook: "retry-failed",
      label: "Retry failed photo fetches",
      autoRunnable: true,
      description: "Re-run failed items in this photo job.",
    });
  }

  if (jobType === "replacement-find") {
    if ((budgetStopped || capExceeded) && unchecked > 0) {
      out.push({
        playbook: "continue-search",
        label: "Continue search",
        autoRunnable: true,
        description: `Resume checking ${unchecked} remaining candidate(s) without re-discovering listings.`,
      });
    }
    if (failureClass === "search-exhausted" || /expand/i.test(errorText) === false) {
      out.push({
        playbook: "expand-search",
        label: "Expand search",
        autoRunnable: true,
        description: "Search Zillow, Realtor, Redfin, and Homes.com with broader queries.",
      });
    }
    out.push({
      playbook: "retry-search",
      label: "Run search again",
      autoRunnable: true,
    });
  }

  if (jobType === "preflight-photo-fetch") {
    out.push({
      playbook: "retry-search",
      label: "Find photos again",
      autoRunnable: true,
      description: "Starts a new photo fetch with the same parameters you provide.",
    });
  }

  const seen = new Set<string>();
  return out.filter((r) => {
    if (seen.has(r.playbook)) return false;
    seen.add(r.playbook);
    return true;
  });
}
