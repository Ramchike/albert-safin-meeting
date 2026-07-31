import { expect, test } from "@playwright/test";

test("основной сценарий встречи работает", async ({ page }, testInfo) => {
  await page.goto(`/?room=e2e-room-${testInfo.project.name}`);
  await expect(page.getByRole("heading", { name: /Не получить ответы/ })).toBeVisible();
  await expect(page.getByText("Цитаты — дословные")).toBeVisible();

  const firstQuestion = page.locator(".question").first();
  await firstQuestion.locator(".check").click();
  await expect(firstQuestion).toHaveClass(/checked/);

  await page.getByRole("button", { name: /Команда/ }).click();
  await expect(page.getByRole("heading", { name: "Сохранить команду при росте" })).toBeVisible();

  await page.getByLabel("Добавить свой вопрос в эту тему").fill("Как понять, что практика прижилась?");
  await page.getByRole("button", { name: "Добавить" }).click();
  await expect(page.getByText("Как понять, что практика прижилась?")).toBeVisible();
});

test("вводная и источники открываются", async ({ page }, testInfo) => {
  await page.goto(`/?room=e2e-dialog-${testInfo.project.name}`);
  await page.getByRole("button", { name: /Вводная на 60 секунд/ }).click();
  await expect(page.getByRole("heading", { name: "Вводная на 60 секунд" })).toBeVisible();
  await page.getByRole("button", { name: "Закрыть" }).click();

  await page.getByRole("button", { name: "Источники" }).click();
  await expect(page.getByRole("heading", { name: "Почему эти вопросы подходят Альберту" })).toBeVisible();
});
