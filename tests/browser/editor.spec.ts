import { expect, test, type Page } from "@playwright/test";

async function scenePoint(page: Page, x: number, z: number) {
  return page.evaluate(
    async ({ x, z }) => {
      const path = performance
        .getEntriesByType("resource")
        .find((entry) => entry.name.includes("/@babylonjs_core.js?"))!.name;
      const { EngineStore, Vector3, Matrix } = await import(path);
      const engine = EngineStore.Instances[0];
      const scene = engine.scenes[0];
      const canvas = engine.getRenderingCanvas().getBoundingClientRect();
      const projected = Vector3.Project(
        new Vector3(x, 0, z),
        Matrix.Identity(),
        scene.getTransformMatrix(),
        scene.activeCamera.viewport.toGlobal(
          engine.getRenderWidth(),
          engine.getRenderHeight(),
        ),
      );
      return {
        x: canvas.left + (projected.x * canvas.width) / engine.getRenderWidth(),
        y:
          canvas.top + (projected.y * canvas.height) / engine.getRenderHeight(),
      };
    },
    { x, z },
  );
}

async function state(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/stores/editor.ts";
    const store = (await import(path)).useEditorStore();
    const selection = store.selection;
    const element = selection
      ? (selection.type === "way"
          ? store.document.ways
          : store.document.nodes
        ).get(selection.id)
      : null;
    return {
      roads: store.stats.roads,
      nodes: store.stats.nodes,
      signals: store.stats.signals,
      selection,
      tags: element
        ? Object.fromEntries(
            Array.from(element.querySelectorAll("tag")).map((tag: any) => [
              tag.getAttribute("k"),
              tag.getAttribute("v"),
            ]),
          )
        : {},
      dirty: store.dirty,
      draft: store.draft.length,
    };
  });
}

test("real map: edit lanes, draw, move, signal, delete, undo, export and reimport", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Ссылки дорог корректны")).toBeVisible({
    timeout: 60000,
  });
  expect((await state(page)).roads).toBe(861);
  await page.getByRole("button", { name: "2D", exact: true }).click();
  const road = await page.evaluate(async () => {
    const path = "/src/stores/editor.ts";
    const store = (await import(path)).useEditorStore();
    return (Array.from(store.document.ways.values()) as Element[])
      .find((way: any) =>
        Array.from(way.querySelectorAll("tag")).some(
          (tag: any) =>
            tag.getAttribute("k") === "lanes" && tag.getAttribute("v") === "2",
        ),
      )
      ?.getAttribute("id");
  });
  await page.getByRole("textbox", { name: "OSM ID", exact: true }).fill(road!);
  await page.getByRole("button", { name: "Найти объект" }).click();
  await page.getByRole("spinbutton", { name: "Полосы", exact: true }).fill("4");
  await page.getByRole("button", { name: "Применить изменения" }).click();
  expect((await state(page)).tags.lanes).toBe("4");
  const width = await page.evaluate(async (id) => {
    const path = performance
      .getEntriesByType("resource")
      .find((entry) => entry.name.includes("/@babylonjs_core.js?"))!.name;
    const { EngineStore, VertexBuffer, Vector3 } = await import(path);
    const mesh = EngineStore.Instances[0].scenes[0].getMeshByName(`way:${id}`);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    return Vector3.Distance(
      Vector3.FromArray(positions, 0),
      Vector3.FromArray(positions, 3),
    );
  }, road);
  expect(width).toBeCloseTo(13.6, 1);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect((await state(page)).tags.lanes).toBe("2");
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  expect((await state(page)).tags.lanes).toBe("4");
  await page.getByRole("button", { name: "Выбор V", exact: false }).click();
  await page.locator("canvas").click({ position: { x: 50, y: 100 } });
  await page.getByRole("button", { name: "Центрировать", exact: true }).click();
  await page.getByRole("button", { name: "Дорога D", exact: false }).click();
  for (const point of [
    { x: -170, z: -80 },
    { x: 0, z: -80 },
    { x: 170, z: -80 },
  ]) {
    const position = await scenePoint(page, point.x, point.z);
    await page.mouse.click(position.x, position.y);
  }
  expect((await state(page)).draft).toBe(3);
  await page.getByRole("button", { name: "Завершить" }).click();
  const newRoad = (await state(page)).selection.id;
  expect((await state(page)).roads).toBe(862);
  await page.getByRole("button", { name: "Центрировать", exact: true }).click();
  await page.getByRole("button", { name: "Геометрия M", exact: false }).click();
  const start = await scenePoint(page, 0, -80);
  const end = await scenePoint(page, 0, -30);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  const moved = await page.evaluate(async (id) => {
    const path = "/src/stores/editor.ts";
    const geo = "/src/core/geo/projection.ts";
    const store = (await import(path)).useEditorStore();
    const { createProjection, documentOrigin } = await import(geo);
    const ref = store.document.ways
      .get(id)
      .querySelectorAll("nd")[1]
      .getAttribute("ref");
    const node = store.document.nodes.get(ref);
    return createProjection(documentOrigin(store.document)).project({
      lat: Number(node.getAttribute("lat")),
      lon: Number(node.getAttribute("lon")),
    });
  }, newRoad);
  expect(moved.z).toBeCloseTo(-30, 0);
  await page.getByRole("button", { name: "Светофор T", exact: false }).click();
  const signalPoint = await scenePoint(page, -85, -55);
  await page.mouse.click(signalPoint.x, signalPoint.y);
  expect((await state(page)).signals).toBe(3);
  await page
    .getByRole("combobox", { name: "Направление светофора" })
    .selectOption("forward");
  await page.getByRole("button", { name: "Применить изменения" }).click();
  expect((await state(page)).tags["traffic_signals:direction"]).toBe("forward");
  await page
    .getByRole("textbox", { name: "OSM ID", exact: true })
    .fill(newRoad);
  await page.getByRole("button", { name: "Найти объект" }).click();
  await page
    .getByRole("button", { name: "Удалить дорогу", exact: true })
    .click();
  await page.getByRole("button", { name: "Подтвердить удаление" }).click();
  expect((await state(page)).roads).toBe(861);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect((await state(page)).roads).toBe(862);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  expect((await state(page)).roads).toBe(861);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт OSM" }).click();
  const download = await downloadEvent;
  const path = testInfo.outputPath("edited.osm");
  await download.saveAs(path);
  await page.getByTestId("file-input").setInputFiles(path);
  await expect(page.getByText("Ссылки дорог корректны")).toBeVisible();
  expect((await state(page)).roads).toBe(862);
  expect((await state(page)).signals).toBe(3);
  await page.getByRole("textbox", { name: "OSM ID", exact: true }).fill(road!);
  await page.getByRole("button", { name: "Найти объект" }).click();
  expect((await state(page)).tags.lanes).toBe("4");
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("editor.png") });
  expect(errors).toEqual([]);
});

