import { describe, expect, it } from "vitest";
import { CALLING_CODES, EPP_PHONE, normalizePhone } from "./phone.ts";

describe("normalizePhone: what people type becomes the EPP form the registries want", () => {
  it("passes the EPP form through unchanged", () => {
    expect(normalizePhone("+1.5555550100", "US")).toBe("+1.5555550100");
    expect(normalizePhone("  +44.2079460958 ", "US")).toBe("+44.2079460958");
  });
  it("reads a national number with the contact's country", () => {
    for (const typed of ["3107747497", "310-774-7497", "(310) 774-7497", "310.774.7497", "1 (310) 774-7497", "13107747497", "310 774 7497 ext. 12", "310-774-7497 x4"]) {
      expect(normalizePhone(typed, "US"), typed).toBe("+1.3107747497");
    }
    expect(normalizePhone("(416) 555-0199", "ca")).toBe("+1.4165550199");
    expect(normalizePhone("020 7946 0958", "GB")).toBe("+44.2079460958");
    expect(normalizePhone("030 1234567", "DE")).toBe("+49.301234567");
    expect(normalizePhone("06 12 34 56 78", "FR")).toBe("+33.612345678");
    expect(normalizePhone("0412 345 678", "AU")).toBe("+61.412345678");
    expect(normalizePhone("8 (495) 123-45-67", "RU")).toBe("+7.4951234567");
    expect(normalizePhone("98765 43210", "IN")).toBe("+91.9876543210");
  });
  it("keeps the leading zero of an Italian landline, which is part of the number", () => {
    expect(normalizePhone("06 1234 5678", "IT")).toBe("+39.0612345678");
    expect(normalizePhone("+39 06 1234 5678", "US")).toBe("+39.0612345678");
    expect(normalizePhone("333 123 4567", "IT")).toBe("+39.3331234567");
  });
  it("reads an international number whatever the country field says", () => {
    expect(normalizePhone("+1 (310) 774-7497", "GB")).toBe("+1.3107747497");
    expect(normalizePhone("+44 (0)20 7946 0958", "US")).toBe("+44.2079460958");
    expect(normalizePhone("+44 20 7946 0958", "")).toBe("+44.2079460958");
    expect(normalizePhone("0049 30 1234567", "US")).toBe("+49.301234567");
    expect(normalizePhone("011 44 20 7946 0958", "US")).toBe("+44.2079460958");
    expect(normalizePhone("+358 40 1234567", "FI")).toBe("+358.401234567");
    expect(normalizePhone("+1 268 555 0100", "AG")).toBe("+1.2685550100");
    expect(normalizePhone("+7 495 123-45-67", "")).toBe("+7.4951234567");
  });
  it("refuses what it cannot read instead of guessing", () => {
    expect(normalizePhone("", "US")).toBeNull();
    expect(normalizePhone("555", "US")).toBeNull();                 // too short for the NANP
    expect(normalizePhone("+1.555", "US")).toBeNull();
    expect(normalizePhone("310-774-7497", "")).toBeNull();          // no country to read a national number with
    expect(normalizePhone("310-774-7497", "ZZ")).toBeNull();
    expect(normalizePhone("443107747497", "US")).toBeNull();        // a foreign number typed without + from a US form
    expect(normalizePhone("+999 1234567", "US")).toBeNull();        // no such calling code
    expect(normalizePhone("call me", "US")).toBeNull();
    expect(normalizePhone("+1 310 774 7497 1234", "US")).toBeNull(); // eleven digits after +1
  });
  it("only ever produces the EPP form, and every code in the table is a real calling code", () => {
    for (const [c, typed] of [["US", "(310) 774-7497"], ["GB", "+44 (0)20 7946 0958"], ["DE", "030 1234567"], ["JP", "03-1234-5678"], ["BR", "(11) 91234-5678"]] as const) {
      expect(normalizePhone(typed, c)).toMatch(EPP_PHONE);
    }
    for (const [iso, code] of Object.entries(CALLING_CODES)) { expect(iso).toMatch(/^[A-Z]{2}$/); expect(code).toMatch(/^[1-9]\d{0,2}$/); }
    expect(Object.keys(CALLING_CODES).length).toBeGreaterThan(230);
  });
});
