// Paste below the two header lines Onshape writes into a new Feature Studio
// (keep Onshape's own "FeatureScript NNNN;" and geometry.fs import lines - they pin the current std version).
// Geometry for the AI Bracket panel. Can also be used by hand from the Part Studio toolbar.

export enum BracketStyle
{
    annotation { "Name" : "Flat link" }
    FLAT,
    annotation { "Name" : "Angle (L)" }
    ANGLE
}

const SMALL_BOUNDS = { (millimeter) : [0.5, 6.6, 200] } as LengthBoundSpec;
const LENGTH_BOUNDS = { (millimeter) : [1, 35, 2000] } as LengthBoundSpec;
const THICK_BOUNDS = { (millimeter) : [0.5, 5, 100] } as LengthBoundSpec;

annotation { "Feature Type Name" : "AI Bracket" }
export const aiBracket = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Style" }
        definition.style is BracketStyle;

        annotation { "Name" : "Mount hole dia (A)" }
        isLength(definition.holeADia, SMALL_BOUNDS);

        annotation { "Name" : "Load hole dia (B)" }
        isLength(definition.holeBDia, SMALL_BOUNDS);

        annotation { "Name" : "Thickness" }
        isLength(definition.thickness, THICK_BOUNDS);

        annotation { "Name" : "Width" }
        isLength(definition.width, LENGTH_BOUNDS);

        if (definition.style == BracketStyle.FLAT)
        {
            annotation { "Name" : "Hole spacing (centre to centre)" }
            isLength(definition.spacing, LENGTH_BOUNDS);
        }
        else
        {
            annotation { "Name" : "Inside bend radius" }
            isLength(definition.bendRadius, THICK_BOUNDS);

            annotation { "Name" : "Base leg length" }
            isLength(definition.baseLength, LENGTH_BOUNDS);

            annotation { "Name" : "Upright leg height" }
            isLength(definition.uprightHeight, LENGTH_BOUNDS);

            annotation { "Name" : "Mount hole offset from outer face" }
            isLength(definition.holeAOffset, LENGTH_BOUNDS);

            annotation { "Name" : "Load hole height from base underside" }
            isLength(definition.holeBHeight, LENGTH_BOUNDS);
        }
    }
    {
        const t = definition.thickness;
        const w = definition.width;
        const zero = 0 * meter;
        const over = 1 * millimeter;

        if (definition.style == BracketStyle.FLAT)
        {
            // Obround link on the Top plane, holes at (0,0) and (S,0).
            const S = definition.spacing;
            const R = w / 2;
            const sk = newSketchOnPlane(context, id + "profile", {
                        "sketchPlane" : plane(vector(0, 0, 0) * meter, vector(0, 0, 1), vector(1, 0, 0))
                    });
            skLineSegment(sk, "bottom", { "start" : vector(zero, -R), "end" : vector(S, -R) });
            skArc(sk, "endB", { "start" : vector(S, -R), "mid" : vector(S + R, zero), "end" : vector(S, R) });
            skLineSegment(sk, "top", { "start" : vector(S, R), "end" : vector(zero, R) });
            skArc(sk, "endA", { "start" : vector(zero, R), "mid" : vector(-R, zero), "end" : vector(zero, -R) });
            skSolve(sk);

            opExtrude(context, id + "body", {
                        "entities" : qSketchRegion(id + "profile"),
                        "direction" : vector(0, 0, 1),
                        "endBound" : BoundingType.BLIND,
                        "endDepth" : t
                    });

            fCylinder(context, id + "holeA", {
                        "bottomCenter" : vector(zero, zero, -over),
                        "topCenter" : vector(zero, zero, t + over),
                        "radius" : definition.holeADia / 2
                    });
            fCylinder(context, id + "holeB", {
                        "bottomCenter" : vector(S, zero, -over),
                        "topCenter" : vector(S, zero, t + over),
                        "radius" : definition.holeBDia / 2
                    });
        }
        else
        {
            // L profile on the Front plane (sketch x = world X, sketch y = world Z), extruded across Y by the width.
            // Upright occupies X in [0, t]; base occupies Z in [0, t]. Bend arcs share centre (t + ri, t + ri).
            const ri = definition.bendRadius;
            const ro = ri + t;
            const c = ro;
            const k = sqrt(0.5);
            const L = definition.baseLength;
            const H = definition.uprightHeight;

            const sk = newSketchOnPlane(context, id + "profile", {
                        "sketchPlane" : plane(vector(zero, w / 2, zero), vector(0, -1, 0), vector(1, 0, 0))
                    });
            skLineSegment(sk, "baseBottom", { "start" : vector(ro, zero), "end" : vector(L, zero) });
            skLineSegment(sk, "baseEnd", { "start" : vector(L, zero), "end" : vector(L, t) });
            skLineSegment(sk, "baseTop", { "start" : vector(L, t), "end" : vector(c, t) });
            skArc(sk, "innerBend", { "start" : vector(c, t), "mid" : vector(c - ri * k, c - ri * k), "end" : vector(t, c) });
            skLineSegment(sk, "uprightInner", { "start" : vector(t, c), "end" : vector(t, H) });
            skLineSegment(sk, "uprightEnd", { "start" : vector(t, H), "end" : vector(zero, H) });
            skLineSegment(sk, "uprightOuter", { "start" : vector(zero, H), "end" : vector(zero, ro) });
            skArc(sk, "outerBend", { "start" : vector(zero, ro), "mid" : vector(c - ro * k, c - ro * k), "end" : vector(ro, zero) });
            skSolve(sk);

            opExtrude(context, id + "body", {
                        "entities" : qSketchRegion(id + "profile"),
                        "direction" : vector(0, -1, 0),
                        "endBound" : BoundingType.BLIND,
                        "endDepth" : w
                    });

            // Mount hole through the base (vertical axis).
            fCylinder(context, id + "holeA", {
                        "bottomCenter" : vector(definition.holeAOffset, zero, -over),
                        "topCenter" : vector(definition.holeAOffset, zero, t + over),
                        "radius" : definition.holeADia / 2
                    });
            // Load hole through the upright (horizontal axis).
            fCylinder(context, id + "holeB", {
                        "bottomCenter" : vector(-over, zero, definition.holeBHeight),
                        "topCenter" : vector(t + over, zero, definition.holeBHeight),
                        "radius" : definition.holeBDia / 2
                    });
        }

        opBoolean(context, id + "cut", {
                    "tools" : qUnion([qCreatedBy(id + "holeA", EntityType.BODY), qCreatedBy(id + "holeB", EntityType.BODY)]),
                    "targets" : qCreatedBy(id + "body", EntityType.BODY),
                    "operationType" : BooleanOperationType.SUBTRACTION
                });

        opDeleteBodies(context, id + "cleanup", { "entities" : qCreatedBy(id + "profile", EntityType.BODY) });
    });
