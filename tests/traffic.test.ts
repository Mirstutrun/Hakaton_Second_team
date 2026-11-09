import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core";
import { parseOsm } from "../src/core/osm/parser";
import { smoothRoadPoints, laneCenterline } from "../src/engine/geometry/roads";
import { TrafficModel, speedMetersPerSecond } from "../src/engine/TrafficModel";
import { applyEdit, applyPatch } from "../src/core/osm/commands";
import { serializeOsm } from "../src/core/osm/serializer";
import { refsOf } from "../src/core/osm/model";

const oneWay = `<osm version="0.6">
  <node id="1" lat="52" lon="104" />
  <node id="2" lat="52" lon="104.0004"><tag k="highway" v="traffic_signals"/></node>
  <way id="10"><nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="residential"/><tag k="lanes" v="2"/>
    <tag k="maxspeed" v="36"/><tag k="oneway" v="yes"/></way>
</osm>`;

describe("lane geometry and local traffic preview", () => {
  it("smoothes visual corners without moving endpoints", () => {
    const points = [
      new Vector3(0, 1, 0), new Vector3(20, 1, 0),
      new Vector3(20, 1, 20),
    ];
    const original = points.map((p) => p.clone());
    const smooth = smoothRoadPoints(points, 8);
    expect(smooth.length).toBeGreaterThan(points.length);
    expect(smooth[0].equals(points[0])).toBe(true);
    expect(smooth[smooth.length - 1].equals(points[2])).toBe(true);
    expect(points.every((p, i) => p.equals(original[i]))).toBe(true);
    const lane = laneCenterline(smooth, 7, 2, 0);
    expect(lane.length).toBe(smooth.length);
  });

  it("spawns vehicles on an OSM road, respects one-way and speed", () => {
    const model = new TrafficModel(parseOsm(oneWay));
    expect(model.available).toBe(1);
    const ids = model.add(2, "10");
    expect(ids).toHaveLength(2);
    const car = model.cars.get(ids[0])!;
    expect(car.edge.from).toBe("1");
    expect(car.edge.to).toBe("2");
    expect(car.speed).toBeLessThanOrEqual(10);
    expect(model.pose(car).x).toBeTypeOf("number");
    expect(model.remove(ids[0])).toBe(true);
    model.clear();
    expect(model.size).toBe(0);
  });

  it("prevents traffic from taking a prohibited oneway direction", () => {
    const backward = oneWay.replace('v="yes"/></way>', 'v="-1"/></way>');
    const model = new TrafficModel(parseOsm(backward));
    const id = model.add(1)[0];
    expect(model.cars.get(id)!.edge.from).toBe("2");
    expect(model.cars.get(id)!.edge.to).toBe("1");
  });

  it("stops at a red signal during its red phase", () => {
    const model = new TrafficModel(parseOsm(oneWay));
    const id = model.add(1)[0];
    const car = model.cars.get(id)!;
    car.progress = 0.95;
    model.update(0.05);
    expect(car.stopped).toBe(true);
  });

  it("smoothes exported OSM geometry without changing endpoint connectivity", () => {
    const xml = `<osm version="0.6">
      <node id="1" lat="52" lon="104"/>
      <node id="2" lat="52" lon="104.001"/>
      <node id="3" lat="52.001" lon="104.001"/>
      <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/>
        <tag k="highway" v="residential"/></way>
    </osm>`;
    const doc = parseOsm(xml);
    const patch = applyEdit(doc, { type: "smooth-road", wayId: "10", radius: 9 });
    const refs = refsOf(doc.ways.get("10")!);
    expect(refs.length).toBeGreaterThan(3);
    expect(refs[0]).toBe("1");
    expect(refs[refs.length - 1]).toBe("3");
    expect(serializeOsm(doc)).toContain("<osm");
    applyPatch(doc, patch, "before");
    expect(refsOf(doc.ways.get("10")!)).toEqual(["1", "2", "3"]);
    expect(serializeOsm(doc)).toBe(xml);
  });

  it("does not smooth a shared intersection node", () => {
    const xml = `<osm version="0.6">
      <node id="1" lat="52" lon="104"/>
      <node id="2" lat="52" lon="104.001"/>
      <node id="3" lat="52.001" lon="104.001"/>
      <node id="4" lat="51.999" lon="104.001"/>
      <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/></way>
      <way id="11"><nd ref="2"/><nd ref="4"/><tag k="highway" v="residential"/></way>
    </osm>`;
    const doc = parseOsm(xml);
    expect(() => applyEdit(doc, {
      type: "smooth-road", wayId: "10",
    })).toThrow("Общие перекрёстки");
    expect(refsOf(doc.ways.get("10")!)).toEqual(["1", "2", "3"]);
  });

  it("parses speeds and applies conservative limits", () => {
    expect(speedMetersPerSecond({ maxspeed: "36" })).toBeCloseTo(10);
    expect(speedMetersPerSecond({ maxspeed: "999" })).toBeCloseTo(130 / 3.6);
  });
});
