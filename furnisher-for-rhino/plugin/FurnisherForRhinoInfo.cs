using System;
using System.Drawing;
using Grasshopper.Kernel;

namespace FurnisherForRhino
{
    /// <summary>
    /// Plugin metadata Grasshopper reads when it loads the .gha.
    /// </summary>
    public class FurnisherForRhinoInfo : GH_AssemblyInfo
    {
        public override string Name => "Furnisher for Rhino";

        public override Bitmap? Icon => null;

        public override string Description =>
            "Runs the SpatialTimber furnisher engine on room geometry read from Rhino layers.";

        public override Guid Id => new Guid("b1f4c6a2-3d7e-4a91-8c2b-6f0e9a1d4c55");

        public override string AuthorName => "NeoBIM";

        public override string AuthorContact => "iuliia@neobim.ai";
    }
}
