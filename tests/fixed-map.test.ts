import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOsm } from "../src/core/osm/parser";
import { serializeOsm } from "../src/core/osm/serializer";
import { auditGeometry } from "../src/core/osm/geometryAudit";
import { validateOsm } from "../src/core/osm/validation";
import { networkConnectivity } from "../src/core/osm/connectivity";
import { tagsOf } from "../src/core/osm/model";

// Проезды под домами в карте организаторов (см. maps/README.md).
const passages = ["806941626", "816684053", "816684054", "1494549628", "1494549683", "1495613247"];

describe("карта организаторов: только реальные проблемы", () => {
  it("исходная карта: 1 дорога сквозь дом и 6 проездов ниже земли, без ложных срабатываний", () => {
    const document = parseOsm(readFileSync("public/example.osm", "utf8"));
    const issues = auditGeometry(document).map((issue) => `${issue.code}:${issue.id}`);
    expect(issues.sort()).toEqual([
      "road-building-overlap:1366216823",
      ...passages.map((id) => `underground-passage:${id}`),
    ].sort());
    const network = networkConnectivity(document);
    expect([network.isolated, network.clipped]).toEqual([0, 3]);
  }, 60000);

  it("исправленная карта maps/example-edited.osm чиста и пригодна для Webots", () => {
    const source = readFileSync("maps/example-edited.osm", "utf8");
    const document = parseOsm(source);
    expect(validateOsm(document).filter((issue) => issue.severity === "error")).toEqual([]);
    expect(auditGeometry(document)).toEqual([]);
    expect(networkConnectivity(document).isolated).toBe(0);
    expect([document.nodes.size, document.ways.size, document.relations.size]).toEqual([6091, 1394, 187]);
    for (const id of passages) {
      const tags = tagsOf(document.ways.get(id)!);
      expect(Number(tags.layer || 0)).toBe(0);
      expect(tags.tunnel === "building_passage" || tags.covered === "yes").toBe(true);
    }
    // Ни одна автомобильная дорога, кроме настоящих тоннелей, не ушла ниже земли.
    for (const way of document.ways.values()) {
      const tags = tagsOf(way);
      if (!tags.highway || ["footway", "steps", "path"].includes(tags.highway)) continue;
      if (Number(tags.layer || 0) < 0) expect(tags.tunnel).toBe("yes");
    }
    expect(source.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(serializeOsm(parseOsm(source))).toBe(source);
  }, 60000);
});
