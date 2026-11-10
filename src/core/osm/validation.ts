import { turnRestrictions, restrictionType } from "./turnRestrictions";
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
  fix?:
    | {
        kind: "connect-crossing";
        wayA: string;
        indexA: number;
        wayB: string;
        indexB: number;
        coordinate: Coordinate;
      }
    | {
        kind: "attach-endpoint";
        nodeId: string;
        targetWayId: string;
        targetIndex: number;
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
        elementType: "node",
        code: "invalid-coordinate",
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
        elementType: "way",
        code: "missing-node",
        message: `Дорога ${id}: отсутствует узел`,
      });
    const tags = tagsOf(way);
    if (tags.highway && new Set(refs).size < 2)
      issues.push({
        severity: "warning",
        id,
        message: `Дорога ${id}: меньше двух разных узлов`,
      });
    if (tags.highway) {
      for (const key of ["lanes", "lanes:forward", "lanes:backward"]) {
        const value = tags[key];
        if (
          value &&
          (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 20)
        )
          issues.push({
            severity: "warning",
            id,
            elementType: "way",
            code: "invalid-lanes",
            message: `Дорога ${id}: некорректное значение ${key}=${value}`,
          });
      }
      const total = Number(tags.lanes || 0);
      const forward = Number(tags["lanes:forward"] || 0);
      const backward = Number(tags["lanes:backward"] || 0);
      if (total > 0 && forward + backward > total)
        issues.push({
          severity: "warning",
          id,
          elementType: "way",
          code: "lane-conflict",
          message: `Дорога ${id}: сумма полос по направлениям превышает общее число`,
        });
      if (tags.oneway === "yes" && backward > 0)
        issues.push({
          severity: "warning",
          id,
          elementType: "way",
          code: "oneway-conflict",
          message: `Дорога ${id}: одностороннее движение конфликтует с lanes:backward`,
        });
      if (tags.oneway === "-1" && forward > 0)
        issues.push({
          severity: "warning",
          id,
          elementType: "way",
          code: "oneway-conflict",
          message: `Дорога ${id}: обратное направление конфликтует с lanes:forward`,
        });
      if (
        tags.oneway &&
        ![
          "yes",
          "1",
          "true",
          "no",
          "0",
          "false",
          "-1",
          "reversible",
          "alternating",
        ].includes(tags.oneway)
      )
        issues.push({
          severity: "warning",
          id,
          elementType: "way",
          code: "invalid-oneway",
          message: `Дорога ${id}: необычное oneway=${tags.oneway}`,
        });
      if (
        tags.bridge &&
        tags.bridge !== "no" &&
        tags.tunnel &&
        tags.tunnel !== "no"
      )
        issues.push({
          severity: "warning",
          id,
          elementType: "way",
          code: "elevation-conflict",
          message: `Дорога ${id}: одновременно мост и тоннель`,
        });
      if (
        tags.width &&
        (!Number.isFinite(Number(tags.width)) || Number(tags.width) <= 0)
      )
        issues.push({
          severity: "warning",
          id,
          elementType: "way",
          code: "invalid-width",
          message: `Дорога ${id}: подозрительная ширина ${tags.width}`,
        });
    }
  }
  for (const rule of turnRestrictions(document)) {
    const broken =
      !rule.from.length ||
      !rule.to.length ||
      (!rule.via && !rule.viaWays.length) ||
      !restrictionType(rule.tags);
    const viaNode = rule.via ? document.nodes.get(rule.via) : undefined;
    if (broken)
      issues.push({
        severity: "warning",
        code: "invalid-restriction",
        id: rule.id,
        elementType: "relation",
        coordinate: viaNode ? coordinateOf(viaNode) : undefined,
        message: `Ограничение ${rule.id}: не указан подъезд, выезд, узел или тип знака`,
      });
    if (
      Object.keys(rule.tags).some(
        (k) => k.startsWith("restriction") && k.endsWith(":conditional"),
      )
    )
      issues.push({
        severity: "warning",
        code: "conditional-restriction",
        id: rule.id,
        elementType: "relation",
        coordinate: viaNode ? coordinateOf(viaNode) : undefined,
        message: `Ограничение ${rule.id}: условие времени/погоды сохраняется в OSM, но не моделируется локальным предпросмотром`,
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
