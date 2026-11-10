import { childElements } from "./model";
import { elements, type ElementType, type OsmDocument } from "./model";

export function parseOsm(source: string): OsmDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error("DTD и внешние сущности не поддерживаются");
  const xml = new DOMParser().parseFromString(source, "application/xml");
  if (
    xml.querySelector("parsererror") ||
    xml.documentElement.tagName !== "osm"
  ) {
    throw new Error("Некорректный OSM XML: ожидается корневой элемент <osm>");
  }
  const document: OsmDocument = {
    xml,
    nodes: new Map(),
    ways: new Map(),
    relations: new Map(),
    nextId: 1n,
  };
  const declaration = /^﻿?(<\?xml[^>]*\?>)/.exec(source)?.[1];
  if (declaration) document.declaration = declaration;
  for (const element of childElements(xml.documentElement)) {
    if (!["node", "way", "relation"].includes(element.tagName)) continue;
    const id = element.getAttribute("id");
    if (!id || !/^-?\d+$/.test(id))
      throw new Error("У OSM-объекта отсутствует целочисленный ID");
    const collection = elements(document, element.tagName as ElementType);
    if (collection.has(id))
      throw new Error(`Повторяющийся ID ${element.tagName} ${id}`);
    collection.set(id, element);
    if (BigInt(id) >= document.nextId) document.nextId = BigInt(id) + 1n;
  }
  for (const reference of Array.from(
    xml.querySelectorAll("nd[ref], member[ref]"),
  )) {
    const id = reference.getAttribute("ref")!;
    if (/^-?\d+$/.test(id) && BigInt(id) >= document.nextId)
      document.nextId = BigInt(id) + 1n;
  }
  if (!document.nodes.size) throw new Error("В файле нет узлов OSM");
  return document;
}
