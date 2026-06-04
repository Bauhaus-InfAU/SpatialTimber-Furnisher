import type { Meta, StoryObj } from "@storybook/react";
import { ApartmentCanvas } from "../components/ApartmentCanvas";
import { generateApartment } from "../../generator";

// ─── Wrapper that calls the generator and passes result to canvas ─────────────

interface GeneratorArgs {
  seed:        number;
  showDoors:   boolean;
  showLabels:  boolean;
  showGrid:    boolean;
  canvasWidth: number;
  canvasHeight:number;
}

function RoomGeneratorStory({
  seed, showDoors, showLabels, showGrid, canvasWidth, canvasHeight
}: GeneratorArgs) {
  const apt = generateApartment(seed);

  return (
    <div style={{ background: "#161616", padding: "20px", borderRadius: 12, display: "inline-block" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
        <span style={{
          fontFamily: "'Segoe UI', sans-serif",
          fontSize: 18, fontWeight: 700,
          color: "#e0e0e0",
        }}>
          {apt.label}
        </span>
        <span style={{
          fontFamily: "monospace",
          fontSize: 11, color: "#555",
          background: "#222", padding: "2px 8px", borderRadius: 4,
        }}>
          seed {seed}
        </span>
        <span style={{
          fontFamily: "'Segoe UI', sans-serif",
          fontSize: 11, color: "#777",
        }}>
          {apt.rooms.length} room{apt.rooms.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Canvas */}
      <ApartmentCanvas
        apartment={apt}
        width={canvasWidth}
        height={canvasHeight}
        showDoors={showDoors}
        showLabels={showLabels}
        showGrid={showGrid}
      />

      {/* Room list */}
      <div style={{
        marginTop: 12,
        display: "flex", gap: 8, flexWrap: "wrap",
        fontFamily: "'Segoe UI', sans-serif", fontSize: 11,
      }}>
        {apt.rooms.map((r, i) => (
          <span key={i} style={{
            background: "#1e1e1e", border: "1px solid #333",
            borderRadius: 20, padding: "3px 10px", color: "#aaa",
          }}>
            {r.name}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

const meta: Meta<GeneratorArgs> = {
  title: "Engine / Room Generator",
  component: RoomGeneratorStory,
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark", values: [{ name: "dark", value: "#0e0e0e" }] },
  },
  argTypes: {
    seed: {
      control: { type: "range", min: 0, max: 9999, step: 1 },
      description: "Integer seed — drag to explore different apartments",
    },
    showDoors:   { control: "boolean", description: "Show door points" },
    showLabels:  { control: "boolean", description: "Show room name labels" },
    showGrid:    { control: "boolean", description: "Show 1m grid" },
    canvasWidth: {
      control: { type: "range", min: 400, max: 1400, step: 50 },
      description: "Canvas width (px)",
    },
    canvasHeight: {
      control: { type: "range", min: 200, max: 800, step: 50 },
      description: "Canvas height (px)",
    },
  },
};

export default meta;
type Story = StoryObj<GeneratorArgs>;

// ─── Stories ──────────────────────────────────────────────────────────────────

export const Default: Story = {
  args: {
    seed:         42,
    showDoors:    true,
    showLabels:   true,
    showGrid:     true,
    canvasWidth:  900,
    canvasHeight: 380,
  },
};

export const Studio: Story = {
  name: "Specific — Studio",
  args: { ...Default.args, seed: 7 },
};

export const LargeFamily: Story = {
  name: "Specific — Large family",
  args: { ...Default.args, seed: 1337 },
};

export const CompactView: Story = {
  name: "Display — Compact",
  args: { ...Default.args, showGrid: false, canvasWidth: 600, canvasHeight: 260 },
};
