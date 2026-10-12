// Deterministic bracket sizing. The LLM only turns plain English into a spec;
// every number that decides strength is computed here so it is repeatable and auditable.

export const G = 9.81;

// ISO 273 medium-fit clearance holes, ISO 7089 washer OD, ISO 898-1 tensile stress area.
export const FASTENERS = {
  M3: { d: 3, clearance: 3.4, washerOD: 7, As: 5.03 },
  M4: { d: 4, clearance: 4.5, washerOD: 9, As: 8.78 },
  M5: { d: 5, clearance: 5.5, washerOD: 10, As: 14.2 },
  M6: { d: 6, clearance: 6.6, washerOD: 12, As: 20.1 },
  M8: { d: 8, clearance: 9.0, washerOD: 16, As: 36.6 },
  M10: { d: 10, clearance: 11.0, washerOD: 20, As: 58.0 },
  M12: { d: 12, clearance: 13.5, washerOD: 24, As: 84.3 },
  M16: { d: 16, clearance: 17.5, washerOD: 30, As: 157 },
};

// Property class 8.8 bolt (ISO 898-1): proof stress 580 MPa, ultimate 800 MPa.
const BOLT_PROOF_MPA = 580;
const BOLT_UTS_MPA = 800;

// Yield (Sy) and modulus (E) in MPa. Plastics are FDM-printed, XY orientation, conservative.
export const MATERIALS = {
  steel_g250: { name: "Mild steel AS/NZS 3678 Gr250 / ASTM A36", Sy: 250, E: 200000, rho: 7.85 },
  al6061_t6: { name: "Aluminium 6061-T6 (AS/NZS 1734, ASTM B209)", Sy: 276, E: 69000, rho: 2.7 },
  al5052_h32: { name: "Aluminium 5052-H32 sheet", Sy: 193, E: 70000, rho: 2.68 },
  ss304: { name: "Stainless 304 (annealed)", Sy: 215, E: 193000, rho: 8.0 },
  petg: { name: "PETG (FDM printed)", Sy: 35, E: 2100, rho: 1.27 },
  pla: { name: "PLA (FDM printed)", Sy: 40, E: 3500, rho: 1.24 },
};

export const STOCK_THICKNESS_MM = [1.6, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 25];

const roundUp = (x, step) => Math.ceil(x / step - 1e-9) * step;
const r2 = (x) => Math.round(x * 100) / 100;

/**
 * spec: {
 *   style: "flat" | "angle",
 *   mount_hole: "M8",        // bolts to the structure
 *   load_hole: "M6",         // carries the load
 *   spacing_mm: 35,
 *   load_kg: 25,
 *   load_case: "tension" | "shear" | "cantilever",
 *   material: keyof MATERIALS,
 *   safety_factor: 3,
 * }
 */
