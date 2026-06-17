using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;

namespace FurnisherForRhino
{
    // ─── Wire DTOs (must match engine-cli/src/cli.ts) ──────────────────────────
    // Geometry points are [x, y] in metres, encoded as 2-element double arrays.

    internal sealed class RoomInput
    {
        public string Name { get; set; } = "";
        public double[][] Polygon { get; set; } = Array.Empty<double[]>();
        public double[][]? Windows { get; set; }
    }

    internal sealed class EngineRequest
    {
        public List<RoomInput> Rooms { get; set; } = new();
        public double[][]? Doors { get; set; }
        public int? AptType { get; set; }
        /// <summary>"flat" or "variant-position" (see CLI docs).</summary>
        public string? SelectionMode { get; set; }
        /// <summary>selections[roomIndex] = flat indices or interleaved [vi,pos,...] pairs.</summary>
        public List<List<int>>? Selections { get; set; }
    }

    internal sealed class GeomOut
    {
        public bool Closed { get; set; }
        public double[][] Points { get; set; } = Array.Empty<double[]>();
    }

    internal sealed class VariantGroup
    {
        public int VariantIndex { get; set; }
        public int StartFlatIndex { get; set; }
        public int Count { get; set; }
    }

    internal sealed class StepOut
    {
        public string FurnitureName { get; set; } = "";
        public int OptionCount { get; set; }
        public int SelectedIndex { get; set; }
        public VariantGroup[] VariantGroups { get; set; } = Array.Empty<VariantGroup>();
        public int SelectedVariant { get; set; } = -1;
        public int SelectedPosition { get; set; } = -1;
        public GeomOut[] Geometry { get; set; } = Array.Empty<GeomOut>();
        public double[][] Bbox { get; set; } = Array.Empty<double[]>();
        public double[][] SmallBbox { get; set; } = Array.Empty<double[]>();
    }

    internal sealed class StepScoreOut
    {
        public string FurnitureName { get; set; } = "";
        public int PreferredCount { get; set; }
        public int FallbackCount { get; set; }
        public bool UsedFallback { get; set; }
        public double NodeScore { get; set; }
        public double LevelWeight { get; set; }
    }

    internal sealed class DoorOut
    {
        /// <summary>[c0,c1,c2,c3]: wall pts c0,c1; inward pts c3=c0+inward, c2=c1+inward.</summary>
        public double[][] Rect { get; set; } = Array.Empty<double[]>();
        public double Width { get; set; }
        /// <summary>0 = hinge at c0 (panel→c3, arc c3→c1). 1 = hinge at c1 (panel→c2, arc c2→c0).</summary>
        public int HingeAtIndex { get; set; }
    }

    internal sealed class RoomOut
    {
        public string Name { get; set; } = "";
        public double Score { get; set; }
        public StepScoreOut[] StepScores { get; set; } = Array.Empty<StepScoreOut>();
        public StepOut[] Steps { get; set; } = Array.Empty<StepOut>();
        public DoorOut[] Doors { get; set; } = Array.Empty<DoorOut>();
        public string[] Warnings { get; set; } = Array.Empty<string>();
    }

    internal sealed class EngineResponse
    {
        public int AptType { get; set; }
        public RoomOut[] Rooms { get; set; } = Array.Empty<RoomOut>();
        public string? Error { get; set; }
    }

    /// <summary>
    /// Runs the bundled Node CLI (engine-cli/dist/furnisher-cli.cjs) as a child
    /// process: writes the request JSON to stdin, reads the response from stdout.
    /// This is the same engine the React app uses — no logic is reimplemented here.
    /// </summary>
    internal static class EngineBridge
    {
        private static readonly JsonSerializerOptions JsonOpts = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        public static EngineResponse Run(EngineRequest request, string cliPath, string nodeExe)
        {
            if (!File.Exists(cliPath))
                throw new FileNotFoundException(
                    $"Engine CLI not found at '{cliPath}'. Build it with " +
                    "`npm install && npm run build` in furnisher-for-rhino/engine-cli, " +
                    "or set the FURNISHER_CLI environment variable / the 'Engine CLI' input.",
                    cliPath);

            string requestJson = JsonSerializer.Serialize(request, JsonOpts);

            var psi = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = $"\"{cliPath}\"",
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                // BOM-less UTF-8: Encoding.UTF8 prepends a ﻿ byte-order-mark
                // to stdin, which breaks Node's JSON.parse ("Unexpected token").
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardInputEncoding = new UTF8Encoding(false),
            };

            using var proc = new Process { StartInfo = psi };

            try
            {
                proc.Start();
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    $"Could not start Node ('{nodeExe}'). Make sure Node.js is installed " +
                    "and on PATH, or set the 'Node Exe' input to its full path. " + ex.Message,
                    ex);
            }

            // Read stdout AND stderr concurrently. The engine writes many
            // [placer] debug lines to stderr; if we read stdout to completion
            // first, a full stderr pipe buffer blocks the child, which then
            // never finishes stdout -> deadlock (frozen Rhino UI thread).
            Task<string> stdoutTask = proc.StandardOutput.ReadToEndAsync();
            Task<string> stderrTask = proc.StandardError.ReadToEndAsync();

            proc.StandardInput.Write(requestJson);
            proc.StandardInput.Close();

            if (!proc.WaitForExit(60_000))
            {
                try { proc.Kill(true); } catch { /* ignore */ }
                throw new InvalidOperationException(
                    "Engine timed out after 60s and was terminated.");
            }
            // Ensure the async readers have fully drained after exit.
            Task.WaitAll(new Task[] { stdoutTask, stderrTask }, 5_000);
            string stdout = stdoutTask.IsCompleted ? stdoutTask.Result : "";
            string stderr = stderrTask.IsCompleted ? stderrTask.Result : "";

            if (string.IsNullOrWhiteSpace(stdout))
                throw new InvalidOperationException(
                    "Engine returned no output. stderr:\n" + stderr);

            EngineResponse? response;
            try
            {
                response = JsonSerializer.Deserialize<EngineResponse>(stdout, JsonOpts);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    "Could not parse engine output as JSON: " + ex.Message +
                    "\nRaw output:\n" + stdout, ex);
            }

            if (response == null)
                throw new InvalidOperationException("Engine returned null response.");

            if (!string.IsNullOrEmpty(response.Error))
                throw new InvalidOperationException("Engine error: " + response.Error);

            return response;
        }
    }
}
