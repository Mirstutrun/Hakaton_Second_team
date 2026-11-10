import { describe, expect, it } from "vitest";
import { parseOsm } from "../src/core/osm/parser";
import { serializeOsm } from "../src/core/osm/serializer";
import { drivingLanes, oneWayDirection, laneTagInfo } from "../src/engine/trafficRules";
import { TrafficModel, speedMetersPerSecond } from "../src/engine/TrafficModel";
const xml = (tags = '') => `<osm version="0.6"><node id="1" lat="52" lon="104"/><node id="2" lat="52" lon="104.002"/><way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="lanes" v="4"/>${tags}</way></osm>`;

describe("traffic direction regressions", () => {
  for (const side of ["left", "right"] as const) {
    it(`keeps every lane on the ${side} in both directions, including invalid lane input`, () => {
      const model = new TrafficModel(parseOsm(xml()), side);
      for (const [from, to] of [["1", "2"], ["2", "1"]]) {
        for (const lane of [0, 1, 2, 99, -1]) {
          model.clear();
          const id = model.addAt("10", from, to, 0.4, lane)!;
          const car = model.cars.get(id)!;
          const p = model.pose(car), e = car.edge;
          const cross = (e.b.x-e.a.x)*(p.z-e.a.z)-(e.b.z-e.a.z)*(p.x-e.a.x);
          expect(Math.sign(cross)).toBe(side === "left" ? 1 : -1);
        }
      }
    });
    it(`clicking all four physical lanes chooses legal direction (${side})`, () => {
      const model = new TrafficModel(parseOsm(xml()), side);
      for (let lane=0;lane<4;lane++) {
        model.clear();
        const car = model.cars.get(model.addOnLane("10", "1", "2", 0.3, lane)!)!;
        expect(car.edge.laneIndices[car.lane]).toBe(lane);
        expect(car.edge.from).toBe((side === "left" ? lane >= 2 : lane < 2) ? "1" : "2");
        expect(car.progress).toBeCloseTo(car.edge.from === "1" ? 0.3 : 0.7);
      }
    });
  }
  it("orders OSM lane tags left-to-right in either travel direction", () => {
    expect(laneTagInfo({}, 4, 3, "left")).toMatchObject({index:0,suffix:":forward"});
    expect(laneTagInfo({}, 4, 0, "left")).toMatchObject({index:0,suffix:":backward"});
    expect(laneTagInfo({oneway:"-1"}, 3, 0, "left")).toMatchObject({index:0,suffix:""});
  });
  it("respects asymmetric counts and excludes the shared turning lane", () => {
    expect(drivingLanes({ "lanes:forward":"2", "lanes:backward":"1", "lanes:both_ways":"1" },4,"left"))
      .toEqual({forward:[3,2],backward:[0]});
    expect(drivingLanes({ "lanes:forward":"1", "lanes:backward":"2" },3,"right"))
      .toEqual({forward:[0],backward:[2,1]});
  });
  it("recognises numeric oneway and explicit roundabout override", () => {
    expect(oneWayDirection({oneway:"1"})).toBe(1);
    expect(oneWayDirection({junction:"roundabout",oneway:"no"})).toBe(0);
    const model = new TrafficModel(parseOsm(xml('<tag k="oneway" v="-1"/>')));
    expect(model.addAt("10","1","2",0.4)).toBeNull();
    expect(model.addOnLane("10","1","2",0.4,3)).not.toBeNull();
  });
  it("rejects overlapping spawns, including buses, and preserves a gap at high speed", () => {
    const model = new TrafficModel(parseOsm(xml()));
    const front = model.cars.get(model.addAt("10","1","2",0.5)!)!;
    expect(model.addAt("10","1","2",0.5)).toBeNull();
    const rear = model.cars.get(model.addAt("10","1","2",0.3)!)!;
    front.speed = 0; rear.speed = 36;
    for(let i=0;i<100;i++) model.update(0.1,4);
    expect((front.progress-rear.progress)*front.edge.length).toBeGreaterThanOrEqual(6.09);
  });
  it("does not make a U-turn at a dead end or change source XML", () => {
    const doc = parseOsm(xml());
    const source = serializeOsm(doc);
    const model = new TrafficModel(doc);
    const car = model.cars.get(model.addAt("10","1","2",0.96)!)!;
    for(let i=0;i<100;i++) model.update(0.1,4);
    expect(car.edge.to).toBe("2");
    expect(car.stopped).toBe(true);
    expect(serializeOsm(doc)).toBe(source);
  });
  it("converts mph and honours a zero speed limit", () => {
    expect(speedMetersPerSecond({maxspeed:"30 mph"})).toBeCloseTo(13.4112);
    expect(speedMetersPerSecond({maxspeed:"0"})).toBe(0);
  });

});
