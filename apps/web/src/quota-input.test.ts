import { describe, expect, it } from "vitest";
import { readQuotaForm } from "./quota-input.js";

const valid = {
  maxBots: "5",
  maxConcurrentTasks: "2",
  maxRoutines: "10",
  taskTokenBudget: "",
  taskMaxSteps: "",
  taskMaxDurationSec: "",
};

describe("quota form input", () => {
  it("turns only blank optional fields into null and keeps zero", () => {
    expect(readQuotaForm({ ...valid, taskMaxSteps: "0", taskMaxDurationSec: " 15 " }).taskMaxSteps).toBe(0);
    expect(readQuotaForm({ ...valid, taskMaxDurationSec: "15" })).toMatchObject({
      taskTokenBudget: null,
      taskMaxSteps: null,
      taskMaxDurationSec: 15,
    });
  });

  it("rejects non-integers that would serialize as null and does not produce a payload", () => {
    for (const bad of ["Infinity", "NaN", "1.5", "-1", "1e2", "9007199254740993"]) {
      expect(() => readQuotaForm({ ...valid, taskMaxSteps: bad })).toThrow(/非负整数/);
    }
    expect(() => readQuotaForm({ ...valid, maxBots: "abc" })).toThrow(/非负整数/);
  });
});