export function sizeBracket(spec) {
  const A = FASTENERS[spec.mount_hole];
  const B = FASTENERS[spec.load_hole];
  const mat = MATERIALS[spec.material];
  if (!A || !B) throw new Error(`Unsupported hole size: ${spec.mount_hole} / ${spec.load_hole}`);
  if (!mat) throw new Error(`Unsupported material: ${spec.material}`);
  if (!(spec.load_kg > 0) || !(spec.spacing_mm > 0)) throw new Error("load_kg and spacing_mm must be > 0");

  const SF = spec.safety_factor || 3;
  const F = spec.load_kg * G; // N, working load
  const Fd = F * SF; // N, design load
  const Sy = mat.Sy;

  // Edge distance from hole centre: >= 1.5 x clearance dia (EN 1993-1-8 asks >= 1.2 d0) and room for a washer.
  const edge = (f) => Math.max(1.5 * f.clearance, f.washerOD / 2 + 1);
  const eA = edge(A);
  const eB = edge(B);
  const width = roundUp(2 * Math.max(eA, eB), 1);
  const dMax = Math.max(A.clearance, B.clearance);
  const bNet = width - dMax;

  const checks = [];
  const need = (name, t, formula) => checks.push({ name, required_t_mm: r2(t), formula });

  // Hole-local failure modes (apply to every style / load case).
  need("Net-section tension at largest hole", Fd / (bNet * Sy), "t >= Fd / ((b - d0) * Sy)");
  need("Bearing at load hole", Fd / (B.d * 1.5 * Sy), "t >= Fd / (d * 1.5 * Sy)");
  need("Bearing at mount hole", Fd / (A.d * 1.5 * Sy), "t >= Fd / (d * 1.5 * Sy)");
  need("Tear-out at load hole", Fd / (1.2 * Sy * (eB - B.clearance / 2)), "t >= Fd / (2 * 0.6 * Sy * (e - d0/2))");

  // Bending. Arm is set after thickness is known for the angle (bend clearance), so iterate.
  let t = Math.max(...checks.map((c) => c.required_t_mm));
  let arm = spec.spacing_mm;
  let geometry;
  for (let i = 0; i < 6; i++) {
    t = STOCK_THICKNESS_MM.find((s) => s >= t) ?? roundUp(t, 5);
    geometry = buildGeometry(spec, A, B, eA, eB, width, t);
    arm = geometry.arm_mm;
    let tBend = 0;
    if (spec.style === "angle" || spec.load_case === "cantilever") {
      // Plate bending about its weak axis: sigma = 6M / (b t^2). Angle: critical section at the bend (no hole).
      const b = spec.style === "angle" ? width : bNet;
      tBend = Math.sqrt((6 * Fd * arm) / (b * Sy));
    } else if (spec.load_case === "shear") {
      // In-plane load across a flat link: strong-axis bending, sigma = 6M / (t b^2) at the mount hole.
      tBend = (6 * Fd * arm) / (bNet * bNet * Sy);
    }
    if (tBend <= t) {
      if (tBend > 0) need("Bending at critical section", tBend, "angle/cantilever: t >= sqrt(6 Fd L / (b Sy)); in-plane: t >= 6 Fd L / (b^2 Sy)");
      break;
    }
    t = tBend;
  }

  // Deflection at the load hole under working load (not factored).
  let deflection = null;
  if (spec.style === "angle" || spec.load_case === "cantilever") {
    const I = (width * t ** 3) / 12;
    deflection = (F * arm ** 3) / (3 * mat.E * I);
  }

  // 8.8 bolts, single shear / direct tension.
  const bolts = [
    ["mount", spec.mount_hole, A],
    ["load", spec.load_hole, B],
  ].map(([role, size, f]) => {
    const tensionCap = BOLT_PROOF_MPA * f.As;
    const shearCap = 0.6 * BOLT_UTS_MPA * f.As;
    const cap = Math.min(tensionCap, shearCap);
    return { role, size, class: "8.8", capacity_N: Math.round(cap), utilisation: r2(Fd / cap), ok: Fd <= cap };
  });

  const warnings = [];
  if (deflection !== null && deflection > arm / 100) warnings.push(`Tip deflection ${r2(deflection)} mm exceeds L/100 - consider a gusset or thicker stock.`);
  if (bolts.some((b) => !b.ok)) warnings.push("A grade 8.8 bolt is over-utilised - go up a bolt size or use more bolts.");
  if (spec.material === "pla" || spec.material === "petg") warnings.push("Printed plastic creeps under constant load - derate further or use metal for permanent loads.");
  if (spec.style === "angle" && spec.material === "al6061_t6") warnings.push("6061-T6 cracks on tight bends - machine/weld it, bend in -O then heat-treat, or use 5052-H32.");
  if (geometry.arm_mm > spec.spacing_mm) warnings.push(`Load hole moved to ${geometry.arm_mm} mm from mount face so the washer clears the bend.`);

  const mass_g = (geometry.volume_mm3 / 1000) * mat.rho;

  return {
    inputs: { ...spec, safety_factor: SF },
    material: mat.name,
    working_load_N: r2(F),
    design_load_N: r2(Fd),
    thickness_mm: t,
    width_mm: width,
    edge_distance_mm: { mount: r2(eA), load: r2(eB) },
    arm_mm: r2(arm),
    checks,
    governing: checks.reduce((a, c) => (c.required_t_mm > a.required_t_mm ? c : a)).name,
    bolts,
    deflection_mm: deflection === null ? null : r2(deflection),
    mass_g: Math.round(mass_g),
    geometry,
    warnings,
  };
}

function buildGeometry(spec, A, B, eA, eB, width, t) {
  if (spec.style === "flat") {
    const R = width / 2;
    const S = spec.spacing_mm;
    const area = 2 * R * S + Math.PI * R * R - Math.PI * ((A.clearance / 2) ** 2 + (B.clearance / 2) ** 2);
    return {
      style: "FLAT",
      holeADia: A.clearance,
      holeBDia: B.clearance,
      spacing: S,
      width,
      thickness: t,
      arm_mm: S,
      volume_mm3: area * t,
    };
  }
  // Angle: base leg carries the mount hole (A), upright leg carries the load hole (B).
  const bendRadius = t; // inside bend radius = 1t
  const holeAOffset = roundUp(t + bendRadius + A.washerOD / 2 + 1, 0.5);
  const holeBHeight = Math.max(spec.spacing_mm, roundUp(t + bendRadius + B.washerOD / 2 + 1, 0.5));
  const baseLength = roundUp(holeAOffset + eA, 0.5);
  const uprightHeight = roundUp(holeBHeight + eB, 0.5);
  const area = (baseLength + uprightHeight - t) * t * width - Math.PI * t * ((A.clearance / 2) ** 2 + (B.clearance / 2) ** 2);
  return {
    style: "ANGLE",
    holeADia: A.clearance,
    holeBDia: B.clearance,
    width,
    thickness: t,
    bendRadius,
    baseLength,
    uprightHeight,
    holeAOffset,
    holeBHeight,
    arm_mm: holeBHeight,
    volume_mm3: area,
  };
}
