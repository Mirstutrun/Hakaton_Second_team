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
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect((await state(page)).tags.lanes).toBe("2");
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  expect((await state(page)).tags.lanes).toBe("4");
  await page.getByRole("button", { name: "Выбор V", exact: false }).click();
  await page.locator("canvas").click({ position: { x: 500, y: 100 } });
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
  const moved = await page.evaluate(async () => {
    const path = "/src/stores/editor.ts";
    const geo = "/src/core/geo/projection.ts";
    const store = (await import(path)).useEditorStore();
    const { createProjection, documentOrigin } = await import(geo);
    const ref = store.selectedVertex;
    const node = store.document.nodes.get(ref);
    return createProjection(documentOrigin(store.document)).project({
      lat: Number(node.getAttribute("lat")),
      lon: Number(node.getAttribute("lon")),
    });
  });
  expect(moved.z).toBeCloseTo(-30, 0);
  await page.getByRole("button", { name: "Светофор T", exact: false }).click();
  const signalPoint = await scenePoint(page, -85, -80);
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
  await page.getByRole("button", { name: "Сохранить карту" }).click();
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

test("2D preview: lane tags, vehicles and keyboard shortcuts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Ссылки дорог корректны")).toBeVisible({
    timeout: 60000,
  });
  await expect(
    page.getByRole("button", { name: "2D", exact: true }),
  ).toHaveClass(/active/);
  const wayId = await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    return Array.from(store.document!.ways.values())
      .find(
        (way) =>
          way.querySelector('tag[k="lanes"][v="2"]') &&
          way.querySelector('tag[k="highway"]'),
      )
      ?.getAttribute("id");
  });
  expect(wayId).toBeTruthy();
  await page.getByRole("textbox", { name: "OSM ID", exact: true }).fill(wayId!);
  await page.getByRole("button", { name: "Найти объект" }).click();
  await page.getByText("Настроить отдельную полосу", { exact: true }).click();
  await page.locator(".lane-picker button").first().click();
  await page
    .getByRole("combobox", { name: "Повороты выбранной полосы" })
    .selectOption("left");
  await page.getByRole("button", { name: "Применить к полосе" }).click();
  const laneSaved = await page.evaluate(async (id) => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    const way = store.document!.ways.get(id!);
    return Array.from(way!.querySelectorAll("tag")).some(
      (tag) =>
        tag.getAttribute("k")?.startsWith("turn:lanes") &&
        tag.getAttribute("v")?.includes("left"),
    );
  }, wayId);
  expect(laneSaved).toBe(true);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await page.keyboard.press("Control+y");
  const replayed = await page.evaluate(async (id) => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    return Array.from(
      store.document!.ways.get(id!)!.querySelectorAll("tag"),
    ).some(
      (tag) =>
        tag.getAttribute("k")?.startsWith("turn:lanes") &&
        tag.getAttribute("v")?.includes("left"),
    );
  }, wayId);
  expect(replayed).toBe(true);
  await page.getByRole("button", { name: "Транспорт", exact: true }).click();
  await page.getByRole("button", { name: "+ 10 машин" }).click();
  expect(
    await page.evaluate(
      async () =>
        (await import("/src/stores/editor.ts")).useEditorStore().vehicleCount,
    ),
  ).toBe(10);
  await page.keyboard.press("Space");
  expect(
    await page.evaluate(
      async () =>
        (await import("/src/stores/editor.ts")).useEditorStore().trafficRunning,
    ),
  ).toBe(false);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Очистить" }).click();
  expect(
    await page.evaluate(
      async () =>
        (await import("/src/stores/editor.ts")).useEditorStore().vehicleCount,
    ),
  ).toBe(0);
  expect(errors).toEqual([]);
});

test("bus stops, route and bus are available in the editor", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Ссылки дорог корректны")).toBeVisible({
    timeout: 60000,
  });
  await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    store.load(
      `<osm version="0.6">
      <node id="1" lat="52" lon="104"/><node id="2" lat="52" lon="104.001"/>
      <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
    </osm>`,
      "bus-test.osm",
    );
  });
  await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    store.execute({
      type: "add-bus-stop",
      wayId: "10",
      index: 1,
      point: { lat: 52, lon: 104.00025 },
    });
  });
  await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    store.execute({
      type: "add-bus-stop",
      wayId: "10",
      index: 2,
      point: { lat: 52, lon: 104.00075 },
    });
  });
  await expect(page.getByText("2 остановок")).toBeVisible();
  await page.getByRole("button", { name: "Транспорт", exact: true }).click();
  await page.getByRole("button", { name: "Маршрут автобуса R" }).click();
  await page.getByText("Автобусы и маршруты · 0").click();
  const stops = page.locator(".bus-stop-list button");
  await stops.nth(0).click();
  await stops.nth(1).click();
  await page
    .getByRole("textbox", { name: "Название маршрута" })
    .fill("Автобус 1");
  await page.getByRole("button", { name: "Сохранить маршрут" }).click();
  await expect(page.getByText("Автобусы и маршруты · 1")).toBeVisible();
  await page.getByRole("button", { name: "+ Автобус" }).click();
  expect(
    await page.evaluate(
      async () =>
        (await import("/src/stores/editor.ts")).useEditorStore().busCount,
    ),
  ).toBe(1);
  expect(errors).toEqual([]);
});

