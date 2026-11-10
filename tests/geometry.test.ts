import { describe, expect, it } from "vitest";
import { parseOsm } from "../src/core/osm/parser";
import { serializeOsm } from "../src/core/osm/serializer";
import { auditGeometry } from "../src/core/osm/geometryAudit";
import { applyEdit, applyPatch } from "../src/core/osm/commands";
import { refsOf, tagsOf } from "../src/core/osm/model";
import { networkConnectivity } from "../src/core/osm/connectivity";

const crossing = `<osm version="0.6">
<node id="1" lat="52.00000" lon="104.00000"/>
<node id="2" lat="52.00020" lon="104.00020"/>
<node id="3" lat="52.00020" lon="104.00000"/>
<node id="4" lat="52.00000" lon="104.00020"/>
<node id="5" lat="52.00008" lon="104.00008"/>
<node id="6" lat="52.00008" lon="104.00012"/>
<node id="7" lat="52.00012" lon="104.00012"/>
<node id="8" lat="52.00012" lon="104.00008"/>
<way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
<way id="11"><nd ref="3"/><nd ref="4"/><tag k="highway" v="residential"/></way>
<way id="12"><nd ref="5"/><nd ref="6"/><nd ref="7"/><nd ref="8"/><nd ref="5"/><tag k="building" v="yes"/></way>
</osm>`;

describe("geometry quality assurance", () => {
  it("finds roads crossing without a shared node and roads through buildings", () => {
    const doc = parseOsm(crossing);
    const issues = auditGeometry(doc);
    expect(issues.some((issue) => issue.code === "unconnected-crossing")).toBe(
      true,
    );
    expect(issues.some((issue) => issue.code === "road-building-overlap")).toBe(
      true,
    );
    expect(issues.some((issue) => issue.code === "isolated-component")).toBe(
      true,
    );
  });

  it("joins an at-grade crossing transactionally and survives OSM roundtrip", () => {
    const doc = parseOsm(crossing);
    const suggestion = auditGeometry(doc).find(
      (issue) => issue.code === "unconnected-crossing" && issue.fix,
    );
    expect(suggestion?.fix).toBeDefined();
    const fix = suggestion!.fix!;
    if (fix.kind !== "connect-crossing")
      throw new Error("Ожидалось пересечение");
    const patch = applyEdit(doc, { type: "connect-crossing", ...fix });
    const a = refsOf(doc.ways.get("10")!);
    const b = refsOf(doc.ways.get("11")!);
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    expect(a[1]).toBe(b[1]);
    expect(
      auditGeometry(doc).some((issue) => issue.code === "unconnected-crossing"),
    ).toBe(false);
    expect(
      auditGeometry(doc).some((issue) => issue.code === "isolated-component"),
    ).toBe(false);
    expect(serializeOsm(parseOsm(serializeOsm(doc)))).toBe(serializeOsm(doc));
    applyPatch(doc, patch, "before");
    expect(serializeOsm(doc)).toBe(crossing);
    applyPatch(doc, patch, "after");
    expect(refsOf(doc.ways.get("10")!)[1]).toBe(refsOf(doc.ways.get("11")!)[1]);
  });

  it("never offers connecting an elevated crossing", () => {
    const source = crossing.replace(
      '<tag k="highway" v="residential"/></way>\n<way id="12">',
      '<tag k="highway" v="residential"/><tag k="bridge" v="yes"/><tag k="layer" v="1"/></way>\n<way id="12">',
    );
    const doc = parseOsm(source);
    expect(
      auditGeometry(doc).some((issue) => issue.code === "unconnected-crossing"),
    ).toBe(false);
    expect(() =>
      applyEdit(doc, {
        type: "connect-crossing",
        wayA: "10",
        indexA: 1,
        wayB: "11",
        indexB: 1,
        coordinate: { lat: 52.0001, lon: 104.0001 },
      }),
    ).toThrow("уровни");
  });

  it("snaps a near-miss endpoint into a shared OSM node and undoes cleanly", () => {
    const source = `<osm version="0.6">
      <node id="1" lat="52.0" lon="104.0"/>
      <node id="2" lat="52.0" lon="104.0002"/>
      <node id="3" lat="52.00001" lon="104.0001"/>
      <node id="4" lat="52.0001" lon="104.0001"/>
      <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
      <way id="11"><nd ref="3"/><nd ref="4"/><tag k="highway" v="residential"/></way>
    </osm>`;
    const doc = parseOsm(source);
    const suggestion = auditGeometry(doc).find(
      (issue) =>
        issue.code === "near-disconnection" &&
        issue.fix?.kind === "attach-endpoint",
    );
    expect(suggestion?.fix?.kind).toBe("attach-endpoint");
    if (suggestion?.fix?.kind !== "attach-endpoint")
      throw new Error("No snap suggestion");
    const patch = applyEdit(doc, {
      type: "attach-endpoint",
      ...suggestion.fix,
    });
    expect(refsOf(doc.ways.get("10")!)).toContain("3");
    expect(refsOf(doc.ways.get("11")!)).toContain("3");
    expect(
      auditGeometry(doc).some((issue) => issue.code === "near-disconnection"),
    ).toBe(false);
    applyPatch(doc, patch, "before");
    expect(serializeOsm(doc)).toBe(source);
  });

  it("refuses to create a stale or off-segment junction", () => {
    const doc = parseOsm(crossing);
    const source = serializeOsm(doc);
    expect(() =>
      applyEdit(doc, {
        type: "connect-crossing",
        wayA: "10",
        indexA: 1,
        wayB: "11",
        indexB: 1,
        coordinate: { lat: 52.00015, lon: 104.00019 },
      }),
    ).toThrow("не лежит");
    expect(serializeOsm(doc)).toBe(source);
  });
});

