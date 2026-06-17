using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Grasshopper;
using Grasshopper.Kernel;
using Grasshopper.Kernel.Data;
using Grasshopper.Kernel.Types;
using Rhino;
using Rhino.Geometry;

namespace FurnisherForRhino
{
    /// <summary>
    /// Reads rooms + doors from the active Rhino document's layers, runs the
    /// SpatialTimber furnisher engine (via the Node CLI), and outputs furniture
    /// line geometry plus transition / footprint bounding boxes.
    ///
    /// Scroll through layout variants by feeding option indices into "Variants"
    /// (a tree: one branch {roomIndex}, one integer per furniture step). The
    /// "Options" output tells you how many variants each step has.
    /// </summary>
    public class FurnishComponent : GH_Component
    {
        public FurnishComponent()
            : base("ST Furnish", "Furnish",
                   "Furnish rooms read from Rhino layers using the SpatialTimber engine.",
                   "SpatialTimber", "Furnisher")
        {
        }

        public override Guid ComponentGuid => new Guid("3a9d2e14-7b58-4c0f-9e21-5d8a7c1b6f30");

        protected override System.Drawing.Bitmap? Icon => null;

        protected override void RegisterInputParams(GH_InputParamManager p)
        {
            p.AddBooleanParameter("Furnish", "On",
                "Set true (a Boolean Toggle) to read the document and furnish. " +
                "While on, changing Var re-runs the engine so you can scroll layouts.",
                GH_ParamAccess.item, false);

            p.AddIntegerParameter("Apartment Type", "Apt",
                "Apartment size tier 1-4. Leave at 0 to auto-infer from the rooms.",
                GH_ParamAccess.item, 0);

            p.AddIntegerParameter("Var", "Var",
                "Selection per step. Tree with one branch per room (path {roomIndex}).\n" +
                "TWO integers per step: [variantIndex, positionIndex]\n" +
                "  variantIndex  0…(VariantCount-1) — which furniture shape\n" +
                "  positionIndex 0…(Positions-1)    — where on the wall\n" +
                "Example for a room with Bed+Wardrobe: {0} → [1, 3, 0, 1]\n" +
                "  = Bed variant 1 position 3, Wardrobe variant 0 position 1\n" +
                "Use the VG and Info outputs to learn the available ranges.",
                GH_ParamAccess.tree);
            p[2].Optional = true;

            p.AddTextParameter("Engine CLI", "CLI",
                "Full path to engine-cli/dist/furnisher-cli.cjs. " +
                "If empty, uses the FURNISHER_CLI env var or a default dev path.",
                GH_ParamAccess.item, "");
            p[3].Optional = true;

            p.AddTextParameter("Node Exe", "Node",
                "Node.js executable. Defaults to 'node' (must be on PATH).",
                GH_ParamAccess.item, "node");
            p[4].Optional = true;
        }

        protected override void RegisterOutputParams(GH_OutputParamManager p)
        {
            p.AddCurveParameter("Rooms", "R",
                "Room boundary curves read from the document.", GH_ParamAccess.list);
            p.AddTextParameter("Room Names", "N",
                "Resolved room names, aligned with Rooms.", GH_ParamAccess.list);
            p.AddIntegerParameter("Apt Type", "Apt",
                "The apartment type used (resolved/auto-inferred).", GH_ParamAccess.item);
            p.AddCurveParameter("Furniture", "F",
                "Furniture line geometry. Tree path {room, step}.", GH_ParamAccess.tree);
            p.AddCurveParameter("Transitions", "T",
                "Transition / clearance bounding boxes. Tree path {room, step}.", GH_ParamAccess.tree);
            p.AddCurveParameter("Footprints", "Fp",
                "Physical footprint bounding boxes. Tree path {room, step}.", GH_ParamAccess.tree);
            p.AddTextParameter("Step Names", "S",
                "Furniture name per step. Tree path {room}.", GH_ParamAccess.tree);
            p.AddIntegerParameter("Options", "O",
                "Total options per step (flat count). Tree path {room}.", GH_ParamAccess.tree);
            p.AddIntegerParameter("Selected", "Sel",
                "Selected flat index per step. Tree path {room}.", GH_ParamAccess.tree);
            p.AddTextParameter("Warnings", "W",
                "Engine warnings (e.g. pieces that could not be placed).", GH_ParamAccess.list);
            // ── New outputs ──
            p.AddTextParameter("Variant Groups", "VG",
                "Variant breakdown per step, e.g. 'V1:8 V2:10 V3:6'.\n" +
                "Each Vn:k means shape n has k positions on the wall.\n" +
                "Use this to set slider domains. Tree path {room, step}.",
                GH_ParamAccess.tree);
            p.AddIntegerParameter("Variant Count", "VC",
                "Number of distinct variant shapes per step. Tree path {room}.",
                GH_ParamAccess.tree);
            p.AddIntegerParameter("Sel Variant", "SV",
                "Which variant shape is currently selected per step. Tree path {room}.",
                GH_ParamAccess.tree);
            p.AddIntegerParameter("Sel Position", "SP",
                "Position within the selected variant per step. Tree path {room}.",
                GH_ParamAccess.tree);
            p.AddTextParameter("Info", "Info",
                "Human-readable layout summary per room. Connect to a Panel.\n" +
                "Shows: furniture name, variant groups, current selection.",
                GH_ParamAccess.list);
            p.AddNumberParameter("Room Score", "Score",
                "Quality score 0–100 per room. Based on how many placement options exist " +
                "(more options = higher score). Weighted by furniture importance.",
                GH_ParamAccess.list);
            p.AddCurveParameter("Doors", "D",
                "Door visualisation curves (panel line + swing arc), one set per door. " +
                "Tree path {roomIndex, doorIndex}.",
                GH_ParamAccess.tree);
            p.AddTextParameter("Debug JSON", "JSON",
                "The exact JSON request sent to the engine. Connect to a Panel to inspect " +
                "or copy-paste for offline debugging.",
                GH_ParamAccess.item);
        }

