import { dropsToXrp } from "@aigentia/shared";
import type { Observation } from "@aigentia/protocol";
import type { ObservationView } from "./brain";

export const VIEW_LIMITS = {
  availableServices: 6,
  availableJobs: 6,
  recentEvents: 8,
  nearbyAgents: 6,
  resourceListings: 8,
  knowledge: 8,
  myJobs: 6,
} as const;

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** One line for decision traces, e.g. "Balance 9.42 XRP · 3 services · 1 open job · 2 nearby agents". */
export function summarizeObservation(obs: Observation): string {
  const parts: string[] = [`Balance ${dropsToXrp(obs.balanceDrops)} XRP`];
  parts.push(plural(obs.availableServices.length, "service"));
  const openJobs = obs.availableJobs.filter((j) => j.status === "open").length;
  parts.push(plural(openJobs, "open job"));
  parts.push(plural(obs.nearbyAgents.length, "nearby agent"));
  const claimed = obs.myJobs.filter((j) => j.claimedByAgentId === obs.agentId).length;
  if (claimed > 0) parts.push(plural(claimed, "claimed job"));
  const units = obs.inventory.reduce((sum, i) => sum + i.quantity, 0);
  if (units > 0) parts.push(`${units} inventory units`);
  return parts.join(" · ");
}

function cmpBigintDesc(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x === y ? 0 : x > y ? -1 : 1;
}

/**
 * Bounded copy of the observation: top services by ranker score, top jobs by reward,
 * most recent events, nearest agents (observation order), freshest knowledge.
 * Deterministic: ties keep the original observation order (stable sort).
 */
export function compactObservation(obs: Observation): ObservationView {
  const availableServices = [...obs.availableServices]
    .sort((a, b) => b.score - a.score)
    .slice(0, VIEW_LIMITS.availableServices);
  const availableJobs = [...obs.availableJobs]
    .sort((a, b) => cmpBigintDesc(a.rewardDrops, b.rewardDrops))
    .slice(0, VIEW_LIMITS.availableJobs);
  const recentEvents = obs.recentEvents.slice(-VIEW_LIMITS.recentEvents);
  const nearbyAgents = obs.nearbyAgents.slice(0, VIEW_LIMITS.nearbyAgents);
  const resourceListings = [...obs.resourceListings]
    .sort((a, b) => -cmpBigintDesc(a.unitPriceDrops, b.unitPriceDrops))
    .slice(0, VIEW_LIMITS.resourceListings);
  const knowledge = [...obs.knowledge]
    .sort((a, b) => b.learnedAtTick - a.learnedAtTick)
    .slice(0, VIEW_LIMITS.knowledge);
  const myJobs = obs.myJobs.slice(0, VIEW_LIMITS.myJobs);

  return {
    ...obs,
    availableServices,
    availableJobs,
    recentEvents,
    nearbyAgents,
    resourceListings,
    knowledge,
    myJobs,
    summary: summarizeObservation(obs),
    truncated: {
      availableServices: obs.availableServices.length - availableServices.length,
      availableJobs: obs.availableJobs.length - availableJobs.length,
      recentEvents: obs.recentEvents.length - recentEvents.length,
      nearbyAgents: obs.nearbyAgents.length - nearbyAgents.length,
      resourceListings: obs.resourceListings.length - resourceListings.length,
      knowledge: obs.knowledge.length - knowledge.length,
      myJobs: obs.myJobs.length - myJobs.length,
    },
  };
}