test("2D preview: lane tags, vehicles and keyboard shortcuts", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Ссылки дорог корректны")).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("button", { name: "2D", exact: true })).toHaveClass(/active/);
  const wayId = await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    return Array.from(store.document.ways.values())
      .find((way) => way.querySelector('tag[k="lanes"][v="2"]') &&
        way.querySelector('tag[k="highway"]'))?.getAttribute("id");
  });
  expect(wayId).toBeTruthy();
  await page.getByRole("textbox", { name: "OSM ID", exact: true }).fill(wayId!);
  await page.getByRole("button", { name: "Найти объект" }).click();
  await page.locator(".lane-picker button").first().click();
  await page.getByRole("combobox", { name: "Повороты выбранной полосы" }).selectOption("left");
  await page.getByRole("button", { name: "Сохранить полосу" }).click();
  const laneSaved = await page.evaluate(async (id) => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    const way = store.document.ways.get(id);
    return Array.from(way.querySelectorAll("tag"))
      .some((tag) => tag.getAttribute("k")?.startsWith("turn:lanes") &&
        tag.getAttribute("v")?.includes("left"));
  }, wayId);
  expect(laneSaved).toBe(true);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await page.keyboard.press("Control+y");
  const replayed = await page.evaluate(async (id) => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    return Array.from(store.document.ways.get(id).querySelectorAll("tag"))
      .some((tag) => tag.getAttribute("k")?.startsWith("turn:lanes") &&
        tag.getAttribute("v")?.includes("left"));
  }, wayId);
  expect(replayed).toBe(true);
  await page.getByRole("button", { name: "+1", exact: true }).click();
  expect(await page.evaluate(async () =>
    (await import("/src/stores/editor.ts")).useEditorStore().vehicleCount)).toBe(1);
  await page.keyboard.press("Space");
  expect(await page.evaluate(async () =>
    (await import("/src/stores/editor.ts")).useEditorStore().trafficRunning)).toBe(false);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Очистить" }).click();
  expect(await page.evaluate(async () =>
    (await import("/src/stores/editor.ts")).useEditorStore().vehicleCount)).toBe(0);
  expect(errors).toEqual([]);
});
