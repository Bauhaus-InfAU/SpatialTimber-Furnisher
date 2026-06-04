import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { RoomWithFurnitureCanvas } from "../components/RoomWithFurnitureCanvas";
import { generateSingleRoom } from "../../generator";
import { findFurniture, ALL_CATEGORIES, defaultLibrary } from "../../../src/library";
import { getAllPlacements } from "../../../src/engine";
import type { PlacementOption } from "../../../src/engine";
import type { FurnitureCategory } from "../../../src/library";
import type { RoomName } from "../../../src/layout";

// ─── Category → RoomName ─────────────────────────────────────────────────────

const CATEGORY_TO_ROOM: Record<FurnitureCategory, RoomName> = {
  Bathroom:   "Bathroom",
  Kitchen:    "Kitchen",
  Livingroom: "Living room",
  Bedroom:    "Bedroom",
  Children:   "Children 1",
  WC:         "WC",
};

// ─── Story args ───────────────────────────────────────────────────────────────

interface Args {
  seed:          number;
  apartmentType: number;
  roomCategory:  FurnitureCategory;
  showDoors:     boolean;
  showLabels:    boolean;
  showGrid:      boolean;
  showBbox:      boolean;
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

// ─── Variant pills (clickable) ────────────────────────────────────────────────

function VariantPills({
  totalVariants, countsPerVariant, selected, onSelect,
}: {
  totalVariants: number;
  countsPerVariant: number[];
  selected: number;
  onSelect: (i: number) => void;
}) {
  if (totalVariants === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
      {Array.from({ length: totalVariants }, (_, vi) => {
        const count = countsPerVariant[vi] ?? 0;
        const isActive = vi === selected;
        return (
          <button
            key={vi}
            onClick={() => onSelect(vi)}
            style={{
              fontFamily: "monospace", fontSize: 11,
              background: isActive ? "#252010" : "#1a1a1a",
              border: isActive ? "1px solid #e8c060" : "1px solid #333",
              borderRadius: 4, padding: "3px 10px",
              color: count > 0 ? (isActive ? "#e8c060" : "#888") : "#444",
              cursor: count > 0 ? "pointer" : "default",
            }}
          >
            V{vi + 1}: {count === 0 ? "✗" : `${count} pos`}
          </button>
        );
      })}
    </div>
  );
}

// ─── Placement navigation ─────────────────────────────────────────────────────

function PlacementNav({
  options, selected, onChange,
}: {
  options: PlacementOption[];
  selected: number;
  onChange: (i: number) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
      <button style={BTN} disabled={selected <= 0} onClick={() => onChange(selected - 1)}>
        ‹ prev
      </button>
      <span style={{ ...MONO, color: "#e8c060" }}>
        pos {selected + 1} / {options.length}
      </span>
      <button style={BTN} disabled={selected >= options.length - 1} onClick={() => onChange(selected + 1)}>
        next ›
      </button>
      {options.length <= 12 && (
        <div style={{ display: "flex", gap: 4, marginLeft: 4 }}>
          {options.map((_, i) => (
            <button
              key={i}
              onClick={() => onChange(i)}
              style={{
                width: 8, height: 8, borderRadius: "50%", padding: 0, border: "none",
                background: i === selected ? "#e8c060" : "#444",
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

function FurniturePlacementStory({
  seed, apartmentType, roomCategory,
  showDoors, showLabels, showGrid, showBbox,
  canvasWidth, canvasHeight,
}: Args) {
  const [selectedVariant,   setSelectedVariant]   = useState(0);
  const [selectedPlacement, setSelectedPlacement] = useState(0);

  const roomName = CATEGORY_TO_ROOM[roomCategory];
  const room     = generateSingleRoom(roomName, seed);
  const entry    = findFurniture(defaultLibrary, apartmentType, roomCategory);

  const allOptions    = entry ? getAllPlacements(room, entry) : [];
  const totalVariants = entry?.pieces[0]?.variants.length ?? 0;

  const countsPerVariant: number[] = Array(totalVariants).fill(0);
  for (const opt of allOptions) countsPerVariant[opt.variantIndex]++;

  const clampedVariant   = Math.min(selectedVariant, Math.max(0, totalVariants - 1));
  const variantOptions   = allOptions.filter(o => o.variantIndex === clampedVariant);
  const clampedPlacement = Math.min(selectedPlacement, Math.max(0, variantOptions.length - 1));

  const current = variantOptions[clampedPlacement] ?? null;

  function selectVariant(vi: number) {
    setSelectedVariant(vi);
    setSelectedPlacement(0);
  }

  return (
    <div style={{ background: "#161616", padding: 20, borderRadius: 12, display: "inline-block" }}>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <span style={{
          fontFamily: "'Segoe UI', sans-serif", fontSize: 18, fontWeight: 700, color: "#e0e0e0",
        }}>
          {roomName}
        </span>
        <span style={{ ...MONO, color: "#555" }}>apt {apartmentType}</span>
        <span style={{ ...MONO, color: "#555" }}>seed {seed}</span>

        {!entry && (
          <span style={{ fontFamily: "'Segoe UI', sans-serif", fontSize: 12, color: "#ff5555" }}>
            No furniture for this combination
          </span>
        )}
        {entry && current && (
          <span style={{ fontFamily: "'Segoe UI', sans-serif", fontSize: 12, color: "#e8c060" }}>
            {current.placed.name}
          </span>
        )}
        {entry && !current && variantOptions.length === 0 && (
          <span style={{ fontFamily: "'Segoe UI', sans-serif", fontSize: 12, color: "#ff5555" }}>
            V{clampedVariant + 1}: no valid placement
          </span>
        )}
      </div>

      <VariantPills
        totalVariants={totalVariants}
        countsPerVariant={countsPerVariant}
        selected={clampedVariant}
        onSelect={selectVariant}
      />

      <PlacementNav
        options={variantOptions}
        selected={clampedPlacement}
        onChange={setSelectedPlacement}
      />

      <RoomWithFurnitureCanvas
        room={room}
        furniture={current?.placed ?? null}
        width={canvasWidth}
        height={canvasHeight}
        showDoors={showDoors}
        showLabels={showLabels}
        showGrid={showGrid}
        showBbox={showBbox}
      />
    </div>
  );
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

const meta: Meta<Args> = {
  title: "Engine / Furniture Placement",
  component: FurniturePlacementStory,
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark", values: [{ name: "dark", value: "#0e0e0e" }] },
  },
  argTypes: {
    seed: {
      control: { type: "range", min: 0, max: 9999, step: 1 },
      description: "Seed for room shape",
    },
    apartmentType: {
      control: { type: "select" },
      options: [1, 2, 3, 4],
      description: "Apartment type",
    },
    roomCategory: {
      control: { type: "select" },
      options: ALL_CATEGORIES,
      mapping: Object.fromEntries(ALL_CATEGORIES.map(c => [c, c])),
      description: "Room / furniture category",
    },
    showDoors:  { control: "boolean" },
    showLabels: { control: "boolean" },
    showGrid:   { control: "boolean" },
    showBbox: {
      control: "boolean",
      description: "bboxBig (dashed red) + bboxSmall (amber) + wall (green)",
    },
    canvasWidth:  { control: { type: "range", min: 400, max: 1400, step: 50 } },
    canvasHeight: { control: { type: "range", min: 200, max: 800, step: 50 } },
  },
};

export default meta;
type Story = StoryObj<Args>;

// ─── Stories ─────────────────────────────────────────────────────────────────

export const Default: Story = {
  args: {
    seed:          42,
    apartmentType: 2,
    roomCategory:  "Bedroom",
    showDoors:     true,
    showLabels:    true,
    showGrid:      true,
    showBbox:      true,
    canvasWidth:   700,
    canvasHeight:  500,
  },
};

export const BathroomSmall: Story = {
  name: "Bathroom — Apt 1",
  args: { ...Default.args, apartmentType: 1, roomCategory: "Bathroom" },
};

export const LivingRoomLarge: Story = {
  name: "Living room — Apt 4",
  args: { ...Default.args, apartmentType: 4, roomCategory: "Livingroom", seed: 123 },
};

export const KitchenDebug: Story = {
  name: "Kitchen — Debug overlay",
  args: { ...Default.args, apartmentType: 3, roomCategory: "Kitchen", showBbox: true },
};
