// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Combobox } from "@appstrate/ui/components/combobox";
import { timezoneOptions } from "../lib/timezones";

/** A time zone, searched rather than scrolled: the browser knows four hundred of them. */
export function TimezoneSelect({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string;
  onChange: (timezone: string) => void;
}) {
  const { t } = useTranslation(["agents"]);
  return (
    <Combobox
      id={id}
      value={value}
      onValueChange={onChange}
      options={timezoneOptions(value).map((zone) => ({ value: zone }))}
      searchPlaceholder={t("schedule.timezoneSearch")}
      emptyText={t("schedule.timezoneEmpty")}
    />
  );
}
