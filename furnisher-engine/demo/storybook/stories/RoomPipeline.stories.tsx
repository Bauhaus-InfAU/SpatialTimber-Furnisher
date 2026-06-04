import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { RoomWithFurnitureCanvas } from "../components/RoomWithFurnitureCanvas";
import { ScoreDisplay } from "../components/ScoreDisplay";
import { generateSingleRoom } from "../../generator";
import { runRoomPipelineAt, scoreRoom } from "../../../src/engine";
import type { StepOptions } from "../../../src/engine";
import type { RoomName } from "../../../src/layout";

// ─── Story args ───────────────────────────────────────────────────────────────

interface Args {
  roomName:      RoomName;
  seed:          number;
  apartmentType: number;
  showDoors:     boolean;
  showLabels:    boolean;
  showGrid:      boolean;
  showBbox:      boolean;
  showStage4:    boolean;
  canvasWidth:   number;
  canvasHeight:  number;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const MONO: React.CSSProperties = {
  fontFamily: "monospace", fontSize: 11, background: "#222",
  padding: "2px 8px", borderRadius: 4,
};

const BTN: React.CSSProperties = {
  fontFamily: "monospace", fontSize: 12,
  background: "#1e1e1e", border: "1px solid #444",
  borderRadius: 4, padding: "3px 10px",
  color: "#aaa", cursor: "pointer",
  lineHeight: 1.4,
};

const STEP_LABEL: React.CSSProperties = {
  fontFamily: "'Segoe UI', sans-serif", fontSize: 12, fontWeight: 600,
  color: "#e8c060", minWidth: 90,
};

const VARIANT_TAG: React.CSSProperties = {
  fontFamily: "monospace", fontSize: 11,
  background: "#252010", border: "1px solid #e8c060",
  borderRadius: 4, padding: "2px 8px", color: "#e8c060",
};

const WARN_TAG: React.CSSProperties = {
  fontFamily: "monospace", fontSize: 11,
  background: "#2a1a1a", border: "1px solid #8a4a4a",
  borderRadius: 4, padding: "2px 8px", color: "#cc8888",
};

// ─── Per-step nav bar ─────────────────────────────────────────────────────────

function StepNav({
  step, onChange,
}: {
  step: StepOptions;
  onChange: (newIndex: number) => void;
}) {
  const { furnitureName, allOptions, selectedIndex, selected } = step;

  if (allOptions.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={STEP_LABEL}>{furnitureName}</span>
        <span style={WARN_TAG}>no valid placement</span>
      </div>
    );
  }

  const variantLabel = selected ? `V${selected.variantIndex + 1}` : "—";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
      <span style={STEP_LABEL}>{furnitureName}</span>
      <span style={VARIANT_TAG}>{variantLabel}</span>

      <button
        style={BTN}
        disabled={selectedIndex <= 0}
        onClick={() => onChange(selectedIndex - 1)}
      >
        ‹ prev
      </button>
      <span style={{ ...MONO, color: "#e8c060" }}>
        pos {selectedIndex + 1} / {allOptions.length}
      </span>
      <button
        style={BTN}
        disabled={selectedIndex >= allOptions.length - 1}
        onClick={() => onChange(selectedIndex + 1)}
      >
        next ›
      </button>

