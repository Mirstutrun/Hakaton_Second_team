import { expect, it } from "vitest";
import { applyEdit, type EditCommand } from "../src/core/osm/commands";
import { parseOsm } from "../src/core/osm/parser";
import { serializeOsm } from "../src/core/osm/serializer";

const source = `<osm version="0.6">
<node id="1" lat="52" lon="104"/><node id="2" lat="52" lon="104.001"/>
<node id="3" lat="52.001" lon="104.001"/><node id="4" lat="52.001" lon="104"/>
<node id="5" lat="52" lon="103.999"/>
<way id="10"><nd ref="5"/><nd ref="1"/><tag k="highway" v="residential"/></way>
<way id="20"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/><tag k="building" v="yes"/></way>
</osm>`;
const commands: EditCommand[] = [
  { type: "delete-way", id: "20" },
  { type: "set-tags", target: { type: "way", id: "20" }, tags: { height: "20" } },
  { type: "remove-vertex", wayId: "20", index: 2 },
  { type: "insert-node", wayId: "20", index: 1, point: { lat: 52, lon: 104.0005 } },
  { type: "move-node", id: "1", coordinate: { lat: 51.9999, lon: 104 } },
];

it.each(commands)("protects a building from $type and rolls the transaction back", command => {
  const doc = parseOsm(source);
  expect(() => applyEdit(doc, command)).toThrow("Здания доступны только для просмотра");
  const elements = (xml: XMLDocument) => Array.from(xml.documentElement.children, element => element.outerHTML);
  expect(elements(doc.xml)).toEqual(elements(parseOsm(source).xml));
});

it("protects untagged contours of a multipolygon and shared road nodes", () => {
  const xml = source.replace('<tag k="building" v="yes"/>', '').replace('</osm>',
    '<relation id="30"><member type="way" ref="20" role="outer"/><tag k="type" v="multipolygon"/><tag k="building" v="yes"/></relation></osm>');
  const doc = parseOsm(xml);
  expect(() => applyEdit(doc, { type: "move-node", id: "1", coordinate: { lat: 51.999, lon: 104 } })).toThrow("Здания доступны только для просмотра");
  expect(serializeOsm(doc)).toBe(serializeOsm(parseOsm(xml)));
});

it("rejects creating a building via generic road tags", () => {
  const doc = parseOsm(source);
  expect(() => applyEdit(doc, {
    type: "create-road", points: [{ lat: 51.99, lon: 103.99 }, { lat: 51.99, lon: 103.991 }],
    tags: { building: "yes" },
  })).toThrow("Здания доступны только для просмотра");
  expect(doc.nodes.size).toBe(5);
  expect(doc.ways.size).toBe(2);
});
