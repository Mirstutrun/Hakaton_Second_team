import { describe, expect, it } from "vitest";
import { parseOsm } from "../src/core/osm/parser";
import { serializeOsm } from "../src/core/osm/serializer";
import { drivingLanes, oneWayDirection, laneTagInfo, laneDirections, laneDirectionTags, normalizeLaneDirections } from "../src/engine/trafficRules";
import { applyEdit } from "../src/core/osm/commands";
import { applyPatch } from "../src/core/osm/commands";
import { laneConnections, planLaneLink, planRoadLink } from "../src/core/osm/laneConnectivity";
import { refsOf, tagsOf } from "../src/core/osm/model";
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
  it("leaves the map at a dead end instead of a U-turn, without changing source XML", () => {
    const doc = parseOsm(xml());
    const source = serializeOsm(doc);
    const model = new TrafficModel(doc);
    const id = model.addAt("10","1","2",0.96)!;
    const car = model.cars.get(id)!;
    for(let i=0;i<100;i++) model.update(0.1,4);
    expect(car.edge.to).toBe("2"); // разворота не было
    expect(model.cars.has(id)).toBe(false); // машина исчезла в конце дороги
    expect(serializeOsm(doc)).toBe(source);
  });
  it("converts mph and honours a zero speed limit", () => {
    expect(speedMetersPerSecond({maxspeed:"30 mph"})).toBeCloseTo(13.4112);
    expect(speedMetersPerSecond({maxspeed:"0"})).toBe(0);
  });

});

describe("lane count and per-lane direction editor", () => {
  it("reads per-lane directions from OSM tags (right-hand traffic)", () => {
    expect(laneDirections({ lanes: "3", oneway: "yes" }, 3, "right")).toEqual(["forward", "forward", "forward"]);
    expect(laneDirections({ lanes: "1" }, 1, "right")).toEqual(["both"]);
    // Попутные полосы справа по ходу линии дороги (индекс 0 — крайняя правая).
    expect(laneDirections({ lanes: "3", "lanes:forward": "1", "lanes:backward": "2" }, 3, "right"))
      .toEqual(["forward", "backward", "backward"]);
  });
  it("normalizes a toggled lane into a layout OSM can store", () => {
    expect(normalizeLaneDirections(["backward", "forward", "backward"], "right"))
      .toEqual(["forward", "backward", "backward"]);
    expect(normalizeLaneDirections(["backward", "backward"], "right")).toEqual(["backward", "backward"]);
  });
  it("writes lanes, oneway and directional counts", () => {
    expect(laneDirectionTags({ highway: "residential" }, ["forward", "forward"]))
      .toMatchObject({ lanes: "2", oneway: "yes", "lanes:forward": null, "lanes:backward": null });
    expect(laneDirectionTags({ highway: "residential", oneway: "yes" }, ["forward", "backward", "backward"]))
      .toMatchObject({ lanes: "3", oneway: null, "lanes:forward": "1", "lanes:backward": "2" });
    expect(laneDirectionTags({ highway: "residential" }, ["backward"])).toMatchObject({ lanes: "1", oneway: "-1" });
    expect(laneDirectionTags({ highway: "residential", oneway: "yes" }, ["both"])).toMatchObject({ lanes: "1", oneway: null });
    // Круговое движение одностороннее по умолчанию: двустороннее указывается явно.
    expect(laneDirectionTags({ highway: "primary", junction: "roundabout" }, ["forward", "backward"]))
      .toMatchObject({ oneway: "no" });
  });
  it("drops per-lane tags whose lane count no longer matches", () => {
    const tags = {
      highway: "secondary", lanes: "6", "lanes:forward": "3", "lanes:backward": "3",
      "turn:lanes:forward": "through|through|right", "turn:lanes:backward": "left|through|through",
      "maxspeed:lanes": "60|60|60|60|60|60",
    };
    // 3+3 → 2+3: теги встречного направления верны, попутного и общий — уже нет.
    const next = laneDirectionTags(tags, ["forward", "forward", "backward", "backward", "backward"]);
    expect(next).toMatchObject({ lanes: "5", "lanes:forward": "2", "lanes:backward": "3" });
    expect(next["turn:lanes:forward"]).toBeNull();
    expect(next["maxspeed:lanes"]).toBeNull();
    expect("turn:lanes:backward" in next).toBe(false);
    // Раскладка не изменилась — теги по полосам остаются.
    const same = laneDirectionTags(tags, ["forward", "forward", "forward", "backward", "backward", "backward"]);
    expect(Object.keys(same).filter((key) => key.includes(":lanes:") && key.startsWith("turn"))).toEqual([]);
    // Дорога стала односторонней: встречных полос нет.
    expect(laneDirectionTags(tags, ["forward", "forward", "forward"])["turn:lanes:backward"]).toBeNull();
  });
  it("applies the tags through the editor and the preview follows them", () => {
    const doc = parseOsm(xml());
    applyEdit(doc, { type: "set-tags", target: { type: "way", id: "10" },
      tags: laneDirectionTags(tagsOf(doc.ways.get("10")!), ["forward", "forward", "forward", "backward"]) });
    expect(tagsOf(doc.ways.get("10")!)).toMatchObject({ lanes: "4", "lanes:forward": "3", "lanes:backward": "1" });
    expect(drivingLanes(tagsOf(doc.ways.get("10")!), 4, "right")).toEqual({ forward: [0, 1, 2], backward: [3] });
  });
});

