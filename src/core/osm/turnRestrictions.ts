import { childElements, tagsOf, type OsmDocument, type Tags } from "./model";
export const restrictionNames: Record<string, string> = {
  no_left_turn: "Поворот налево запрещён",
  no_right_turn: "Поворот направо запрещён",
  no_u_turn: "Разворот запрещён",
  no_straight_on: "Прямо запрещено",
  only_straight_on: "Только прямо",
  only_left_turn: "Только налево",
  only_right_turn: "Только направо",
};
export function turnRestrictions(document: OsmDocument) {
  return Array.from(document.relations, ([id, r]) => {
    const tags = tagsOf(r),
      members = childElements(r).filter((m) => m.tagName === "member");
    const role = (role: string, type: string) =>
      members
        .filter(
          (m) =>
            m.getAttribute("role") === role && m.getAttribute("type") === type,
        )
        .map((m) => m.getAttribute("ref")!);
    return {
      id,
      tags,
      from: role("from", "way"),
      to: role("to", "way"),
      via: role("via", "node")[0],
      viaWays: role("via", "way"),
    };
  }).filter((r) => r.tags.type === "restriction");
}
export type TurnEdge = { wayId: string; from: string; to: string };
export class TurnRules {
  private rules: ReturnType<typeof turnRestrictions>;
  readonly historyLength: number;
  constructor(document: OsmDocument) {
    this.rules = turnRestrictions(document);
    this.historyLength = Math.max(
      1,
      ...this.rules.map((r) => r.viaWays.length + 1),
    );
  }
  advance(ways: string[], edge: TurnEdge) {
    return (
      ways[ways.length - 1] === edge.wayId ? ways : [...ways, edge.wayId]
    ).slice(-this.historyLength);
  }
  allowed(
    incoming: TurnEdge,
    next: TurnEdge,
    ways: string[],
    kind: "car" | "bus" = "car",
  ) {
    if (incoming.to !== next.from) return false;
    for (const rule of this.rules) {
      const except = (rule.tags.except || "")
        .split(";")
        .map((value) => value.trim());
      if (
        kind === "bus" &&
        (except.includes("bus") ||
          except.includes("psv") ||
          except.includes("motor_vehicle"))
      )
        continue;
      if (
        kind === "car" &&
        (except.includes("motorcar") || except.includes("motor_vehicle"))
      )
        continue;
      const type =
        kind === "bus"
          ? rule.tags["restriction:bus"] ||
            rule.tags["restriction:psv"] ||
            rule.tags["restriction:motor_vehicle"] ||
            rule.tags.restriction
          : rule.tags["restriction:motorcar"] ||
            rule.tags["restriction:motor_vehicle"] ||
            rule.tags.restriction;
      if (!type) continue;
      let applies = false;
      if (rule.via)
        applies =
          rule.via === incoming.to && rule.from.includes(incoming.wayId);
      else if (rule.viaWays.length) {
        if (next.wayId === incoming.wayId) continue;
        applies = rule.from.some((from) => {
          const chain = [from, ...rule.viaWays];
          return (
            chain.length <= ways.length &&
            chain.every((id, i) => ways[ways.length - chain.length + i] === id)
          );
        });
      }
      if (!applies) continue;
      let target = rule.to.includes(next.wayId);
      if (rule.from.includes(next.wayId) && rule.to.includes(incoming.wayId)) {
        if (type.endsWith("u_turn"))
          target = target && next.to === incoming.from;
        else if (type.endsWith("straight_on"))
          target = target && next.to !== incoming.from;
      }
      if (type.startsWith("no_") && target) return false;
      if (type.startsWith("only_") && !target) return false;
    }
    return true;
  }
}
export function restrictionType(tags: Tags) {
  return (
    tags.restriction ||
    tags["restriction:motor_vehicle"] ||
    tags["restriction:motorcar"] ||
    tags["restriction:bus"] ||
    ""
  );
}