        protected override void SolveInstance(IGH_DataAccess DA)
        {
            bool run = false;
            DA.GetData(0, ref run);
            if (!run)
            {
                AddRuntimeMessage(GH_RuntimeMessageLevel.Remark,
                    "Toggle 'On' to read the document and furnish.");
                return;
            }

            int aptType = 0;
            DA.GetData(1, ref aptType);

            var variants = new GH_Structure<GH_Integer>();
            DA.GetDataTree(2, out variants);

            string cliPath = "";
            DA.GetData(3, ref cliPath);
            string nodeExe = "node";
            DA.GetData(4, ref nodeExe);
            if (string.IsNullOrWhiteSpace(nodeExe)) nodeExe = "node";

            cliPath = ResolveCliPath(cliPath);

            RhinoDoc? doc = RhinoDoc.ActiveDoc;
            if (doc == null)
            {
                AddRuntimeMessage(GH_RuntimeMessageLevel.Error, "No active Rhino document.");
                return;
            }

            SceneData scene = LayerReader.Read(doc);
            if (scene.Rooms.Count == 0)
            {
                AddRuntimeMessage(GH_RuntimeMessageLevel.Warning,
                    "No room layers found. Name layers like '01 Bedroom', '02 Living room', " +
                    "place one closed curve per room, and put door points on a 'Doors' layer.");
                return;
            }

            // ─── Build request ────────────────────────────────────────────────
            var (selMode, selData) = BuildSelections(variants, scene.Rooms.Count);
            var request = new EngineRequest
            {
                Rooms = scene.Rooms.Select(r => new RoomInput
                {
                    Name = r.Name,
                    Polygon = r.Polygon.ToArray(),
                    Windows = r.Windows.Count > 0 ? r.Windows.ToArray() : null,
                }).ToList(),
                Doors = scene.Doors.Count > 0 ? scene.Doors.ToArray() : null,
                AptType = aptType > 0 ? aptType : (int?)null,
                SelectionMode = selMode,
                Selections = selData,
            };

            // ─── Capture debug JSON before sending ────────────────────────────
            string debugJson = System.Text.Json.JsonSerializer.Serialize(request,
                new System.Text.Json.JsonSerializerOptions
                {
                    PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
                    WriteIndented = false,
                    DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
                });

            // ─── Run engine ───────────────────────────────────────────────────
            EngineResponse response;
            try
            {
                response = EngineBridge.Run(request, cliPath, nodeExe);
            }
            catch (Exception ex)
            {
                AddRuntimeMessage(GH_RuntimeMessageLevel.Error, ex.Message);
                return;
            }

            // ─── Build outputs ────────────────────────────────────────────────
            var roomCurves   = new List<Curve>();
            var roomNames    = new List<string>();
            var furniture    = new GH_Structure<GH_Curve>();
            var transitions  = new GH_Structure<GH_Curve>();
            var footprints   = new GH_Structure<GH_Curve>();
            var stepNames    = new GH_Structure<GH_String>();
            var options      = new GH_Structure<GH_Integer>();
            var selected     = new GH_Structure<GH_Integer>();
            var warnings     = new List<string>();
            var vgText       = new GH_Structure<GH_String>();
            var variantCount = new GH_Structure<GH_Integer>();
            var selVariant   = new GH_Structure<GH_Integer>();
            var selPosition  = new GH_Structure<GH_Integer>();
            var infoLines    = new List<string>();
            var roomScores   = new List<double>();
            var doorCurves   = new GH_Structure<GH_Curve>();

            for (int r = 0; r < response.Rooms.Length; r++)
            {
                RoomOut ro = response.Rooms[r];
                roomNames.Add(ro.Name);
                if (r < scene.Rooms.Count && scene.Rooms[r].SourceCurve != null)
                    roomCurves.Add(scene.Rooms[r].SourceCurve!);

                var roomPath = new GH_Path(r);
                var infoSb = new System.Text.StringBuilder();
                infoSb.AppendLine(ro.Name.ToUpperInvariant());

                for (int s = 0; s < ro.Steps.Length; s++)
                {
                    StepOut step = ro.Steps[s];
                    stepNames.Append(new GH_String(step.FurnitureName), roomPath);
                    options.Append(new GH_Integer(step.OptionCount), roomPath);
                    selected.Append(new GH_Integer(step.SelectedIndex), roomPath);
                    selVariant.Append(new GH_Integer(step.SelectedVariant), roomPath);
                    selPosition.Append(new GH_Integer(step.SelectedPosition), roomPath);
                    variantCount.Append(new GH_Integer(step.VariantGroups.Length), roomPath);

                    // Variant groups text: "V1:8 V2:10 V3:6"
                    string vg = string.Join(" ", step.VariantGroups
                        .Select(g => $"V{g.VariantIndex + 1}:{g.Count}"));
                    vgText.Append(new GH_String(vg), new GH_Path(r, s));

                    // Info panel line
                    string selInfo = step.SelectedIndex < 0
                        ? "no placement"
                        : $"V{step.SelectedVariant + 1} pos {step.SelectedPosition + 1}/{step.VariantGroups.FirstOrDefault(g => g.VariantIndex == step.SelectedVariant)?.Count ?? 0}";
                    infoSb.AppendLine($"  {step.FurnitureName,-14} {vg,-24}  [{selInfo}]");

                    var path = new GH_Path(r, s);
                    foreach (var g in step.Geometry)
                    {
                        Curve? c = MakeCurve(g.Points, g.Closed);
                        if (c != null) furniture.Append(new GH_Curve(c), path);
                    }
                    Curve? bbox = MakeCurve(step.Bbox, true);
                    if (bbox != null) transitions.Append(new GH_Curve(bbox), path);
                    Curve? small = MakeCurve(step.SmallBbox, true);
                    if (small != null) footprints.Append(new GH_Curve(small), path);
                }

                // Score
                roomScores.Add(ro.Score);
                infoSb.AppendLine($"  Score: {ro.Score:F1}/100");
                infoLines.Add(infoSb.ToString().TrimEnd());

                // Door swing curves
                for (int d = 0; d < ro.Doors.Length; d++)
                {
                    var doorPath = new GH_Path(r, d);
                    foreach (var crv in MakeDoorCurves(ro.Doors[d]))
                        doorCurves.Append(new GH_Curve(crv), doorPath);
                }

                foreach (string w in ro.Warnings)
                    warnings.Add($"[{ro.Name}] {w}");
            }

            DA.SetDataList(0, roomCurves);
            DA.SetDataList(1, roomNames);
            DA.SetData(2, response.AptType);
            DA.SetDataTree(3, furniture);
            DA.SetDataTree(4, transitions);
            DA.SetDataTree(5, footprints);
            DA.SetDataTree(6, stepNames);
            DA.SetDataTree(7, options);
            DA.SetDataTree(8, selected);
            DA.SetDataList(9, warnings);
            DA.SetDataTree(10, vgText);
            DA.SetDataTree(11, variantCount);
            DA.SetDataTree(12, selVariant);
            DA.SetDataTree(13, selPosition);
            DA.SetDataList(14, infoLines);
            DA.SetDataList(15, roomScores);
            DA.SetDataTree(16, doorCurves);
            DA.SetData(17, debugJson);
        }

