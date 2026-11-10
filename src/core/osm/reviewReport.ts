import { TrafficModel } from "../../engine/TrafficModel";
import type { OsmDocument } from "./model";
import { auditGeometry } from "./geometryAudit";
import { validateOsm } from "./validation";

function counts(document: OsmDocument) {
  const issues = [...validateOsm(document), ...auditGeometry(document)];
  const byCode: Record<string, number> = {};
  for (const issue of issues) {
    const code = issue.code ?? "validation";
    byCode[code] = (byCode[code] ?? 0) + 1;
  }
  return { nodes: document.nodes.size, ways: document.ways.size,
    relations: document.relations.size, directionalNetwork: new TrafficModel(document).networkSummary, warnings: issues.length, byCode };
}
export function reviewBaseline(document: OsmDocument) {
  return { counts: counts(document),
    nodes: new Map([...document.nodes].map(([id, e]) => [id, e.outerHTML])),
    ways: new Map([...document.ways].map(([id, e]) => [id, e.outerHTML])),
    relations: new Map([...document.relations].map(([id, e]) => [id, e.outerHTML])) };
}
export function reviewReport(baseline: ReturnType<typeof reviewBaseline>, current: OsmDocument) {
  const changes = (before: Map<string, string>, after: Map<string, Element>) => ({
    added: [...after.keys()].filter(id => !before.has(id)),
    removed: [...before.keys()].filter(id => !after.has(id)),
    modified: [...after].filter(([id, e]) => before.has(id) && before.get(id) !== e.outerHTML).map(([id]) => id),
  });
  return { schemaVersion: 1, generatedAt: new Date().toISOString(),
    note: "Локальные эвристики. Точность на местности и прохождение MatSim/SUMO/Webots подтверждаются отдельно.",
    before: baseline.counts, after: counts(current),
    changes: { nodes: changes(baseline.nodes, current.nodes),
      ways: changes(baseline.ways, current.ways), relations: changes(baseline.relations, current.relations) } };
}