test("join tool connects an existing endpoint to a road", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Ссылки дорог корректны")).toBeVisible({
    timeout: 60000,
  });
  await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    store.load(
      `<osm version="0.6">
      <node id="1" lat="52" lon="104"/><node id="2" lat="52" lon="104.001"/>
      <node id="3" lat="52.0002" lon="104.0002"/>
      <node id="4" lat="52.0004" lon="104.0002"/>
      <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
      <way id="11"><nd ref="3"/><nd ref="4"/><tag k="highway" v="residential"/></way>
    </osm>`,
      "join-test.osm",
    );
    store.selectOsmElement({ type: "way", id: "11" });
    store.focusRequest++;
  });
  const points = await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    const { createProjection, documentOrigin } =
      await import("/src/core/geo/projection.ts");
    const projection = createProjection(documentOrigin(store.document!));
    return {
      source: projection.project({ lat: 52.0002, lon: 104.0002 }),
      target: projection.project({ lat: 52, lon: 104.0002 }),
    };
  });
  await page.getByRole("button", { name: "Соединить дороги J" }).click();
  const sourcePoint = await scenePoint(page, points.source.x, points.source.z);
  await page.mouse.click(sourcePoint.x, sourcePoint.y);
  expect(
    await page.evaluate(
      async () =>
        (await import("/src/stores/editor.ts")).useEditorStore().joinSource
          ?.nodeId,
    ),
  ).toBe("3");
  const targetPoint = await scenePoint(page, points.target.x, points.target.z);
  await page.mouse.click(targetPoint.x, targetPoint.y);
  const connected = await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    const refs = (id: string) =>
      Array.from(store.document!.ways.get(id)!.querySelectorAll("nd"), (node) =>
        node.getAttribute("ref"),
      );
    return refs("10").includes(refs("11")[0]);
  });
  expect(connected).toBe(true);
});

test("driving side selector and before-after report preserve OSM", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Ссылки дорог корректны")).toBeVisible({
    timeout: 60000,
  });
  const before = await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    store.load(
      '<osm version="0.6"><node id="1" lat="52" lon="104"/><node id="2" lat="52" lon="104.002"/><way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="lanes" v="4"/></way></osm>',
      "test.osm",
    );
    return store.document!.xml.documentElement.outerHTML;
  });
  await page.getByRole("button", { name: "Транспорт", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Сторона движения" }),
  ).toHaveValue("left");
  await page
    .getByRole("combobox", { name: "Сторона движения" })
    .selectOption("right");
  expect(
    await page.evaluate(async () => {
      const store = (await import("/src/stores/editor.ts")).useEditorStore();
      return store.document!.xml.documentElement.outerHTML;
    }),
  ).toBe(before);
  await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    store.execute({
      type: "set-tags",
      target: { type: "way", id: "10" },
      tags: { lanes: "2" },
    });
  });
  await page.getByRole("button", { name: "Проверка", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Отчёт до / после для защиты" })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("test-before-after.json");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const report = JSON.parse(Buffer.concat(chunks).toString());
  expect(report.changes.ways.modified).toEqual(["10"]);
  expect(report.before.ways).toBe(1);
  expect(report.after.ways).toBe(1);
});

test("clear workspace modes, help and narrow-screen inspector", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.getByText("Ссылки дорог корректны")).toBeVisible({
    timeout: 60000,
  });
  await expect(
    page.getByRole("button", { name: "Редактирование", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "+ 10 машин" })).toBeHidden();
  await page.getByRole("button", { name: "? Как работать" }).click();
  await expect(
    page.getByRole("dialog", { name: "Как работать" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Транспорт", exact: true }).click();
  await expect(page.getByRole("button", { name: "+ 10 машин" })).toBeVisible();
  await page.getByRole("button", { name: "Проверка", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Тип проблемы" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Тип проблемы" })
    .selectOption("near-disconnection");
  await page.screenshot({ path: testInfo.outputPath("review-desktop.png") });
  await page
    .getByRole("button", { name: "Редактирование", exact: true })
    .click();
  await page.screenshot({ path: testInfo.outputPath("editor-desktop.png") });
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.getByRole("button", { name: "Вся карта", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("editor-3d.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Свойства объекта", exact: true })
    .click();
  await expect(
    page.getByText("Выберите дорогу на карте", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Закрыть свойства", exact: true })
    .click();
  await page.screenshot({ path: testInfo.outputPath("editor-mobile.png") });
});

test("search a street by name without changing its OSM data", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Ссылки дорог корректны")).toBeVisible({
    timeout: 60000,
  });
  const name = await page.evaluate(async () => {
    const store = (await import("/src/stores/editor.ts")).useEditorStore();
    return Array.from(store.document!.ways.values())
      .find(
        (w) =>
          w.querySelector('tag[k="highway"]') &&
          w.querySelector('tag[k="name"]'),
      )!
      .querySelector('tag[k="name"]')!
      .getAttribute("v")!;
  });
  await page.getByRole("textbox", { name: "OSM ID", exact: true }).fill(name);
  await page.locator(".search-results button").first().click();
  await expect(page.locator(".properties-panel h2")).toContainText(name);
  expect((await state(page)).dirty).toBe(false);
});
