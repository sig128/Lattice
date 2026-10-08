import type { RpcObservation } from "@lattice/monitor/probe";

export function statusPresentation(status: RpcObservation["httpStatus"]) {
  if (status === "operational") return { tone: "good" as const, label: "Operational" };
  if (status === "degraded") return { tone: "warn" as const, label: "Degraded" };
  return { tone: "bad" as const, label: "Unavailable" };
}

export function formatCheckedAt(iso: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(iso)) + " UTC";
}
