import { childElements } from "./model";
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
  | { type: "move-node"; id: string; coordinate: Coordinate }
  | { type: "insert-node"; wayId: string; index: number; point: RoadPoint }
  | { type: "remove-vertex"; wayId: string; index: number }
  | { type: "delete-way"; id: string }
  | { type: "add-signal"; wayId: string; index: number; point: RoadPoint }
  | { type: "remove-signal"; id: string }
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
  const newElement = (type: "node" | "way") => {
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
        const way = newElement("way");
        const id = way.getAttribute("id")!;
        for (const ref of ids) {
          const nd = document.xml.createElement("nd");
          nd.setAttribute("ref", ref);
          way.appendChild(nd);
        }
        setTags("way", id, { highway: "residential", ...command.tags });
        patch.selection = { type: "way", id };
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
