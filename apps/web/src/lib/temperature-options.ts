// SPDX-License-Identifier: Apache-2.0

export interface TemperatureOption {
  value: string;
  label: string;
}

/**
 * The temperature presets, plus the stored value when it falls between them
 * (set through the API or the launch slider): one more option at its place in
 * the scale, so the control shows the value that applies instead of an empty
 * trigger. `presets` are numeric values in ascending order; an option whose
 * value is not a number (the "inherit" entry) keeps its position.
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
