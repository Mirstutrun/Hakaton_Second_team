import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOsm } from "../src/core/osm/parser";
import { serializeOsm } from "../src/core/osm/serializer";
import { applyEdit, applyPatch } from "../src/core/osm/commands";
import { coordinateOf, refsOf, tagsOf } from "../src/core/osm/model";
import { validateOsm } from "../src/core/osm/validation";
import { createProjection } from "../src/core/geo/projection";

const fixture =
  '<osm version="0.6" custom="keep"><bounds minlat="52" maxlat="53" minlon="104" maxlon="105"/><node id="1" lat="52.2" lon="104.2" user="author"><tag k="unknown" v="A &amp; B"/></node><node id="2" lat="52.21" lon="104.21"/><node id="3" lat="52.22" lon="104.22"/><way id="10" version="7"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/><tag k="lanes" v="2"/><tag k="oneway" v="-1"/></way><relation id="20"><member type="way" ref="10" role="forward"/><member type="way" ref="999" role=""/><tag k="type" v="route"/></relation><custom foo="bar"/></osm>';

describe("OSM data integrity", () => {
  it("preserves unknown XML, metadata, order and external relation members", () => {
    expect(serializeOsm(parseOsm(fixture))).toBe(fixture);
  });
  it("roundtrips the complete organizer map without losing elements", () => {
    const source = readFileSync("public/example.osm", "utf8");
    const document = parseOsm(source);
    const exported = serializeOsm(document);
    const restored = parseOsm(exported);
    expect([
      restored.nodes.size,
      restored.ways.size,
      restored.relations.size,
    ]).toEqual([6089, 1392, 187]);
    expect(restored.xml.isEqualNode(document.xml)).toBe(true);
    expect(
      validateOsm(document).filter((issue) => issue.severity === "error"),
    ).toHaveLength(0);
    expect(
      validateOsm(document).some((issue) => issue.message.includes("72471")),
    ).toBe(true);
  }, 60000);
  it("edits lanes and keeps unrelated attributes through undo and redo", () => {
    const document = parseOsm(fixture);
    const patch = applyEdit(document, {
      type: "set-tags",
      target: { type: "way", id: "10" },
      tags: { lanes: "4" },
    });
    expect(tagsOf(document.ways.get("10")!).lanes).toBe("4");
    expect(tagsOf(document.ways.get("10")!).oneway).toBe("-1");
    expect(document.ways.get("10")!.getAttribute("version")).toBe("7");
    applyPatch(document, patch, "before");
    expect(tagsOf(document.ways.get("10")!).lanes).toBe("2");
    applyPatch(document, patch, "after");
    expect(tagsOf(parseOsm(serializeOsm(document)).ways.get("10")!).lanes).toBe(
      "4",
    );
  });
  it("creates a connected road, moves a shared node and safely deletes the way", () => {
    const document = parseOsm(fixture);
    // Новая дорога уходит на восток от общего узла 1. Точка (52.23, 104.23)
    // лежала бы на продолжении дороги 10 и накрывала её без общих узлов —
    // такую правку проверка безопасности справедливо отклоняет.
    const patch = applyEdit(document, {
      type: "create-road",
      points: [{ nodeId: "1" }, { lat: 52.2, lon: 104.23 }],
      tags: { lanes: "2" },
    });
    const id = patch.selection!.id;
    expect(BigInt(id)).toBeGreaterThan(999n);
    const order = Array.from(document.xml.documentElement.children)
      .filter((element) =>
        ["node", "way", "relation"].includes(element.tagName),
      )
      .map((element) => element.tagName);
    expect(order).toEqual([
      "node",
      "node",
      "node",
      "node",
      "way",
      "way",
      "relation",
    ]);
    expect(refsOf(document.ways.get(id)!)[0]).toBe("1");
    applyEdit(document, {
      type: "move-node",
      id: "1",
      coordinate: { lat: 52.3, lon: 104.3 },
    });
    expect(coordinateOf(document.nodes.get("1")!)).toEqual({
      lat: 52.3,
      lon: 104.3,
    });
    applyEdit(document, { type: "delete-way", id });
    expect(document.nodes.has("1")).toBe(true);
    expect(() => applyEdit(document, { type: "delete-way", id: "10" })).toThrow(
      "отношение",
    );
    expect(
      validateOsm(document).filter((issue) => issue.severity === "error"),
    ).toHaveLength(0);
  });
  it("deletes an existing building with undo", () => {
    // Здание в стороне от дороги: редактор умеет только удалить его.
    // (Отмена удаления возвращает объект в конец своей группы, поэтому здание — последний way.)
    const withBuilding = fixture
      .replace(
        '<way id="10"',
        '<node id="5" lat="52.5" lon="104.5"/><node id="6" lat="52.5" lon="104.5003"/><node id="7" lat="52.5002" lon="104.5003"/><node id="8" lat="52.5002" lon="104.5"/><way id="10"',
      )
      .replace(
        "<relation",
        '<way id="11"><nd ref="5"/><nd ref="6"/><nd ref="7"/><nd ref="8"/><nd ref="5"/><tag k="building" v="yes"/></way><relation',
      );
    const document = parseOsm(withBuilding);
    const removal = applyEdit(document, { type: "delete-building", wayId: "11" });
    expect(document.ways.has("11")).toBe(false);
    expect(serializeOsm(parseOsm(serializeOsm(document)))).not.toContain('k="building"');
    applyPatch(document, removal, "before");
    expect(document.ways.has("11")).toBe(true);
    expect(serializeOsm(document)).toBe(withBuilding);
    // Дорога — не здание: команда её не трогает.
    expect(() => applyEdit(document, { type: "delete-building", wayId: "10" })).toThrow("Выберите здание");
    expect(document.ways.size).toBe(2);
  });
  it("removes vertices and rejects removal of a junction", () => {
    const document = parseOsm(fixture);
    applyEdit(document, {
      type: "create-road",
      points: [{ nodeId: "2" }, { lat: 52.3, lon: 104.3 }],
      tags: {},
    });
    expect(() =>
      applyEdit(document, { type: "remove-vertex", wayId: "10", index: 1 }),
    ).toThrow("Общий узел");
    applyEdit(document, { type: "remove-vertex", wayId: "10", index: 0 });
    expect(refsOf(document.ways.get("10")!)).toEqual(["2", "3"]);
  });
  it("rolls back a partially executed command", () => {
    const document = parseOsm(fixture);
    expect(() =>
      applyEdit(document, {
        type: "create-road",
        points: [{ lat: 52.3, lon: 104.3 }, { nodeId: "missing" }],
        tags: {},
      }),
    ).toThrow();
    expect(document.nodes.size).toBe(3);
    expect(serializeOsm(document)).toBe(fixture);
  });
  it("rejects XML errors, duplicate IDs and unsafe entities", () => {
    expect(() => parseOsm("<osm>")).toThrow();
    expect(() => parseOsm('<osm><node id="1"/><node id="1"/></osm>')).toThrow(
      "Повторяющийся",
    );
    expect(() => parseOsm("<!DOCTYPE osm><osm/>")).toThrow("DTD");
  });
  it("blocks export with broken way references and invalid coordinates", () => {
    expect(() =>
      serializeOsm(parseOsm(fixture.replace('ref="3"', 'ref="333"'))),
    ).toThrow("отсутствует узел");
    expect(() =>
      serializeOsm(parseOsm(fixture.replace('lat="52.2"', 'lat="NaN"'))),
    ).toThrow("координаты");
  });
  it("rejects invalid lanes and conflicting directional lane counts", () => {
    const document = parseOsm(fixture);
    expect(() =>
      applyEdit(document, {
        type: "set-tags",
        target: { type: "way", id: "10" },
        tags: { lanes: "-2" },
      }),
    ).toThrow();
    expect(() =>
      applyEdit(document, {
        type: "set-tags",
        target: { type: "way", id: "10" },
        tags: { "lanes:forward": "3" },
      }),
    ).toThrow();
  });
  it("projects local meters reversibly", () => {
    const projection = createProjection({ lat: 52.26, lon: 104.26 });
    const point = { lat: 52.265, lon: 104.268 };
    const restored = projection.unproject(projection.project(point));
    expect(restored.lat).toBeCloseTo(point.lat, 9);
    expect(restored.lon).toBeCloseTo(point.lon, 9);
  });
});