describe("audit false positives that painted correct roads red", () => {
  // Дом и проезд под ним: подъезды касаются стены в общих узлах 3 и 4.
  const passage = (tags: string) => `<osm version="0.6">
<bounds minlat="51.99" minlon="103.99" maxlat="52.01" maxlon="104.01"/>
<node id="1" lat="52.00000" lon="103.99950"/><node id="2" lat="52.00000" lon="104.00050"/>
<node id="3" lat="52.00000" lon="103.99980"/><node id="4" lat="52.00000" lon="104.00020"/>
<node id="5" lat="51.99990" lon="104.00020"/><node id="6" lat="52.00010" lon="104.00020"/>
<node id="7" lat="52.00010" lon="103.99980"/><node id="8" lat="51.99990" lon="103.99980"/>
<way id="10"><nd ref="1"/><nd ref="3"/><tag k="highway" v="service"/></way>
<way id="11"><nd ref="3"/><nd ref="4"/><tag k="highway" v="service"/>${tags}</way>
<way id="12"><nd ref="4"/><nd ref="2"/><tag k="highway" v="service"/></way>
<way id="20"><nd ref="8"/><nd ref="3"/><nd ref="7"/><nd ref="6"/><nd ref="4"/><nd ref="5"/><nd ref="8"/><tag k="building" v="yes"/></way>
</osm>`;
  const codes = (source: string) => auditGeometry(parseOsm(source)).map((i) => i.code + ":" + i.id);

  it("does not flag roads that only touch a wall where a passage continues", () => {
    expect(codes(passage('<tag k="covered" v="yes"/>'))).toEqual([]);
    expect(codes(passage('<tag k="tunnel" v="building_passage"/>'))).toEqual([]);
  });
  it("still flags a road that runs through the building at grade", () => {
    expect(codes(passage(""))).toContain("road-building-overlap:11");
  });
  it("flags a passage under a building mapped as underground and fixes it in one click", () => {
    const doc = parseOsm(passage('<tag k="tunnel" v="yes"/><tag k="layer" v="-1"/>'));
    const issue = auditGeometry(doc).find((i) => i.code === "underground-passage");
    expect(issue?.id).toBe("11");
    if (issue?.fix?.kind !== "ground-passage") throw new Error("Нет исправления");
    applyEdit(doc, { type: "set-tags", target: { type: "way", id: "11" }, tags: issue.fix.tags });
    expect(auditGeometry(doc)).toEqual([]);
  });
  it("turns a road through a building into an arch without dimensions", () => {
    const doc = parseOsm(passage('<tag k="layer" v="-1"/>').replace(
      '<way id="11"><nd ref="3"/><nd ref="4"/>',
      '<way id="11"><nd ref="1"/><nd ref="2"/>',
    ).replace('<way id="10"><nd ref="1"/><nd ref="3"/><tag k="highway" v="service"/></way>', "")
      .replace('<way id="12"><nd ref="4"/><nd ref="2"/><tag k="highway" v="service"/></way>', ""));
    expect(codes(serializeOsm(doc))).toContain("road-building-overlap:11");
    const patch = applyEdit(doc, { type: "mark-building-passage", wayId: "11", buildingId: "20" });
    const arch = tagsOf(doc.ways.get(patch.selection!.id)!);
    expect(arch).toMatchObject({ tunnel: "building_passage", covered: "yes" });
    expect(arch.maxheight).toBeUndefined();
    // Подъезды без отрицательного layer: Webots не импортирует дороги ниже земли.
    for (const way of doc.ways.values())
      if (tagsOf(way).highway) expect(tagsOf(way).layer).toBeUndefined();
    expect(auditGeometry(doc)).toEqual([]);
  });
  it("does not report a loop end or a short stub as a near disconnection", () => {
    // «Леденец»: подъезд 11 → петля 10, которая заканчивается на своём же узле 2
    // в полутора метрах от начала (как way 1495613242 в карте организаторов).
    const loop = `<osm version="0.6">
      <node id="1" lat="52" lon="104"/><node id="2" lat="52.000005" lon="104.00002"/>
      <node id="3" lat="52.0002" lon="104.0003"/><node id="4" lat="52.0002" lon="104.0001"/>
      <node id="9" lat="52" lon="103.9997"/>
      <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="2"/><tag k="highway" v="service"/></way>
      <way id="11"><nd ref="9"/><nd ref="1"/><tag k="highway" v="service"/></way>
    </osm>`;
    const stub = `<osm version="0.6">
      <node id="1" lat="52" lon="104"/><node id="2" lat="52" lon="104.0004"/>
      <node id="3" lat="52.00002" lon="104.00022"/><node id="4" lat="52" lon="104.0002"/>
      <way id="10"><nd ref="1"/><nd ref="4"/><nd ref="2"/><tag k="highway" v="service"/></way>
      <way id="11"><nd ref="4"/><nd ref="3"/><tag k="highway" v="service"/></way>
    </osm>`;
    expect(codes(loop).filter((c) => c.startsWith("near"))).toEqual([]);
    expect(codes(stub).filter((c) => c.startsWith("near"))).toEqual([]);
  });
  it("treats network pieces cut by the extract boundary as normal", () => {
    const piece = (lon: string) => `<osm version="0.6">
      <bounds minlat="51.999" minlon="103.999" maxlat="52.001" maxlon="104.001"/>
      <node id="1" lat="52" lon="104"/><node id="2" lat="52" lon="104.0005"/>
      <node id="3" lat="52.0005" lon="104"/><node id="4" lat="52.0005" lon="${lon}"/>
      <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
      <way id="11"><nd ref="3"/><nd ref="4"/><tag k="highway" v="residential"/></way>
    </osm>`;
    expect(codes(piece("104.0004"))).toContain("isolated-component:11");
    expect(codes(piece("104.0030")).filter((c) => c.startsWith("isolated"))).toEqual([]);
    const network = networkConnectivity(parseOsm(piece("104.0030")));
    expect([network.isolated, network.clipped, network.connected]).toEqual([0, 1, true]);
  });
});

