import { describe, expect, it } from "vitest";
import { openingScript, sections, sources } from "../src/content.js";

describe("содержание шпаргалки", () => {
  it("у каждого вопроса есть уникальный идентификатор и основание", () => {
    const questions = sections.flatMap((section) => section.questions);
    expect(new Set(questions.map((question) => question.id)).size).toBe(questions.length);
    expect(questions.every((question) => question.text && question.why)).toBe(true);
  });

  it("цитаты отделены от пересказа и имеют автора и время", () => {
    expect(sections.map((section) => section.id)).toEqual(["program"]);
    expect(
      sections.flatMap((section) => section.quotes).every((quote) => quote.text && quote.author && quote.time),
    ).toBe(true);
  });

  it("есть готовая вводная и проверяемые источники", () => {
    expect(openingScript.length).toBeGreaterThanOrEqual(4);
    expect(sections[0].questions).toHaveLength(7);
    expect(sources.every((source) => source.url.startsWith("https://"))).toBe(true);
  });
});
