import { childElements, tagsOf, type OsmDocument } from "./model";

export interface BusRoute {
  id: string;
  name: string;
  stops: string[];
}

export function busRoutes(document: OsmDocument): BusRoute[] {
  return Array.from(document.relations, ([id, relation]) => {
    const tags = tagsOf(relation);
    if (tags.type !== "route" || tags.route !== "bus") return null;
    return {
      id,
      name: tags.name || tags.ref || `Маршрут ${id}`,
      stops: childElements(relation)
        .filter((member) => member.tagName === "member" &&
          member.getAttribute("type") === "node" &&
          member.getAttribute("role") === "stop")
        .map((member) => member.getAttribute("ref")!),
    };
  }).filter((route): route is BusRoute => route !== null && route.stops.length >= 2);
}
