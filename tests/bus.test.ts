import { describe, expect, it } from "vitest";
import { parseOsm } from "../src/core/osm/parser";
import { applyEdit, applyPatch } from "../src/core/osm/commands";
import { refsOf, tagsOf } from "../src/core/osm/model";
import { busRoutes } from "../src/core/osm/busRoutes";
import { serializeOsm } from "../src/core/osm/serializer";
import { TrafficModel } from "../src/engine/TrafficModel";

const source = `<osm version="0.6">
<node id="1" lat="52" lon="104"/><node id="2" lat="52" lon="104.001"/>
<node id="3" lat="51.9995" lon="104.0005"/><node id="4" lat="52.0005" lon="104.0005"/>
<way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
</osm>`;

describe("junctions and bus routes", () => {
  it("merges an existing free road end into another road and supports undo", () => {
    const doc = parseOsm(source);
    const created = applyEdit(doc, { type: "create-road", points: [
      { lat: 52.0002, lon: 104.0002 }, { lat: 52.0004, lon: 104.0002 },
    ], tags: {} });
    const wayId = created.selection!.id;
    const sourceNode = refsOf(doc.ways.get(wayId)!)[0];
    const patch = applyEdit(doc, { type: "merge-endpoint", wayId,
      nodeId: sourceNode,
      target: { wayId: "10", index: 1, coordinate: { lat: 52, lon: 104.0002 } },
    });
    const shared = refsOf(doc.ways.get(wayId)!)[0];
    expect(refsOf(doc.ways.get("10")!)).toContain(shared);
    expect(doc.nodes.has(sourceNode)).toBe(false);
    applyPatch(doc, patch, "before");
    expect(refsOf(doc.ways.get(wayId)!)[0]).toBe(sourceNode);
    expect(doc.nodes.has(sourceNode)).toBe(true);
    applyPatch(doc, patch, "after");
    expect(refsOf(doc.ways.get(wayId)!)[0]).toBe(shared);
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
    expect(bus.dwell).toBe(3);
    expect(bus.edge.from).toBe(second);
    expect(bus.stopped).toBe(false);
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
