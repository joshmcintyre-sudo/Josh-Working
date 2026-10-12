import Anthropic from "@anthropic-ai/sdk";
import { FASTENERS, MATERIALS } from "./engineering.js";

const client = new Anthropic();

// The model only extracts intent. Sizing is done in engineering.js.
const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["style", "mount_hole", "load_hole", "spacing_mm", "load_kg", "load_case", "material", "safety_factor", "assumptions", "questions"],
  properties: {
    style: { type: "string", enum: ["flat", "angle"] },
    mount_hole: { type: "string", enum: Object.keys(FASTENERS), description: "Bolt that fixes the bracket to the structure" },
    load_hole: { type: "string", enum: Object.keys(FASTENERS), description: "Bolt that carries the load" },
    spacing_mm: { type: "number" },
    load_kg: { type: "number" },
    load_case: { type: "string", enum: ["tension", "shear", "cantilever"] },
    material: { type: "string", enum: Object.keys(MATERIALS) },
    safety_factor: { type: "number" },
    assumptions: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM = `You convert a designer's bracket request into a JSON spec for a sizing engine. Do not size anything yourself.

Conventions:
- style "flat": straight link plate, holes spacing_mm centre to centre. style "angle": L bracket, mount hole in the base leg, load hole in the upright leg, spacing_mm = load hole height above the mounting face.
- mount_hole is the bolt into the structure ("mounts to an M8 bracket" -> M8). load_hole carries the load.
- load_case: "tension" = load pulls along the link; "shear" = load in the plate's plane across the link; "cantilever" = load bends the plate out of its plane. Angle brackets holding a hanging load are "cantilever".
- If the request does not say which, prefer "angle" + "cantilever" when "mount"/"hold"/"hang"/"shelf" suggests a load offset from the mounting face; "flat" + "tension" for links and straps.
- material default steel_g250 unless the user names one ("aluminium" -> al6061_t6, "sheet aluminium"/"bent" -> al5052_h32, "stainless" -> ss304, "3D print" -> petg unless PLA named).
- safety_factor: 3 for a static load, 4 if people could be under it, 5 for vehicle-mounted or vibrating use (canopies, trays, roof racks see 2-3 g on corrugated roads).
- Record every assumption you made in "assumptions". Put anything genuinely ambiguous that changes the result in "questions" (max 2), but still return your best-guess spec.
- If a current design is supplied, apply the change request to it and keep everything else.`;

export async function parseRequest(query, current) {
  const content = current
    ? `Current design spec:\n${JSON.stringify(current)}\n\nChange request: ${query}`
    : query;

  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: { type: "json_schema", schema: SPEC_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  if (response.stop_reason === "max_tokens") throw new Error("Model output was cut off - try a shorter request.");
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("No spec returned by the model.");
  return JSON.parse(text);
}
