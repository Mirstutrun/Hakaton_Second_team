import { childElements } from "./model";
import { createProjection } from "../geo/projection";
import {
  coordinateOf,
  elements,
  insertElement,
  refsOf,
  requireElement,
  tagsOf,
} from "./model";
import type {
  Coordinate,
  EditPatch,
  ElementType,
  OsmDocument,
  RoadPoint,
  Selection,
  Tags,
} from "./model";

export type EditCommand =
  | { type: "set-tags"; target: Selection; tags: Record<string, string | null> }
  | { type: "create-road"; points: RoadPoint[]; tags: Tags }
  | { type: "merge-endpoint"; wayId: string; nodeId: string; target: RoadPoint }
  | { type: "move-node"; id: string; coordinate: Coordinate }
  | { type: "insert-node"; wayId: string; index: number; point: RoadPoint }
  | { type: "remove-vertex"; wayId: string; index: number }
  | { type: "delete-way"; id: string }
  | { type: "add-signal"; wayId: string; index: number; point: RoadPoint }
  | { type: "add-bus-stop"; wayId: string; index: number; point: RoadPoint }
  | { type: "remove-bus-stop"; id: string }
  | { type: "create-bus-route"; name: string; stops: string[]; ways?: string[] }
  | { type: "delete-bus-route"; id: string }
  | { type: "remove-signal"; id: string }
  | { type: "smooth-road"; wayId: string; radius?: number }
  | {
      type: "connect-crossing";
      wayA: string;
      indexA: number;
      wayB: string;
      indexB: number;
      coordinate: Coordinate;
    }
  | {
      type: "attach-endpoint";
      nodeId: string;
      targetWayId: string;
      targetIndex: number;
      coordinate: Coordinate;
    };

export function applyPatch(
  document: OsmDocument,
  patch: EditPatch,
  direction: "before" | "after",
): void {
  for (const change of patch.changes) {
    const collection = elements(document, change.type);
    const existing = collection.get(change.id);
    const replacement = change[direction]?.cloneNode(true) as
      | Element
      | undefined;
    if (replacement) {
      if (existing) existing.replaceWith(replacement);
      else insertElement(document, replacement);
      collection.set(change.id, replacement);
    } else {
      existing?.remove();
      collection.delete(change.id);
    }
  }
}

function checkCoordinate({ lat, lon }: Coordinate): void {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    throw new Error("Некорректные координаты узла");
}

function checkTags(tags: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(tags)) {
    if (value === null || value === "") continue;
    if (
      /^lanes(?::forward|:backward)?$/.test(key) &&
      (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 20)
    )
      throw new Error("Число полос должно быть целым от 1 до 20");
    if (
      key === "oneway" &&
      !["yes", "no", "-1", "reversible", "alternating"].includes(value)
    )
      throw new Error("Некорректное направление дороги");
    if (key === "layer" && !/^-?\d+$/.test(value))
      throw new Error("Уровень должен быть целым числом");
    if (key === "width" &&
        (!Number.isFinite(Number(value)) || Number(value) <= 0))
      throw new Error("Ширина должна быть положительным числом в метрах");
  }
}

