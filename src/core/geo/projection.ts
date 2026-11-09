import { coordinateOf, type Coordinate, type OsmDocument } from "../osm/model";

export interface LocalPoint {
  x: number;
  z: number;
}

export function createProjection(origin: Coordinate) {
  const scale = (Math.PI * 6378137) / 180;
  const longitudeScale = scale * Math.cos((origin.lat * Math.PI) / 180);
  return {
    origin,
    project: ({ lat, lon }: Coordinate): LocalPoint => ({
      x: (lon - origin.lon) * longitudeScale,
      z: (lat - origin.lat) * scale,
    }),
    unproject: ({ x, z }: LocalPoint): Coordinate => ({
      lat: origin.lat + z / scale,
      lon: origin.lon + x / longitudeScale,
    }),
  };
}

export function documentOrigin(document: OsmDocument): Coordinate {
  const bounds = document.xml.documentElement.querySelector("bounds");
  if (bounds) {
    const values = ["minlat", "maxlat", "minlon", "maxlon"].map((key) =>
      Number(bounds.getAttribute(key)),
    );
    if (values.every(Number.isFinite))
      return {
        lat: (values[0] + values[1]) / 2,
        lon: (values[2] + values[3]) / 2,
      };
  }
  const points = Array.from(document.nodes.values(), coordinateOf);
  return {
    lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
    lon: points.reduce((sum, p) => sum + p.lon, 0) / points.length,
  };
}
