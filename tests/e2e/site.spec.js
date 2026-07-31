import { expect, test } from "@playwright/test";

test("основной сценарий встречи и быстрый новый запрос работают", async ({ page }, testInfo) => {
  const room = `main-${testInfo.project.name}-${Date.now()}`;
  await page.goto(`/?test-room=${room}`);
  await expect(page.getByRole("heading", { name: /Запросы к программе Альберта Сафина/ })).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.getByRole("heading", { name: "Пять направлений программы" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Коротко о команде" })).toBeVisible();
  await expect(page.locator(".question")).toHaveCount(5);

  const firstQuestion = page.locator(".question").first();
  await firstQuestion.locator(".check").click();
  await expect(firstQuestion).toHaveClass(/checked/);

  const addButton = page.getByRole("button", { name: "Добавить новый запрос" });
  await expect(addButton).toBeVisible();
  await addButton.click();
  await page.getByRole("textbox", { name: "Запрос" }).fill("Как понять, что практика прижилась?");
  await page.getByRole("button", { name: "Добавить для всех" }).click();
  await expect(page.getByText("Как понять, что практика прижилась?")).toBeVisible();
});

test("мобильная кнопка нового запроса закреплена снизу", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Проверка относится только к мобильной раскладке");
  await page.goto(`/?test-room=fab-${Date.now()}`);
  const addButton = page.getByRole("button", { name: "Добавить новый запрос" });
  await expect(addButton).toBeVisible({ timeout: 8_000 });

  const geometry = await addButton.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      position: getComputedStyle(element).position,
      centerDelta: Math.abs(rect.left + rect.width / 2 - innerWidth / 2),
      bottomGap: innerHeight - rect.bottom,
    };
  });

  expect(geometry.position).toBe("fixed");
  expect(geometry.centerDelta).toBeLessThan(2);
  expect(geometry.bottomGap).toBeLessThan(30);
});

test("контекст команды и источники доступны", async ({ page }, testInfo) => {
  await page.goto(`/?test-room=dialog-${testInfo.project.name}-${Date.now()}`);
  await expect(page.getByText(/За две недели до вашего выступления/)).toBeVisible({ timeout: 8_000 });

  await page.getByRole("button", { name: "Источники" }).click();
  await expect(page.getByRole("heading", { name: "Материалы Альберта по нашим запросам" })).toBeVisible();
});

test("два изолированных посетителя видят отметки, заметки и указатели", async ({ browser }, testInfo) => {
  const room = `collab-${testInfo.project.name}-${Date.now()}`;
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();

  try {
    await Promise.all([
      first.goto(`/?test-room=${room}`),
      second.goto(`/?test-room=${room}`),
    ]);
    await expect(first.locator("#presence-count")).toContainText("2 участника", { timeout: 15_000 });
    await expect(second.locator("#presence-count")).toContainText("2 участника", { timeout: 15_000 });
    await first.waitForTimeout(3_500);

    await first.locator(".question").first().locator(".check").click();
    await expect(second.locator(".question").first()).toHaveClass(/checked/, { timeout: 8_000 });

    await first.locator(".question").first().locator(".team-notes summary").click();
    await first.locator(".note-form").first().getByRole("textbox").fill("Проверить через неделю");
    await first.locator(".note-form").first().getByRole("button").click();
    await expect(second.getByText("Проверить через неделю")).toBeVisible({ timeout: 8_000 });

    await first.mouse.move(220, 260);
    await expect(second.locator(".remote-cursor")).toBeVisible({ timeout: 8_000 });
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});
