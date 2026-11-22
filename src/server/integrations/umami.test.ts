import { describe, expect, it } from "vitest";
import { umamiBase, umamiHeaders } from "./umami";

describe("umami client", () => {
  it("picks Cloud or the self-hosted API base", () => {
    expect(umamiBase("")).toEqual({ base: "https://api.umami.is/v1", cloud: true });
    expect(umamiBase("https://cloud.umami.is")).toEqual({ base: "https://api.umami.is/v1", cloud: true });
    expect(umamiBase("https://stats.example.com/")).toEqual({ base: "https://stats.example.com/api", cloud: false });
    expect(umamiBase("https://example.com/umami/api")).toEqual({ base: "https://example.com/umami/api", cloud: false });
  });

  it("sends the key as header only; Cloud also gets x-umami-api-key", () => {
    expect(umamiHeaders("k", true)).toEqual({ "x-umami-api-key": "k", Authorization: "Bearer k" });
    expect(umamiHeaders("k", false)).toEqual({ Authorization: "Bearer k" });
  });
});
