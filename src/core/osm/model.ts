export type ElementType = "node" | "way" | "relation";
export type Tags = Record<string, string>;
export type Selection = { type: "node" | "way"; id: string };
export type Coordinate = { lat: number; lon: number };
export type RoadPoint = Coordinate | { nodeId: string } | {
  wayId: string;
  index: number;
  coordinate: Coordinate;
};

export interface OsmDocument {
  xml: XMLDocument;
  nodes: Map<string, Element>;
  ways: Map<string, Element>;
  relations: Map<string, Element>;
  nextId: bigint;
  /** XML-декларация исходного файла: XMLSerializer её не выводит. */
  declaration?: string;
}

export interface Change {
  type: ElementType;
  id: string;
  before: Element | null;
  after: Element | null;
}

export interface EditPatch {
  label: string;
  changes: Change[];
  selection?: Selection;
}

export function elements(
  document: OsmDocument,
  type: ElementType,
): Map<string, Element> {
  return type === "node"
    ? document.nodes
    : type === "way"
      ? document.ways
      : document.relations;
}

export function tagsOf(element: Element): Tags {
  return Object.fromEntries(
    childElements(element)
      .filter((child) => child.tagName === "tag")
      .map((child) => [
        child.getAttribute("k")!,
        child.getAttribute("v") ?? "",
      ]),
  );
}

export function refsOf(way: Element): string[] {
  return childElements(way)
    .filter((child) => child.tagName === "nd")
    .map((child) => child.getAttribute("ref")!);
}

export function coordinateOf(node: Element): Coordinate {
  return {
    lat: Number(node.getAttribute("lat")),
    lon: Number(node.getAttribute("lon")),
  };
}

export function requireElement(
  document: OsmDocument,
  type: ElementType,
  id: string,
): Element {
  const element = elements(document, type).get(id);
  if (!element) throw new Error(`Объект ${type} ${id} не найден`);
  return element;
}

export function insertElement(document: OsmDocument, element: Element): void {
  const next =
    element.tagName === "node"
      ? (document.ways.values().next().value ??
        document.relations.values().next().value)
      : element.tagName === "way"
        ? document.relations.values().next().value
        : null;
  document.xml.documentElement.insertBefore(element, next ?? null);
}

export function childElements(element: Element): Element[] {
  const result: Element[] = [];
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) result.push(child);
  return result;
}