describe("manual lane connection (hotkey J)", () => {
  const junction = `<osm version="0.6">
    <node id="1" lat="52" lon="104"/><node id="2" lat="52" lon="104.001"/>
    <node id="3" lat="52.001" lon="104.001"/><node id="4" lat="51.999" lon="104.001"/>
    <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="lanes" v="2"/><tag k="oneway" v="yes"/></way>
    <way id="11"><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/><tag k="lanes" v="2"/></way>
    <way id="12"><nd ref="4"/><nd ref="2"/><tag k="highway" v="residential"/></way>
  </osm>`;
  it("connects the selected lane with a lane of another road at their junction", () => {
    const doc = parseOsm(junction);
    const command = planLaneLink(doc, { wayId: "10", lane: 1 }, { wayId: "11", lane: 0 }, "right");
    expect(command).toMatchObject({ via: "2", fromNode: "1", toNode: "3" });
    applyEdit(doc, command);
    expect(laneConnections(doc)).toHaveLength(1);
    expect(laneConnections(doc)[0]).toMatchObject({ fromWay: "10", toWay: "11", via: "2" });
  });
  it("explains why lanes cannot be connected", () => {
    const doc = parseOsm(junction);
    // Полоса 1 дороги 11 ведёт к перекрёстку, а не от него.
    expect(() => planLaneLink(doc, { wayId: "10", lane: 0 }, { wayId: "11", lane: 1 }, "right"))
      .toThrow("не ведут через общий перекрёсток");
    const apart = parseOsm(junction.replace('<nd ref="2"/><nd ref="3"/>', '<nd ref="3"/><nd ref="4"/>'));
    expect(() => planLaneLink(apart, { wayId: "10", lane: 0 }, { wayId: "11", lane: 0 }, "right"))
      .toThrow("нет общего перекрёстка");
  });
});

describe("J connects roads that are not joined yet", () => {
  // Дорога 10 идёт на восток; дорога 11 начинается севернее неё и уходит на север.
  const apart = (gapLat: string) => `<osm version="0.6">
    <node id="1" lat="52" lon="104"/><node id="2" lat="52" lon="104.001"/>
    <node id="3" lat="${gapLat}" lon="104.0005"/><node id="4" lat="52.0006" lon="104.0005"/>
    <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
    <way id="11"><nd ref="3"/><nd ref="4"/><tag k="highway" v="residential"/></way>
  </osm>`;
  const click = { lat: 52, lon: 104.0003 };

  it("extends a distant road end to the clicked point of the other road", () => {
    const source = apart("52.0002"); // конец в 22 м от дороги 10
    const doc = parseOsm(source);
    const command = planRoadLink(doc, { wayId: "11", lane: 0 }, { wayId: "10", lane: 0, near: click }, "right");
    expect(command).toMatchObject({ type: "connect-roads", wayId: "11", nodeId: "3" });
    const patch = applyEdit(doc, command);
    const joint = refsOf(doc.ways.get("11")!)[0];
    // Дорога продлена: прежний конец остался, новый узел общий с дорогой 10 в месте клика.
    expect(refsOf(doc.ways.get("11")!)).toEqual([joint, "3", "4"]);
    expect(refsOf(doc.ways.get("10")!)).toEqual(["1", joint, "2"]);
    expect(Number(doc.nodes.get(joint)!.getAttribute("lon"))).toBeCloseTo(104.0003, 6);
    applyPatch(doc, patch, "before");
    expect(serializeOsm(doc)).toBe(source);
  });

  it("snaps a road end that is already next to the other road", () => {
    const doc = parseOsm(apart("52.00002")); // конец в 2 м от дороги 10
    applyEdit(doc, planRoadLink(doc, { wayId: "11", lane: 0 }, { wayId: "10", lane: 0, near: click }, "right"));
    const joint = refsOf(doc.ways.get("11")!)[0];
    // Конец подтянут к ближайшей точке дороги 10, а не к месту клика; старый узел убран.
    expect(refsOf(doc.ways.get("11")!)).toEqual([joint, "4"]);
    expect(refsOf(doc.ways.get("10")!)).toEqual(["1", joint, "2"]);
    expect(doc.nodes.has("3")).toBe(false);
    expect(Number(doc.nodes.get(joint)!.getAttribute("lon"))).toBeCloseTo(104.0005, 6);
  });

  it("links lanes on the second J once the roads share a node", () => {
    const doc = parseOsm(apart("52.0002"));
    applyEdit(doc, planRoadLink(doc, { wayId: "11", lane: 0 }, { wayId: "10", lane: 0, near: click }, "right"));
    // Полоса 1 дороги 11 ведёт к новому перекрёстку, полоса 0 дороги 10 — от него на восток.
    const second = planRoadLink(doc, { wayId: "11", lane: 1 }, { wayId: "10", lane: 0, near: { lat: 52, lon: 104.0006 } }, "right");
    expect(second.type).toBe("connect-lanes");
    applyEdit(doc, second);
    expect(laneConnections(doc)).toHaveLength(1);
  });

  it("refuses footways, bridges and roads without a free end", () => {
    const footway = parseOsm(apart("52.0002").replace('<nd ref="4"/><tag k="highway" v="residential"/>', '<nd ref="4"/><tag k="highway" v="footway"/>'));
    expect(() => planRoadLink(footway, { wayId: "11", lane: 0 }, { wayId: "10", lane: 0, near: click }, "right"))
      .toThrow("автомобильные дороги");
    const bridge = parseOsm(apart("52.0002").replace('<nd ref="2"/><tag k="highway" v="residential"/>', '<nd ref="2"/><tag k="highway" v="residential"/><tag k="bridge" v="yes"/><tag k="layer" v="1"/>'));
    const plan = planRoadLink(bridge, { wayId: "11", lane: 0 }, { wayId: "10", lane: 0, near: click }, "right");
    expect(() => applyEdit(bridge, plan)).toThrow("одного уровня");
    expect(refsOf(bridge.ways.get("11")!)).toEqual(["3", "4"]);
  });
});
