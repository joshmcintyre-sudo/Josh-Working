// Minimal Onshape REST client using API keys (Basic auth).
// Docs: https://onshape-public.github.io/docs/api-intro/  and  https://cad.onshape.com/glassworks/explorer

const BASE = process.env.ONSHAPE_BASE_URL || "https://cad.onshape.com";

export const onshapeConfigured = () =>
  Boolean(process.env.ONSHAPE_ACCESS_KEY && process.env.ONSHAPE_SECRET_KEY && process.env.FS_DOCUMENT_ID && process.env.FS_VERSION_ID && process.env.FS_ELEMENT_ID);

async function api(method, path, body) {
  const auth = Buffer.from(`${process.env.ONSHAPE_ACCESS_KEY}:${process.env.ONSHAPE_SECRET_KEY}`).toString("base64");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json;charset=UTF-8; qs=0.09",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Onshape ${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

// Namespace that points a Part Studio feature at the versioned Feature Studio holding aiBracket.
let cachedNamespace;
async function featureNamespace() {
  if (cachedNamespace) return cachedNamespace;
  const { FS_DOCUMENT_ID: d, FS_VERSION_ID: v, FS_ELEMENT_ID: e } = process.env;
  const version = await api("GET", `/api/v10/documents/d/${d}/versions/${v}`);
  cachedNamespace = `d${d}::v${v}::e${e}::m${version.microversion}`;
  return cachedNamespace;
}

const qty = (parameterId, mm) => ({ btType: "BTMParameterQuantity-147", parameterId, expression: `${mm} mm`, isInteger: false });

export async function insertBracket({ documentId, workspaceId, elementId }, geometry, name = "AI Bracket") {
  const ns = await featureNamespace();
  const g = geometry;
  const lengths =
    g.style === "FLAT"
      ? { holeADia: g.holeADia, holeBDia: g.holeBDia, thickness: g.thickness, width: g.width, spacing: g.spacing }
      : {
          holeADia: g.holeADia,
          holeBDia: g.holeBDia,
          thickness: g.thickness,
          width: g.width,
          bendRadius: g.bendRadius,
          baseLength: g.baseLength,
          uprightHeight: g.uprightHeight,
          holeAOffset: g.holeAOffset,
          holeBHeight: g.holeBHeight,
        };

  const body = {
    btType: "BTFeatureDefinitionCall-1406",
    feature: {
      btType: "BTMFeature-134",
      featureType: "aiBracket",
      name,
      namespace: ns,
      parameters: [
        { btType: "BTMParameterEnum-145", parameterId: "style", enumName: "BracketStyle", value: g.style, namespace: ns },
        ...Object.entries(lengths).map(([k, v]) => qty(k, v)),
      ],
    },
  };
  return api("POST", `/api/v10/partstudios/d/${documentId}/w/${workspaceId}/e/${elementId}/features`, body);
}
