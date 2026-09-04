// SPDX-License-Identifier: AGPL-3.0-or-later

export type FloatingAlign = "left" | "right";

export interface FloatingRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface FloatingPlacement {
  left: number;
  top: number;
  maxHeight: number;
  placement: "bottom" | "top";
}

export interface FloatingPlacementOptions {
  align?: FloatingAlign;
  gap?: number;
  margin?: number;
  minHeight?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

export function isScrollInsideElement(event: Event, element: HTMLElement | null): boolean {
  return event.type === "scroll" && Boolean(element && event.composedPath().includes(element));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function viewportSize(options: FloatingPlacementOptions): { width: number; height: number } {
  return {
    width: options.viewportWidth ?? window.innerWidth,
    height: options.viewportHeight ?? window.innerHeight,
  };
}

export function placeFloatingMenu(
  anchor: FloatingRect,
  floating: Pick<FloatingRect, "width" | "height">,
  options: FloatingPlacementOptions = {},
): FloatingPlacement {
  const { width: viewportWidth, height: viewportHeight } = viewportSize(options);
  const margin = options.margin ?? 8;
  const gap = options.gap ?? 4;
  const minHeight = options.minHeight ?? 120;
  const desiredLeft = (options.align ?? "right") === "right"
    ? anchor.right - floating.width
    : anchor.left;
  const maxLeft = Math.max(margin, viewportWidth - floating.width - margin);
  const left = clamp(desiredLeft, margin, maxLeft);

  const belowTop = anchor.bottom + gap;
  const spaceBelow = Math.max(0, viewportHeight - belowTop - margin);
  const spaceAbove = Math.max(0, anchor.top - gap - margin);
  const placement: "bottom" | "top" = floating.height > spaceBelow && spaceAbove > spaceBelow ? "top" : "bottom";
  const available = placement === "top" ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(Math.min(viewportHeight - margin * 2, Math.max(minHeight, available)), 0);
  const renderedHeight = Math.min(floating.height, maxHeight);
  const top = placement === "top"
    ? clamp(anchor.top - gap - renderedHeight, margin, Math.max(margin, viewportHeight - renderedHeight - margin))
    : clamp(belowTop, margin, Math.max(margin, viewportHeight - renderedHeight - margin));

  return { left, top, maxHeight, placement };
}

export function placeFloatingPoint(
  x: number,
  y: number,
  floating: Pick<FloatingRect, "width" | "height">,
  options: FloatingPlacementOptions = {},
): FloatingPlacement {
  const anchor: FloatingRect = {
    left: x,
    right: x,
    top: y,
    bottom: y,
    width: 0,
    height: 0,
  };
  return placeFloatingMenu(anchor, floating, { align: "left", gap: 0, ...options });
}
