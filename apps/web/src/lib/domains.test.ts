import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { explainDomain, explainRollback } from "./domains";

describe("DNS roll back refused by the write-safety rules (422)", () => {
  it("says nothing changed, why, and to roll back the newer changes first", () => {
    const older = explainRollback(new ApiError(422, "unrelated_delete", "server words"));
    expect(older).toMatch(/^Nothing was changed\./);
    expect(older).toContain("Roll back the newer changes first");
    const many = explainRollback(new ApiError(422, "too_many_deletes"));
    expect(many).toMatch(/^Nothing was changed\./);
    expect(many).toContain("more than five records");
    for (const s of [older, many]) expect(s).not.toContain("server words");
  });
  it("uses the shared wording for everything else", () => {
    for (const code of ["registrar_writes_paused", "not_found", "network", "something_new"]) {
      expect(explainRollback(new ApiError(409, code))).toBe(explainDomain(new ApiError(409, code)));
    }
  });
});
