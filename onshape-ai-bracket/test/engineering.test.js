import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeBracket } from "../src/engineering.js";

const base = { mount_hole: "M8", load_hole: "M6", spacing_mm: 35, load_kg: 25, safety_factor: 3 };

test("25 kg M8->M6 steel angle, 35 mm: bending governs, 5 mm stock", () => {
  const d = sizeBracket({ ...base, style: "angle", load_case: "cantilever", material: "steel_g250" });
  // M = 25*9.81*3*35 = 25,751 Nmm; t = sqrt(6M/(27*250)) = 4.78 -> 5 mm
  assert.equal(d.thickness_mm, 5);
  assert.equal(d.width_mm, 27);
  assert.equal(d.governing, "Bending at critical section");
  assert.ok(d.bolts.every((b) => b.ok));
});

test("flat tension link is hole-governed and thin", () => {
  const d = sizeBracket({ ...base, style: "flat", load_case: "tension", material: "steel_g250" });
  assert.equal(d.thickness_mm, 1.6);
  assert.equal(d.geometry.spacing, 35);
});

test("printed PETG angle needs much thicker stock and warns about creep", () => {
  const d = sizeBracket({ ...base, style: "angle", load_case: "cantilever", material: "petg" });
  assert.ok(d.thickness_mm >= 12);
  assert.ok(d.warnings.some((w) => w.includes("creep")));
});

test("higher safety factor never gives thinner stock", () => {
  const a = sizeBracket({ ...base, style: "angle", load_case: "cantilever", material: "al6061_t6", safety_factor: 3 });
  const b = sizeBracket({ ...base, style: "angle", load_case: "cantilever", material: "al6061_t6", safety_factor: 5 });
  assert.ok(b.thickness_mm >= a.thickness_mm);
});

test("rejects unknown fastener", () => {
  assert.throws(() => sizeBracket({ ...base, mount_hole: "M7", style: "flat", load_case: "tension", material: "steel_g250" }));
});
