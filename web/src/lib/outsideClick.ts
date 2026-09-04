// SPDX-License-Identifier: AGPL-3.0-or-later
export function isOutsideElements(target: EventTarget | null, elements: Array<HTMLElement | null>): boolean {
  if (!target) return true;
  return elements.every((element) => !element || !element.contains(target as Node));
}
