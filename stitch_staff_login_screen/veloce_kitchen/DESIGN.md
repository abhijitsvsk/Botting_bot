# Design System Specification

## 1. Overview & Creative North Star: "The Kinetic Engine"
This design system is built to facilitate high-velocity decision-making. In a restaurant environment, friction is the enemy. Our Creative North Star is **"The Kinetic Engine"**—a philosophy that treats the UI as a living, breathing dashboard of efficiency. 

We break the "template" look by eschewing traditional grids in favor of **Intentional Asymmetry**. Key metrics bleed into the margins, and functional areas (like the receipt sidebar) are treated as physical artifacts layered over a digital workspace. We replace rigid lines with **Tonal Depth**, creating an editorial feel that prioritizes data legibility and ergonomic speed.

---

## 2. Color & Surface Philosophy
The palette is anchored by the high-performance contrast of **Emerald (#4EDE63)** and **Indigo (#6366F1)**. This is not just a color choice; it is a functional mapping of "Success/Flow" vs. "Structure/Action."

### The "No-Line" Rule
Traditional 1px borders are prohibited for sectioning. To create a premium, bespoke feel, boundaries must be defined by **Background Color Shifts**.
*   **Surface Hierarchy:** Use `surface_container_lowest` for the base canvas and `surface_container_high` for interactive elements. This creates a "molded" look rather than a "sketched" look.
*   **Signature Textures:** Main CTAs should utilize a subtle linear gradient from `primary` (#4EDE63) to `primary_container` (#10B981) at a 135-degree angle. This adds a "jewel" polish that signifies importance without visual clutter.

### Surface Hierarchy (Dark Theme Example)
*   **Background (`#101419`):** The primary void.
*   **Surface Container Low (`#181C21`):** Large structural areas (e.g., KDS background).
*   **Surface Container Highest (`#31353B`):** Active interactive cards or focused ticket items.

---

## 3. Typography: Editorial Clarity
We utilize **Inter** for its neutral, high-legibility character, paired with **Monospace** for precision data.

*   **Display (Editorial Hero):** Use `display-lg` (3.5rem) with -0.02em letter spacing for high-level revenue metrics. It should feel authoritative and "un-web-like."
*   **The Precision Layer (Monospace):** All timestamps, order numbers, and table codes must use a Monospace font. This differentiates "data" from "instruction."
*   **Scale Harmony:**
    *   `Headline-sm` (1.5rem): Used for section headers to create a rhythmic "heartbeat" across the dashboard.
    *   `Label-md` (0.75rem): Always Uppercase with +0.05em tracking for secondary metadata (e.g., "TABLE 12").

---

## 4. Elevation & Depth: The Layering Principle
We move beyond shadows to **Tonal Layering**. Depth is achieved by stacking surface-container tiers.

*   **Ambient Shadows:** For floating elements like Modals or Tooltips, use an ultra-diffused shadow: `box-shadow: 0 20px 40px rgba(0, 0, 0, 0.12)`. The shadow color must be a tint of the `on_surface` color, never pure black.
*   **The "Ghost Border" Fallback:** If accessibility requires a border (e.g., KDS tickets), use the `outline_variant` token at **15% opacity**. It should feel like a suggestion of a line, not a physical barrier.
*   **Glassmorphism:** For login screens and high-level overlays, use:
    *   `background: rgba(28, 32, 37, 0.7)`
    *   `backdrop-filter: blur(12px)`
    *   This ensures the UI feels integrated into the restaurant's physical atmosphere.

---

## 5. Components

### POS Receipt Sidebar
*   **Style:** `surface_container_lowest` background.
*   **Detail:** Forbid dividers. Use a 24px vertical gap between order groups. Use a "jagged" mask-image at the bottom to evoke the physical receipt metaphor subtly.

### KDS Tickets (Kitchen Display System)
*   **Visual Priority:** No borders. Use a `4px` solid left-edge accent using `error` (#EF4444) for overdue orders and `primary` (#10B981) for new orders.
*   **Typography:** Order items must use `title-md` for maximum readability under kitchen heat and stress.

### Buttons (The Kinetic Triggers)
*   **Primary:** Gradient of `primary` to `primary_container`. `borderRadius: 0.375rem`. No border.
*   **Secondary:** `surface_container_highest` background with `on_surface` text.
*   **Tertiary:** Transparent background, `on_surface_variant` text, 0.5px ghost border on hover only.

### Analytics Progress Bars
*   **Execution:** Horizontal bars should use a "track and fill" approach. The track is `surface_container_high`. The fill is a gradient of `secondary` to `primary`. Avoid rounded end-caps; use `0.125rem` (sm) rounding for a modern, architectural look.

---

## 6. Do’s and Don’ts

### Do:
*   **DO** use whitespace as the primary separator. If you feel the need for a line, increase the padding by 8px instead.
*   **DO** use `tertiary` (Amber) sparingly for warnings. It should act as a "caution light" in a sea of Emerald and Indigo.
*   **DO** prioritize the "Dark Mode" for high-glare environments like kitchens (KDS) and "Light Mode" for administrative offices (Manager Reports).

### Don't:
*   **DON'T** use 100% opaque borders. They flatten the UI and make it look like a legacy spreadsheet.
*   **DON'T** use standard "drop shadows" with 0 blur. Shadows must be ambient and soft.
*   **DON'T** mix typography families. Stick to Inter for the UI and Monospace for the numbers. Consistency equals speed.