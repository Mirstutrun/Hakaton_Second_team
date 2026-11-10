import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core";
import { parseOsm } from "../src/core/osm/parser";
import { smoothRoadPoints, laneCenterline } from "../src/engine/geometry/roads";
import { TrafficModel, speedMetersPerSecond } from "../src/engine/TrafficModel";

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

  it("removes a vehicle that reaches the end of the road", () => {
    const model = new TrafficModel(parseOsm(oneWay));
    const id = model.add(1)[0];
    const car = model.cars.get(id)!;
    car.progress = 0.99;
    for (let i = 0; i < 20; i++) model.update(0.1);
    // В тупике машина исчезает, а не ждёт: ожидающих машин не остаётся.
    expect(model.cars.has(id)).toBe(false);
    expect(model.finished).toContain(id);
    expect(model.metrics.stopped).toBe(0);
  });

  it("ignores traffic signals in the local preview", () => {
    const model = new TrafficModel(parseOsm(oneWay));
    const car = model.cars.get(model.add(1)[0])!;
    car.progress = 0.5;
    model.update(0.05);
    expect(car.stopped).toBe(false);
  });

  it("lets oncoming cars pass on a single-lane two-way road instead of deadlocking", () => {
    // Узкий проезд 1—2—3: машины едут навстречу друг другу и встречаются у узла 2.
    const narrow = `<osm version="0.6">
      <node id="1" lat="52" lon="104"/><node id="2" lat="52" lon="104.0006"/><node id="3" lat="52" lon="104.0012"/>
      <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="service"/></way>
    </osm>`;
    const model = new TrafficModel(parseOsm(narrow));
    const east = model.addAt("10", "1", "2", 0.9)!, west = model.addAt("10", "3", "2", 0.9)!;
    const a = model.cars.get(east)!, b = model.cars.get(west)!;
    // Каждое направление держится своего правого края: машины не едут лоб в лоб.
    expect(Math.abs(model.pose(a).z - model.pose(b).z)).toBeGreaterThan(1.2);
    let longestWait = 0;
    for (let i = 0; i < 400; i++) {
      model.update(0.05);
      for (const car of model.cars.values()) longestWait = Math.max(longestWait, car.waited ?? 0);
    }
    // Обе проехали дорогу насквозь и исчезли в её концах; никто не ждал.
    expect(model.finished).toEqual(expect.arrayContaining([east, west]));
    expect(longestWait).toBeLessThan(1);
  });

  it("removes a vehicle that has been waiting too long", () => {
    const model = new TrafficModel(parseOsm(oneWay.replace("104.0004", "104.01")));
    const front = model.cars.get(model.addAt("10", "1", "2", 0.5, 0)!)!;
    const rearId = model.addAt("10", "1", "2", 0.4, 0)!;
    front.speed = 0; // затор: передняя машина не едет
    for (let i = 0; i < 60; i++) model.update(0.1);
    expect(model.cars.has(rearId)).toBe(true); // 6 с — ещё ждёт
    for (let i = 0; i < 300; i++) model.update(0.1);
    expect(model.cars.has(rearId)).toBe(false); // простой дольше 8 с — убрана с карты
    expect(model.finished).toContain(rearId);
    expect(model.metrics.stopped).toBe(0);
  });

  it("drives on the right by default", () => {
    const twoWay = oneWay.replace('<tag k="oneway" v="yes"/>', "");
    const model = new TrafficModel(parseOsm(twoWay));
    expect(model.drivingSide).toBe("right");
    // Дорога идёт на восток: попутная машина — южнее оси (справа по ходу).
    const car = model.cars.get(model.addAt("10", "1", "2", 0.5, 0)!)!;
    const axis = (car.edge.a.z + car.edge.b.z) / 2;
    expect(model.pose(car).z).toBeLessThan(axis);
  });

  it("parses speeds and applies conservative limits", () => {
    expect(speedMetersPerSecond({ maxspeed: "36" })).toBeCloseTo(10);
    expect(speedMetersPerSecond({ maxspeed: "999" })).toBeCloseTo(130 / 3.6);
  });
});