describe("lane edits are not blocked by existing map imprecision", () => {
  // Проезд 10 идёт в метре от стены здания 20; дорога 11 — петля, замкнутая на свой узел.
  const tight = `<osm version="0.6">
<node id="1" lat="52.00000" lon="104.00000"/><node id="2" lat="52.00000" lon="104.00060"/>
<node id="3" lat="52.00001" lon="104.00020"/><node id="4" lat="52.00001" lon="104.00040"/>
<node id="5" lat="52.00012" lon="104.00040"/><node id="6" lat="52.00012" lon="104.00020"/>
<node id="7" lat="51.99990" lon="104.00000"/><node id="8" lat="51.99970" lon="104.00010"/>
<node id="9" lat="51.99970" lon="103.99990"/>
<way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="service"/></way>
<way id="11"><nd ref="1"/><nd ref="7"/><nd ref="8"/><nd ref="9"/><nd ref="7"/><tag k="highway" v="service"/></way>
<way id="20"><nd ref="3"/><nd ref="4"/><nd ref="5"/><nd ref="6"/><nd ref="3"/><tag k="building" v="yes"/></way>
</osm>`;
  it("changes lanes and direction on a road that hugs a building", () => {
    const doc = parseOsm(tight);
    applyEdit(doc, { type: "set-tags", target: { type: "way", id: "10" }, tags: { lanes: "1", oneway: "yes" } });
    applyEdit(doc, { type: "set-tags", target: { type: "way", id: "10" }, tags: { lanes: "4", oneway: null } });
    expect(tagsOf(doc.ways.get("10")!).lanes).toBe("4");
  });
  it("changes direction on a loop that ends on its own node", () => {
    const doc = parseOsm(tight);
    applyEdit(doc, { type: "set-tags", target: { type: "way", id: "11" }, tags: { lanes: "1", oneway: "yes" } });
    expect(tagsOf(doc.ways.get("11")!).oneway).toBe("yes");
  });
  it("still rejects moving a road into the building", () => {
    const doc = parseOsm(tight);
    expect(() =>
      applyEdit(doc, { type: "move-node", id: "2", coordinate: { lat: 52.00012, lon: 104.0006 } }),
    ).toThrow("через здание");
    expect(doc.nodes.get("2")!.getAttribute("lat")).toBe("52.00000");
  });
});