      {allOptions.length <= 12 && (
        <div style={{ display: "flex", gap: 4, marginLeft: 4 }}>
          {allOptions.map((_, i) => (
            <button
              key={i}
              onClick={() => onChange(i)}
              style={{
                width: 8, height: 8, borderRadius: "50%", padding: 0, border: "none",
                background: i === selectedIndex ? "#e8c060" : "#444",
                cursor: "pointer",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Story component ──────────────────────────────────────────────────────────

function RoomPipelineStory({
  roomName, seed, apartmentType,
  showDoors, showLabels, showGrid, showBbox, showStage4,
  canvasWidth, canvasHeight,
}: Args) {
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);

  const room   = generateSingleRoom(roomName, seed);
  const result = runRoomPipelineAt(room, apartmentType, selectedIndices);
  const score  = scoreRoom(roomName, result);

  useEffect(() => {
    const expected = result.steps.length;
    if (selectedIndices.length !== expected) {
      setSelectedIndices(Array(expected).fill(0));
    }
  }, [result.steps.length]);

  function changeStep(stepIndex: number, newIndex: number) {
    setSelectedIndices((prev) => {
      const next = [...prev];
      next[stepIndex] = newIndex;
      for (let i = stepIndex + 1; i < next.length; i++) next[i] = 0;
      return next;
    });
  }

  const placedPieces = result.steps
    .map((s) => s.selected?.placed)
    .filter((p): p is NonNullable<typeof p> => p != null);

  return (
    <div style={{ background: "#161616", padding: 20, borderRadius: 12, display: "inline-flex", gap: 20, alignItems: "flex-start" }}>

      {/* Left column: title + step controls + score */}
      <div style={{ display: "flex", flexDirection: "column", minWidth: 260 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{
            fontFamily: "'Segoe UI', sans-serif", fontSize: 18, fontWeight: 700, color: "#e0e0e0",
          }}>
            {roomName}
          </span>
          <span style={{ ...MONO, color: "#555" }}>apt {apartmentType}</span>
          <span style={{ ...MONO, color: "#555" }}>seed {seed}</span>

          {result.steps.length === 0 && (
            <span style={{ ...MONO, color: "#555" }}>no pipeline defined for this room</span>
          )}
        </div>

        {result.steps.map((step, i) => (
          <StepNav
            key={`${roomName}-${i}-${step.furnitureName}`}
            step={step}
            onChange={(ni) => changeStep(i, ni)}
          />
        ))}

        <ScoreDisplay score={score} />
      </div>

      {/* Right column: canvas */}
      <RoomWithFurnitureCanvas
        room={room}
        furniture={placedPieces}
        width={canvasWidth}
        height={canvasHeight}
        showDoors={showDoors}
        showLabels={showLabels}
        showGrid={showGrid}
        showBbox={showBbox}
        showStage4={showStage4}
      />
    </div>
  );
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

const ROOM_NAMES: RoomName[] = [
  "Bedroom", "Living room", "Kitchen", "Bathroom", "WC",
  "Children 1", "Children 2",
];

const meta: Meta<Args> = {
  title: "Engine / Room Pipeline",
  component: RoomPipelineStory,
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark", values: [{ name: "dark", value: "#0e0e0e" }] },
  },
  argTypes: {
    roomName: {
      control: { type: "select" },
      options: ROOM_NAMES,
      description: "Room type",
    },
    seed: {
      control: { type: "range", min: 0, max: 9999, step: 1 },
      description: "Seed for room shape",
    },
    apartmentType: {
      control: { type: "select" },
      options: [1, 2, 3, 4],
      description: "Apartment type (affects which furniture variants are used)",
    },
    showDoors:  { control: "boolean" },
    showLabels: { control: "boolean" },
    showGrid:   { control: "boolean" },
    showBbox: {
      control: "boolean",
      description: "bboxBig (dashed red) + bboxSmall (amber) + wall (green) for all pieces",
    },
    showStage4: {
      control: "boolean",
      description: "Final room_full (teal) + room_rdc (amber) after all placements",
    },
    canvasWidth:  { control: { type: "range", min: 400, max: 1400, step: 50 } },
    canvasHeight: { control: { type: "range", min: 200, max: 800, step: 50 } },
  },
};

export default meta;
type Story = StoryObj<Args>;

// ─── Stories ──────────────────────────────────────────────────────────────────

export const Bedroom: Story = {
  args: {
    roomName:      "Bedroom",
    seed:          42,
    apartmentType: 2,
    showDoors:     true,
    showLabels:    true,
    showGrid:      true,
    showBbox:      false,
    showStage4:    false,
    canvasWidth:   700,
    canvasHeight:  500,
  },
};

export const BedroomWithDebug: Story = {
  name: "Bedroom — bbox + stage4",
  args: {
    ...Bedroom.args,
    showBbox:   true,
    showStage4: true,
  },
};

export const Children: Story = {
  name: "Children — Apt 3",
  args: {
    ...Bedroom.args,
    roomName:      "Children 1",
    apartmentType: 3,
  },
};

export const LivingRoom: Story = {
  name: "Living room — Apt 4",
  args: {
    ...Bedroom.args,
    roomName:      "Living room",
    apartmentType: 4,
    canvasWidth:   900,
    canvasHeight:  600,
  },
};

export const Kitchen: Story = {
  name: "Kitchen — Apt 3",
  args: {
    ...Bedroom.args,
    roomName:      "Kitchen",
    apartmentType: 3,
  },
};

export const Bathroom: Story = {
  name: "Bathroom — Apt 4",
  args: {
    ...Bedroom.args,
    roomName:      "Bathroom",
    apartmentType: 4,
  },
};

export const BathroomSmall: Story = {
  name: "Bathroom — Apt 1 (Shower fallback)",
  args: {
    ...Bedroom.args,
    roomName:      "Bathroom",
    apartmentType: 1,
  },
};

export const WC: Story = {
  name: "WC — Apt 4",
  args: {
    ...Bedroom.args,
    roomName:      "WC",
    apartmentType: 4,
  },
};
