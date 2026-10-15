// SPDX-License-Identifier: Apache-2.0

export interface TemperatureOption {
  value: string;
  label: string;
}

/**
 * The presets plus the stored value when it falls between them, so the control
 * never shows an empty trigger. `presets` ascend numerically; a non-numeric
 * option (the "inherit" entry) keeps its position.
 */
export function withStoredTemperature(
  presets: readonly TemperatureOption[],
  stored: number | null | undefined,
  formatValue: (value: number) => string,
): TemperatureOption[] {
  const options = [...presets];
  if (stored == null || options.some((option) => option.value === String(stored))) return options;
  const at = options.findIndex((option) => {
    const value = Number(option.value);
    return Number.isFinite(value) && value > stored;
  });
  options.splice(at === -1 ? options.length : at, 0, {
    value: String(stored),
    label: formatValue(stored),
  });
  return options;
}
