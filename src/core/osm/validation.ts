import { childElements, type Coordinate } from "./model";
import {
  coordinateOf,
  elements,
  refsOf,
  tagsOf,
  type ElementType,
  type OsmDocument,
} from "./model";

export interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
  id?: string;
  elementType?: "node" | "way" | "relation";
  code?: string;
  coordinate?: Coordinate;
  fix?: {
    kind: "connect-crossing";
    wayA: string;
    indexA: number;
    wayB: string;
    indexB: number;
    coordinate: Coordinate;
  };
}

export function validateOsm(document: OsmDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [id, node] of document.nodes) {
    const { lat, lon } = coordinateOf(node);
    if (
      !node.hasAttribute("lat") ||
      !node.hasAttribute("lon") ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      issues.push({
        severity: "error",
        id,
        message: `Узел ${id}: некорректные координаты`,
      });
    }
  }
  for (const [id, way] of document.ways) {
    const refs = refsOf(way);
    if (refs.some((ref) => !document.nodes.has(ref)))
      issues.push({
        severity: "error",
        id,
        message: `Дорога ${id}: отсутствует узел`,
      });
    if (tagsOf(way).highway && new Set(refs).size < 2)
      issues.push({
        severity: "warning",
        id,
        message: `Дорога ${id}: меньше двух разных узлов`,
      });
  }
  let externalMembers = 0;
  for (const relation of document.relations.values()) {
    for (const member of childElements(relation).filter(
      (child) => child.tagName === "member",
    )) {
      const type = member.getAttribute("type") as ElementType;
      if (
        !["node", "way", "relation"].includes(type) ||
        !elements(document, type).has(member.getAttribute("ref")!)
      )
        externalMembers++;
    }
  }
  if (externalMembers)
    issues.push({
      severity: "warning",
      message: `Внешние участники отношений: ${externalMembers}. Ссылки сохранены; выгрузка охватывает только часть карты.`,
    });
  return issues;
}