export function applyEdit(
  document: OsmDocument,
  command: EditCommand,
): EditPatch {
  const patch: EditPatch = { label: command.type, changes: [] };
  const touched = new Map<
    string,
    { type: ElementType; id: string; before: Element | null }
  >();
  const touch = (type: ElementType, id: string) => {
    const key = `${type}/${id}`;
    if (!touched.has(key))
      touched.set(key, {
        type,
        id,
        before:
          (elements(document, type).get(id)?.cloneNode(true) as Element) ??
          null,
      });
  };
  const setTags = (
    type: ElementType,
    id: string,
    updates: Record<string, string | null>,
  ) => {
    checkTags(updates);
    touch(type, id);
    const element = requireElement(document, type, id);
    for (const [key, value] of Object.entries(updates)) {
      const existing = childElements(element).find(
        (child) => child.tagName === "tag" && child.getAttribute("k") === key,
      );
      if (value === null || value === "") existing?.remove();
      else {
        const tag = existing ?? document.xml.createElement("tag");
        tag.setAttribute("k", key);
        tag.setAttribute("v", value);
        if (!existing) element.appendChild(tag);
      }
    }
  };
  const newElement = (type: "node" | "way" | "relation") => {
    const id = (document.nextId++).toString();
    touch(type, id);
    const element = document.xml.createElement(type);
    element.setAttribute("id", id);
    element.setAttribute("version", "1");
    insertElement(document, element);
    elements(document, type).set(id, element);
    return element;
  };
  const pointId = (point: RoadPoint): string => {
    if ("nodeId" in point) {
      requireElement(document, "node", point.nodeId);
      return point.nodeId;
    }
    if ("wayId" in point) {
      const way = requireElement(document, "way", point.wayId);
      const tags = tagsOf(way);
      if (!tags.highway || (tags.bridge && tags.bridge !== "no") ||
          (tags.tunnel && tags.tunnel !== "no") || tags.covered === "yes" ||
          Number(tags.layer || 0) !== 0)
        throw new Error("Привязка возможна только к наземной дороге");
      const refs = refsOf(way);
      checkCoordinate(point.coordinate);
      const projection = createProjection(point.coordinate);
      const p = projection.project(point.coordinate);
      let index = -1, best = Infinity;
      let start = { x: 0, z: 0 }, end = { x: 0, z: 0 };
      for (let j = 1; j < refs.length; j++) {
        const a = projection.project(coordinateOf(requireElement(document, "node", refs[j - 1])));
        const b = projection.project(coordinateOf(requireElement(document, "node", refs[j])));
        const dx = b.x - a.x, dz = b.z - a.z;
        const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1);
        const distance = Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
        if (t >= 0 && t <= 1 && distance < best) {
          index = j; best = distance; start = a; end = b;
        }
      }
      if (index < 0 || best > 0.5)
        throw new Error("Точка привязки вышла за пределы сегмента");
      if (Math.hypot(p.x - start.x, p.z - start.z) < 1) return refs[index - 1];
      if (Math.hypot(p.x - end.x, p.z - end.z) < 1) return refs[index];
      return insert(point.wayId, index, point.coordinate);
    }
    checkCoordinate(point);
    const node = newElement("node");
    node.setAttribute("lat", point.lat.toFixed(9));
    node.setAttribute("lon", point.lon.toFixed(9));
    return node.getAttribute("id")!;
  };
  const insert = (wayId: string, index: number, point: RoadPoint) => {
    const way = requireElement(document, "way", wayId);
    const refs = childElements(way).filter(
      (child) => child.tagName === "nd",
    );
    if (!Number.isInteger(index) || index < 1 || index >= refs.length)
      throw new Error("Выберите существующий сегмент дороги");
    const id = pointId(point);
    if (
      refs[index - 1].getAttribute("ref") === id ||
      refs[index].getAttribute("ref") === id
    )
      throw new Error("Узел уже находится на этом сегменте");
    touch("way", wayId);
    const nd = document.xml.createElement("nd");
    nd.setAttribute("ref", id);
    way.insertBefore(nd, refs[index]);
    return id;
  };
  try {
    switch (command.type) {
      case "set-tags": {
        const target = requireElement(
          document,
          command.target.type,
          command.target.id,
        );
        const combined = { ...tagsOf(target), ...command.tags };
        const total = Number(combined.lanes);
        const forward = Number(combined["lanes:forward"] || 0);
        const backward = Number(combined["lanes:backward"] || 0);
        if (total && forward + backward > total)
          throw new Error("Сумма полос по направлениям превышает общее число");
        if (combined.oneway === "yes" && backward > 0)
          throw new Error("Для oneway=yes нельзя указывать встречные полосы");
        if (combined.oneway === "-1" && forward > 0)
          throw new Error("Для oneway=-1 нельзя указывать прямые полосы");
        if (combined.bridge && combined.bridge !== "no" &&
            combined.tunnel && combined.tunnel !== "no")
          throw new Error("Объект не может быть одновременно мостом и тоннелем");
        setTags(command.target.type, command.target.id, command.tags);
        break;
      }
      case "create-road": {
        if (command.points.length < 2)
          throw new Error("Для дороги нужны минимум две точки");
        checkTags(command.tags);
        const ids = command.points.map(pointId);
        const positions = ids.map((id) =>
          coordinateOf(requireElement(document, "node", id)),
        );
        if (
          new Set(positions.map((p) => `${p.lat}/${p.lon}`)).size < 2 ||
          ids.some((id, index) => index > 0 && id === ids[index - 1])
        )
          throw new Error("Дорога должна содержать разные точки");
        // Connect every at-grade crossing to the OSM graph, including crossings
        // between clicks. Keep the original ways and their relation references.
        const projection = createProjection(positions[0]);
        const xy = positions.map((coordinate) => projection.project(coordinate));
        const onNew = new Map<number, { t: number; id: string }[]>();
        const onOld = new Map<string, Map<number, { t: number; id: string }[]>>();
        const made: { x: number; z: number; id: string }[] = [];
        const atGround = (tags: Tags) => tags.highway &&
          !["footway", "path", "steps", "pedestrian", "cycleway", "construction", "proposed"].includes(tags.highway) &&
          (!tags.bridge || tags.bridge === "no") &&
          (!tags.tunnel || tags.tunnel === "no") && tags.covered !== "yes" &&
          Number(tags.layer || 0) === Number(command.tags.layer || 0);
        if (atGround({ highway: "residential", ...command.tags })) {
          for (const [wayId, other] of document.ways) {
            if (!atGround(tagsOf(other))) continue;
            const refs = refsOf(other);
            for (let j = 1; j < refs.length; j++) {
              const a = projection.project(coordinateOf(requireElement(document, "node", refs[j - 1])));
              const b = projection.project(coordinateOf(requireElement(document, "node", refs[j])));
              const bx = b.x - a.x, bz = b.z - a.z;
              for (let i = 1; i < xy.length; i++) {
                const p = xy[i - 1], q = xy[i];
                if (Math.max(p.x, q.x) < Math.min(a.x, b.x) ||
                    Math.min(p.x, q.x) > Math.max(a.x, b.x) ||
                    Math.max(p.z, q.z) < Math.min(a.z, b.z) ||
                    Math.min(p.z, q.z) > Math.max(a.z, b.z)) continue;
                const dx = q.x - p.x, dz = q.z - p.z;
                const cross = dx * bz - dz * bx;
                if (Math.abs(cross) < 0.0001) continue;
                const rx = a.x - p.x, rz = a.z - p.z;
                const t = (rx * bz - rz * bx) / cross;
                const u = (rx * dz - rz * dx) / cross;
                if (t < 0 || t > 1 || u < 0 || u > 1) continue;
                const x = p.x + t * dx, z = p.z + t * dz;
                const newStart = Math.hypot(x - p.x, z - p.z) < 0.75;
                const newEnd = Math.hypot(x - q.x, z - q.z) < 0.75;
                const oldStart = Math.hypot(x - a.x, z - a.z) < 0.75;
                const oldEnd = Math.hypot(x - b.x, z - b.z) < 0.75;
                const known = made.find((candidate) => Math.hypot(candidate.x - x, candidate.z - z) < 0.75);
                const id = oldStart ? refs[j - 1] : oldEnd ? refs[j] :
                  newStart ? ids[i - 1] : newEnd ? ids[i] : known?.id ?? (() => {
                    const node = newElement("node");
                    const coordinate = projection.unproject({ x, z });
                    node.setAttribute("lat", coordinate.lat.toFixed(9));
                    node.setAttribute("lon", coordinate.lon.toFixed(9));
                    return node.getAttribute("id")!;
                  })();
                made.push({ x, z, id });
                if (!newStart && !newEnd && id !== ids[i - 1] && id !== ids[i]) {
                  const list = onNew.get(i) ?? [];
                  if (!list.some((entry) => entry.id === id)) list.push({ t, id });
                  onNew.set(i, list);
                }
                if (!oldStart && !oldEnd && id !== refs[j - 1] && id !== refs[j]) {
                  const segments = onOld.get(wayId) ?? new Map<number, { t: number; id: string }[]>();
                  const list = segments.get(j) ?? [];
                  if (!list.some((entry) => entry.id === id)) list.push({ t: u, id });
                  segments.set(j, list);
                  onOld.set(wayId, segments);
                }
              }
            }
          }
        }
        for (const [wayId, segments] of onOld) {
          const other = requireElement(document, "way", wayId);
          touch("way", wayId);
          const refs = refsOf(other);
          const nextRefs = [refs[0]];
          for (let j = 1; j < refs.length; j++) {
            nextRefs.push(...(segments.get(j) ?? []).sort((a, b) => a.t - b.t).map((entry) => entry.id), refs[j]);
          }
          for (const nd of childElements(other).filter((child) => child.tagName === "nd")) nd.remove();
          const beforeTags = childElements(other).find((child) => child.tagName === "tag") ?? null;
          for (const ref of nextRefs) {
            const nd = document.xml.createElement("nd");
            nd.setAttribute("ref", ref);
            other.insertBefore(nd, beforeTags);
          }
        }
        const way = newElement("way");
        const id = way.getAttribute("id")!;
        const connected = [ids[0]];
        for (let i = 1; i < ids.length; i++)
          connected.push(...(onNew.get(i) ?? []).sort((a, b) => a.t - b.t).map((entry) => entry.id), ids[i]);
        for (const ref of connected.filter((ref, index) => index === 0 || ref !== connected[index - 1])) {
          const nd = document.xml.createElement("nd");
          nd.setAttribute("ref", ref);
          way.appendChild(nd);
        }
        setTags("way", id, { highway: "residential", ...command.tags });
        patch.selection = { type: "way", id };
        break;
      }
      case "merge-endpoint": {
        const source = requireElement(document, "way", command.wayId);
        const sourceTags = tagsOf(source);
        const refs = refsOf(source);
        if (!sourceTags.highway ||
            (refs[0] !== command.nodeId && refs[refs.length - 1] !== command.nodeId))
          throw new Error("Выберите свободный конец дороги");
        const node = requireElement(document, "node", command.nodeId);
        const owners = Array.from(document.ways.values()).filter((way) =>
          tagsOf(way).highway && refsOf(way).includes(command.nodeId));
        if (owners.length !== 1 || owners[0] !== source)
          throw new Error("Конец уже соединён с другой дорогой");
        if (Object.keys(tagsOf(node)).length || Array.from(document.relations.values()).some((relation) =>
          childElements(relation).some((member) => member.tagName === "member" &&
            member.getAttribute("type") === "node" && member.getAttribute("ref") === command.nodeId)))
          throw new Error("Конечный узел имеет теги или входит в OSM-отношение");
        const sourceGround = (!sourceTags.bridge || sourceTags.bridge === "no") &&
          (!sourceTags.tunnel || sourceTags.tunnel === "no") &&
          sourceTags.covered !== "yes" && Number(sourceTags.layer || 0) === 0;
        if (!sourceGround) throw new Error("Соединять можно наземные дороги одного уровня");
        const targetNodeId = "nodeId" in command.target ? command.target.nodeId : null;
        const targetWayId = "wayId" in command.target ? command.target.wayId :
          targetNodeId ? Array.from(document.ways, ([id, way]) =>
            tagsOf(way).highway && refsOf(way).includes(targetNodeId) ? id : "").find(Boolean) : "";
        if (!targetWayId || targetWayId === command.wayId)
          throw new Error("Выберите другую дорогу");
        const targetWay = requireElement(document, "way", targetWayId);
        const targetTags = tagsOf(targetWay);
        if (!targetTags.highway ||
            (targetTags.bridge && targetTags.bridge !== "no") ||
            (targetTags.tunnel && targetTags.tunnel !== "no") ||
            targetTags.covered === "yes" || Number(targetTags.layer || 0) !== 0)
          throw new Error("Целевая дорога должна быть наземной и на том же уровне");
        const targetId = pointId(command.target);
        if (targetId === command.nodeId || refs.includes(targetId))
          throw new Error("Дорога уже использует этот узел");
        touch("way", command.wayId);
        const nds = childElements(source).filter((child) => child.tagName === "nd");
        (refs[0] === command.nodeId ? nds[0] : nds[nds.length - 1]).setAttribute("ref", targetId);
        if (!Array.from(document.ways.values()).some((way) => refsOf(way).includes(command.nodeId))) {
          touch("node", command.nodeId);
          node.remove();
          document.nodes.delete(command.nodeId);
        }
        patch.selection = { type: "way", id: command.wayId };
        break;
      }
      case "add-bus-stop": {
        const way = requireElement(document, "way", command.wayId);
        if (!tagsOf(way).highway) throw new Error("Остановка должна находиться на дороге");
        const id = "nodeId" in command.point && refsOf(way).includes(command.point.nodeId)
          ? command.point.nodeId : insert(command.wayId, command.index, command.point);
        const node = requireElement(document, "node", id);
        if (tagsOf(node).highway === "traffic_signals")
          throw new Error("Выберите место без светофора");
        setTags("node", id, { public_transport: "stop_position", bus: "yes" });
        patch.selection = { type: "node", id };
        break;
      }
      case "remove-bus-stop": {
        const node = requireElement(document, "node", command.id);
        if (tagsOf(node).public_transport !== "stop_position" || tagsOf(node).bus !== "yes")
          throw new Error("Выбранный узел не является автобусной остановкой");
        if (Array.from(document.relations.values()).some((relation) =>
          tagsOf(relation).route === "bus" && childElements(relation).some((member) =>
            member.tagName === "member" && member.getAttribute("type") === "node" &&
            member.getAttribute("ref") === command.id)))
          throw new Error("Остановка входит в автобусный маршрут. Сначала удалите маршрут.");
        setTags("node", command.id, { public_transport: null, bus: null, name: null });
        break;
      }
      case "create-bus-route": {
        const name = command.name.trim();
        if (!name || command.stops.length < 2 || new Set(command.stops).size !== command.stops.length)
          throw new Error("Укажите название и минимум две разные остановки");
        for (const id of command.stops) {
          const tags = tagsOf(requireElement(document, "node", id));
          if (tags.public_transport !== "stop_position" || tags.bus !== "yes")
            throw new Error(`Узел ${id} не является автобусной остановкой`);
        }
        for (const id of command.ways ?? []) {
          if (!tagsOf(requireElement(document, "way", id)).highway)
            throw new Error(`Участок ${id} не является дорогой`);
        }
        const relation = newElement("relation");
        for (const id of command.ways ?? []) {
          const member = document.xml.createElement("member");
          member.setAttribute("type", "way");
          member.setAttribute("ref", id);
          member.setAttribute("role", "");
          relation.appendChild(member);
        }
        for (const id of command.stops) {
          const member = document.xml.createElement("member");
          member.setAttribute("type", "node");
          member.setAttribute("ref", id);
          member.setAttribute("role", "stop");
          relation.appendChild(member);
        }
        setTags("relation", relation.getAttribute("id")!, { type: "route", route: "bus", name });
        break;
      }
      case "delete-bus-route": {
        const relation = requireElement(document, "relation", command.id);
        if (tagsOf(relation).route !== "bus") throw new Error("Это не автобусный маршрут");
        touch("relation", command.id);
        relation.remove();
        document.relations.delete(command.id);
        break;
      }
      case "move-node": {
        checkCoordinate(command.coordinate);
        const node = requireElement(document, "node", command.id);
        touch("node", command.id);
        node.setAttribute("lat", command.coordinate.lat.toFixed(9));
        node.setAttribute("lon", command.coordinate.lon.toFixed(9));
        break;
      }
      case "insert-node": {
        const id = insert(command.wayId, command.index, command.point);
        patch.selection = { type: "node", id };
        break;
      }
      case "remove-vertex": {
        const way = requireElement(document, "way", command.wayId);
        const refs = refsOf(way);
        if (
          !Number.isInteger(command.index) ||
          command.index < 0 ||
          command.index >= refs.length
        )
          throw new Error("Вершина не найдена");
        if (refs.length <= 2)
          throw new Error("В дороге должны остаться минимум две вершины");
        const id = refs[command.index];
        if (
          tagsOf(requireElement(document, "node", id)).highway ===
          "traffic_signals"
        )
          throw new Error("Сначала удалите светофор с этой вершины");
        if (
          Array.from(document.ways.values()).some(
            (other) => other !== way && refsOf(other).includes(id),
          )
        )
          throw new Error(
            "Общий узел соединяет дороги: удаление вершины заблокировано",
          );
        if (
          Array.from(document.relations.values()).some((rel) =>
            childElements(rel).some(
              (m) =>
                m.getAttribute("type") === "node" &&
                m.getAttribute("ref") === id,
            ),
          )
        )
          throw new Error("Узел используется в отношении");
        touch("way", command.wayId);
        childElements(way)
          .filter((child) => child.tagName === "nd")
          [command.index].remove();
        break;
      }
      case "delete-way": {
        const way = requireElement(document, "way", command.id);
        if (
          Array.from(document.relations.values()).some((rel) =>
            childElements(rel).some(
              (m) =>
                m.tagName === "member" &&
                m.getAttribute("type") === "way" &&
                m.getAttribute("ref") === command.id,
            ),
          )
        )
          throw new Error(
            "Дорога входит в отношение OSM. Удаление заблокировано для сохранения связей.",
          );
        touch("way", command.id);
        way.remove();
        document.ways.delete(command.id);
        break;
      }
      case "add-signal": {
        const way = requireElement(document, "way", command.wayId);
        if (!tagsOf(way).highway)
          throw new Error("Светофор должен принадлежать дороге");
        const id =
          "nodeId" in command.point &&
          refsOf(way).includes(command.point.nodeId)
            ? command.point.nodeId
            : insert(command.wayId, command.index, command.point);
        const highway = tagsOf(requireElement(document, "node", id)).highway;
        if (highway && highway !== "traffic_signals")
          throw new Error(
            "Узел уже содержит highway. Выберите свободный участок рядом.",
          );
        setTags("node", id, { highway: "traffic_signals" });
        patch.selection = { type: "node", id };
        break;
      }
      case "smooth-road": {
        const way = requireElement(document, "way", command.wayId);
        const refs = refsOf(way);
        if (!tagsOf(way).highway || refs.length < 3 ||
            refs[0] === refs[refs.length - 1])
          throw new Error("Для сглаживания выберите незамкнутую дорогу с изгибами");
        const radius = Math.max(1, Math.min(command.radius ?? 8, 30));
        const projection = createProjection(coordinateOf(
          requireElement(document, "node", refs[Math.floor(refs.length / 2)])));
        const projected = refs.map((id) =>
          projection.project(coordinateOf(requireElement(document, "node", id))));
        const occurrences = new Map<string, number>();
        for (const candidate of document.ways.values())
          for (const id of new Set(refsOf(candidate)))
            occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
        const relationRefs = new Set<string>();
        for (const relation of document.relations.values())
          for (const member of childElements(relation))
            if (member.tagName === "member" && member.getAttribute("type") === "node")
              relationRefs.add(member.getAttribute("ref")!);
        const result: string[] = [refs[0]];
        let corners = 0;
        for (let i = 1; i < refs.length - 1; i++) {
          const id = refs[i];
          const node = requireElement(document, "node", id);
          const point = projected[i], before = projected[i - 1], after = projected[i + 1];
          const ax = point.x - before.x, az = point.z - before.z;
          const bx = after.x - point.x, bz = after.z - point.z;
          const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
          const dot = (ax * bx + az * bz) / (la * lb || 1);
          const protectedNode = (occurrences.get(id) ?? 0) > 1 ||
            refs.indexOf(id) !== refs.lastIndexOf(id) ||
            relationRefs.has(id) || Object.keys(tagsOf(node)).length > 0;
          const trim = Math.min(radius, la * 0.32, lb * 0.32);
          if (protectedNode || dot > 0.96 || dot < -0.98 ||
              trim < 0.5 || !Number.isFinite(trim)) {
            result.push(id);
            continue;
          }
          if (corners >= 80)
            throw new Error("Слишком много изгибов в одном действии. Разделите дорогу на участки.");
          corners++;
          const p0 = { x: point.x - ax / la * trim,
            z: point.z - az / la * trim };
          const p2 = { x: point.x + bx / lb * trim,
            z: point.z + bz / lb * trim };
          for (let step = 0; step <= 6; step++) {
            const t = step / 6, s = 1 - t;
            const coordinate = projection.unproject({
              x: p0.x * s * s + point.x * 2 * s * t + p2.x * t * t,
              z: p0.z * s * s + point.z * 2 * s * t + p2.z * t * t,
            });
            const fresh = newElement("node");
            fresh.setAttribute("lat", coordinate.lat.toFixed(9));
            fresh.setAttribute("lon", coordinate.lon.toFixed(9));
            result.push(fresh.getAttribute("id")!);
          }
        }
        if (!corners) throw new Error(
          "Нет сглаживаемых поворотов. Общие перекрёстки и значимые узлы защищены.");
        result.push(refs[refs.length - 1]);
        touch("way", command.wayId);
        for (const nd of childElements(way).filter((item) => item.tagName === "nd"))
          nd.remove();
        const beforeTags = childElements(way).find((item) => item.tagName === "tag") ?? null;
        for (const id of result) {
          const nd = document.xml.createElement("nd");
          nd.setAttribute("ref", id);
          way.insertBefore(nd, beforeTags);
        }
        patch.selection = { type: "way", id: command.wayId };
        break;
      }
      case "connect-crossing": {
        const { wayA, wayB, indexA, indexB, coordinate } = command;
        if (wayA === wayB) throw new Error("Нужны две разные дороги");
        checkCoordinate(coordinate);
        const first = requireElement(document, "way", wayA);
        const second = requireElement(document, "way", wayB);
        const firstTags = tagsOf(first);
        const secondTags = tagsOf(second);
        if (!firstTags.highway || !secondTags.highway)
          throw new Error("Соединять можно только дороги");
        const surface = (tags: Tags) =>
          !((tags.bridge && tags.bridge !== "no") ||
            (tags.tunnel && tags.tunnel !== "no") || tags.covered === "yes" ||
            tags.indoor === "yes");
        if (!surface(firstTags) || !surface(secondTags) ||
            Number(firstTags.layer || 0) !== Number(secondTags.layer || 0))
          throw new Error("Нельзя соединять разные уровни или мосты/тоннели");
        const projection = (point: Coordinate) => {
          const scale = 111319.49079327358;
          return {
            x: point.lon * scale * Math.cos(coordinate.lat * Math.PI / 180),
            y: point.lat * scale,
          };
        };
        const near = (a: Coordinate, b: Coordinate) => {
          const p = projection(a), q = projection(b);
          return Math.hypot(p.x - q.x, p.y - q.y);
        };
        const segment = (way: Element, index: number) => {
          const refs = refsOf(way);
          if (!Number.isInteger(index) || index < 1 || index >= refs.length)
            throw new Error("Сегмент изменился. Запустите проверку повторно");
          const a = coordinateOf(requireElement(document, "node", refs[index - 1]));
          const b = coordinateOf(requireElement(document, "node", refs[index]));
          if (near(a, coordinate) < 0.75 || near(b, coordinate) < 0.75)
            throw new Error("Пересечение у конца сегмента: соедините узлы вручную");
          const p = projection(coordinate), u = projection(a), v = projection(b);
          const dx = v.x - u.x, dy = v.y - u.y;
          const t = ((p.x - u.x) * dx + (p.y - u.y) * dy) /
            (dx * dx + dy * dy || 1);
          const distance = Math.hypot(p.x - (u.x + t * dx), p.y - (u.y + t * dy));
          if (t <= 0 || t >= 1 || distance > 0.35)
            throw new Error("Пересечение больше не лежит на сегменте");
          return refs;
        };
        const refsA = segment(first, indexA);
        const refsB = segment(second, indexB);
        if (refsA.some((id) => refsB.includes(id)))
          throw new Error("Дороги уже соединены общим узлом");
        const node = newElement("node");
        node.setAttribute("lat", coordinate.lat.toFixed(9));
        node.setAttribute("lon", coordinate.lon.toFixed(9));
        const id = node.getAttribute("id")!;
        for (const [way, index] of [[first, indexA], [second, indexB]] as const) {
          touch("way", way.getAttribute("id")!);
          const refs = childElements(way).filter((element) => element.tagName === "nd");
          const nd = document.xml.createElement("nd");
          nd.setAttribute("ref", id);
          way.insertBefore(nd, refs[index]);
        }
        patch.selection = { type: "node", id };
        break;
      }
      case "attach-endpoint": {
        const { nodeId, targetWayId, targetIndex, coordinate } = command;
        checkCoordinate(coordinate);
        const node = requireElement(document, "node", nodeId);
        const target = requireElement(document, "way", targetWayId);
        const tags = tagsOf(target);
        if (!tags.highway || (tags.bridge && tags.bridge !== "no") ||
            (tags.tunnel && tags.tunnel !== "no") || tags.covered === "yes")
          throw new Error("Стыковка допускается только на дороге на одном уровне");
        if (refsOf(target).includes(nodeId))
          throw new Error("Этот узел уже принадлежит целевой дороге");
        const owners = Array.from(document.ways.values()).filter((way) =>
          tagsOf(way).highway && refsOf(way).includes(nodeId));
        if (owners.length !== 1)
          throw new Error("Узел должен быть свободным концом ровно одной дороги");
        const owner = owners[0];
        const ownerRefs = refsOf(owner);
        if (ownerRefs[0] !== nodeId &&
            ownerRefs[ownerRefs.length - 1] !== nodeId)
          throw new Error("Узел не является концом дороги");
        const ownerTags = tagsOf(owner);
        if ((ownerTags.bridge && ownerTags.bridge !== "no") ||
            (ownerTags.tunnel && ownerTags.tunnel !== "no") ||
            ownerTags.covered === "yes" ||
            Number(ownerTags.layer || 0) !== Number(tags.layer || 0))
          throw new Error("Нельзя соединять дороги на разных уровнях");
        if (Array.from(document.relations.values()).some((rel) =>
            childElements(rel).some((member) =>
              member.tagName === "member" && member.getAttribute("type") === "node" &&
              member.getAttribute("ref") === nodeId)))
          throw new Error("Этот узел входит в OSM-отношение; проверьте его вручную");
        const refs = refsOf(target);
        if (!Number.isInteger(targetIndex) || targetIndex < 1 ||
            targetIndex >= refs.length)
          throw new Error("Целевой сегмент больше не существует");
        const a = coordinateOf(requireElement(document, "node", refs[targetIndex - 1]));
        const b = coordinateOf(requireElement(document, "node", refs[targetIndex]));
        const meters = (p: Coordinate) => {
          const scale = 111319.49079327358;
          return { x: p.lon * scale * Math.cos(coordinate.lat * Math.PI / 180),
            y: p.lat * scale };
        };
        const p = meters(coordinate), u = meters(a), v = meters(b);
        const dx = v.x - u.x, dy = v.y - u.y;
        const length2 = dx * dx + dy * dy;
        const t = ((p.x - u.x) * dx + (p.y - u.y) * dy) / (length2 || 1);
        if (t <= 0 || t >= 1 || Math.sqrt(length2) * Math.min(t, 1 - t) < 0.75 ||
            Math.hypot(p.x - (u.x + t * dx), p.y - (u.y + t * dy)) > 0.35)
          throw new Error("Точка привязки не находится внутри сегмента");
        const original = coordinateOf(node);
        const old = meters(original);
        if (Math.hypot(old.x - p.x, old.y - p.y) > 4)
          throw new Error("Разрыв больше 4 м: проверьте дорогу вручную");
        touch("node", nodeId);
        touch("way", targetWayId);
        node.setAttribute("lat", coordinate.lat.toFixed(9));
        node.setAttribute("lon", coordinate.lon.toFixed(9));
        const nds = childElements(target).filter((element) => element.tagName === "nd");
        const nd = document.xml.createElement("nd");
        nd.setAttribute("ref", nodeId);
        target.insertBefore(nd, nds[targetIndex]);
        patch.selection = { type: "node", id: nodeId };
        break;
      }
      case "remove-signal": {
        const node = requireElement(document, "node", command.id);
        if (tagsOf(node).highway !== "traffic_signals")
          throw new Error("Выбранный узел не является светофором");
        setTags(
          "node",
          command.id,
          Object.fromEntries(
            Object.keys(tagsOf(node))
              .filter(
                (key) => key === "highway" || key.startsWith("traffic_signals"),
              )
              .map((key) => [key, null]),
          ),
        );
        break;
      }
    }
    patch.changes = Array.from(touched.values(), (change) => ({
      ...change,
      after:
        (elements(document, change.type)
          .get(change.id)
          ?.cloneNode(true) as Element) ?? null,
    }));
    return patch;
  } catch (error) {
    applyPatch(
      document,
      {
        label: command.type,
        changes: Array.from(touched.values(), (change) => ({
          ...change,
          after: null,
        })),
      },
      "before",
    );
    throw error;
  }
}
