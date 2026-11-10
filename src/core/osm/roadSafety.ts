import { createProjection, documentOrigin } from "../geo/projection";
import {
  coordinateOf,
  refsOf,
  tagsOf,
  type EditPatch,
  type OsmDocument,
  type Tags,
} from "./model";
type Point = { x: number; z: number };
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
function distance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dz = b.z - a.z,
    t = Math.max(
      0,
      Math.min(
        1,
        ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1),
      ),
    );
  return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
}
function intersects(a: Point, b: Point, c: Point, d: Point) {
  const u = cross(a, b, c),
    v = cross(a, b, d),
    w = cross(c, d, a),
    x = cross(c, d, b);
  return (
    (((u > 0 && v < 0) || (u < 0 && v > 0)) &&
      ((w > 0 && x < 0) || (w < 0 && x > 0))) ||
    Math.min(
      distance(a, c, d),
      distance(b, c, d),
      distance(c, a, b),
      distance(d, a, b),
    ) < 0.001
  );
}
function inside(p: Point, ring: Point[]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    )
      result = !result;
  }
  return result;
}
function rings(document: OsmDocument, ways: string[]) {
  const pending = ways
    .map((id) =>
      refsOf(document.ways.get(id) ?? document.xml.createElement("way")),
    )
    .filter((r) => r.length > 1);
  const result: string[][] = [];
  while (pending.length) {
    let ring = pending.pop()!;
    while (ring[0] !== ring[ring.length - 1]) {
      const end = ring[ring.length - 1];
      const i = pending.findIndex(
        (r) => r[0] === end || r[r.length - 1] === end,
      );
      if (i < 0) break;
      const next = pending.splice(i, 1)[0];
      if (next[0] !== end) next.reverse();
      ring = ring.concat(next.slice(1));
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1])
      result.push(ring);
  }
  return result;
}
export function assertRoadEditSafe(document: OsmDocument, patch: EditPatch) {
  const projection = createProjection(documentOrigin(document));
  const project = (id: string, old = false) => {
    const before = old
      ? patch.changes.find((c) => c.type === "node" && c.id === id)
      : undefined;
    const node = before ? before.before : document.nodes.get(id);
    return node ? projection.project(coordinateOf(node)) : null;
  };
  const polygons: {
    id: string;
    outer: Point[];
    holes: Point[][];
    tags: Tags;
  }[] = [];
  const pointRing = (ids: string[]) =>
    ids.map((id) => project(id)).filter((p): p is Point => p !== null);
  const memberBuildings = new Set<string>();
  for (const [id, relation] of document.relations) {
    const tags = tagsOf(relation);
    if (
      tags.type !== "multipolygon" ||
      !tags.building ||
      tags.building === "no"
    )
      continue;
    const members = Array.from(relation.querySelectorAll('member[type="way"]'));
    const outer = members
      .filter((m) => m.getAttribute("role") !== "inner")
      .map((m) => m.getAttribute("ref")!);
    const holes = rings(
      document,
      members
        .filter((m) => m.getAttribute("role") === "inner")
        .map((m) => m.getAttribute("ref")!),
    ).map(pointRing);
    for (const ring of rings(document, outer))
      polygons.push({ id, outer: pointRing(ring), holes, tags });
    for (const member of members)
      memberBuildings.add(member.getAttribute("ref")!);
  }
  for (const [id, way] of document.ways) {
    const tags = tagsOf(way),
      refs = refsOf(way);
    if (
      tags.building &&
      tags.building !== "no" &&
      !memberBuildings.has(id) &&
      refs.length >= 4 &&
      refs[0] === refs[refs.length - 1]
    )
      polygons.push({
        id,
        outer: pointRing(refs.slice(0, -1)),
        holes: [],
        tags,
      });
  }
  const changedNodes = new Set(
    patch.changes
      .filter(
        (c) =>
          c.type === "node" &&
          (!c.before ||
            !c.after ||
            c.before.getAttribute("lat") !== c.after.getAttribute("lat") ||
            c.before.getAttribute("lon") !== c.after.getAttribute("lon")),
      )
      .map((c) => c.id),
  );
  for (const [id, way] of document.ways) {
    const tags = tagsOf(way);
    if (!tags.highway || tags.area === "yes") continue;
    const edit = patch.changes.find((c) => c.type === "way" && c.id === id);
    const refs = refsOf(way);
    if (!edit && !refs.some((id) => changedNodes.has(id))) continue;
    const oldWay = edit ? edit.before : way;
    const oldTags = oldWay ? tagsOf(oldWay) : {};
    const signature = (a: Point, b: Point, t: Tags) =>
      JSON.stringify([
        a,
        b,
        t.width,
        t.lanes,
        t.layer,
        t.bridge,
        t.tunnel,
        t.covered,
      ]);
    const oldSegments = new Set<string>();
    const oldParts: { a: Point; b: Point; tags: Tags }[] = [];
    if (!oldWay && patch.label === "set-turn-restriction")
      for (const original of patch.changes.filter(
        (c) => c.type === "way" && c.before,
      )) {
        const before = refsOf(original.before!);
        for (let j = 1; j < before.length; j++) {
          const a = project(before[j - 1], true),
            b = project(before[j], true);
          if (a && b)
            oldSegments.add(signature(a, b, tagsOf(original.before!)));
        }
      }
    if (oldWay) {
      const before = refsOf(oldWay);
      for (let i = 1; i < before.length; i++) {
        const a = project(before[i - 1], true),
          b = project(before[i], true);
        if (a && b) {
          oldSegments.add(signature(a, b, oldTags));
          oldParts.push({ a, b, tags: oldTags });
        }
      }
    }
    const points = refs.map((ref) => project(ref));
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      if (!a || !b) throw Error(`Дорога ${id}: отсутствует узел`);
      if (
        oldSegments.has(signature(a, b, tags)) ||
        oldParts.some(
          (old) =>
            signature(old.a, old.b, old.tags) ===
              signature(old.a, old.b, tags) &&
            distance(a, old.a, old.b) < 0.001 &&
            distance(b, old.a, old.b) < 0.001,
        )
      )
        continue;
      if (Math.hypot(b.x - a.x, b.z - a.z) < 0.2)
        throw Error(
          "Дорога не может содержать совпадающие или слишком близкие узлы",
        );
      for (let j = 1; j < i - 1; j++) {
        if (refs[j - 1] === refs[i] || refs[j] === refs[i - 1]) continue;
        const c = points[j - 1],
          d = points[j];
        if (c && d && intersects(a, b, c, d))
          throw Error(
            "Дорога пересекает саму себя. Разделите её на отдельные участки с общим узлом",
          );
      }
      if (
        (!tags.bridge || tags.bridge === "no") &&
        (!tags.tunnel || tags.tunnel === "no") &&
        ![
          "footway",
          "path",
          "steps",
          "pedestrian",
          "cycleway",
          "bridleway",
          "corridor",
          "platform",
        ].includes(tags.highway)
      )
        for (const [otherId, other] of document.ways) {
          const t = tagsOf(other);
          if (
            otherId === id ||
            !t.highway ||
            [
              "footway",
              "path",
              "steps",
              "pedestrian",
              "cycleway",
              "bridleway",
              "corridor",
              "platform",
            ].includes(t.highway) ||
            t.area === "yes" ||
            (t.bridge && t.bridge !== "no") ||
            (t.tunnel && t.tunnel !== "no") ||
            Number(t.layer || 0) !== Number(tags.layer || 0)
          )
            continue;
          const otherRefs = refsOf(other);
          for (let j = 1; j < otherRefs.length; j++) {
            if (
              [refs[i - 1], refs[i]].some(
                (ref) => ref === otherRefs[j - 1] || ref === otherRefs[j],
              )
            )
              continue;
            const c = project(otherRefs[j - 1]),
              d = project(otherRefs[j]);
            if (c && d && intersects(a, b, c, d))
              throw Error(
                `Дорога пересекает дорогу ${otherId} без общего узла. Используйте привязку или «Соединить дороги»`,
              );
          }
        }
      // A below-ground tunnel is a valid crossing; an arbitrary layer tag is not a building bypass.
      if (tags.tunnel && tags.tunnel !== "no" && Number(tags.layer || 0) < 0)
        continue;
      const width =
        Math.min(
          70,
          Math.max(1, Number(tags.width) || Number(tags.lanes || 2) * 3.4),
        ) / 2;
      for (const polygon of polygons) {
        if (polygon.id === id || polygon.outer.length < 3) continue;
        const height =
          Number.parseFloat(polygon.tags.height) ||
          Number(polygon.tags["building:levels"]) * 3.2 ||
          12;
        if (
          tags.bridge &&
          tags.bridge !== "no" &&
          Number(tags.layer || 1) * 5 > height + 2
        )
          continue;
        const occupied = (p: Point) =>
          inside(p, polygon.outer) && !polygon.holes.some((h) => inside(p, h));
        let collision =
          occupied(a) ||
          occupied(b) ||
          occupied({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
        for (const ring of [polygon.outer, ...polygon.holes])
          for (let k = 0; k < ring.length; k++) {
            const c = ring[k],
              d = ring[(k + 1) % ring.length];
            if (
              intersects(a, b, c, d) ||
              Math.min(
                distance(a, c, d),
                distance(b, c, d),
                distance(c, a, b),
                distance(d, a, b),
              ) < width
            )
              collision = true;
          }
        if (collision)
          throw Error(
            `Нельзя провести дорогу через здание ${polygon.id} или вплотную к нему: учитывается ширина проезжей части`,
          );
      }
    }
    // Connections between different grades must be modelled as separate ramps, not a shared internal node.
    if (!oldWay || refs.join() !== refsOf(oldWay).join())
      for (const ref of refs) {
        if (oldWay && refsOf(oldWay).includes(ref)) continue;
        for (const [otherId, other] of document.ways) {
          if (
            otherId === id ||
            !tagsOf(other).highway ||
            !refsOf(other).includes(ref)
          )
            continue;
          const t = tagsOf(other),
            otherRefs = refsOf(other);
          if (
            Number(t.layer || 0) !== Number(tags.layer || 0) &&
            ref !== otherRefs[0] &&
            ref !== otherRefs[otherRefs.length - 1]
          )
            throw Error(
              "Нельзя присоединять дорогу к середине моста или тоннеля другого уровня",
            );
        }
      }
  }
}
