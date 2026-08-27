import { describe, expect, it } from "vitest";
import { classifyLatency } from "./gas.ts";

describe("classifyLatency", () => {
  it("classifies at/under the fast threshold as fast", () => {
    expect(classifyLatency(0)).toBe("fast");
    expect(classifyLatency(300)).toBe("fast");
  });

  it("classifies at/over the slow threshold as slow", () => {
    expect(classifyLatency(1500)).toBe("slow");
    expect(classifyLatency(10_000)).toBe("slow");
  });

  it("classifies the gap between as normal", () => {
    expect(classifyLatency(301)).toBe("normal");
    expect(classifyLatency(1499)).toBe("normal");
  });
});
