import { describe, expect, it } from "vitest";
import { parseOsm } from "../src/core/osm/parser";
import { serializeOsm } from "../src/core/osm/serializer";
import { auditGeometry } from "../src/core/osm/geometryAudit";
import { applyEdit, applyPatch } from "../src/core/osm/commands";
import { refsOf } from "../src/core/osm/model";

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
    expect(issues.some((issue) => issue.code === "unconnected-crossing")).toBe(true);
    expect(issues.some((issue) => issue.code === "road-building-overlap")).toBe(true);
    expect(issues.some((issue) => issue.code === "isolated-component")).toBe(true);
  });

  it("joins an at-grade crossing transactionally and survives OSM roundtrip", () => {
    const doc = parseOsm(crossing);
    const suggestion = auditGeometry(doc).find((issue) =>
      issue.code === "unconnected-crossing" && issue.fix);
    expect(suggestion?.fix).toBeDefined();
    const patch = applyEdit(doc, { type: "connect-crossing", ...suggestion!.fix! });
    const a = refsOf(doc.ways.get("10")!);
    const b = refsOf(doc.ways.get("11")!);
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    expect(a[1]).toBe(b[1]);
    expect(auditGeometry(doc).some((issue) => issue.code === "unconnected-crossing")).toBe(false);
    expect(auditGeometry(doc).some((issue) => issue.code === "isolated-component")).toBe(false);
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
    expect(auditGeometry(doc).some((issue) => issue.code === "unconnected-crossing")).toBe(false);
    expect(() => applyEdit(doc, {
      type: "connect-crossing", wayA: "10", indexA: 1, wayB: "11",
      indexB: 1, coordinate: { lat: 52.0001, lon: 104.0001 },
    })).toThrow("уровни");
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
    const suggestion = auditGeometry(doc).find((issue) =>
      issue.code === "near-disconnection" && issue.fix?.kind === "attach-endpoint");
    expect(suggestion?.fix?.kind).toBe("attach-endpoint");
    if (suggestion?.fix?.kind !== "attach-endpoint") throw new Error("No snap suggestion");
    const patch = applyEdit(doc, { type: "attach-endpoint", ...suggestion.fix });
    expect(refsOf(doc.ways.get("10")!)).toContain("3");
    expect(refsOf(doc.ways.get("11")!)).toContain("3");
    expect(auditGeometry(doc).some((issue) => issue.code === "near-disconnection")).toBe(false);
    applyPatch(doc, patch, "before");
    expect(serializeOsm(doc)).toBe(source);
  });

  it("refuses to create a stale or off-segment junction", () => {
    const doc = parseOsm(crossing);
    const source = serializeOsm(doc);
    expect(() => applyEdit(doc, {
      type: "connect-crossing", wayA: "10", indexA: 1, wayB: "11",
      indexB: 1, coordinate: { lat: 52.00015, lon: 104.00019 },
    })).toThrow("не лежит");
    expect(serializeOsm(doc)).toBe(source);
  });
});
