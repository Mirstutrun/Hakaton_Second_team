import { describe, expect, it } from "vitest";
import { parseOsm } from "../src/core/osm/parser";
import { applyEdit, applyPatch } from "../src/core/osm/commands";
import { coordinateOf, refsOf, tagsOf } from "../src/core/osm/model";
import { createProjection } from "../src/core/geo/projection";
import { busRoutes } from "../src/core/osm/busRoutes";
import { serializeOsm } from "../src/core/osm/serializer";
import { TrafficModel } from "../src/engine/TrafficModel";

const source = `<osm version="0.6">
<node id="1" lat="52" lon="104"/><node id="2" lat="52" lon="104.001"/>
<node id="3" lat="51.9995" lon="104.0005"/><node id="4" lat="52.0005" lon="104.0005"/>
<way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
</osm>`;

describe("junctions and bus routes", () => {
  it("places a bus stop platform on the chosen side of the road", () => {
    const doc = parseOsm(source);
    const project = createProjection({ lat: 52, lon: 104.0005 }).project;
    const sides: Record<string, number> = {};
    for (const side of ["left", "right"] as const) {
      // После первой остановки дорога 1–s–2: вторая встаёт на сегмент s–2.
      const patch = applyEdit(doc, { type: "add-bus-stop", wayId: "10", index: side === "left" ? 1 : 2,
        point: { lat: 52, lon: side === "left" ? 104.0003 : 104.0007 }, side });
      const stop = patch.selection!.id;
      // Точка остановки — на дороге, платформа — сбоку, в группе stop_area.
      expect(refsOf(doc.ways.get("10")!)).toContain(stop);
      const area = [...doc.relations.values()].find((r) => tagsOf(r).public_transport === "stop_area"
        && [...r.children].some((m) => m.getAttribute("ref") === stop))!;
      const platformId = [...area.children].find((m) => m.getAttribute("role") === "platform")!.getAttribute("ref")!;
      const platform = doc.nodes.get(platformId)!;
      expect(tagsOf(platform)).toMatchObject({ public_transport: "platform", highway: "bus_stop", bus: "yes" });
      expect(refsOf(doc.ways.get("10")!)).not.toContain(platformId);
      sides[side] = project(coordinateOf(platform)).z;
    }
    // Дорога идёт на восток: левая сторона — к северу, правая — к югу, за краем полотна.
    expect(sides.left).toBeGreaterThan(3);
    expect(sides.right).toBeLessThan(-3);
  });
  it("renames and removes a stop together with its platform", () => {
    const doc = parseOsm(source);
    const stop = applyEdit(doc, { type: "add-bus-stop", wayId: "10", index: 1,
      point: { lat: 52, lon: 104.0005 }, side: "right" }).selection!.id;
    applyEdit(doc, { type: "rename-bus-stop", id: stop, name: "Университет" });
    const named = [...doc.nodes.values()].filter((n) => tagsOf(n).name === "Университет");
    expect(named).toHaveLength(2); // stop_position и платформа
    const nodes = doc.nodes.size;
    applyEdit(doc, { type: "remove-bus-stop", id: stop });
    expect(tagsOf(doc.nodes.get(stop)!).public_transport).toBeUndefined();
    expect(doc.nodes.size).toBe(nodes - 1); // платформа удалена, узел дороги остался
    expect([...doc.relations.values()].some((r) => tagsOf(r).public_transport === "stop_area")).toBe(false);
  });
  it("attaches both ends of a new road to existing segments and undoes all nodes", () => {
    const doc = parseOsm(source);
    const patch = applyEdit(doc, { type: "create-road", points: [
      { wayId: "10", index: 1, coordinate: { lat: 52, lon: 104.00025 } },
      { lat: 52.0002, lon: 104.00025 },
      { wayId: "10", index: 1, coordinate: { lat: 52, lon: 104.00075 } },
    ], tags: {} });
    const oldRefs = refsOf(doc.ways.get("10")!);
    const newRefs = refsOf(doc.ways.get(patch.selection!.id)!);
    expect(oldRefs).toHaveLength(4);
    expect(newRefs[0]).toBe(oldRefs[1]);
    expect(newRefs[newRefs.length - 1]).toBe(oldRefs[2]);
    applyPatch(doc, patch, "before");
    expect(serializeOsm(doc)).toBe(source);
    applyPatch(doc, patch, "after");
    expect(refsOf(doc.ways.get("10")!)).toHaveLength(4);
  });

  it("creates a shared node when a new road crosses an old road between clicks", () => {
    const doc = parseOsm(source);
    const patch = applyEdit(doc, { type: "create-road", points: [
      { nodeId: "3" }, { nodeId: "4" },
    ], tags: {} });
    const oldRefs = refsOf(doc.ways.get("10")!);
    const newRefs = refsOf(doc.ways.get(patch.selection!.id)!);
    expect(oldRefs).toHaveLength(3);
    expect(newRefs).toHaveLength(3);
    expect(newRefs[1]).toBe(oldRefs[1]);
    const model = new TrafficModel(doc);
    expect(model.addAt("10", "1", oldRefs[1], 0.9)).toBeTruthy();
  });

  it("stores stops and ordered routes in OSM; buses follow roads and dwell", () => {
    const doc = parseOsm(source);
    const first = applyEdit(doc, { type: "add-bus-stop", wayId: "10", index: 1,
      point: { lat: 52, lon: 104.00025 } }).selection!.id;
    const second = applyEdit(doc, { type: "add-bus-stop", wayId: "10", index: 2,
      point: { lat: 52, lon: 104.00075 } }).selection!.id;
    expect(tagsOf(doc.nodes.get(first)!).public_transport).toBe("stop_position");
    expect(refsOf(doc.ways.get("10")!)).toContain(second);
    const patch = applyEdit(doc, { type: "create-bus-route", name: "Автобус 1", stops: [first, second] });
    const route = busRoutes(doc)[0];
    expect(route.stops).toEqual([first, second]);
    expect(busRoutes(parseOsm(serializeOsm(doc)))[0].name).toBe("Автобус 1");
    const model = new TrafficModel(doc);
    const id = model.addBus(route.id)!;
    const bus = model.cars.get(id)!;
    expect(bus.kind).toBe("bus");
    expect(bus.edge.from).toBe(first);
    expect(bus.edge.to).toBe(second);
    bus.progress = 0.999;
    model.update(0.1);
    expect(bus.dwell).toBeGreaterThanOrEqual(2.9);
    expect(bus.dwell).toBeLessThanOrEqual(3);
    expect(bus.edge.from).toBe(second);
    expect(bus.stopped).toBe(true);
    model.update(0.1);
    expect(bus.stopped).toBe(true);
    applyPatch(doc, patch, "before");
    expect(busRoutes(doc)).toHaveLength(0);
    applyPatch(doc, patch, "after");
    expect(busRoutes(doc)).toHaveLength(1);
  });

  it("rejects a route against one-way direction", () => {
    const doc = parseOsm(source);
    applyEdit(doc, { type: "set-tags", target: { type: "way", id: "10" },
      tags: { oneway: "yes" } });
    expect(new TrafficModel(doc).canRoute(["2", "1"])).toBe(false);
  });
});
