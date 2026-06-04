using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace FurnisherForRhino
{
    internal sealed class RoomData
    {
        public string Name { get; set; } = "";
        public List<double[]> Polygon { get; set; } = new();
        public List<double[]> Windows { get; set; } = new();
        /// <summary>The source curve, kept so we can echo it back as output.</summary>
        public Curve? SourceCurve { get; set; }
    }

    internal sealed class SceneData
    {
        public List<RoomData> Rooms { get; set; } = new();
        public List<double[]> Doors { get; set; } = new();
    }

    /// <summary>
    /// Reads room boundaries, door points and window points from the Rhino
    /// document, organised by layer name.
    ///
    /// LAYER NAMING CONVENTION (units = metres):
    ///   • Room layers:  "NN RoomName"   e.g. "01 Bedroom", "02 Living room",
    ///                   "03 Kitchen", "04 Bathroom", "05 WC", "06 Children 1".
    ///                   The "NN " number prefix is optional and only orders/
    ///                   disambiguates; it is stripped before matching. A bare
    ///                   "Bedroom" works too. Each room layer holds ONE closed
    ///                   curve (the room boundary). Supported room names:
    ///                   Bedroom, Living room, Kitchen, Bathroom, WC,
    ///                   Children 1..4.
    ///   • "Doors" layer:   Point objects marking door centres on walls.
    ///   • "Windows" layer: Point objects marking window centres (optional).
    /// </summary>
    internal static class LayerReader
    {
        private static readonly Regex NumberPrefix = new(@"^\s*\d+[\s._\-]*", RegexOptions.Compiled);

        // A stripped layer name is a "room" layer if it starts with one of these.
        private static readonly string[] RoomPrefixes =
            { "bedroom", "living", "bathroom", "wc", "kitchen", "children" };

        public static string StripPrefix(string layerName) =>
            NumberPrefix.Replace(layerName ?? "", "").Trim();

        private static bool IsRoomName(string stripped) =>
            RoomPrefixes.Any(p => stripped.StartsWith(p, StringComparison.OrdinalIgnoreCase));

        public static SceneData Read(RhinoDoc doc)
        {
            var scene = new SceneData();
            // roomsByLayer keyed by layer index so multiple curves on one layer merge.
            var roomsByLayer = new Dictionary<int, RoomData>();
            var windowsByRoomLayer = new Dictionary<int, List<double[]>>();

            foreach (RhinoObject obj in doc.Objects)
            {
                if (obj?.Attributes == null) continue;
                Layer layer = doc.Layers[obj.Attributes.LayerIndex];
                if (layer == null) continue;

                string stripped = StripPrefix(layer.Name);
                string lower = stripped.ToLowerInvariant();

                if (lower == "doors")
                {
                    AddPointIfAny(obj, scene.Doors);
                }
                else if (lower == "windows")
                {
                    // Global window layer — attach to nearest room later if desired.
                    // For now we read them but they are room-scoped, so skip global.
                }
                else if (IsRoomName(stripped))
                {
                    int li = obj.Attributes.LayerIndex;
                    Curve? crv = (obj.Geometry as Curve);
                    if (crv != null && crv.IsClosed)
                    {
                        var pts = CurveToPolygon(crv);
                        if (pts.Count >= 3)
                        {
                            if (!roomsByLayer.TryGetValue(li, out var rd))
                            {
                                rd = new RoomData { Name = stripped, SourceCurve = crv };
                                roomsByLayer[li] = rd;
                            }
                            // First/largest curve on the layer is the room boundary.
                            if (rd.Polygon.Count == 0)
                            {
                                rd.Polygon = pts;
                                rd.SourceCurve = crv;
                            }
                        }
                    }
                }
            }

            scene.Rooms = roomsByLayer.Values.Where(r => r.Polygon.Count >= 3).ToList();
            return scene;
        }

        private static void AddPointIfAny(RhinoObject obj, List<double[]> sink)
        {
            switch (obj.Geometry)
            {
                case Point p:
                    sink.Add(new[] { p.Location.X, p.Location.Y });
                    break;
                case PointCloud pc:
                    foreach (var item in pc)
                        sink.Add(new[] { item.Location.X, item.Location.Y });
                    break;
                case TextDot dot:
                    sink.Add(new[] { dot.Point.X, dot.Point.Y });
                    break;
            }
        }

        /// <summary>
        /// Convert a closed curve to a list of [x,y] vertices, dropping the
        /// duplicated closing point (the engine expects last != first).
        /// </summary>
        private static List<double[]> CurveToPolygon(Curve crv)
        {
            Polyline pl;
            if (!crv.TryGetPolyline(out pl))
            {
                // Fall back: discretise non-polyline curves.
                PolylineCurve plc = crv.ToPolyline(0.01, 1.0, 0.05, 1000.0);
                if (plc == null || !plc.TryGetPolyline(out pl))
                    return new List<double[]>();
            }

            var pts = new List<double[]>(pl.Count);
            foreach (Point3d pt in pl)
                pts.Add(new[] { pt.X, pt.Y });

            // Remove trailing duplicate of the first point if present.
            if (pts.Count >= 2)
            {
                var first = pts[0];
                var last = pts[pts.Count - 1];
                if (Math.Abs(first[0] - last[0]) < 1e-9 && Math.Abs(first[1] - last[1]) < 1e-9)
                    pts.RemoveAt(pts.Count - 1);
            }
            return pts;
        }
    }
}