        // ─── Helpers ──────────────────────────────────────────────────────────

        /// <summary>
        /// Parse the Var input tree into (mode, selections).
        /// Each branch {r} should contain 2 integers per furniture step:
        ///   [vi0, pos0, vi1, pos1, ...]  → mode "variant-position"
        /// If the branch is empty or has exactly 1 int per step (legacy), mode is "flat".
        /// </summary>
        private static (string mode, List<List<int>> data) BuildSelections(
            GH_Structure<GH_Integer> tree, int roomCount)
        {
            var data = new List<List<int>>();
            bool anyBranch = false;

            for (int r = 0; r < roomCount; r++)
            {
                var list = new List<int>();
                IList<GH_Integer>? branch = null;
                var path = new GH_Path(r);
                if (tree.PathExists(path))
                    branch = tree[path];
                else if (tree.PathCount == 1 && r == 0)
                    branch = tree.Branches[0];

                if (branch != null)
                {
                    foreach (var gi in branch)
                        if (gi != null) list.Add(gi.Value);
                    if (list.Count > 0) anyBranch = true;
                }
                data.Add(list);
            }

            if (!anyBranch) return ("flat", data);

            // Detect variant-position mode: every non-empty branch has an even count
            // and at least one branch has >1 value per step (count > 1 after halving).
            bool allEven = data.All(l => l.Count == 0 || l.Count % 2 == 0);
            string mode = allEven ? "variant-position" : "flat";
            return (mode, data);
        }

