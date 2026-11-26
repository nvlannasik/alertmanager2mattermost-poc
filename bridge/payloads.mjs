// Alertmanager webhook payloads (version 4), for the tests and send-test-alerts.mjs.
import { fingerprintOf } from "./card.mjs";

export const NEVER = "0001-01-01T00:00:00Z";

export function alert(labels, { status = "firing", startsAt, endsAt, annotations = {} } = {}) {
  const a = {
    status,
    labels,
    annotations,
    startsAt,
    endsAt: status === "resolved" ? endsAt : NEVER,
    generatorURL: `http://prometheus-server:9090/graph?g0.expr=${encodeURIComponent(labels.alertname)}`,
  };
  return { ...a, fingerprint: fingerprintOf(a) };
}

export function notification(groupLabels, alerts, extra = {}) {
  const groupKey = `{}:{${Object.entries(groupLabels).map(([k, v]) => `${k}="${v}"`).join(", ")}}`;
  const common = {};
  for (const [k, v] of Object.entries(alerts[0]?.labels ?? {})) if (alerts.every((a) => a.labels[k] === v)) common[k] = v;
  const commonAnn = {};
  for (const [k, v] of Object.entries(alerts[0]?.annotations ?? {})) if (alerts.every((a) => a.annotations?.[k] === v)) commonAnn[k] = v;
  return {
    version: "4",
    groupKey,
    truncatedAlerts: 0,
    status: alerts.some((a) => a.status === "firing") ? "firing" : "resolved",
    receiver: "mattermost",
    groupLabels,
    commonLabels: common,
    commonAnnotations: commonAnn,
    externalURL: "http://alertmanager:9093",
    alerts,
    ...extra,
  };
}

// The demo groups.
export const crashLabels = (pod) => ({ alertname: "KubePodCrashLooping", severity: "critical", namespace: "sample-apps", cluster: "dev", pod, container: "app" });
export const crashAnn = { summary: "Pod is crash looping.", description: "The container restarted 5 times in 10 minutes.", runbook_url: "https://runbooks.prometheus-operator.dev/runbooks/kubernetes/kubepodcrashlooping" };
export const crashGroup = { alertname: "KubePodCrashLooping", namespace: "sample-apps" };
export const memLabels = { alertname: "NodeMemoryHighUtilization", severity: "warning", cluster: "dev", node: "worker-1", instance: "10.0.0.21:9100" };
export const memAnn = { summary: "Node worker-1 is running out of memory.", description: "Memory is 91% used." };
export const memGroup = { alertname: "NodeMemoryHighUtilization" };