it("building roofs face up and facade colours stay within one mesh", async () => {
  const { NullEngine, Scene, StandardMaterial, VertexBuffer, Vector3 } =
    await import("@babylonjs/core");
  const { buildBuilding } = await import("../src/engine/geometry/buildings");
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new StandardMaterial("building", scene);
  for (const reverse of [false, true]) {
    const points = [
      new Vector3(0, 0, 0),
      new Vector3(20, 0, 0),
      new Vector3(20, 0, 10),
      new Vector3(0, 0, 10),
    ];
    if (reverse) points.reverse();
    const mesh = buildBuilding(
      "123",
      points,
      { height: "15", min_height: "3" },
      scene,
      material,
    )!;
    expect(mesh.getBoundingInfo().boundingBox.minimum.y).toBe(3);
    expect(mesh.getBoundingInfo().boundingBox.maximum.y).toBe(15);
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    for (let i = 0; i < 4; i++) expect(normals[i * 3 + 1]).toBeGreaterThan(0.9);
    expect(mesh.getVerticesData(VertexBuffer.ColorKind)).toHaveLength(
      mesh.getTotalVertices() * 4,
    );
    // Здания выбираются кликом для редактирования (BuildingProperties).
    expect(mesh.isPickable).toBe(true);
    expect(mesh.metadata.role).toBe("building");
  }
  scene.dispose();
  engine.dispose();
});