        private static Curve? MakeCurve(double[][] pts, bool closed)
        {
            if (pts == null || pts.Length < 2) return null;
            var poly = new Polyline();
            foreach (var p in pts)
                poly.Add(new Point3d(p[0], p[1], 0.0));
            if (closed)
            {
                var f = pts[0];
                var l = pts[pts.Length - 1];
                if (Math.Abs(f[0] - l[0]) > 1e-9 || Math.Abs(f[1] - l[1]) > 1e-9)
                    poly.Add(new Point3d(f[0], f[1], 0.0));
            }
            return poly.Count >= 2 ? new PolylineCurve(poly) : null;
        }

        /// <summary>
        /// Build door visualisation curves (panel line + swing arc).
        /// rect = [c0, c1, c2, c3]:
        ///   c0 = door - wallDir*dw/2,  c1 = door + wallDir*dw/2  (on the wall)
        ///   c3 = c0 + inward*dw,       c2 = c1 + inward*dw        (into the room)
        ///
        /// HingeAtIndex selects which wall corner is the hinge so the door swings
        /// toward the room interior (away from the nearest corner).
        ///   0 → hinge=c0, panel end=c3, arc sweeps c3→c1
        ///   1 → hinge=c1, panel end=c2, arc sweeps c2→c0
        /// </summary>
        private static IEnumerable<Curve> MakeDoorCurves(DoorOut door)
        {
            double[][] r = door.Rect;
            if (r.Length < 4) yield break;

            var c0 = new Point3d(r[0][0], r[0][1], 0);
            var c1 = new Point3d(r[1][0], r[1][1], 0);
            var c2 = new Point3d(r[2][0], r[2][1], 0);
            var c3 = new Point3d(r[3][0], r[3][1], 0);

            Point3d hinge, wallEnd, panelEnd;
            if (door.HingeAtIndex == 0) { hinge = c0; wallEnd = c1; panelEnd = c3; }
            else                        { hinge = c1; wallEnd = c0; panelEnd = c2; }

            // Panel line: hinge → panel end (door in open/90° position)
            yield return new LineCurve(hinge, panelEnd);

            // Arc from panelEnd to wallEnd, centred at hinge (quarter circle).
            // Midpoint at 45°: bisect the two radius vectors.
            Vector3d toPanelEnd = panelEnd - hinge;
            Vector3d toWallEnd  = wallEnd  - hinge;
            Vector3d midDir = toPanelEnd + toWallEnd;
            if (midDir.Length < 1e-9) yield break;
            midDir.Unitize();
            var arcMid = hinge + midDir * door.Width;

            var arc = new Arc(panelEnd, arcMid, wallEnd);
            if (arc.IsValid) yield return new ArcCurve(arc);
        }

        private static string ResolveCliPath(string given)
        {
            if (!string.IsNullOrWhiteSpace(given)) return given;

            string? env = Environment.GetEnvironmentVariable("FURNISHER_CLI");
            if (!string.IsNullOrWhiteSpace(env)) return env;

            // Default dev location (sibling of this repo layout).
            return @"c:\Work\SpatialTimber-Furnisher\furnisher-for-rhino\engine-cli\dist\furnisher-cli.cjs";
        }
    }
}
