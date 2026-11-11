import type { Tags } from "./model";

export const SIGNAL_RED_TAG = "roadforge:signal:red";
export const SIGNAL_GREEN_TAG = "roadforge:signal:green";
export const MAX_SIGNAL_SECONDS = 300;

export function isTrafficSignal(tags: Tags): boolean {
  return tags.highway === "traffic_signals" ||
    (tags.highway === "crossing" && tags.crossing === "traffic_signals");
}

export function validSignalSeconds(seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_SIGNAL_SECONDS;
}

export function signalTiming(tags: Tags) {
  const red = Number(tags[SIGNAL_RED_TAG]);
  const green = Number(tags[SIGNAL_GREEN_TAG]);
  return {
    red: validSignalSeconds(red) ? red : 10,
    green: validSignalSeconds(green) ? green : 12,
  };
}
