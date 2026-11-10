import { childElements, refsOf, tagsOf, type EditPatch, type OsmDocument } from "./model";

function isBuilding(element: Element | null): boolean {
  const tags = element ? tagsOf(element) : {};
  return [tags.building, tags["building:part"]].some(value => !!value && value !== "no");
}

export function buildingWayIds(document: OsmDocument): Set<string> {
  const result = new Set<string>();
  for (const [id, way] of document.ways) if (isBuilding(way)) result.add(id);
  for (const relation of document.relations.values()) {
    if (!isBuilding(relation)) continue;
    for (const member of childElements(relation)) {
      if (member.tagName === "member" && member.getAttribute("type") === "way")
        result.add(member.getAttribute("ref")!);
    }
  }
  return result;
}

export function assertBuildingsReadOnly(document: OsmDocument, patch: EditPatch): void {
  const original = { ...document, ways: new Map(document.ways), relations: new Map(document.relations) };
  for (const change of patch.changes) {
    if (change.type === "node") continue;
    const collection = change.type === "way" ? original.ways : original.relations;
    if (change.before) collection.set(change.id, change.before);
    else collection.delete(change.id);
  }
  const ways = new Set([...buildingWayIds(original), ...buildingWayIds(document)]);
  const nodes = new Set([...ways].flatMap(id => {
    const way = original.ways.get(id) ?? document.ways.get(id);
    return way ? refsOf(way) : [];
  }));
  for (const change of patch.changes) {
    const protectedWay = change.type === "way" && ways.has(change.id);
    const protectedRelation = change.type === "relation" && (isBuilding(change.before) || isBuilding(change.after));
    const movedNode = change.type === "node" && nodes.has(change.id) &&
      ["lat", "lon"].some(key => change.before?.getAttribute(key) !== change.after?.getAttribute(key));
    if (((protectedWay || protectedRelation) && !change.before?.isEqualNode(change.after)) || movedNode)
      throw new Error("Здания доступны только для просмотра. Контуры и общие с ними узлы изменять нельзя.");
  }
}
