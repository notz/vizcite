import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isolatedDot } from "./charts";

const render = (data: Record<string, unknown>[], index: number) => {
  const Dot = isolatedDot(data, "v");
  return renderToStaticMarkup(<svg>{Dot({ cx: 10, cy: 20, index, stroke: "red" })}</svg>);
};

describe("isolatedDot", () => {
  it("draws a dot for a single point", () => {
    expect(render([{ v: 5 }], 0)).toContain("<circle");
  });
  it("draws a dot for a point surrounded by gaps", () => {
    expect(render([{ v: null }, { v: 5 }, { v: undefined }], 1)).toContain("<circle");
  });
  it("draws nothing when a neighbour exists (the line covers it)", () => {
    expect(render([{ v: 1 }, { v: 2 }], 0)).not.toContain("<circle");
    expect(render([{ v: 1 }, { v: 2 }, { v: 3 }], 1)).not.toContain("<circle");
  });
});
